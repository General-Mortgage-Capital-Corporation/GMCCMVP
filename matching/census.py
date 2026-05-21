"""Census tract lookup for property addresses.

Three-step approach:
1. Census Bureau Geocoder (address -> state, county, tract FIPS codes)
2. FFIEC tract lookup file (MSA code, income level, MFI data)
3. Census ACS 5-year API (population demographics by race/ethnicity)

Caching layers:
- L1: in-process @lru_cache (within a single invocation)
- L2: Upstash Redis (persists across Vercel serverless invocations)
"""

import json
import logging
import os
import re
from functools import lru_cache

import requests

logger = logging.getLogger(__name__)

try:
    from matching.cache import (
        get_cached_geocode,
        set_cached_geocode,
        get_cached_coord_geocode,
        set_cached_coord_geocode,
        get_cached_acs,
        set_cached_acs,
    )
except ImportError:
    # Graceful degradation if cache module fails to import
    def get_cached_geocode(*a, **kw): return None
    def set_cached_geocode(*a, **kw): pass
    def get_cached_coord_geocode(*a, **kw): return None
    def set_cached_coord_geocode(*a, **kw): pass
    def get_cached_acs(*a, **kw): return None
    def set_cached_acs(*a, **kw): pass

CENSUS_GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/address"
CENSUS_ACS_BASE = "https://api.census.gov/data/2023/acs/acs5"

# FFIEC tract data loaded from pre-processed JSON (derived from CensusTractList2026.xlsx)
_TRACT_LOOKUP: dict | None = None

LMI_LEVELS = {"low", "moderate"}


def _load_tract_lookup() -> dict:
    """Load the FFIEC tract lookup dict from JSON. Cached after first call."""
    global _TRACT_LOOKUP
    if _TRACT_LOOKUP is not None:
        return _TRACT_LOOKUP

    lookup_path = os.path.join(
        os.path.dirname(os.path.dirname(__file__)), "data", "tract_lookup.json"
    )
    if os.path.exists(lookup_path):
        with open(lookup_path) as f:
            _TRACT_LOOKUP = json.load(f)
    else:
        _TRACT_LOOKUP = {}
    return _TRACT_LOOKUP


def get_census_data(listing: dict) -> dict | None:
    """Get census data for a RentCast listing dict.

    Geocodes the address via Census Bureau, enriches with FFIEC tract data
    and ACS demographics. Returns a unified dict or None if geocoding fails.
    """
    address_line = listing.get("addressLine1", "")
    city = listing.get("city", "")
    state = listing.get("state", "")

    # Fall back to parsing formattedAddress if components missing
    if not address_line or not city or not state:
        parsed = _parse_formatted_address(listing.get("formattedAddress", ""))
        if parsed:
            address_line, city, state, _ = parsed

    # Step 1: Geocode address to get FIPS codes
    geo = None
    if address_line and state:
        geo = _geocode_address(address_line, city, state)

    # Fallback: use lat/lng coordinates if address geocoding failed
    if not geo:
        lat = listing.get("latitude")
        lng = listing.get("longitude")
        if lat and lng:
            geo = _geocode_coordinates(lat, lng)

    if not geo:
        return None

    state_fips = geo["state_fips"]
    county_fips_3 = geo["county_fips"]
    tract_code = geo["tract_code"]
    county_name = geo.get("county_name", "")

    # Build the 11-digit FIPS code for FFIEC lookup
    fips_11 = state_fips + county_fips_3 + tract_code

    result = {
        "state_code": state_fips,
        "county_code": county_fips_3,
        "county_name": county_name,
        "tract_code": tract_code,
        "msa_code": None,
        "msa_name": None,
        "state_name": state,
        "tract_income_level": None,
        "tract_minority_pct": None,
        "tract_population": None,
        "minority_population": None,
        "ffiec_mfi": None,
        "tract_mfi": None,
        "tract_to_msa_ratio": None,
        "total_population": None,
        "black_population": None,
        "asian_population": None,
        "hispanic_population": None,
    }

    # Step 2: FFIEC tract lookup for MSA code, income level, MFI
    lookup = _load_tract_lookup()
    ffiec = lookup.get(fips_11)
    if ffiec:
        result["msa_code"] = ffiec.get("msa_code")
        result["msa_name"] = ffiec.get("msa_name")
        result["ffiec_mfi"] = ffiec.get("ffiec_mfi")
        result["tract_mfi"] = ffiec.get("tract_mfi")
        result["tract_to_msa_ratio"] = ffiec.get("tract_income_pct")
        result["tract_income_level"] = ffiec.get("tract_income_level")

    # Step 3: ACS demographics
    acs = _get_acs_demographics(state_fips, county_fips_3, tract_code)
    if acs:
        result.update(acs)

    # Compute minority % using FFIEC standard: Total - White non-Hispanic
    total = result.get("total_population") or 0
    white_nh = result.get("white_nh_population") or 0
    black = result.get("black_population") or 0
    hispanic = result.get("hispanic_population") or 0
    if total > 0:
        minority = total - white_nh
        result["tract_minority_pct"] = round((minority / total) * 100, 1)
        result["minority_population"] = minority
        result["tract_population"] = total
        result["majority_aa_hp"] = (black + hispanic) / total > 0.50

    return result


