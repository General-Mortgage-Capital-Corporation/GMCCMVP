"""Refi Finder search orchestrator.

Three responsibilities:

1. **Normalize** the UI's friendly filter JSON into PropertyRadar's
   ``Criteria`` array shape (the canonical mapping lives in
   ``UI_FILTER_TO_PR_CRITERIA``). Handles label↔code mismatches we
   discovered in Day 1 (e.g. FirstPurpose enum codes, date string format).

2. **Cache** by criteria hash + page + limit. PR data refreshes daily, so
   we cache 24h on disk under ``data/pr_cache/`` to avoid double-charging
   on a repeat query.

3. **Enrich** each row with tract income / minority demographics via the
   existing ``matching.census`` pipeline so the LO can filter by LMI
   tract / minority % without a second backend call.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone, date, timedelta
from pathlib import Path
from typing import Any

from concurrent.futures import ThreadPoolExecutor

from matching import propertyradar
from matching.cache import (
    get_cached_contact_unlock,
    get_cached_refi_search,
    set_cached_contact_unlock,
    set_cached_refi_search,
)
from matching.census import get_census_data, get_census_data_fast
from matching.refi_presets import get_preset

logger = logging.getLogger(__name__)

CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "pr_cache"
CACHE_TTL_SECONDS = 24 * 60 * 60  # 24 hours

# Max page size we let the UI request. PropertyRadar accepts higher limits
# but each row costs a record — keep the per-page max small.
MAX_PAGE_LIMIT = 100
DEFAULT_PAGE_LIMIT = 25


class RefiSearchError(Exception):
    pass


# ---------------------------------------------------------------------------
# Geography handling
# ---------------------------------------------------------------------------


def _build_geography_criteria(geo: dict | None) -> list[dict]:
    """Convert the UI geography block into PR Criteria entries.

    Geo shape:
        {"zip_codes": [95014, 95129]}                   # list of 5-digit zips
        {"cities": [{"city": "Cupertino", "state": "CA"}]}  # city + state pairs
        {"county_fips": ["6085"]}                       # 4 or 5-digit FIPS
        {"states": ["California"]}                      # full state names
    """
    if not geo:
        raise RefiSearchError("at least one geography filter is required (zip_codes, cities, county_fips, or states)")

    criteria: list[dict] = []
    if geo.get("zip_codes"):
        zips = [int(z) for z in geo["zip_codes"]]
        criteria.append({"name": "ZipFive", "value": zips})
    if geo.get("cities"):
        # PR City criterion accepts city name strings; pair with State separately.
        criteria.append({"name": "City", "value": [c.get("city") for c in geo["cities"] if c.get("city")]})
        states = sorted({c.get("state") for c in geo["cities"] if c.get("state")})
        if states:
            criteria.append({"name": "State", "value": states})
    if geo.get("county_fips"):
        criteria.append({"name": "County", "value": [str(f) for f in geo["county_fips"]]})
    if geo.get("states") and not geo.get("cities"):
        criteria.append({"name": "State", "value": geo["states"]})

    if not criteria:
        raise RefiSearchError("geography block must include at least one populated key")
    return criteria


# ---------------------------------------------------------------------------
# UI filter -> PR Criteria normalizer
# ---------------------------------------------------------------------------


def _fmt_pr_date(iso: str | None) -> str | None:
    """ISO 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ' -> PR's 'M/D/YYYY'."""
    if not iso:
        return None
    s = str(iso).split("T", 1)[0]
    try:
        d = date.fromisoformat(s)
    except ValueError:
        raise RefiSearchError(f"invalid ISO date: {iso}")
    return f"{d.month}/{d.day}/{d.year}"


def _date_range_value(rng: dict | None,
                      key_from: str = "from", key_to: str = "to") -> list[str] | None:
    if not rng:
        return None
    f = _fmt_pr_date(rng.get(key_from))
    t = _fmt_pr_date(rng.get(key_to))
    if not f and not t:
        return None
    parts = []
    if f:
        parts.append(f"from: {f}")
    if t:
        parts.append(f"to: {t}")
    return [" ".join(parts)]


def _range(min_v: Any, max_v: Any) -> list[list]:
    return [[min_v, max_v]]


def _arm_reset_window_value(months: int | None) -> list[str] | None:
    """Convert 'within N months' to a PR Relative Date range. Month math is
    approximate (30d/mo) — sufficient for a ~12mo lookahead window."""
    if not months or months <= 0:
        return None
    today = date.today()
    end = today + timedelta(days=months * 30)
    return [f"from: {today.month}/{today.day}/{today.year} to: {end.month}/{end.day}/{end.year}"]


# Canonical mapping. Each entry: (criterion_name, value_builder).
# Builders return either a PR Criteria value or None (skip this criterion).
def _build_filter_criteria(filters: dict | None) -> list[dict]:
    if not filters:
        return []

    out: list[dict] = []

    def add(name: str, value: Any) -> None:
        if value is None or value == [] or value == {}:
            return
        out.append({"name": name, "value": value})

    # Property type (composite criterion)
    if filters.get("property_types"):
        add("PropertyType", [{"name": "PType", "value": list(filters["property_types"])}])

    # Owner-occupancy
    if filters.get("owner_occupied") is True:
        add("isSameMailingOrExempt", [1])
    elif filters.get("owner_occupied") is False:
        add("isNotSameMailingOrExempt", [1])

    # First mortgage purpose
    if filters.get("first_purpose"):
        add("FirstPurpose", list(filters["first_purpose"]))

    # First mortgage loan type (codes: B|C|F|N|O|P|S|V)
    if filters.get("first_loan_type"):
        add("FirstLoanType", list(filters["first_loan_type"]))

    # Rate type (F | A)
    if filters.get("first_rate_type"):
        add("FirstRateType", list(filters["first_rate_type"]))

    # First mortgage date — supports either a range dict or single-sided keys
    dr = filters.get("first_date_range") or {}
    if filters.get("first_date_from"):
        dr.setdefault("from", filters["first_date_from"])
    if filters.get("first_date_to"):
        dr.setdefault("to", filters["first_date_to"])
    add("FirstDate", _date_range_value(dr))

    # First rate band
    fr_min = filters.get("first_rate_min")
    fr_max = filters.get("first_rate_max")
    if fr_min is not None or fr_max is not None:
        add("FirstRate", _range(fr_min, fr_max))

    # First amount band
    fa_min = filters.get("first_amount_min")
    fa_max = filters.get("first_amount_max")
    if fa_min is not None or fa_max is not None:
        add("FirstAmount", _range(fa_min, fa_max))

    # Aggregate equity
    eq_min = filters.get("available_equity_min")
    eq_max = filters.get("available_equity_max")
    if eq_min is not None or eq_max is not None:
        add("AvailableEquity", _range(eq_min, eq_max))

    ep_min = filters.get("equity_percent_min")
    ep_max = filters.get("equity_percent_max")
    if ep_min is not None or ep_max is not None:
        add("EquityPercent", _range(ep_min, ep_max))

    # AVM band
    avm_min = filters.get("avm_min")
    avm_max = filters.get("avm_max")
    if avm_min is not None or avm_max is not None:
        add("AVM", _range(avm_min, avm_max))

    # Free-and-clear: map to NumberLoans because isFreeAndClear is gated to
    # higher PR plan tiers (returns "cannot be used by this user" on Solo).
    # True (no loans)  -> NumberLoans = 0
    # False (has loan) -> NumberLoans >= 1
    if filters.get("is_free_and_clear") is True:
        add("NumberLoans", _range(0, 0))
    elif filters.get("is_free_and_clear") is False:
        add("NumberLoans", _range(1, None))

    # Number of open liens
    nl_min = filters.get("number_loans_min")
    nl_max = filters.get("number_loans_max")
    if nl_min is not None or nl_max is not None:
        add("NumberLoans", _range(nl_min, nl_max))

    # Last transfer (sale) date
    lt = filters.get("last_transfer_date_range") or {}
    if filters.get("last_transfer_date_from"):
        lt.setdefault("from", filters["last_transfer_date_from"])
    if filters.get("last_transfer_date_to"):
        lt.setdefault("to", filters["last_transfer_date_to"])
    add("LastTransferRecDate", _date_range_value(lt))

    # ARM reset window. PR's field is `FirstARMNext` (next scheduled reset
    # date) — NOT `FirstARMResetDate` as the criteria-reference summary
    # claimed. API error message ("Unexpected Criterion") was authoritative.
    add("FirstARMNext", _arm_reset_window_value(filters.get("first_arm_reset_within_months")))

    # Lender targeting
    if filters.get("first_lender_original"):
        add("FirstLenderOriginal", list(filters["first_lender_original"]))

    # Distress exclusions — only inForeclosure is allowed on Solo plan.
    # isBankOwned and inBankruptcyProperty are gated to higher tiers.
    if filters.get("exclude_distressed"):
        add("inForeclosure", [0])

    return out


def build_pr_criteria(*, preset_id: str | None, geography: dict | None,
                      filters: dict | None) -> list[dict]:
    """Compose the full PropertyRadar Criteria array from a UI request.

    Preset base_filters are merged FIRST, then overridden by any keys the
    user explicitly set in `filters`. Empty/None values in `filters` do
    NOT override (they mean 'leave preset value alone'); to explicitly
    clear a preset filter, the UI sends the key set to False / 0 / [].
    """
    merged_filters: dict[str, Any] = {}
    if preset_id:
        preset = get_preset(preset_id)
        if not preset:
            raise RefiSearchError(f"unknown preset: {preset_id}")
        merged_filters.update(preset.base_filters)
    if filters:
        for k, v in filters.items():
            if v is None:
                continue  # None means 'use preset default'
            merged_filters[k] = v

    geo_criteria = _build_geography_criteria(geography)
    filt_criteria = _build_filter_criteria(merged_filters)
    return geo_criteria + filt_criteria


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def _criteria_hash(criteria: list[dict], *, page: int = 0, limit: int = 0) -> str:
    payload = json.dumps({"c": criteria, "p": page, "l": limit}, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def _cache_path(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def _read_cache(key: str) -> dict | None:
    """Two-tier read: Upstash Redis first (cross-user), then local file fallback
    (useful for offline dev when Redis isn't configured)."""
    # L2: shared Redis
    redis_hit = get_cached_refi_search(key)
    if redis_hit is not None:
        return redis_hit

    # L1: local file (dev / offline fallback)
    p = _cache_path(key)
    if not p.exists():
        return None
    try:
        raw = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    cached_at = raw.get("_cached_at")
    if not cached_at:
        return None
    try:
        ts = datetime.fromisoformat(cached_at)
    except ValueError:
        return None
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    if age > CACHE_TTL_SECONDS:
        return None
    return raw.get("data")


def _write_cache(key: str, data: dict) -> None:
    """Two-tier write: Redis (with TTL) + local file (best-effort fallback).

    Local file is purely a dev-environment convenience. Any filesystem error
    (e.g. Vercel's read-only ``/var/task``) is swallowed silently — Redis is
    the source of truth for production cross-invocation caching.
    """
    # L2: shared Redis (no-op if not configured)
    set_cached_refi_search(key, data)

    # L1: local file — best-effort, never fatal
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"_cached_at": datetime.now(timezone.utc).isoformat(), "data": data}
        _cache_path(key).write_text(json.dumps(payload, default=str))
    except OSError as exc:
        # Read-only fs (Vercel) or quota — fine, Redis carries the cache.
        logger.debug("refi local cache write skipped: %s", exc)


