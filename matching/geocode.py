"""FCC Area API county fallback for reverse geocoding coordinates."""

from functools import lru_cache

import requests


@lru_cache(maxsize=1024)
def get_county_from_coordinates(lat: float, lon: float) -> dict | None:
    """Reverse geocode coordinates to county using FCC Area API.

    Returns dict with county_name, county_fips, state_code, state_name,
    or None on failure. Results are cached by (lat, lon) rounded to 3 decimals.
    """
    lat_r = round(lat, 3)
    lon_r = round(lon, 3)
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
