# Architecture

**Analysis Date:** 2026-03-06

## Pattern Overview

**Overall:** Monolithic client-server with API proxy

**Key Characteristics:**
- Single Flask server acts as both static file server and API proxy layer
- No database -- all data comes from external RentCast API in real-time
- Vanilla JavaScript frontend with no framework, build step, or module system
- Server-side logic is limited to proxying, parameter mapping, and distance calculation
- All UI rendering happens client-side via DOM manipulation

## Layers

**Presentation Layer (Frontend):**
- Purpose: Renders the search form, property cards, stats bar, and detail modal
- Location: `static/`
- Contains: HTML template (`index.html`), vanilla JS (`script.js`), CSS (`styles.css`)
- Depends on: Backend `/api/search` endpoint
- Used by: End users via browser

**API Proxy Layer (Backend):**
- Purpose: Receives search requests from frontend, proxies them to RentCast API, enriches results with distance calculations, returns JSON
- Location: `server.py`
- Contains: Flask route handlers, distance calculation utility, geocoding helper
- Depends on: RentCast API (`https://api.rentcast.io/v1/listings/sale`), `RENTCAST_API_KEY` environment variable
- Used by: Frontend via `/api/search` endpoint

**External API Layer:**
- Purpose: Provides property listing data
- Location: External -- `https://api.rentcast.io/v1/listings/sale`
- Contains: Sale listing data (address, price, bedrooms, agent info, coordinates, etc.)
- Depends on: Valid API key
- Used by: Backend proxy layer

## Data Flow

**Property Search (Area):**

1. User fills search form (query, radius, limit, search type) and submits
2. `handleSearch()` in `static/script.js` calls `searchListings()` which sends GET to `/api/search` with query params
3. `search_listings()` in `server.py` validates API key and params
4. Server builds RentCast API params: sets `zipCode` (if 5-digit zip) or `address` + `radius`, always sets `status=Active` and `limit`
5. Server sends GET to `https://api.rentcast.io/v1/listings/sale` with `X-Api-Key` header
6. Server receives listing array, calculates distance from center using Haversine formula, sorts by distance
7. Server returns JSON: `{success, listings, total, exact_match, message}`
8. Frontend receives JSON, calls `renderListings()` to build property cards via DOM, updates stats bar

**Property Search (Specific Address):**

1. Same form submission flow as area search, but with `search_type=specific`
2. Server first tries exact address match via RentCast API
3. If exact match found (address substring match), returns single listing with `exact_match: true`
4. If no exact match, retries with `radius=1` mile to find nearby listings
5. Returns nearby listings with message explaining no exact match was found

**Property Detail View:**

1. User clicks a property card
2. `openPropertyModal(listing)` in `static/script.js` builds modal HTML from the listing object already in memory (stored in `currentListings` array)
3. Modal displays property details, listing info, location, and contact info (agent/builder/office)
4. No additional API call -- uses data from the original search response

**State Management:**
- Frontend state is a single global variable `currentListings` (array) in `static/script.js`
- No client-side routing, no URL state, no localStorage
- Each search replaces the entire listing state
- Server is stateless -- no sessions, no caching, no database

## Key Abstractions

**Search Modes:**
- Purpose: Two distinct search behaviors controlled by `search_type` parameter
- `area`: Radius-based search around an address or zip code
- `specific`: Exact address lookup with fallback to 1-mile radius nearby results
- Implementation: Single route handler with branching logic in `server.py` (lines 68-258)

**Property Listing Object:**
- Purpose: Core data structure passed between API, server, and frontend
- Shape defined by RentCast API response (not by this codebase)
- Key fields used: `price`, `formattedAddress`, `bedrooms`, `bathrooms`, `squareFootage`, `propertyType`, `daysOnMarket`, `latitude`, `longitude`, `listingAgent`, `builder`, `listingOffice`, `hoa`
- Server enriches with computed `distance` field

**API Response Envelope:**
- Purpose: Standard response format from server to frontend
- Shape: `{success: bool, listings: array, total: int, exact_match: bool, message: string|null}`
- Error shape: `{success: false, error: string}`

## Entry Points

**Server Entry Point:**
- Location: `server.py` (line 270: `if __name__ == '__main__':`)
- Triggers: `python server.py`
- Responsibilities: Starts Flask dev server on port 5000 with debug mode

**Frontend Entry Point:**
- Location: `static/index.html`
- Triggers: Browser navigates to `http://localhost:5000`
- Responsibilities: Loads CSS and JS, renders the search form shell

**JavaScript Initialization:**
- Location: `static/script.js` (line 421: `DOMContentLoaded` listener)
- Triggers: DOM ready event
- Responsibilities: Binds form submit, search type change, radius slider, modal close, escape key handlers

## API Endpoints

**`GET /`** - Serves `static/index.html`
- Location: `server.py` line 56

**`GET /static/<path:filename>`** - Serves static assets
- Location: `server.py` line 62

**`GET /api/search`** - Main search endpoint
- Location: `server.py` line 68
- Params: `query` (required), `radius` (default 5), `limit` (default 20, max 50), `search_type` (default "area")
- Returns: JSON response envelope

**`GET /api/health`** - Health check
- Location: `server.py` line 261
- Returns: `{status: "healthy", api_configured: bool}`

## Error Handling

**Strategy:** Per-request try/catch with user-facing error messages

**Backend Patterns:**
- API key validation at start of `search_listings()` -- returns 400 if missing (`server.py` line 79)
- Empty query validation -- returns 400 (`server.py` line 91)
- HTTP status code handling from RentCast: 401 (invalid key), 429 (rate limit), other codes (`server.py` lines 225-239)
- `requests.exceptions.Timeout` caught separately with 504 response (`server.py` line 241)
- Generic `requests.exceptions.RequestException` caught with 500 response (`server.py` lines 246, 182)

**Frontend Patterns:**
- `try/catch` around `searchListings()` call in `handleSearch()` (`static/script.js` line 377)
- `showError()` displays error banner that auto-hides after 5 seconds (`static/script.js` line 71)
- No retry logic, no error boundary patterns
- Fetch errors (network failures) caught generically with "Failed to connect to the server" message

## Cross-Cutting Concerns

**Logging:** Console prints only at server startup (`server.py` lines 271-276). No request logging, no structured logging.

**Validation:** Minimal -- query emptiness check and API key presence check on backend. No input sanitization beyond `.strip()`. Frontend relies on HTML `required` attribute.

**Authentication:** None. The app is open -- no user auth. RentCast API auth is via `X-Api-Key` header using env var.

**CORS:** Enabled globally via `flask_cors.CORS(app)` (`server.py` line 17). No origin restrictions configured.

**Caching:** None. Every search triggers a fresh RentCast API call. Footer mentions "cached for efficiency" but no caching is implemented.

---

*Architecture analysis: 2026-03-06*
