"""PropertyRadar API client for the Refi Finder feature.

Wraps the subset of PropertyRadar's v1 API we use for mortgage / refi
prospecting. Critical cost model: every returned record counts against the
account's monthly export quota (Solo=10K, Team=25K, Business=50K). Previews
(Purchase=0) and RadarID-only fetches are free.

Safety rails:
- Every paid call MUST pass through ``fetch_search`` / ``get_property`` /
  ``get_transactions`` / ``get_documents``, which append to
  ``data/pr_quota_log.jsonl`` so spend is auditable.
- A daily record cap (env: ``PROPERTY_RADAR_DAILY_RECORD_CAP``, default 500)
  prevents a runaway loop from wiping the monthly quota.
- ``preview_search`` is the only way to learn ``totalResultCount`` and
  ``quantityFreeRemaining`` without spending; the UI should always preview
  before fetching.
"""

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://api.propertyradar.com/v1"
DEFAULT_TIMEOUT_S = 60

# Fieldsets PropertyRadar exposes. Don't use named fieldsets for the refi
# grid — they're inconsistent (e.g. ``All`` is NOT a superset of
# ``LimitedREI``; the named sets carry different fields and combining them
# can blow the API's 50-field cap). Instead, request the curated list
# below: every field the v1 refi grid + drill-in + tract enrichment needs.
FIELDSET_LIMITED_REI = "LimitedREI"  # kept for ad-hoc spikes
FIELDSET_ALL = "All"                 # do not rely on — drops loan + owner fields

REFI_GRID_FIELDS: list[str] = [
    "RadarID",
    # Location / IDs
    "Address", "City", "State", "ZipFive", "County", "APN",
    "Latitude", "Longitude", "CensusTract",
    # Owner / occupancy
    "Owner", "OwnerFirstName", "OwnerLastName", "OwnershipType",
    "isSameMailingOrExempt",
    # People — needed for contact unlock. Each row's Persons array carries
    # PersonKey values we POST to /persons/{PersonKey}/Phone (or /Email).
    "Persons",
    # Property characteristics
    "PType", "AdvancedPropertyType",
    "Beds", "Baths", "SqFt", "YearBuilt", "Units",
    # Valuation
    "AVM", "AVMAsOf", "AVMReliability", "AssessedValue",
    # Equity / open loans
    "AvailableEquity", "EquityPercent", "CLTV", "TotalLoanBalance",
    "NumberLoans", "isFreeAndClear", "isHighEquity", "isUnderwater",
    # First mortgage (the refi target loan)
    "FirstAmount", "FirstDate", "FirstPurpose", "FirstLoanType",
    "FirstRateType", "FirstRate", "FirstTermInYears", "FirstLenderOriginal",
    # Second mortgage (when present)
    "SecondAmount", "SecondLenderOriginal",
    # Last sale (for "recent purchase" preset)
    "LastTransferRecDate", "LastTransferValue", "LastTransferType",
    # Misc
    "AnnualTaxes",
]
REFI_GRID_FIELDS_PARAM = ",".join(REFI_GRID_FIELDS)

QUOTA_LOG_PATH = Path(__file__).resolve().parents[1] / "data" / "pr_quota_log.jsonl"


