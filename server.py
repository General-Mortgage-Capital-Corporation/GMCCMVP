"""
Property Search Dashboard - Backend API
Flask server that proxies requests to RentCast API
"""

import json
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests

from matching.models import ListingInput
from matching.matcher import match_listing, load_programs, quick_prescreen
from matching.census import get_census_data
from matching.explain import explain_match

# Load environment variables
load_dotenv()

app = Flask(__name__, static_folder='static')
CORS(app)

# Configuration
API_KEY = os.getenv('RENTCAST_API_KEY', '')
GOOGLE_PLACES_API_KEY = os.getenv('GOOGLE_PLACES_API_KEY', '')
API_BASE_URL = "https://api.rentcast.io/v1/listings/sale"
DEFAULT_LIMIT = 20
MAX_LIMIT = 500

# County FIPS lookup (loaded once)
_COUNTY_FIPS_DATA: dict | None = None
_MSA_LOOKUP: dict | None = None


def _load_county_fips() -> dict:
    global _COUNTY_FIPS_DATA
    if _COUNTY_FIPS_DATA is not None:
        return _COUNTY_FIPS_DATA
    path = os.path.join(os.path.dirname(__file__), "data", "county_fips.json")
    if os.path.exists(path):
        with open(path) as f:
            _COUNTY_FIPS_DATA = json.load(f)
    else:
        _COUNTY_FIPS_DATA = {}
    return _COUNTY_FIPS_DATA


def _load_msa_lookup() -> dict:
    """Load MSA code → county FIPS mapping. Used for programs with MSA restrictions."""
    global _MSA_LOOKUP
    if _MSA_LOOKUP is not None:
        return _MSA_LOOKUP
    path = os.path.join(os.path.dirname(__file__), "data", "msa_lookup.json")
    if os.path.exists(path):
        with open(path) as f:
            _MSA_LOOKUP = json.load(f)
    else:
        _MSA_LOOKUP = {}
    return _MSA_LOOKUP


_STREET_SUFFIXES = {
    'avenue': 'ave', 'street': 'st', 'drive': 'dr', 'boulevard': 'blvd',
    'road': 'rd', 'lane': 'ln', 'court': 'ct', 'place': 'pl',
    'circle': 'cir', 'terrace': 'ter', 'way': 'way', 'parkway': 'pkwy',
    'highway': 'hwy', 'trail': 'trl', 'square': 'sq',
}


def _normalize_address(addr: str) -> str:
    """Normalize address for fuzzy comparison.

    Lowercases, strips punctuation/zip/country, and normalizes street suffixes
    so 'Avenue' matches 'Ave', etc.
    """
    s = addr.lower().strip()
    s = re.sub(r',?\s*usa$', '', s)            # strip country
    s = re.sub(r'\b\d{5}(-\d{4})?\b', '', s)   # strip zip codes
    s = s.replace(',', '').replace('.', '')
    for full, abbr in _STREET_SUFFIXES.items():
        s = re.sub(rf'\b{full}\b', abbr, s)
    return ' '.join(s.split())                   # collapse whitespace


