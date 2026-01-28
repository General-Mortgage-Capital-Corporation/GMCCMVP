"""
Property Search Dashboard - Backend API
Flask server that proxies requests to RentCast API
"""

import os
import math
import re
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests

# Load environment variables
load_dotenv()

app = Flask(__name__, static_folder='static')
CORS(app)

# Configuration
API_KEY = os.getenv('RENTCAST_API_KEY', '')
API_BASE_URL = "https://api.rentcast.io/v1/listings/sale"
DEFAULT_LIMIT = 20
MAX_LIMIT = 50

# Playwright browser check flag
PLAYWRIGHT_AVAILABLE = False
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    pass

# DuckDuckGo search check
DUCKDUCKGO_AVAILABLE = False
try:
    from duckduckgo_search import DDGS
    DUCKDUCKGO_AVAILABLE = True
except ImportError:
    pass


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


@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({
        'status': 'healthy',
        'api_configured': bool(API_KEY and API_KEY != 'API_KEY_HERE')
    })


def search_zillow_url(address: str) -> str:
    """
    Search DuckDuckGo for Zillow listing URL.
    Returns the first Zillow URL found or empty string.
    """
    if not DUCKDUCKGO_AVAILABLE:
        return ''
    
    try:
        with DDGS() as ddgs:
            query = f"site:zillow.com {address}"
            results = list(ddgs.text(query, max_results=5))
            
            for result in results:
                url = result.get('href', '')
                if 'zillow.com' in url and '/homedetails/' in url:
                    return url
            
            # Fallback: return first zillow result even if not homedetails
            for result in results:
                url = result.get('href', '')
                if 'zillow.com' in url:
                    return url
                    
    except Exception as e:
        print(f"DuckDuckGo search error: {e}")
    
    return ''


def scrape_zillow_price(url: str) -> dict:
    """
    Use Playwright to scrape price from Zillow page.
    Returns dict with price, days_on_market, and success status.
    """
    result = {
        'success': False,
        'price': None,
        'days_on_market': None,
        'error': None
    }
    
    if not PLAYWRIGHT_AVAILABLE:
        result['error'] = 'Playwright not installed'
        return result
    
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport={'width': 1920, 'height': 1080}
            )
            page = context.new_page()
            
            # Navigate with timeout
            page.goto(url, timeout=30000, wait_until='domcontentloaded')
            page.wait_for_timeout(2000)  # Wait for JS to render
            
            # Try multiple selectors for price
            price_selectors = [
                '[data-testid="price"]',
                'span[data-testid="price"]',
                '.summary-container span.Text-c11n-8-84-3__sc-aiai24-0',
                '.hdp__sc-1tsvzbc-1',  # Zillow price class
                'span.dpf__sc-1me8eh6-0',
                '[class*="price"]',
                'h3[class*="Price"]',
            ]
            
            price_text = None
            for selector in price_selectors:
                try:
                    element = page.query_selector(selector)
                    if element:
                        text = element.inner_text()
                        # Check if it looks like a price
                        if '$' in text or text.replace(',', '').replace('.', '').isdigit():
                            price_text = text
                            break
                except:
                    continue
            
            # Fallback: search page content for price pattern
            if not price_text:
                content = page.content()
                price_match = re.search(r'\$[\d,]+(?:\.\d{2})?', content)
                if price_match:
                    price_text = price_match.group()
            
            if price_text:
                # Clean up price text
                price_clean = price_text.replace('$', '').replace(',', '').strip()
                # Handle "Est." or other prefixes
                price_clean = re.sub(r'[^\d.]', '', price_clean)
                try:
                    result['price'] = int(float(price_clean))
                except:
                    result['price'] = price_text
            
            # Try to find days on market
            dom_selectors = [
                '[data-testid="days-on-zillow"]',
                'span:has-text("days on Zillow")',
                'dt:has-text("Time on Zillow")',
            ]
            
            for selector in dom_selectors:
                try:
                    element = page.query_selector(selector)
                    if element:
                        result['days_on_market'] = element.inner_text()
                        break
                except:
                    continue
            
            # Fallback: search for days pattern
            if not result['days_on_market']:
                content = page.content()
                dom_match = re.search(r'(\d+)\s*days?\s*on\s*Zillow', content, re.IGNORECASE)
                if dom_match:
                    result['days_on_market'] = f"{dom_match.group(1)} days"
            
            browser.close()
            
            if result['price']:
                result['success'] = True
            else:
                result['error'] = 'Could not extract price from page'
                
    except Exception as e:
        result['error'] = f'Scraping failed: {str(e)}'
    
    return result


@app.route('/api/verify-live', methods=['POST'])
def verify_listing_live():
    """
    Verify a listing against live Zillow data.
    
    Request Body:
        - address: Property address to verify
        - rentcast_price: Original price from RentCast for comparison
    """
    data = request.get_json() or {}
    address = data.get('address', '').strip()
    rentcast_price = data.get('rentcast_price')
    
    if not address:
        return jsonify({
            'success': False,
            'error': 'Address is required'
        }), 400
    
    # Check dependencies
    if not DUCKDUCKGO_AVAILABLE:
        return jsonify({
            'success': False,
            'error': 'DuckDuckGo search library not installed. Run: pip install duckduckgo-search'
        }), 500
    
    if not PLAYWRIGHT_AVAILABLE:
        return jsonify({
            'success': False,
            'error': 'Playwright not installed. Run: pip install playwright && playwright install chromium'
        }), 500
    
    # Step 1: Search for Zillow URL
    zillow_url = search_zillow_url(address)
    
    if not zillow_url:
        return jsonify({
            'success': False,
            'error': 'Could not find Zillow listing for this address',
            'manual_search_url': f'https://www.zillow.com/homes/{address.replace(" ", "-").replace(",", "")}_rb/'
        })
    
    # Step 2: Scrape the Zillow page
    scrape_result = scrape_zillow_price(zillow_url)
    
    if not scrape_result['success']:
        return jsonify({
            'success': False,
            'error': scrape_result.get('error', 'Automated check blocked'),
            'zillow_url': zillow_url,
            'message': 'Automated check failed. Please verify manually using the link below.'
        })
    
    # Step 3: Compare prices
    live_price = scrape_result['price']
    price_difference = None
    price_change_percent = None
    price_status = 'same'
    
    if rentcast_price and isinstance(live_price, int):
        price_difference = live_price - rentcast_price
        if rentcast_price > 0:
            price_change_percent = round((price_difference / rentcast_price) * 100, 1)
        
        if price_difference < 0:
            price_status = 'lower'
        elif price_difference > 0:
            price_status = 'higher'
    
    return jsonify({
        'success': True,
        'zillow_url': zillow_url,
        'live_price': live_price,
        'live_days_on_market': scrape_result.get('days_on_market'),
        'rentcast_price': rentcast_price,
        'price_difference': price_difference,
        'price_change_percent': price_change_percent,
        'price_status': price_status
    })


if __name__ == '__main__':
    print("\n" + "="*50)
    print("Property Search Dashboard")
    print("="*50)
    print(f"Server running at: http://localhost:5000")
    print(f"API Key configured: {'Yes' if API_KEY and API_KEY != 'API_KEY_HERE' else 'No - Please add to .env file'}")
    print("="*50 + "\n")
    app.run(debug=True, port=5000)