class PropertyRadarError(Exception):
    """Raised when the PropertyRadar API returns an error response."""

    def __init__(self, message: str, status_code: int | None = None, event_id: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.event_id = event_id


class QuotaCapExceeded(PropertyRadarError):
    """Raised when a fetch would push today's record spend over the configured cap."""


def _token() -> str:
    token = os.getenv("PROPERTY_RADAR_API_ACCESS_TOKEN", "").strip()
    if not token:
        raise PropertyRadarError("PROPERTY_RADAR_API_ACCESS_TOKEN is not set")
    return token


def _daily_cap() -> int:
    raw = os.getenv("PROPERTY_RADAR_DAILY_RECORD_CAP", "500")
    try:
        return max(0, int(raw))
    except ValueError:
        return 500


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _request(method: str, path: str, *, params: dict | None = None, body: dict | list | None = None) -> dict:
    url = f"{BASE_URL}{path}"
    started = time.monotonic()
    try:
        resp = requests.request(
            method,
            url,
            headers=_headers(),
            params=params or {},
            json=body if body is not None else None,
            timeout=DEFAULT_TIMEOUT_S,
        )
    except requests.RequestException as exc:
        raise PropertyRadarError(f"network error calling {path}: {exc}") from exc

    elapsed_ms = int((time.monotonic() - started) * 1000)
    logger.debug("PR %s %s -> %s in %dms", method, path, resp.status_code, elapsed_ms)

    try:
        data = resp.json()
    except ValueError:
        raise PropertyRadarError(
            f"non-JSON response from {path} (status={resp.status_code}): {resp.text[:200]}",
            status_code=resp.status_code,
        )

    if resp.status_code >= 400 or (isinstance(data, dict) and "error" in data):
        err_msg = data.get("error") if isinstance(data, dict) else str(data)
        event_id = data.get("eventid") if isinstance(data, dict) else None
        raise PropertyRadarError(
            f"PropertyRadar API error on {path}: {err_msg}",
            status_code=resp.status_code,
            event_id=event_id,
        )

    return data


def _today_spend() -> int:
    """Sum of paid records pulled today (UTC) from the quota log."""
    if not QUOTA_LOG_PATH.exists():
        return 0
    today = datetime.now(timezone.utc).date().isoformat()
    total = 0
    try:
        with QUOTA_LOG_PATH.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("date") == today and entry.get("purchase") == 1:
                    total += int(entry.get("records", 0))
    except OSError:
        return 0
    return total


def _log_quota(*, endpoint: str, purchase: int, records: int, total_cost: float | int | str | None,
               criteria_hash: str | None = None, extra: dict | None = None) -> None:
    """Append a paid-call record to the local audit log.

    Best-effort only — Vercel's ``/var/task`` is read-only so the mkdir/write
    will fail there. That's fine; the log is for local development and
    auditing. Production observability should live in Vercel/PostHog logs.
    """
    now = datetime.now(timezone.utc)
    entry = {
        "ts": now.isoformat(),
        "date": now.date().isoformat(),
        "endpoint": endpoint,
        "purchase": purchase,
        "records": records,
        "total_cost": total_cost,
    }
    if criteria_hash:
        entry["criteria_hash"] = criteria_hash
    if extra:
        entry["extra"] = extra
    try:
        QUOTA_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with QUOTA_LOG_PATH.open("a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as exc:
        logger.debug("quota log write skipped: %s", exc)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def preview_search(criteria: list[dict], *, fields: str = REFI_GRID_FIELDS_PARAM) -> dict:
    """Free preview of how many properties match and how much fetching would cost.

    Returns the raw PropertyRadar response dict, which contains:
    - ``totalResultCount``: matching property count
    - ``quantityFreeRemaining``: records left in the monthly quota
    - ``totalCost``: 0 on a preview
    """
    params = {"Fields": fields, "Limit": 1, "Start": 0, "Purchase": 0}
    body = {"Criteria": criteria}
    data = _request("POST", "/properties", params=params, body=body)
    _log_quota(endpoint="/properties (preview)", purchase=0, records=0,
               total_cost=data.get("totalCost"),
               extra={"totalResultCount": data.get("totalResultCount"),
                      "quantityFreeRemaining": data.get("quantityFreeRemaining")})
    return data


def fetch_search(criteria: list[dict], *, fields: str = REFI_GRID_FIELDS_PARAM,
                 limit: int = 50, start: int = 0, sort: str | None = None,
                 criteria_hash: str | None = None) -> dict:
    """Paid search. Each row in ``results`` counts against the monthly quota.

    Guards against runaway spend with the daily cap.
    """
    cap = _daily_cap()
    if cap > 0:
        spent = _today_spend()
        if spent + limit > cap:
            raise QuotaCapExceeded(
                f"daily cap {cap} would be exceeded: spent {spent} + requested {limit}"
            )

    params: dict[str, Any] = {"Fields": fields, "Limit": limit, "Start": start, "Purchase": 1}
    if sort:
        params["Sort"] = sort
    body = {"Criteria": criteria}
    data = _request("POST", "/properties", params=params, body=body)
    records = len(data.get("results", []))
    _log_quota(endpoint="/properties (fetch)", purchase=1, records=records,
               total_cost=data.get("totalCost"), criteria_hash=criteria_hash,
               extra={"totalResultCount": data.get("totalResultCount")})
    return data


def get_property(radar_id: str, *, fields: str = REFI_GRID_FIELDS_PARAM, purchase: int = 1) -> dict:
    """Fetch a single property by RadarID. Pass ``purchase=0`` for a free preview
    (returns shape without billing) when ``fields=RadarID``."""
    if purchase == 1:
        cap = _daily_cap()
        if cap > 0 and _today_spend() + 1 > cap:
            raise QuotaCapExceeded(f"daily cap {cap} reached")
    params = {"Fields": fields, "Purchase": purchase}
    data = _request("GET", f"/properties/{radar_id}", params=params)
    _log_quota(endpoint=f"/properties/{{radar_id}}", purchase=purchase,
               records=1 if purchase == 1 else 0, total_cost=data.get("totalCost"))
    return data


def get_transactions(radar_id: str, *, purchase: int = 1) -> dict:
    """Full deed/loan transaction history for a property (paid per record)."""
    if purchase == 1:
        cap = _daily_cap()
        if cap > 0 and _today_spend() + 1 > cap:
            raise QuotaCapExceeded(f"daily cap {cap} reached")
    params = {"Purchase": purchase}
    data = _request("GET", f"/properties/{radar_id}/transactions", params=params)
    records = len(data.get("results", [])) if isinstance(data, dict) else 0
    _log_quota(endpoint=f"/properties/{{radar_id}}/transactions", purchase=purchase,
               records=records if purchase == 1 else 0, total_cost=data.get("totalCost"))
    return data


def get_document(document_id: str, *, purchase: int = 1) -> dict:
    """Per-document detail (rate, ARM terms, lender) for a recorded deed/loan."""
    if purchase == 1:
        cap = _daily_cap()
        if cap > 0 and _today_spend() + 1 > cap:
            raise QuotaCapExceeded(f"daily cap {cap} reached")
    params = {"Purchase": purchase}
    data = _request("GET", f"/documents/{document_id}", params=params)
    _log_quota(endpoint="/documents/{id}", purchase=purchase,
               records=1 if purchase == 1 else 0, total_cost=data.get("totalCost"))
    return data


def unlock_phone(person_key: str, *, purchase: int = 1) -> dict:
    """Unlock the primary phone for a person. SEPARATE PAID ACTION from the
    record export quota — counts against the account's phone-unlock budget.
    Pass ``purchase=0`` to preview cost without charging."""
    params = {"Purchase": purchase}
    data = _request("POST", f"/persons/{person_key}/Phone", params=params, body={})
    _log_quota(endpoint="/persons/{key}/Phone", purchase=purchase,
               records=1 if purchase == 1 else 0, total_cost=data.get("totalCost"),
               extra={"person_key": person_key})
    return data


def unlock_email(person_key: str, *, purchase: int = 1) -> dict:
    """Unlock the primary email for a person. SEPARATE PAID ACTION."""
    params = {"Purchase": purchase}
    data = _request("POST", f"/persons/{person_key}/Email", params=params, body={})
    _log_quota(endpoint="/persons/{key}/Email", purchase=purchase,
               records=1 if purchase == 1 else 0, total_cost=data.get("totalCost"),
               extra={"person_key": person_key})
    return data


def get_quota_remaining() -> int | None:
    """Lightweight quota check via a 1-result preview against a tiny criterion.

    Returns ``quantityFreeRemaining`` or ``None`` if the field is missing.
    """
    data = preview_search([{"name": "ZipFive", "value": [10001]}], fields=FIELDSET_LIMITED_REI)
    val = data.get("quantityFreeRemaining")
    return int(val) if val is not None else None


def get_today_spend() -> int:
    return _today_spend()


def get_daily_cap() -> int:
    return _daily_cap()