@lru_cache(maxsize=1)
def _load_county_name_fips_lookup() -> dict[tuple[str, str], str]:
    """Build (state_upper, county_lower) -> 5-digit FIPS map from county_fips.json.

    Used by ``get_census_data_fast`` to derive state+county FIPS from human-
    readable strings (which is what PropertyRadar returns) WITHOUT calling
    the slow Census Bureau address geocoder.
    """
    here = os.path.dirname(__file__)
    path = os.path.join(here, "..", "data", "county_fips.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        logger.warning("could not load county_fips.json for fast tract path")
        return {}
    out: dict[tuple[str, str], str] = {}
    for fips, info in data.items():
        if not isinstance(info, dict):
            continue
        state = (info.get("state") or "").strip().upper()
        county = (info.get("county") or "").strip().lower()
        if state and county and len(fips) == 5:
            out[(state, county)] = fips
    return out


def get_census_data_fast(state: str | None, county_name: str | None,
                         tract_code: str | int | None) -> dict | None:
    """Fast tract enrichment using PropertyRadar's pre-resolved fields.

    PR returns ``State`` (2-letter), ``County`` (name), ``CensusTract``
    (6-digit) on every row — so we don't need to round-trip through the
    Census Bureau geocoder (which times out at 15s for non-trivial fractions
    of addresses). Goes straight to FFIEC tract lookup + ACS demographics
    (the ACS call is the only remaining network hop, and it's cached per
    tract for 30 days).

    Returns the same shape as ``get_census_data`` or None if any of the
    upstream pieces (county FIPS lookup, FFIEC entry) is missing.
    """
    if not state or not county_name or tract_code in (None, ""):
        return None

    state_u = str(state).strip().upper()
    county_l = str(county_name).strip().lower()
    tract_str = str(tract_code).strip().zfill(6)

    lookup = _load_county_name_fips_lookup()
    county_fips_5 = lookup.get((state_u, county_l))
    if not county_fips_5 or len(county_fips_5) != 5:
        return None

    state_fips = county_fips_5[:2]
    county_fips_3 = county_fips_5[2:]
    fips_11 = state_fips + county_fips_3 + tract_str

    result = {
        "state_code": state_fips,
        "county_code": county_fips_3,
        "county_name": county_name,
        "tract_code": tract_str,
        "msa_code": None,
        "msa_name": None,
        "state_name": state_u,
        "tract_income_level": None,
        "tract_minority_pct": None,
        "tract_population": None,
        "minority_population": None,
        "ffiec_mfi": None,
        "tract_mfi": None,
        "tract_to_msa_ratio": None,
        "total_population": None,
    }

    ffiec = _load_tract_lookup().get(fips_11)
    if ffiec:
        result["msa_code"] = ffiec.get("msa_code")
        result["msa_name"] = ffiec.get("msa_name")
        result["ffiec_mfi"] = ffiec.get("ffiec_mfi")
        result["tract_mfi"] = ffiec.get("tract_mfi")
        result["tract_to_msa_ratio"] = ffiec.get("tract_income_pct")
        result["tract_income_level"] = ffiec.get("tract_income_level")

    # ACS demographics intentionally skipped. The Census Bureau ACS API
    # has been chronically flaky (HTML error pages, timeouts) and the only
    # field we got from it was tract_minority_pct. Dropping it makes refi
    # enrichment near-instant (just an in-memory FFIEC lookup) at the cost
    # of leaving tract_minority_pct as None. Tract income level + MSA from
    # FFIEC are the load-bearing fields anyway.
    return result


def is_lmi_tract(tract_income_level: str | None) -> bool:
    """Return True if the tract income level is Low or Moderate."""
    if not tract_income_level:
        return False
    return tract_income_level.strip().lower() in LMI_LEVELS


# ---------------------------------------------------------------------------
# Census Bureau Geocoder
# ---------------------------------------------------------------------------

def _geocode_address(street: str, city: str, state: str) -> dict | None:
    """Geocode an address using the Census Bureau Geocoder.

    Returns dict with state_fips, county_fips, tract_code, county_name
    or None if geocoding fails.
    """
    # L2 cache: check Redis first
    try:
        cached = get_cached_geocode(street, city, state)
        if cached is not None:
            return cached
    except Exception as exc:
        logger.debug("Cache read failed (geocode): %s", exc)

    try:
        resp = requests.get(
            CENSUS_GEOCODER,
            params={
                "street": street,
                "city": city,
                "state": state,
                "benchmark": "Public_AR_Current",
                "vintage": "Current_Current",
                "format": "json",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        matches = data.get("result", {}).get("addressMatches", [])
        if not matches:
            return None

        geo = matches[0].get("geographies", {})

        tracts = geo.get("Census Tracts", [])
        tract_info = tracts[0] if tracts else {}

        counties = geo.get("Counties", [])
        county_info = counties[0] if counties else {}

        state_fips = tract_info.get("STATE", "")
        county_code = tract_info.get("COUNTY", "")
        tract_code = tract_info.get("TRACT", "")

        if not state_fips or not county_code or not tract_code:
            return None

        result = {
            "state_fips": state_fips.zfill(2),
            "county_fips": county_code.zfill(3),
            "tract_code": tract_code,
            "county_name": county_info.get("BASENAME", ""),
        }

        # L2 cache: store in Redis
        try:
            set_cached_geocode(street, city, state, result)
        except Exception as exc:
            logger.debug("Cache write failed (geocode): %s", exc)

        return result
    except (requests.RequestException, json.JSONDecodeError, KeyError) as exc:
        logger.warning("Address geocode failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Census Bureau Coordinate Geocoder (fallback)
# ---------------------------------------------------------------------------

CENSUS_COORD_GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"


@lru_cache(maxsize=256)
def _geocode_coordinates(lat: float, lng: float) -> dict | None:
    """Geocode lat/lng via Census Bureau coordinate geocoder.

    Fallback when address geocoding fails. Returns same dict shape as
    _geocode_address or None.
    L1 cache: @lru_cache (in-process, single invocation)
    L2 cache: Upstash Redis (cross-invocation on Vercel)
    """
    # L2 cache: check Redis first
    try:
        cached = get_cached_coord_geocode(lat, lng)
        if cached is not None:
            return cached
    except Exception as exc:
        logger.debug("Cache read failed (coord geocode): %s", exc)

    try:
        resp = requests.get(
            CENSUS_COORD_GEOCODER,
            params={
                "x": lng,
                "y": lat,
                "benchmark": "Public_AR_Current",
                "vintage": "Current_Current",
                "format": "json",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            return None

        data = resp.json()
        geo = data.get("result", {}).get("geographies", {})

        tracts = geo.get("Census Tracts", [])
        tract_info = tracts[0] if tracts else {}

        counties = geo.get("Counties", [])
        county_info = counties[0] if counties else {}

        state_fips = tract_info.get("STATE", "")
        county_code = tract_info.get("COUNTY", "")
        tract_code = tract_info.get("TRACT", "")

        if not state_fips or not county_code or not tract_code:
            return None

        result = {
            "state_fips": state_fips.zfill(2),
            "county_fips": county_code.zfill(3),
            "tract_code": tract_code,
            "county_name": county_info.get("BASENAME", ""),
        }

        # L2 cache: store in Redis
        try:
            set_cached_coord_geocode(lat, lng, result)
        except Exception as exc:
            logger.debug("Cache write failed (coord geocode): %s", exc)

        return result
    except (requests.RequestException, json.JSONDecodeError, KeyError) as exc:
        logger.warning("Coordinate geocode failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Census ACS 5-Year API (demographics only)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=256)
def _get_acs_demographics(
    state_fips: str, county_fips: str, tract_code: str
) -> dict | None:
    """Fetch race/ethnicity population from Census ACS 5-year.

    Variables:
    - B03002_001E: Total population
    - B03002_003E: White alone, not Hispanic or Latino
    - B03002_004E: Black/African American alone (non-Hispanic)
    - B03002_006E: Asian alone (non-Hispanic)
    - B03002_012E: Hispanic or Latino

    L1 cache: @lru_cache (in-process, single invocation)
    L2 cache: Upstash Redis (cross-invocation on Vercel)
    """
    # L2 cache: check Redis first
    try:
        cached = get_cached_acs(state_fips, county_fips, tract_code)
        if cached is not None:
            return cached
    except Exception as exc:
        logger.debug("Cache read failed (ACS): %s", exc)

    # The Census ACS API occasionally returns HTML error pages or 5xx — retry
    # with a short backoff before giving up. We don't want to spam: 2 retries
    # max, brief sleep between.
    import time
    params = {
        "get": "B03002_001E,B03002_003E,B03002_004E,B03002_006E,B03002_012E",
        "for": f"tract:{tract_code}",
        "in": f"state:{state_fips} county:{county_fips}",
    }
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            resp = requests.get(CENSUS_ACS_BASE, params=params, timeout=10)
            if resp.status_code != 200:
                last_err = Exception(f"HTTP {resp.status_code}")
                time.sleep(0.3 * (attempt + 1))
                continue
            # Census occasionally returns HTML when overloaded — guard against it.
            ct = resp.headers.get("content-type", "")
            if "json" not in ct and not resp.text.lstrip().startswith("["):
                last_err = Exception("non-JSON response (likely transient ACS outage)")
                time.sleep(0.3 * (attempt + 1))
                continue
            rows = resp.json()
            if len(rows) >= 2:
                headers = rows[0]
                values = rows[1]
                row = dict(zip(headers, values))
                total = _to_int(row.get("B03002_001E"))
                white_nh = _to_int(row.get("B03002_003E"))
                result = {
                    "total_population": total,
                    "white_nh_population": white_nh,
                    "black_population": _to_int(row.get("B03002_004E")),
                    "asian_population": _to_int(row.get("B03002_006E")),
                    "hispanic_population": _to_int(row.get("B03002_012E")),
                }
                try:
                    set_cached_acs(state_fips, county_fips, tract_code, result)
                except Exception as exc:
                    logger.debug("Cache write failed (ACS): %s", exc)
                return result
            # Successful response but no data — don't retry, just give up.
            return None
        except (requests.RequestException, json.JSONDecodeError, KeyError) as exc:
            last_err = exc
            time.sleep(0.3 * (attempt + 1))
    if last_err is not None:
        logger.warning("ACS demographics fetch failed after retries: %s", last_err)
    return None


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _parse_formatted_address(addr: str) -> tuple | None:
    """Parse '1610 Long St, Santa Clara, CA 95050' into components."""
    if not addr:
        return None
    m = re.match(
        r"^(.+?),\s*(.+?),\s*([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$", addr.strip()
    )
    if m:
        return m.group(1).strip(), m.group(2).strip(), m.group(3).strip(), (m.group(4) or "").strip()
    return None


def _to_int(val) -> int | None:
    try:
        n = int(str(val).replace(",", "").replace("$", "").strip())
        # Census ACS uses -666666666 as sentinel for "data not available"
        if n < 0:
            return None
        return n
    except (TypeError, ValueError):
        return None
