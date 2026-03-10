"""FCC Area API county fallback for reverse geocoding coordinates."""

from functools import lru_cache

import requests


def get_county_from_coordinates(lat: float, lon: float) -> dict | None:
    """Reverse geocode coordinates to county using FCC Area API.

    Returns dict with county_name, county_fips, state_code, state_name,
    or None on failure. Rounds to 3 decimals before lookup for cache efficiency.
    """
    return _get_county_cached(round(lat, 3), round(lon, 3))


@lru_cache(maxsize=1024)
def _get_county_cached(lat_r: float, lon_r: float) -> dict | None:
    try:
        resp = requests.get(
            "https://geo.fcc.gov/api/census/area",
            params={"lat": lat_r, "lon": lon_r, "format": "json"},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("results"):
            r = data["results"][0]
            return {
                "county_name": r.get("county_name"),
                "county_fips": r.get("county_fips"),
                "state_code": r.get("state_code"),
                "state_name": r.get("state_name"),
            }
    except (requests.RequestException, KeyError, IndexError):
        pass
    return None