def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two coordinates using Haversine formula (miles)."""
    R = 3959
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)
    a = math.sin(delta_lat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c



@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)


@app.route('/api/programs', methods=['GET'])
def list_programs():
    """Return the list of available GMCC program names."""
    programs = load_programs()
    return jsonify({
        'programs': [p.program_name for p in programs]
    })


@app.route('/api/config', methods=['GET'])
def get_config():
    """Return public configuration."""
    return jsonify({
        'places_api_key': GOOGLE_PLACES_API_KEY,
    })


@app.route('/api/autocomplete', methods=['GET'])
def autocomplete():
    """Proxy Google Places Autocomplete (New) REST API.

    Keeps the API key server-side. Returns place predictions for the input.
    """
    input_text = request.args.get('input', '').strip()
    if not input_text or not GOOGLE_PLACES_API_KEY:
        return jsonify({'suggestions': []})

    try:
        resp = requests.post(
            'https://places.googleapis.com/v1/places:autocomplete',
            json={
                'input': input_text,
                'includedRegionCodes': ['us'],
                'includedPrimaryTypes': ['street_address', 'subpremise', 'premise'],
            },
            headers={
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
            },
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            suggestions = []
            for s in data.get('suggestions', []):
                pred = s.get('placePrediction', {})
                text = pred.get('text', {}).get('text', '')
                place_id = pred.get('placeId', '')
                if text:
                    suggestions.append({'text': text, 'place_id': place_id})
            return jsonify({'suggestions': suggestions})
    except Exception:
        pass
    return jsonify({'suggestions': []})


@app.route('/api/search', methods=['GET'])
def search_listings():
    """Search for property listings via RentCast API."""
    if not API_KEY or API_KEY == 'API_KEY_HERE':
        return jsonify({
            'success': False,
            'error': 'API key not configured. Please add your RentCast API key to the .env file.'
        }), 400

    search_query = request.args.get('query', '').strip()
    radius = float(request.args.get('radius', 5))
    search_type = request.args.get('search_type', 'area')
    program_filter = request.args.get('programs', '').strip()
    selected_programs = [p for p in program_filter.split(',') if p] if program_filter else []

    # Use frontend-provided lat/lng (from map marker / Google Places) as distance center
    search_lat = request.args.get('lat', type=float)
    search_lng = request.args.get('lng', type=float)

    if not search_query:
        return jsonify({'success': False, 'error': 'Please enter a search location.'}), 400

    headers = {
        "accept": "application/json",
        "X-Api-Key": API_KEY
    }

    def _apply_program_filter(listings):
        """Pre-screen listings against selected programs using only RentCast data."""
        if not selected_programs:
            return listings
        total_before = len(listings)
        filtered = [l for l in listings if quick_prescreen(l, selected_programs)]
        count = len(filtered)
        return filtered

    is_zip = search_query.isdigit() and len(search_query) == 5
    params = {"status": "Active", "limit": MAX_LIMIT}

    if search_type == 'specific':
        params["address"] = search_query
        try:
            response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    search_norm = _normalize_address(search_query)
                    for listing in data:
                        addr_norm = _normalize_address(listing.get('formattedAddress', ''))
                        if search_norm in addr_norm or addr_norm in search_norm:
                            result = _apply_program_filter([listing])
                            return jsonify({
                                'success': True,
                                'listings': result,
                                'total': len(result),
                                'exact_match': True,
                                'message': None
                            })

            # No exact match — search with 1 mile radius
            params["radius"] = 1
            response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    center_lat = search_lat or data[0].get('latitude')
                    center_lon = search_lng or data[0].get('longitude')
                    if center_lat and center_lon:
                        for listing in data:
                            if listing.get('latitude') and listing.get('longitude'):
                                listing['distance'] = calculate_distance(
                                    center_lat, center_lon,
                                    listing['latitude'], listing['longitude']
                                )
                            else:
                                listing['distance'] = 999
                        data.sort(key=lambda x: x.get('distance', 999))
                    data = _apply_program_filter(data)
                    return jsonify({
                        'success': True,
                        'listings': data,
                        'total': len(data),
                        'exact_match': False,
                        'message': f'No exact match found for "{search_query}". Showing {len(data)} properties within 1 mile.'
                    })

            return jsonify({
                'success': True, 'listings': [], 'total': 0,
                'exact_match': False,
                'message': f'No properties found at or near "{search_query}".'
            })

        except requests.exceptions.RequestException as e:
            return jsonify({'success': False, 'error': f'Connection error: {str(e)}'}), 500

    else:
        if is_zip:
            params["zipCode"] = search_query
        else:
            params["address"] = search_query
            params["radius"] = radius

        try:
            response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list):
                    if data and not is_zip:
                        center_lat = search_lat or (data[0].get('latitude') if data else None)
                        center_lon = search_lng or (data[0].get('longitude') if data else None)
                        if center_lat and center_lon:
                            for listing in data:
                                if listing.get('latitude') and listing.get('longitude'):
                                    listing['distance'] = calculate_distance(
                                        center_lat, center_lon,
                                        listing['latitude'], listing['longitude']
                                    )
                                else:
                                    listing['distance'] = 999
                            data.sort(key=lambda x: x.get('distance', 999))
                    data = _apply_program_filter(data)
                    msg = None
                    if selected_programs:
                        msg = f'Pre-screened to {len(data)} potential matches. Verifying eligibility...'
                    return jsonify({
                        'success': True,
                        'listings': data,
                        'total': len(data),
                        'exact_match': False,
                        'message': msg
                    })
            elif response.status_code == 401:
                return jsonify({'success': False, 'error': 'Invalid API key.'}), 401
            elif response.status_code == 429:
                return jsonify({'success': False, 'error': 'API rate limit exceeded.'}), 429
            else:
                return jsonify({'success': False, 'error': f'API error: {response.status_code}'}), response.status_code

        except requests.exceptions.Timeout:
            return jsonify({'success': False, 'error': 'Request timed out.'}), 504
        except requests.exceptions.RequestException as e:
            return jsonify({'success': False, 'error': f'Connection error: {str(e)}'}), 500

    return jsonify({
        'success': True, 'listings': [], 'total': 0,
        'exact_match': False,
        'message': 'No properties found matching your search criteria.'
    })


@app.route('/api/match', methods=['POST'])
def match_listing_endpoint():
    """Match a listing against all GMCC programs.

    Fetches FFIEC census data using the listing address, enriches the listing,
    runs deterministic matching, and returns program results + census data.
    """
    try:
        listing_data = request.get_json(silent=True)
        if not listing_data:
            return jsonify({'success': False, 'error': 'Request body must be a non-empty JSON object.'}), 400

        # Fetch FFIEC census data
        census_data = get_census_data(listing_data)

        listing = ListingInput.from_rentcast(listing_data, census_data)
        results = match_listing(listing)

        eligible_count = sum(1 for r in results if r.status.value != "Ineligible")

        return jsonify({
            'success': True,
            'programs': [r.model_dump() for r in results],
            'eligible_count': eligible_count,
            'census_data': census_data,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': f'Matching error: {str(e)}'}), 500


@app.route('/api/match-batch', methods=['POST'])
def match_batch_endpoint():
    """Match multiple listings in a single request to reduce HTTP round-trips.

    Expects JSON array of RentCast listing objects. Processes in parallel
    (up to 8 threads) for faster Census/ACS lookups.
    """
    try:
        listings = request.get_json(silent=True)
        if not listings or not isinstance(listings, list):
            return jsonify({'success': False, 'error': 'Expected JSON array of listings'}), 400

        def _process_one(listing_data):
            census_data = get_census_data(listing_data)
            listing = ListingInput.from_rentcast(listing_data, census_data)
            match_results = match_listing(listing)
            return {
                'programs': [r.model_dump() for r in match_results],
                'census_data': census_data,
            }

        # Process listings in parallel — Census/ACS APIs handle concurrent requests fine
        with ThreadPoolExecutor(max_workers=min(len(listings), 20)) as pool:
            futures = {pool.submit(_process_one, ld): i for i, ld in enumerate(listings)}
            results = [None] * len(listings)
            for future in as_completed(futures):
                results[futures[future]] = future.result()

        return jsonify({'success': True, 'results': results})
    except Exception as e:
        return jsonify({'success': False, 'error': f'Batch matching error: {str(e)}'}), 500


@app.route('/api/explain', methods=['POST'])
def explain_endpoint():
    """Generate an on-demand LLM explanation for a program match."""
    try:
        body = request.get_json(silent=True)
        if not body:
            return jsonify({'success': False, 'error': 'Request body must be a non-empty JSON object.'}), 400

        program_name = body.get('program_name')
        listing = body.get('listing')
        tier_name = body.get('tier_name', '')

        if not program_name or not listing:
            return jsonify({'success': False, 'error': 'program_name and listing are required.'}), 400

        # Load program rules JSON for context
        from rag.config import PROGRAMS_DIR
        program_rules = None
        for fname in os.listdir(PROGRAMS_DIR):
            if fname.endswith('.json'):
                with open(os.path.join(PROGRAMS_DIR, fname)) as f:
                    data = json.load(f)
                if data.get('program_name') == program_name:
                    program_rules = data
                    break

        explanation = explain_match(program_name, listing, tier_name, program_rules)
        return jsonify({'success': True, 'explanation': explanation})

    except Exception as e:
        return jsonify({'success': False, 'error': 'Failed to generate explanation'}), 500


@app.route('/api/program-locations', methods=['GET'])
def program_locations():
    """Return program → state → county hierarchy for the program search tab.

    Aggregates eligible_county_fips across all tiers of each program and
    enriches with county names, cities, and state grouping from county_fips.json.
    """
    county_data = _load_county_fips()
    msa_lookup = _load_msa_lookup()
    programs = load_programs()

    result = []
    for program in programs:
        # Collect all eligible county FIPS across tiers
        all_fips = set()
        for tier in program.tiers:
            all_fips.update(tier.eligible_county_fips)
            # Also resolve MSA codes to their constituent counties
            for msa_code in (tier.eligible_msa_codes or []):
                msa_info = msa_lookup.get(msa_code)
                if msa_info:
                    all_fips.update(msa_info["counties"])

        # Group by state
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

        states_list = [
            {"state": st, "counties": counties}
            for st, counties in sorted(states_map.items())
        ]

        result.append({
            "program_name": program.program_name,
            "states": states_list,
        })

    return jsonify({"programs": result})


@app.route('/api/program-search', methods=['GET'])
def program_search():
    """Search listings in a county and match against a specific program.

    1. Query RentCast by city+state or county centroid+radius
    2. Filter results to the selected county FIPS
    3. Pre-screen against program (fast, no Census)
    4. Full match survivors in parallel (Census + rules)
    5. Return only Eligible + Potentially Eligible, sorted by status
    """
    program_name = request.args.get('program', '').strip()
    county_fips_param = request.args.get('county_fips', '').strip()
    city = request.args.get('city', '').strip()

    if not program_name or not county_fips_param:
        return jsonify({'success': False, 'error': 'program and county_fips are required'}), 400

    county_data = _load_county_fips()
    county_info = county_data.get(county_fips_param)
    if not county_info:
        return jsonify({'success': False, 'error': f'Unknown county FIPS: {county_fips_param}'}), 400

    if not API_KEY or API_KEY == 'API_KEY_HERE':
        return jsonify({'success': False, 'error': 'RentCast API key not configured.'}), 400

    headers = {"accept": "application/json", "X-Api-Key": API_KEY}
    state = county_info["state"]

    # Build RentCast query
    params = {"status": "Active", "limit": MAX_LIMIT}
    if city:
        params["city"] = city
        params["state"] = state
    else:
        params["latitude"] = county_info["lat"]
        params["longitude"] = county_info["lng"]
        params["radius"] = county_info.get("radius", 25)

    try:
        response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
        if response.status_code != 200:
            return jsonify({'success': False, 'error': f'RentCast API error: {response.status_code}'}), response.status_code
        data = response.json()
        if not isinstance(data, list):
            data = []
    except requests.exceptions.RequestException as e:
        return jsonify({'success': False, 'error': f'Connection error: {str(e)}'}), 500

    # Filter to target county FIPS
    filtered = []
    for listing in data:
        sf = (listing.get("stateFips") or "").strip()
        cf = (listing.get("countyFips") or "").strip()
        listing_fips = sf.zfill(2) + cf.zfill(3) if sf and cf else ""
        if listing_fips == county_fips_param:
            filtered.append(listing)

    # Pre-screen against the selected program
    prescreened = [l for l in filtered if quick_prescreen(l, [program_name])]

    if not prescreened:
        return jsonify({
            'success': True,
            'listings': [],
            'total_searched': len(filtered),
            'total_matched': 0,
        })

    # Full match in parallel
    def _process_one(listing_data):
        census_data = get_census_data(listing_data)
        listing_input = ListingInput.from_rentcast(listing_data, census_data)
        match_results = match_listing(listing_input)
        prog_result = next((r for r in match_results if r.program_name == program_name), None)
        return {
            'listing': listing_data,
            'program': prog_result.model_dump() if prog_result else None,
            'census_data': census_data,
        }

    with ThreadPoolExecutor(max_workers=min(len(prescreened), 20)) as pool:
        futures = {pool.submit(_process_one, ld): i for i, ld in enumerate(prescreened)}
        results = [None] * len(prescreened)
        for future in as_completed(futures):
            idx = futures[future]
            try:
                results[idx] = future.result()
            except Exception:
                results[idx] = None

    # Filter to eligible / potentially eligible only
    matched = []
    for r in results:
        if not r or not r['program']:
            continue
        status = r['program']['status']
        if status in ('Eligible', 'Potentially Eligible'):
            # Attach match data and census to the listing dict for frontend reuse
            listing = r['listing']
            listing['matchData'] = {'programs': [r['program']]}
            listing['censusData'] = r['census_data']
            listing['_matchStatus'] = status
            matched.append(listing)

    # Sort: Eligible first, then Potentially Eligible
    status_order = {'Eligible': 0, 'Potentially Eligible': 1}
    matched.sort(key=lambda l: status_order.get(l.get('_matchStatus', ''), 2))

    # Clean up internal field
    for l in matched:
        l.pop('_matchStatus', None)

    return jsonify({
        'success': True,
        'listings': matched,
        'total_searched': len(filtered),
        'total_matched': len(matched),
    })


@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'api_configured': bool(API_KEY and API_KEY != 'API_KEY_HERE'),
        'places_configured': bool(GOOGLE_PLACES_API_KEY),
    })


if __name__ == '__main__':
    print("\n" + "="*50)
    print("Property Search Dashboard")
    print("="*50)
    print(f"Server running at: http://localhost:5000")
    print(f"RentCast API Key: {'Yes' if API_KEY and API_KEY != 'API_KEY_HERE' else 'No'}")
    print(f"Google Places Key: {'Yes' if GOOGLE_PLACES_API_KEY else 'No'}")
    print("="*50 + "\n")
    app.run(debug=True, port=5000)
