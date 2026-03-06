# External Integrations

**Analysis Date:** 2026-03-06

## APIs & External Services

**Real Estate Data:**
- **RentCast API** - Property sale listings data (active listings, property details, agent/office info)
  - SDK/Client: `requests` library (standard HTTP GET calls)
  - Base URL: `https://api.rentcast.io/v1/listings/sale`
  - Auth: API key passed via `X-Api-Key` header (`server.py`, line 99)
  - Auth env var: `RENTCAST_API_KEY`
  - Rate limiting: API returns 429 when rate limit exceeded; handled in `server.py` line 230-233
  - Timeout: 30 seconds per request (`server.py`, lines 119, 147, 197)
  - Documentation: https://developers.rentcast.io/reference/sale-listings

**RentCast API Parameters Used:**
- `status`: Always set to `"Active"` (`server.py`, line 108)
- `address`: For address-based searches (`server.py`, lines 116, 193)
- `zipCode`: For zip code searches (`server.py`, line 191)
- `radius`: Search radius in miles (`server.py`, lines 144, 194)
- `limit`: Max results per request, capped at 50 (`server.py`, line 109)

**RentCast API Response Fields Consumed:**
- Core: `formattedAddress`, `price`, `latitude`, `longitude`, `status`
- Property: `propertyType`, `bedrooms`, `bathrooms`, `squareFootage`, `lotSize`, `yearBuilt`
- Listing: `daysOnMarket`, `listedDate`, `lastSeenDate`, `listingType`, `mlsNumber`
- Location: `city`, `state`, `zipCode`, `county`
- Contact: `listingAgent` (name, phone, email, website), `builder` (name, phone, development, website), `listingOffice` (name, phone, email)
- HOA: `hoa.fee`

**Fonts CDN:**
- **Google Fonts** - Inter font family
  - URL: `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap`
  - Used in: `static/index.html` (lines 8-10)
  - No API key required

## Data Storage

**Databases:**
- None - no database is used. All data is fetched live from the RentCast API on each search request.

**File Storage:**
- Local filesystem only - Flask serves static files from `static/` directory

**Caching:**
- None - no caching layer. Every search triggers a fresh API call to RentCast. The footer mentions "Results cached for efficiency" (`static/index.html`, line 142) but no caching is actually implemented.

## Authentication & Identity

**Auth Provider:**
- None - no user authentication system. The application is a public dashboard.
- The only auth is the server-side RentCast API key, which is never exposed to the frontend.

## Monitoring & Observability

**Error Tracking:**
- None - no error tracking service (Sentry, etc.)

**Logs:**
- Flask default logging only
- Console print statements for startup info (`server.py`, lines 271-276)
- No structured logging framework

## CI/CD & Deployment

**Hosting:**
- Not configured - no deployment target specified
- No `Procfile`, `Dockerfile`, `docker-compose.yml`, or platform-specific config

**CI Pipeline:**
- None - no CI/CD configuration detected (no `.github/workflows/`, no `.gitlab-ci.yml`, etc.)

## Environment Configuration

**Required env vars:**
- `RENTCAST_API_KEY` - RentCast API key for property data access. Application returns a 400 error if missing or set to placeholder value `API_KEY_HERE` (`server.py`, lines 79-83).

**Secrets location:**
- `.env` file in project root (not committed; listed in `.gitignore`)
- Loaded at startup via `load_dotenv()` (`server.py`, line 14)

## Webhooks & Callbacks

**Incoming:**
- None

**Outgoing:**
- None

## API Endpoints (Internal)

The Flask server exposes these endpoints for the frontend:

**`GET /`** - Serves `static/index.html` (`server.py`, line 56-59)

**`GET /static/<path:filename>`** - Serves static assets (`server.py`, line 62-65)

**`GET /api/search`** - Property search endpoint (`server.py`, line 68-258)
- Query params: `query` (string), `radius` (float, default 5), `limit` (int, default 20, max 50), `search_type` ("area" or "specific")
- Returns JSON: `{ success, listings, total, exact_match, message }`
- Proxies to RentCast API with server-side API key

**`GET /api/health`** - Health check (`server.py`, line 261-267)
- Returns JSON: `{ status, api_configured }`

## Integration Risks

- **Single API dependency**: The entire application depends on RentCast API availability. No fallback or cached data.
- **No API key rotation**: API key is a single static value in `.env`.
- **Rate limit exposure**: No request throttling on the Flask side; each user search triggers 1-2 RentCast API calls (specific search can make 2 calls: exact match attempt + fallback radius search in `server.py`, lines 118-180).

---

*Integration audit: 2026-03-06*
