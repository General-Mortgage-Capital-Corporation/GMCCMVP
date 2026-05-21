"""Upstash Redis caching layer.

Provides L2 (cross-invocation) caching for Vercel serverless functions.
All functions degrade gracefully — returns None if Redis is not configured
or if any Redis operation fails.

Key structure:
  census:geocode:{sha256(address)}     — geocode results (90-day TTL)
  census:coord:{lat}:{lng}             — coordinate geocode results (90-day TTL)
  census:acs:{state}:{county}:{tract}  — ACS demographics (30-day TTL)
  refi:search:{criteria_hash}          — PR search results (3-day TTL)
                                         Shared across ALL LOs so a repeated
                                         query never re-charges PropertyRadar.
                                         3 days balances freshness (PR updates
                                         daily) against credit savings.
  refi:contacts:{radar_id}             — Person records + unlocked phones/emails
                                         (14-day TTL). Shared cross-LO since the
                                         Solo subscription is a single PR account.
                                         Phones/emails change rarely (public-
                                         records aggregator refresh cycle is
                                         monthly), so longer TTL is safe.
  pr:spend:records:{YYYY-MM-DD}        — PropertyRadar daily record spend
                                         (UTC date, 48-hour TTL). Backs the
                                         daily-cap guard in production.
"""

import hashlib
import json
import logging
import os

logger = logging.getLogger(__name__)

_redis_client = None
_redis_init_attempted = False

# Per-invocation hit/miss counters (reset each cold start)
_stats = {"geocode_hit": 0, "geocode_miss": 0, "acs_hit": 0, "acs_miss": 0,
          "coord_hit": 0, "coord_miss": 0, "refi_hit": 0, "refi_miss": 0,
          "contacts_hit": 0, "contacts_miss": 0}

# TTLs in seconds
GEOCODE_TTL = 90 * 24 * 60 * 60   # 90 days
ACS_TTL = 30 * 24 * 60 * 60       # 30 days
COORD_TTL = 90 * 24 * 60 * 60     # 90 days
REFI_SEARCH_TTL = 3 * 24 * 60 * 60     # 3 days — PR refreshes daily, but the
                                       # refi universe for a (zip, preset)
                                       # changes slowly; 3 days balances credit
                                       # savings vs. staleness
REFI_CONTACTS_TTL = 14 * 24 * 60 * 60  # 14 days — phones/emails change rarely
                                       # (public-records aggregator refresh
                                       # cycle is monthly)
PR_SPEND_TTL = 48 * 60 * 60            # 48 hours — covers timezone roll + buffer


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
# Refi Finder search cache (shared across all LOs)
# ---------------------------------------------------------------------------

def get_cached_refi_search(criteria_hash: str) -> dict | None:
    """Retrieve a cached refi search payload. Hits across users."""
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = f"refi:search:{criteria_hash}"
        raw = redis.get(key)
        if raw is None:
            _stats["refi_miss"] += 1
            return None
        _stats["refi_hit"] += 1
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None


def set_cached_refi_search(criteria_hash: str, payload: dict) -> None:
    """Store a refi search payload. Short TTL — PR data refreshes daily."""
    try:
        redis = _get_redis()
        if redis is None:
            return
        key = f"refi:search:{criteria_hash}"
        redis.set(key, json.dumps(payload, default=str), ex=REFI_SEARCH_TTL)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Refi Finder contact-unlock cache (cross-LO, 14-day TTL)
# ---------------------------------------------------------------------------

def get_cached_contact_unlock(radar_id: str) -> dict | None:
    """Retrieve a cached person/contact unlock payload for a property.

    Cached cross-LO so any LO benefits from any other LO's previous unlocks.
    Returns the full structured payload (persons + phone + email + errors)
    that ``refi_search.unlock_contacts`` produces per property.
    """
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = f"refi:contacts:{radar_id}"
        raw = redis.get(key)
        if raw is None:
            _stats["contacts_miss"] += 1
            return None
        _stats["contacts_hit"] += 1
        return json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None


def set_cached_contact_unlock(radar_id: str, payload: dict) -> None:
    """Store a contact-unlock payload. 14-day TTL since phone/email data
    changes rarely (PR refreshes from public records monthly)."""
    try:
        redis = _get_redis()
        if redis is None:
            return
        key = f"refi:contacts:{radar_id}"
        redis.set(key, json.dumps(payload, default=str), ex=REFI_CONTACTS_TTL)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# PropertyRadar daily-spend counter (cross-invocation, cross-LO)
# ---------------------------------------------------------------------------

def _pr_spend_key() -> str:
    """UTC date-keyed Redis key for today's PR record spend."""
    from datetime import datetime, timezone as _tz
    today = datetime.now(_tz.utc).date().isoformat()
    return f"pr:spend:records:{today}"


def increment_pr_daily_spend(records: int) -> int | None:
    """Atomically bump today's PropertyRadar record spend by ``records``.

    Returns the new total, or ``None`` if Redis is unavailable. Safe under
    concurrent writes from multiple serverless instances (uses INCRBY).
    """
    if records <= 0:
        return None
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = _pr_spend_key()
        new_total = redis.incrby(key, records)
        # Set TTL each time — cheap, and ensures the key eventually expires
        # even if we hot-loop without ever reading it.
        redis.expire(key, PR_SPEND_TTL)
        return int(new_total) if new_total is not None else None
    except Exception as exc:
        logger.warning("PR daily spend increment failed: %s", exc)
        return None


def get_pr_daily_spend() -> int | None:
    """Read today's PropertyRadar record spend total. Returns ``None`` if
    Redis is unavailable so the caller can fall back to a local source."""
    try:
        redis = _get_redis()
        if redis is None:
            return None
        key = _pr_spend_key()
        val = redis.get(key)
        if val is None:
            return 0
        return int(val)
    except Exception:
        return None


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
