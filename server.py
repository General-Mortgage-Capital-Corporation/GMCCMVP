"""
GMCC Matching Microservice

Pure Python matching/census service — no external API keys required.
All RentCast and Google Places calls are handled by the Next.js API layer.

Routes:
  GET  /api/health              Health check
  GET  /api/programs            List available GMCC programs
  POST /api/match               Match a single listing
  POST /api/match-batch         Match up to 50 listings in parallel
  POST /api/program-rules       Return raw program JSON for given names
  POST /api/explain             Generate LLM explanation for a match
  GET  /api/program-locations   Program → state → county hierarchy
  GET  /api/county-info         Resolve a 5-digit FIPS to lat/lng/state
"""

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

logger = logging.getLogger(__name__)

from matching.models import ListingInput
from matching.matcher import match_listing, load_programs, SECONDARY_PROGRAM_NAMES
from matching.census import get_census_data
from matching.explain import explain_match
from rag.config import PROGRAMS_DIR

load_dotenv()

app = Flask(__name__)
CORS(app, origins=[
    r"^https://gmccmvp-two(-.+)?\.vercel\.app$",
    r"^http://localhost:3000$",
    *([os.environ["FRONTEND_ORIGIN"]] if os.environ.get("FRONTEND_ORIGIN") else []),
])

# ---------------------------------------------------------------------------
# Data helpers (loaded once at startup)
# ---------------------------------------------------------------------------

import threading

_CACHE_LOCK = threading.Lock()
_COUNTY_FIPS_DATA: dict | None = None
_MSA_LOOKUP: dict | None = None
_RAW_PROGRAM_RULES: dict[str, dict] | None = None


def _load_raw_program_rules() -> dict[str, dict]:
    """Load all program JSONs as raw dicts, keyed by program_name. Cached."""
    global _RAW_PROGRAM_RULES
    with _CACHE_LOCK:
        if _RAW_PROGRAM_RULES is not None:
            return _RAW_PROGRAM_RULES
        _RAW_PROGRAM_RULES = {}
        for fname in sorted(os.listdir(PROGRAMS_DIR)):
            if fname.endswith(".json"):
                with open(os.path.join(PROGRAMS_DIR, fname)) as f:
                    data = json.load(f)
                name = data.get("program_name", "")
                if name:
                    _RAW_PROGRAM_RULES[name] = data
        return _RAW_PROGRAM_RULES


def _load_county_fips() -> dict:
    global _COUNTY_FIPS_DATA
    with _CACHE_LOCK:
        if _COUNTY_FIPS_DATA is not None:
            return _COUNTY_FIPS_DATA
        path = os.path.join(os.path.dirname(__file__), "data", "county_fips.json")
        with open(path) as f:
            _COUNTY_FIPS_DATA = json.load(f)
        return _COUNTY_FIPS_DATA


def _load_msa_lookup() -> dict:
    global _MSA_LOOKUP
    with _CACHE_LOCK:
        if _MSA_LOOKUP is not None:
            return _MSA_LOOKUP
        path = os.path.join(os.path.dirname(__file__), "data", "msa_lookup.json")
        if os.path.exists(path):
            with open(path) as f:
                _MSA_LOOKUP = json.load(f)
        else:
            _MSA_LOOKUP = {}
        return _MSA_LOOKUP


_TRACT_COUNTIES_CACHE: dict[str, set[str]] = {}


def _get_tract_counties(tract_file: str) -> set[str]:
    """Derive unique 5-digit county FIPS from an 11-digit tract FIPS file."""
    if tract_file in _TRACT_COUNTIES_CACHE:
        return _TRACT_COUNTIES_CACHE[tract_file]
    basename = os.path.basename(tract_file)
    if basename != tract_file or ".." in tract_file:
        _TRACT_COUNTIES_CACHE[tract_file] = set()
        return set()
    path = os.path.join(os.path.dirname(__file__), "data", basename)
    counties: set[str] = set()
    if os.path.exists(path):
        with open(path) as f:
            tracts = json.load(f)
        for t in tracts:
            counties.add(t[:5])
    _TRACT_COUNTIES_CACHE[tract_file] = counties
    return counties


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/api/health", methods=["GET"])
def health_check():
    return jsonify({"status": "healthy"})


@app.route("/api/cache-stats", methods=["GET"])
def cache_stats():
    try:
        from matching.cache import get_cache_stats
        return jsonify(get_cache_stats())
    except Exception as exc:
        return jsonify({"connected": False, "error": str(exc)})