# ---------------------------------------------------------------------------
# Tract enrichment
# ---------------------------------------------------------------------------


def _enrich_row_with_tract(row: dict) -> dict:
    """Add ``census`` block to a PR row.

    Fast path: PR already gives us state + county name + CensusTract on every
    row, so we skip the slow Census Bureau address geocoder (which times out
    at 15s on a non-trivial fraction of addresses). Falls back to the full
    address-geocoded pipeline only if the fast lookup can't resolve county
    FIPS (e.g. unusual county name spelling).
    """
    if not isinstance(row, dict):
        return row

    census = None
    try:
        census = get_census_data_fast(
            state=row.get("State"),
            county_name=row.get("County"),
            tract_code=row.get("CensusTract"),
        )
    except Exception:
        logger.exception("fast tract lookup failed for RadarID=%s", row.get("RadarID"))

    if census is None:
        # Fallback: geocode the address (slow). Only fires when fast path
        # can't resolve — should be rare.
        listing_like = {
            "addressLine1": row.get("Address") or "",
            "city": row.get("City") or "",
            "state": row.get("State") or "",
            "zipCode": str(row.get("ZipFive") or ""),
            "latitude": row.get("Latitude"),
            "longitude": row.get("Longitude"),
        }
        try:
            census = get_census_data(listing_like)
        except Exception:
            logger.exception("address-geocode tract fallback failed for RadarID=%s", row.get("RadarID"))
            census = None

    if census:
        row["census"] = {
            "tract_income_level": census.get("tract_income_level"),
            "tract_minority_pct": census.get("tract_minority_pct"),
            "tract_population": census.get("tract_population"),
            "msa_name": census.get("msa_name"),
            "msa_code": census.get("msa_code"),
            "tract_to_msa_ratio": census.get("tract_to_msa_ratio"),
            "tract_mfi": census.get("tract_mfi"),
            "ffiec_mfi": census.get("ffiec_mfi"),
        }
    return row


