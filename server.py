"""
Property Search Dashboard - Backend API
Flask server that proxies requests to RentCast API
"""

import json
import math
import os
import re

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests

from matching.models import ListingInput
from matching.matcher import match_listing, load_programs
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


def geocode_from_listings(listings: list, search_query: str) -> tuple:
    if listings and len(listings) > 0:
        first = listings[0]
        if first.get('latitude') and first.get('longitude'):
            return first['latitude'], first['longitude']
    return None, None


@app.route('/')
def index():
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)


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

    if not search_query:
        return jsonify({'success': False, 'error': 'Please enter a search location.'}), 400

    headers = {
        "accept": "application/json",
        "X-Api-Key": API_KEY
    }

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
                            return jsonify({
                                'success': True,
                                'listings': [listing],
                                'total': 1,
                                'exact_match': True,
                                'message': None
                            })

            # No exact match — search with 1 mile radius
            params["radius"] = 1
            response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    center_lat, center_lon = geocode_from_listings(data, search_query)
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
                        center_lat, center_lon = geocode_from_listings(data, search_query)
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
                    return jsonify({
                        'success': True,
                        'listings': data,
                        'total': len(data),
                        'exact_match': False,
                        'message': None
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