@app.route("/api/programs", methods=["GET"])
def list_programs():
    programs = load_programs()
    return jsonify({"programs": [p.program_name for p in programs if p.program_name not in SECONDARY_PROGRAM_NAMES]})


@app.route("/api/match", methods=["POST"])
def match_listing_endpoint():
    """Match a single listing against all GMCC programs."""
    try:
        listing_data = request.get_json(silent=True)
        if not listing_data:
            return jsonify({"success": False, "error": "Request body must be a non-empty JSON object."}), 400

        census_data = get_census_data(listing_data)
        listing = ListingInput.from_rentcast(listing_data, census_data)
        results = match_listing(listing)
        eligible_count = sum(1 for r in results if r.status.value != "Ineligible")

        return jsonify({
            "success": True,
            "programs": [r.model_dump() for r in results],
            "eligible_count": eligible_count,
            "census_data": census_data,
        })
    except Exception:
        logger.exception("Single match failed")
        return jsonify({"success": False, "error": "Matching error. Please try again."}), 500


@app.route("/api/match-batch", methods=["POST"])
def match_batch_endpoint():
    """Match up to 50 listings in parallel.

    Deduplicates census lookups: listings sharing the same address (or lat/lng)
    share a single get_census_data() call, eliminating ~80% of redundant
    Census API calls within a batch.
    """
    try:
        listings = request.get_json(silent=True)
        if not listings or not isinstance(listings, list):
            return jsonify({"success": False, "error": "Expected JSON array of listings."}), 400

        MAX_BATCH_SIZE = 50
        if len(listings) > MAX_BATCH_SIZE:
            return jsonify({"success": False, "error": f"Batch size exceeds limit of {MAX_BATCH_SIZE}."}), 400

        # --- Dedup: group listings by address key ---
        def _dedup_key(idx, ld):
            """Build a dedup key from address components or lat/lng."""
            addr = ld.get("addressLine1", "").strip().lower()
            city = ld.get("city", "").strip().lower()
            state = ld.get("state", "").strip().upper()
            if addr and city and state:
                return f"addr:{addr}|{city}|{state}"
            lat = ld.get("latitude")
            lng = ld.get("longitude")
            if lat is not None and lng is not None:
                return f"coord:{lat}|{lng}"
            # No usable dedup key — each gets its own census call
            return f"idx:{idx}"

        # Map each listing index to its dedup key
        listing_keys = [_dedup_key(i, ld) for i, ld in enumerate(listings)]

        # Collect unique keys and a representative listing for each
        unique_census: dict[str, dict] = {}  # key -> representative listing_data
        for i, key in enumerate(listing_keys):
            if key not in unique_census:
                unique_census[key] = listings[i]

        # --- Phase 1: fetch census data for unique addresses in parallel ---
        census_cache: dict[str, dict | None] = {}

        def _fetch_census(key, listing_data):
            return key, get_census_data(listing_data)

        max_workers = min(len(unique_census), 16)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            census_futures = {
                pool.submit(_fetch_census, key, ld): key
                for key, ld in unique_census.items()
            }
            for future in as_completed(census_futures):
                try:
                    key, census_data = future.result()
                    census_cache[key] = census_data
                except Exception:
                    key = census_futures[future]
                    census_cache[key] = None

        # --- Phase 2: match all listings using cached census data ---
        def _process_one(listing_data, census_data):
            listing = ListingInput.from_rentcast(listing_data, census_data)
            match_results = match_listing(listing)
            return {
                "programs": [r.model_dump() for r in match_results],
                "census_data": census_data,
            }

        errors = 0
        max_workers = min(len(listings), 16)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {}
            for i, ld in enumerate(listings):
                key = listing_keys[i]
                cd = census_cache.get(key)
                futures[pool.submit(_process_one, ld, cd)] = i

            results = [None] * len(listings)
            for future in as_completed(futures):
                idx = futures[future]
                try:
                    results[idx] = future.result()
                except Exception as exc:
                    errors += 1
                    results[idx] = {"error": str(exc), "programs": [], "census_data": None}

        return jsonify({"success": errors == 0, "results": results,
                         **({"errors": errors} if errors else {})})
    except Exception:
        logger.exception("Batch match failed")
        return jsonify({"success": False, "error": "Batch matching error. Please try again."}), 500


