"""
Property Search Dashboard - Backend API
Flask server that proxies requests to RentCast API
"""

import os
import math
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests

from matching.models import ListingInput
from matching.matcher import match_listing, load_programs
from matching.explain import explain_match

# Load environment variables
load_dotenv()

app = Flask(__name__, static_folder='static')
CORS(app)

# Configuration
API_KEY = os.getenv('RENTCAST_API_KEY', '')
API_BASE_URL = "https://api.rentcast.io/v1/listings/sale"
DEFAULT_LIMIT = 20
MAX_LIMIT = 50


def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate distance between two coordinates using Haversine formula.
    Returns distance in miles.
    """
    R = 3959  # Earth's radius in miles
    
    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)
    
    a = math.sin(delta_lat/2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    
    return R * c


def geocode_from_listings(listings: list, search_query: str) -> tuple:
    """
    Try to get center coordinates from first listing or search query.
    Returns (latitude, longitude) or (None, None)
    """
    if listings and len(listings) > 0:
        first = listings[0]
        if first.get('latitude') and first.get('longitude'):
            return first['latitude'], first['longitude']
    return None, None


@app.route('/')
def index():
    """Serve the main HTML page."""
    return send_from_directory('static', 'index.html')


@app.route('/static/<path:filename>')
def serve_static(filename):
    """Serve static files."""
    return send_from_directory('static', filename)


@app.route('/api/search', methods=['GET'])
def search_listings():
    """
    Search for property listings.
    
    Query Parameters:
        - query: Address or zip code
        - radius: Search radius in miles (default: 5)
        - limit: Max results (default: 20)
        - search_type: 'area' or 'specific'
    """
    if not API_KEY or API_KEY == 'API_KEY_HERE':
        return jsonify({
            'success': False,
            'error': 'API key not configured. Please add your RentCast API key to the .env file.'
        }), 400
    
    # Get parameters
    search_query = request.args.get('query', '').strip()
    radius = float(request.args.get('radius', 5))
    limit = min(int(request.args.get('limit', DEFAULT_LIMIT)), MAX_LIMIT)
    search_type = request.args.get('search_type', 'area')
    
    if not search_query:
        return jsonify({
            'success': False,
            'error': 'Please enter a search location.'
        }), 400
    
    headers = {
        "accept": "application/json",
        "X-Api-Key": API_KEY
    }
    
    # Determine if input is a zip code
    is_zip = search_query.isdigit() and len(search_query) == 5
    
    # Build API parameters
    params = {
        "status": "Active",
        "limit": limit
    }
    
    exact_match_found = False
    show_nearby_message = False
    
    if search_type == 'specific':
        # First try exact address match
        params["address"] = search_query
        
        try:
            response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    # Check if we have an exact match
                    search_lower = search_query.lower().replace(',', '').replace('.', '')
                    for listing in data:
                        addr = listing.get('formattedAddress', '').lower().replace(',', '').replace('.', '')
                        if search_lower in addr or addr in search_lower:
                            exact_match_found = True
                            # Return only the exact match
                            return jsonify({
                                'success': True,
                                'listings': [listing],
                                'total': 1,
                                'exact_match': True,
                                'message': None
                            })
                    
                    # No exact match in results, but we have nearby listings
                    exact_match_found = False
            
            # No exact match found - search with 1 mile radius
            if not exact_match_found:
                params["radius"] = 1
                params["limit"] = limit
                
                response = requests.get(API_BASE_URL, headers=headers, params=params, timeout=30)
                
                if response.status_code == 200:
                    data = response.json()
                    if isinstance(data, list) and len(data) > 0:
                        show_nearby_message = True
                        # Sort by distance if we can
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
                            'listings': data[:limit],
                            'total': len(data[:limit]),
                            'exact_match': False,
                            'message': f'No exact match found for "{search_query}". Showing {len(data[:limit])} properties within 1 mile.'
                        })
                
                return jsonify({
                    'success': True,
                    'listings': [],
                    'total': 0,
                    'exact_match': False,
                    'message': f'No properties found at or near "{search_query}".'
                })
                
        except requests.exceptions.RequestException as e:
            return jsonify({
                'success': False,
                'error': f'Connection error: {str(e)}'
            }), 500
    
    else:
        # Area search with radius
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
                    # Sort by distance from center
                    if data and not is_zip:
                        # Use first result's coords as approximate center
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
                        'listings': data[:limit],
                        'total': len(data[:limit]),
                        'exact_match': False,
                        'message': None
                    })
                    
            elif response.status_code == 401:
                return jsonify({
                    'success': False,
                    'error': 'Invalid API key. Please check your configuration.'
                }), 401
            elif response.status_code == 429:
                return jsonify({
                    'success': False,
                    'error': 'API rate limit exceeded. Please wait before searching again.'
                }), 429
            else:
                return jsonify({
                    'success': False,
                    'error': f'API error: {response.status_code}'
                }), response.status_code
                
        except requests.exceptions.Timeout:
            return jsonify({
                'success': False,
                'error': 'Request timed out. Please try again.'
            }), 504
        except requests.exceptions.RequestException as e:
            return jsonify({
                'success': False,
                'error': f'Connection error: {str(e)}'
            }), 500
    
    return jsonify({
        'success': True,
        'listings': [],
        'total': 0,
        'exact_match': False,
        'message': 'No properties found matching your search criteria.'
    })


@app.route('/api/match', methods=['POST'])
def match_listing_endpoint():
    """Match a RentCast listing against all GMCC programs.

    Accepts a RentCast listing JSON and returns program eligibility results.
    This endpoint is fully deterministic -- zero LLM calls.
    """
    try:
        listing_data = request.get_json(silent=True)

        if not listing_data:
            return jsonify({
                'success': False,
                'error': 'Request body must be a non-empty JSON object with listing data.'
            }), 400

        listing = ListingInput.from_rentcast(listing_data)
        results = match_listing(listing)

        eligible_count = sum(
            1 for r in results if r.status.value != "Ineligible"
        )

        return jsonify({
            'success': True,
            'programs': [r.model_dump() for r in results],
            'eligible_count': eligible_count,
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f'Matching error: {str(e)}'
        }), 500


@app.route('/api/explain', methods=['POST'])
def explain_endpoint():
    """Generate an on-demand LLM explanation for a program match.

    Accepts {program_name, listing, tier_name} and returns Gemini Flash
    explanation with ChromaDB guideline context.
    """
    try:
        body = request.get_json(silent=True)

        if not body:
            return jsonify({
                'success': False,
                'error': 'Request body must be a non-empty JSON object.'
            }), 400

        program_name = body.get('program_name')
        listing = body.get('listing')
        tier_name = body.get('tier_name', '')

        if not program_name:
            return jsonify({
                'success': False,
                'error': 'program_name is required.'
            }), 400

        if not listing:
            return jsonify({
                'success': False,
                'error': 'listing is required.'
            }), 400

        explanation = explain_match(program_name, listing, tier_name)

        return jsonify({
            'success': True,
            'explanation': explanation,
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': 'Failed to generate explanation'
        }), 500


@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        'status': 'healthy',
        'api_configured': bool(API_KEY and API_KEY != 'API_KEY_HERE')
    })


if __name__ == '__main__':
    print("\n" + "="*50)
    print("Property Search Dashboard")
    print("="*50)
    print(f"Server running at: http://localhost:5000")
    print(f"API Key configured: {'Yes' if API_KEY and API_KEY != 'API_KEY_HERE' else 'No - Please add to .env file'}")
    print("="*50 + "\n")
    app.run(debug=True, port=5000)