# Tract enrichment parallelism. ACS calls are I/O-bound (network), so we can
# run many concurrently. 10 workers is plenty for a 25-row page.
_TRACT_ENRICH_WORKERS = 10


# ---------------------------------------------------------------------------
# Contact unlock (phone + email per person)
# ---------------------------------------------------------------------------


def preview_contacts(radar_ids: list[str]) -> dict:
    """Free preview: how many person records would be returned, total credits.

    Calls GET /properties/{rid}/persons?Purchase=0 for each radar_id. Returns
    the aggregate resultCount across all properties and the remaining quota.
    Zero credits charged.
    """
    if not radar_ids:
        raise RefiSearchError("at least one radar_id is required")
    total_persons = 0
    cached_count = 0
    quota_remaining: int | None = None
    per_property: list[dict] = []
    for rid in radar_ids:
        # Cache hit means we'd pay 0 credits — already in Redis.
        if get_cached_contact_unlock(rid) is not None:
            cached_count += 1
            per_property.append({"radar_id": rid, "persons": 0, "cached": True})
            continue
        try:
            resp = propertyradar.fetch_property_persons(rid, purchase=0)
        except propertyradar.PropertyRadarError as exc:
            per_property.append({"radar_id": rid, "persons": 0, "error": str(exc)})
            continue
        cnt = int(resp.get("resultCount") or 0)
        total_persons += cnt
        qr = resp.get("quantityFreeRemaining")
        if qr is not None:
            quota_remaining = int(qr)
        per_property.append({"radar_id": rid, "persons": cnt, "cached": False})
    return {
        "total_credits": total_persons,
        "cached_properties": cached_count,
        "quantity_free_remaining": quota_remaining,
        "per_property": per_property,
    }


