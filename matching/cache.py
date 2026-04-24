"""Upstash Redis caching layer for Census API calls.

Provides L2 (cross-invocation) caching for Vercel serverless functions.
All functions degrade gracefully — returns None if Redis is not configured
or if any Redis operation fails.

Key structure:
  census:geocode:{sha256(address)}     — geocode results (90-day TTL)
  census:coord:{lat}:{lng}             — coordinate geocode results (90-day TTL)
  census:acs:{state}:{county}:{tract}  — ACS demographics (30-day TTL)
"""

import hashlib
import json
import logging
import os

logger = logging.getLogger(__name__)

_redis_client = None
_redis_init_attempted = False

# Per-invocation hit/miss counters (reset each cold start)
_stats = {"geocode_hit": 0, "geocode_miss": 0, "acs_hit": 0, "acs_miss": 0, "coord_hit": 0, "coord_miss": 0}

# TTLs in seconds
GEOCODE_TTL = 90 * 24 * 60 * 60   # 90 days
ACS_TTL = 30 * 24 * 60 * 60       # 30 days
COORD_TTL = 90 * 24 * 60 * 60     # 90 days


def _get_redis():
    """Lazy-init the Upstash Redis client. Returns None if not configured."""
    global _redis_client, _redis_init_attempted
    if _redis_init_attempted:
        return _redis_client
    _redis_init_attempted = True

    url = os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        logger.warning("Upstash Redis not configured — L2 cache disabled")
        return None

    try:
        from upstash_redis import Redis
        _redis_client = Redis(url=url, token=token)
        logger.info("Redis cache connected")
    except Exception as exc:
        logger.error("Failed to connect to Redis: %s", exc)
        _redis_client = None
    return _redis_client


def _address_hash(street: str, city: str, state: str) -> str:
    """Normalize and hash an address for cache key."""
    normalized = f"{street.strip().lower()}|{city.strip().lower()}|{state.strip().upper()}"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Geocode cache (address -> FIPS)
# ---------------------------------------------------------------------------

def get_cached_geocode(street: str, city: str, state: str) -> dict | None:
    """Retrieve cached geocode result for an address."""
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = f"census:geocode:{_address_hash(street, city, state)}"
        raw = redis.get(key)
        if raw is None:
            _stats["geocode_miss"] += 1
            return None
        _stats["geocode_hit"] += 1
        logger.debug("Cache HIT geocode: %s, %s, %s", street, city, state)
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None


def set_cached_geocode(street: str, city: str, state: str, data: dict) -> None:
    """Store geocode result in Redis."""
    try:
        redis = _get_redis()
        if redis is None:
            return
        key = f"census:geocode:{_address_hash(street, city, state)}"
        redis.set(key, json.dumps(data), ex=GEOCODE_TTL)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Coordinate geocode cache (lat/lng -> FIPS)
# ---------------------------------------------------------------------------

def get_cached_coord_geocode(lat: float, lng: float) -> dict | None:
    """Retrieve cached coordinate geocode result."""
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = f"census:coord:{lat}:{lng}"
        raw = redis.get(key)
        if raw is None:
            _stats["coord_miss"] += 1
            return None
        _stats["coord_hit"] += 1
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None


def set_cached_coord_geocode(lat: float, lng: float, data: dict) -> None:
    """Store coordinate geocode result in Redis."""
    try:
        redis = _get_redis()
        if redis is None:
            return
        key = f"census:coord:{lat}:{lng}"
        redis.set(key, json.dumps(data), ex=COORD_TTL)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# ACS demographics cache
# ---------------------------------------------------------------------------

def get_cached_acs(state_fips: str, county_fips: str, tract_code: str) -> dict | None:
    """Retrieve cached ACS demographics."""
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = f"census:acs:{state_fips}:{county_fips}:{tract_code}"
        raw = redis.get(key)
        if raw is None:
            _stats["acs_miss"] += 1
            return None
        _stats["acs_hit"] += 1
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None


def set_cached_acs(state_fips: str, county_fips: str, tract_code: str, data: dict) -> None:
    """Store ACS demographics in Redis."""
    try:
        redis = _get_redis()
        if redis is None:
            return
        key = f"census:acs:{state_fips}:{county_fips}:{tract_code}"
        redis.set(key, json.dumps(data), ex=ACS_TTL)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Stats & health check
# ---------------------------------------------------------------------------

def get_cache_stats() -> dict:
    """Return cache hit/miss stats and Redis connection status."""
    redis = _get_redis()
    connected = redis is not None
    total_keys = None
    if connected:
        try:
            total_keys = redis.dbsize()
        except Exception:
            pass
    return {
        "connected": connected,
        "total_keys": total_keys,
        "invocation_stats": dict(_stats),
    }
