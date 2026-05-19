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

from matching import propertyradar
from matching.cache import get_cached_refi_search, set_cached_refi_search
from matching.census import get_census_data
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

    # Free-and-clear and other open-loan flags
    if filters.get("is_free_and_clear") is True:
        add("isFreeAndClear", [1])
    elif filters.get("is_free_and_clear") is False:
        add("isFreeAndClear", [0])

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

    # ARM reset window
    add("FirstARMResetDate", _arm_reset_window_value(filters.get("first_arm_reset_within_months")))

    # Lender targeting
    if filters.get("first_lender_original"):
        add("FirstLenderOriginal", list(filters["first_lender_original"]))

    # Distress / flag exclusions kept off by default — LOs typically want
    # non-distressed properties for refi outreach. Surface as opt-in.
    if filters.get("exclude_distressed"):
        add("inForeclosure", [0])
        add("isBankOwned", [0])
        add("inBankruptcyProperty", [0])

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
    """Two-tier write: Redis (with TTL) + local file (best-effort fallback)."""
    # L2: shared Redis (no-op if not configured)
    set_cached_refi_search(key, data)

    # L1: local file
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"_cached_at": datetime.now(timezone.utc).isoformat(), "data": data}
    try:
        _cache_path(key).write_text(json.dumps(payload, default=str))
    except OSError as exc:
        logger.warning("refi local cache write failed: %s", exc)


# ---------------------------------------------------------------------------
# Tract enrichment
# ---------------------------------------------------------------------------


def _enrich_row_with_tract(row: dict) -> dict:
    """Add ``census`` block to a PR row using the existing census pipeline.

    Adapts the PR field names to the RentCast-shaped dict that
    ``get_census_data`` expects.
    """
    if not isinstance(row, dict):
        return row
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
        logger.exception("tract enrichment failed for RadarID=%s", row.get("RadarID"))
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


# ---------------------------------------------------------------------------
# Contact unlock (phone + email per person)
# ---------------------------------------------------------------------------


def unlock_contacts(person_keys: list[str], *, phone: bool = True, email: bool = True) -> dict:
    """Unlock phone and/or email for a list of PersonKeys.

    Each unlock is a SEPARATE paid action on PropertyRadar (separate from the
    record export quota). Returns per-person results so the UI can show what
    was unlocked vs. what failed.
    """
    if not person_keys:
        raise RefiSearchError("at least one person_key is required")
    if not phone and not email:
        raise RefiSearchError("at least one of phone/email must be requested")

    results: list[dict] = []
    for pk in person_keys:
        item: dict = {"person_key": pk, "phone": None, "email": None,
                      "phone_error": None, "email_error": None}
        if phone:
            try:
                pr = propertyradar.unlock_phone(pk)
                item["phone"] = _extract_phone(pr)
            except propertyradar.PropertyRadarError as exc:
                item["phone_error"] = str(exc)
        if email:
            try:
                er = propertyradar.unlock_email(pk)
                item["email"] = _extract_email(er)
            except propertyradar.PropertyRadarError as exc:
                item["email_error"] = str(exc)
        results.append(item)

    return {"results": results}


def _extract_phone(resp: dict) -> str | None:
    """Pull the unlocked phone string out of PropertyRadar's response shape."""
    # PR returns the unlocked value under "results" or "Phone"; field name
    # varies across response variants. Try common shapes.
    if isinstance(resp.get("results"), list) and resp["results"]:
        r0 = resp["results"][0]
        if isinstance(r0, dict):
            return r0.get("Phone") or r0.get("PrimaryPhone1") or r0.get("phone")
    return resp.get("Phone") or resp.get("PrimaryPhone1") or resp.get("phone")


def _extract_email(resp: dict) -> str | None:
    if isinstance(resp.get("results"), list) and resp["results"]:
        r0 = resp["results"][0]
        if isinstance(r0, dict):
            return r0.get("Email") or r0.get("PrimaryEmail1") or r0.get("email")
    return resp.get("Email") or resp.get("PrimaryEmail1") or resp.get("email")


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
    if enrich_tract:
        rows = [_enrich_row_with_tract(r) for r in rows]

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