@app.route("/api/program-rules", methods=["POST"])
def program_rules_endpoint():
    """Return raw program JSON rules for the given program names."""
    try:
        body = request.get_json(silent=True)
        if not body or not isinstance(body.get("programs"), list):
            return jsonify({"success": False, "error": "programs array is required."}), 400

        requested = set(body["programs"])
        all_rules = _load_raw_program_rules()
        result = {name: rules for name, rules in all_rules.items() if name in requested}

        return jsonify({"success": True, "rules": result})
    except Exception:
        logger.exception("Program rules load failed")
        return jsonify({"success": False, "error": "Failed to load program rules."}), 500


@app.route("/api/explain", methods=["POST"])
def explain_endpoint():
    """Generate an LLM explanation for a program match."""
    try:
        body = request.get_json(silent=True)
        if not body:
            return jsonify({"success": False, "error": "Request body required."}), 400

        program_name = body.get("program_name")
        listing = body.get("listing")
        tier_name = body.get("tier_name", "")

        if not program_name or not listing:
            return jsonify({"success": False, "error": "program_name and listing are required."}), 400

        program_rules = _load_raw_program_rules().get(program_name)

        explanation = explain_match(program_name, listing, tier_name, program_rules)
        return jsonify({"success": True, "explanation": explanation})
    except Exception:
        logger.exception("Explain generation failed")
        return jsonify({"success": False, "error": "Failed to generate explanation."}), 500


@app.route("/api/program-locations", methods=["GET"])
def program_locations():
    """Return program → state → county hierarchy for the program search tab."""
    county_data = _load_county_fips()
    msa_lookup = _load_msa_lookup()
    programs = load_programs()

    # Build state → [fips] index for resolving eligible_states
    state_to_fips: dict[str, list[str]] = {}
    for fips, info in county_data.items():
        st = info["state"]
        if st not in state_to_fips:
            state_to_fips[st] = []
        state_to_fips[st].append(fips)

    result = []
    for program in programs:
        if program.program_name in SECONDARY_PROGRAM_NAMES:
            continue
        all_fips: set[str] = set()
        has_any_location_restriction = False
        for tier in program.tiers:
            tier_has_location = False
            if tier.eligible_county_fips:
                all_fips.update(tier.eligible_county_fips)
                tier_has_location = True
            for msa_code in (tier.eligible_msa_codes or []):
                msa_info = msa_lookup.get(msa_code)
                if msa_info:
                    all_fips.update(msa_info["counties"])
                    tier_has_location = True
            if tier.eligible_tract_fips_file:
                all_fips.update(_get_tract_counties(tier.eligible_tract_fips_file))
                tier_has_location = True
            # Include all counties for states listed in eligible_states
            if tier.eligible_states:
                for st in tier.eligible_states:
                    all_fips.update(state_to_fips.get(st, []))
                tier_has_location = True
            if tier_has_location:
                has_any_location_restriction = True

        # Nationwide programs (no location restrictions) — show all states
        if not has_any_location_restriction:
            all_fips = set(county_data.keys())

        states_map: dict[str, list] = {}
        for fips in sorted(all_fips):
            info = county_data.get(fips)
            if not info:
                continue
            state = info["state"]
            if state not in states_map:
                states_map[state] = []
            states_map[state].append({
                "fips": fips,
                "county": info["county"],
                "cities": info.get("cities", []),
            })

        result.append({
            "program_name": program.program_name,
            "states": [
                {"state": st, "counties": counties}
                for st, counties in sorted(states_map.items())
            ],
        })

    return jsonify({"programs": result})


@app.route("/api/county-info", methods=["GET"])
def county_info():
    """Return lat/lng/state/radius for a 5-digit county FIPS code.

    Used by Next.js program-search and marketing-search routes to build
    RentCast queries without needing local access to county_fips.json.
    """
    fips = request.args.get("fips", "").strip()
    if not fips:
        return jsonify({"success": False, "error": "fips parameter is required."}), 400

    county_data = _load_county_fips()
    info = county_data.get(fips)
    if not info:
        return jsonify({"success": False, "error": f"Unknown county FIPS: {fips}"}), 404

    return jsonify({
        "success": True,
        "info": {
            "state": info["state"],
            "county": info["county"],
            "lat": info["lat"],
            "lng": info["lng"],
            "radius": info.get("radius", 25),
        },
    })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", 5001))
    debug = os.getenv("FLASK_DEBUG", "").lower() == "1"
    print(f"\n{'='*50}")
    print("GMCC Matching Microservice")
    print(f"{'='*50}")
    print(f"Listening on http://localhost:{port}")
    print(f"{'='*50}\n")
    app.run(debug=debug, port=port, threaded=True)