def unlock_contacts(radar_ids: list[str], *, phone: bool = True, email: bool = True) -> dict:
    """Fetch phone + email for a list of properties (by RadarID).

    Uses ``GET /properties/{RadarID}/persons`` (one call per property)
    instead of the per-person POST /persons/{key}/Phone endpoint because:

    1. **Recovery:** the POST endpoint refuses already-purchased contacts
       ("Phone not available for purchase, ... already purchased"). The
       GET endpoint returns the inline values for "owned" contacts so we
       can recover previously-paid-for data.
    2. **Cheaper:** 1 call per property returns ALL persons + ALL their
       phones/emails. Previously we made 2 calls per person.
    3. **More complete:** PR typically has 2–3 phones and 2–3 emails per
       person; this endpoint returns them all in one shot.

    Each call charges per person record returned (typically 1–3/property)
    against the unified export-credit pool. ``"available"`` contacts that
    haven't been purchased yet may NOT come back inline — they require
    the POST unlock to actually purchase. We surface that in the result.
    """
    if not radar_ids:
        raise RefiSearchError("at least one radar_id is required")
    if not phone and not email:
        raise RefiSearchError("at least one of phone/email must be requested")

    results: list[dict] = []
    for rid in radar_ids:
        # L2 cache: cross-LO Redis (14-day TTL). Saves credits on any
        # repeated query of the same property by anyone on the team.
        cached = get_cached_contact_unlock(rid)
        if cached is not None:
            cached_copy = dict(cached)
            cached_copy["cache_hit"] = True
            results.append(cached_copy)
            continue

        item: dict = {"radar_id": rid, "phone": None, "email": None,
                      "phone_error": None, "email_error": None, "persons": [],
                      "cache_hit": False}
        try:
            resp = propertyradar.fetch_property_persons(rid)
        except propertyradar.PropertyRadarError as exc:
            item["phone_error"] = str(exc)
            item["email_error"] = str(exc)
            # Don't cache errors — they may be transient (rate limit, etc.)
            results.append(item)
            continue

        phones, emails, persons_info = _extract_persons_contacts(resp)
        if phone:
            item["phone"] = ", ".join(phones) if phones else None
            if not phones:
                item["phone_error"] = "No phone on file for any owner (or not purchased)"
        if email:
            item["email"] = ", ".join(emails) if emails else None
            if not emails:
                item["email_error"] = "No email on file for any owner (or not purchased)"
        item["persons"] = persons_info
        # Cache the successful result (including negative "no contact" results,
        # so we don't keep re-querying properties PR has nothing for).
        set_cached_contact_unlock(rid, {k: v for k, v in item.items() if k != "cache_hit"})
        results.append(item)

    return {"results": results}


def _extract_persons_contacts(resp: dict) -> tuple[list[str], list[str], list[dict]]:
    """Walk a GET /properties/{id}/persons response and pull out every
    populated phone and email across all persons on the property.

    PR's GET response uses lowercase field names inside the Phone/Email
    arrays (``value``, ``linktext``, ``status``, ``source``) — different
    from the POST unlock response's PascalCase. Handle both for safety.

    Returns (phones, emails, per-person summary).
    """
    phones: list[str] = []
    emails: list[str] = []
    persons: list[dict] = []
    for p in (resp.get("results") or []):
        if not isinstance(p, dict):
            continue
        person_phones: list[str] = []
        person_emails: list[str] = []
        for item in (p.get("Phone") or []):
            if not isinstance(item, dict):
                continue
            status = (item.get("status") or item.get("Status") or "")
            if str(status).lower() in {"bad", "disconnected", "invalid"}:
                continue
            v = item.get("linktext") or item.get("Linktext") or item.get("value") or item.get("Value")
            if v:
                person_phones.append(str(v))
        for item in (p.get("Email") or []):
            if not isinstance(item, dict):
                continue
            v = item.get("value") or item.get("Value") or item.get("linktext") or item.get("Linktext")
            if v:
                person_emails.append(str(v))
        # Dedupe per person
        person_phones = list(dict.fromkeys(person_phones))
        person_emails = list(dict.fromkeys(person_emails))
        phones.extend(person_phones)
        emails.extend(person_emails)
        name = " ".join(filter(None, [p.get("FirstName"), p.get("MiddleName"), p.get("LastName")])).strip() or p.get("EntityName")
        persons.append({
            "person_key": p.get("PersonKey"),
            "name": name,
            "role": p.get("OwnershipRole"),
            "is_primary": bool(p.get("isPrimaryContact")),
            "phones": person_phones,
            "emails": person_emails,
        })
    # Dedupe across persons (a phone may be shared between spouses).
    phones = list(dict.fromkeys(phones))
    emails = list(dict.fromkeys(emails))
    return phones, emails, persons


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def preview(*, preset_id: str | None, geography: dict, filters: dict | None) -> dict:
    """Free preview: matching count + quota remaining."""
    criteria = build_pr_criteria(preset_id=preset_id, geography=geography, filters=filters)
    data = propertyradar.preview_search(criteria)
    return {
        "totalResultCount": data.get("totalResultCount"),
        "quantityFreeRemaining": data.get("quantityFreeRemaining"),
        "criteria": criteria,
    }


def search(*, preset_id: str | None, geography: dict, filters: dict | None,
           page: int = 0, limit: int = DEFAULT_PAGE_LIMIT,
           enrich_tract: bool = True, use_cache: bool = True) -> dict:
    """Paid search: returns a page of rows enriched with tract data."""
    if limit <= 0 or limit > MAX_PAGE_LIMIT:
        raise RefiSearchError(f"limit must be 1..{MAX_PAGE_LIMIT}")
    if page < 0:
        raise RefiSearchError("page must be >= 0")

    criteria = build_pr_criteria(preset_id=preset_id, geography=geography, filters=filters)
    cache_key = _criteria_hash(criteria, page=page, limit=limit)

    if use_cache:
        cached = _read_cache(cache_key)
        if cached:
            cached["cache_hit"] = True
            return cached

    start = page * limit
    data = propertyradar.fetch_search(criteria, limit=limit, start=start,
                                      criteria_hash=cache_key)
    rows = data.get("results", []) or []
    if enrich_tract and rows:
        # Parallel enrichment — each row's ACS call is independent and
        # network-bound, so they overlap cleanly. Wall time drops from
        # ~sequential 25 × 1-2s = 30-50s to ~3-5s for a typical page.
        with ThreadPoolExecutor(max_workers=_TRACT_ENRICH_WORKERS) as pool:
            rows = list(pool.map(_enrich_row_with_tract, rows))

    payload = {
        "results": rows,
        "rows_returned": len(rows),
        "rows_available": data.get("totalResultCount"),
        "page": page,
        "limit": limit,
        "cache_hit": False,
        "criteria": criteria,
        "cache_key": cache_key,
    }
    _write_cache(cache_key, payload)
    return payload
