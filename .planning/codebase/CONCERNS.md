# Codebase Concerns

**Analysis Date:** 2026-03-06

## Tech Debt

**No Input Validation or Sanitization on Query Parameters:**
- Issue: The `radius` and `limit` query parameters in `server.py` are cast directly with `float()` and `int()` without try/except. A non-numeric value causes an unhandled 500 error.
- Files: `server.py` (lines 87-88)
- Impact: Any malformed request (e.g., `/api/search?query=test&radius=abc`) crashes with an unhandled ValueError, returning a raw Python traceback to the client.
- Fix approach: Wrap parameter parsing in try/except blocks or use a validation library. Return 400 with a descriptive error message for invalid parameters.

**Monolithic Single-File Backend:**
- Issue: All backend logic (routing, API proxying, geocoding, distance calculation) lives in a single `server.py` file (277 lines). This is manageable now but will not scale as features are added (e.g., rental listings, saved searches, user accounts).
- Files: `server.py`
- Impact: Adding new endpoints or business logic increases coupling and makes the file harder to navigate and test.
- Fix approach: Extract into modules: `routes/`, `services/`, `utils/`. Move `calculate_distance` and `geocode_from_listings` into a `utils.py`. Move API call logic into a `services/rentcast.py`.

**Monolithic Single-File Frontend JavaScript:**
- Issue: All frontend logic (API calls, UI manipulation, modal handling, event binding) lives in one `static/script.js` file (448 lines) with no module system, no bundler, and no framework.
- Files: `static/script.js`
- Impact: No code splitting, no tree shaking, no ability to use npm packages on the frontend. Adding complexity (maps, charts, pagination) will make this file unwieldy.
- Fix approach: If the app grows, introduce a build step (Vite) and either vanilla JS modules or a lightweight framework. For now, consider splitting into multiple script files loaded via `<script>` tags.

**Duplicated Distance Calculation Logic:**
- Issue: The distance-sorting logic (iterating listings, computing distance, assigning 999 as default, sorting) appears twice in `server.py` -- once in the `specific` search branch (lines 153-164) and once in the `area` search branch (lines 203-215). This is copy-pasted code.
- Files: `server.py` (lines 153-164, lines 203-215)
- Impact: Bug fixes or changes to sorting logic must be applied in two places. Easy to miss one.
- Fix approach: Extract a `sort_listings_by_distance(listings, center_lat, center_lon)` helper function and call it from both branches.

**Footer Claims Caching That Does Not Exist:**
- Issue: The footer in `index.html` states "Results cached for efficiency" but there is no caching implemented anywhere -- not on the backend (no Redis, no in-memory cache) and not on the frontend (no localStorage, no sessionStorage).
- Files: `static/index.html` (line 142)
- Impact: Misleading to users. Every search makes a fresh API call to RentCast, consuming API quota.
- Fix approach: Either implement caching (e.g., `functools.lru_cache`, Redis, or frontend localStorage with TTL) or remove the misleading footer text.

**No Dependency Pinning:**
- Issue: `requirements.txt` uses minimum version specifiers (`>=`) instead of pinned versions. There is no `requirements.lock` or `pip-compile` output.
- Files: `requirements.txt`
- Impact: Builds are non-reproducible. A new major version of Flask or requests could break the app silently during deployment.
- Fix approach: Pin exact versions (e.g., `flask==3.1.0`) or use `pip-compile` from `pip-tools` to generate a lockfile.

## Known Bugs

**Specific Search Makes Two API Calls on Non-Exact Match:**
- Symptoms: When `search_type=specific` and the address does not exactly match, the backend makes a first API call (line 119), determines no exact match, then makes a second API call with `radius=1` (line 147). This silently doubles API quota consumption.
- Files: `server.py` (lines 114-180)
- Trigger: Any "Exact Address" search where the address string does not substring-match the returned `formattedAddress`.
- Workaround: None. Users are unaware they consumed 2 API calls.

**ZIP Code Search Ignores Radius Parameter:**
- Symptoms: When searching by ZIP code, the `radius` parameter is not passed to the RentCast API. The backend sets `zipCode` but omits `radius` (line 191-192), so results are limited to the exact ZIP code boundary regardless of the user's radius slider setting.
- Files: `server.py` (lines 190-194)
- Trigger: Search with a 5-digit ZIP code using area search.
- Workaround: None. The radius slider has no effect on ZIP code searches but the UI does not indicate this.

**Error Auto-Dismiss Hides Important Messages:**
- Symptoms: Error messages auto-dismiss after 5 seconds via `setTimeout` (line 79-81 in `script.js`). For critical errors like "API key not configured" or "rate limit exceeded," the user may not have time to read and act on the message.
- Files: `static/script.js` (lines 79-81)
- Trigger: Any error response from the API.
- Workaround: Users must read the error quickly or re-trigger it.

## Security Considerations

**XSS via Unescaped Listing Data in innerHTML:**
- Risk: Property card creation (`createPropertyCard`) and modal content (`openPropertyModal`) use template literals injected into `innerHTML` without sanitizing data from the RentCast API. If the API ever returns HTML or script tags in fields like `formattedAddress`, `propertyType`, `agent.name`, `agent.website`, or `agent.email`, the content is rendered as HTML.
- Files: `static/script.js` (lines 142-166 in `createPropertyCard`, lines 240-345 in `openPropertyModal`)
- Current mitigation: None. The app trusts the RentCast API to return clean data.
- Recommendations: Use `textContent` instead of `innerHTML` for data fields, or sanitize all API data before insertion. For the `agent.website` link, validate that the URL starts with `https://` to prevent `javascript:` URLs.

**CORS Open to All Origins:**
- Risk: `CORS(app)` with no arguments allows requests from any origin. Any website can make API calls to the backend and consume RentCast API quota.
- Files: `server.py` (line 17)
- Current mitigation: None.
- Recommendations: Restrict CORS to the actual frontend origin: `CORS(app, origins=["http://localhost:5000"])` or the production domain.

**Debug Mode Enabled in Production:**
- Risk: `app.run(debug=True)` (line 277) enables the Werkzeug debugger, which provides an interactive Python console on error pages. If this server is exposed to the network, anyone can execute arbitrary Python code.
- Files: `server.py` (line 277)
- Current mitigation: Only runs when `__name__ == '__main__'` (not via gunicorn), but developers may deploy this way.
- Recommendations: Use `app.run(debug=os.getenv('FLASK_DEBUG', 'false').lower() == 'true')` or use a proper WSGI server (gunicorn) for production.

**API Key Exposed in Raw Error Messages:**
- Risk: The `requests.exceptions.RequestException` catch block passes `str(e)` directly to the client (line 185, line 249). Some request exceptions include the full URL with headers in their string representation, potentially leaking the API key.
- Files: `server.py` (lines 182-186, lines 246-250)
- Current mitigation: None.
- Recommendations: Log the full exception server-side and return a generic error message to the client: `"An unexpected error occurred. Please try again."`

**No Rate Limiting on Backend:**
- Risk: The backend has no rate limiting. An attacker can repeatedly hit `/api/search` to exhaust the RentCast API quota, which is a paid resource.
- Files: `server.py` (entire `/api/search` endpoint)
- Current mitigation: None.
- Recommendations: Add `flask-limiter` with per-IP rate limits (e.g., 10 requests per minute).

## Performance Bottlenecks

**No Response Caching:**
- Problem: Every search request makes a synchronous HTTP call to the RentCast API. Identical searches within seconds of each other each consume a full round-trip and API call.
- Files: `server.py` (lines 119, 147, 197)
- Cause: No caching layer exists. The backend is a pure pass-through proxy.
- Improvement path: Add in-memory caching with TTL (e.g., `cachetools.TTLCache` keyed by query parameters) for 5-10 minutes. This reduces API quota usage and improves response times for repeated searches.

**Synchronous Flask Server:**
- Problem: Flask's built-in development server handles one request at a time. Under concurrent load, requests queue.
- Files: `server.py` (line 277)
- Cause: Using `app.run()` instead of a production WSGI server.
- Improvement path: Deploy with gunicorn (`gunicorn -w 4 server:app`) or switch to an async framework if high concurrency is expected.

**Full Listing Data Sent to Client:**
- Problem: The entire RentCast API response payload is forwarded to the client without filtering. Each listing contains many fields the UI never displays, increasing payload size.
- Files: `server.py` (lines 131, 166, 217-223)
- Cause: No response transformation or field filtering.
- Improvement path: Extract only the fields needed by the frontend before returning the JSON response. This reduces bandwidth and improves mobile performance.

## Fragile Areas

**Exact Address Match Logic:**
- Files: `server.py` (lines 124-129)
- Why fragile: The "exact match" detection uses naive string comparison (lowercase + remove commas/periods + substring check). This fails for common address variations: "St" vs "Street", "Apt 3" vs "Unit 3", different ordering, abbreviations.
- Safe modification: Replace with a fuzzy matching library (e.g., `fuzzywuzzy` or `rapidfuzz`) with a configurable threshold. Test with diverse address formats.
- Test coverage: No tests exist for this logic.

**Distance Calculation Center Point:**
- Files: `server.py` (lines 44-53, `geocode_from_listings` function)
- Why fragile: The "center" coordinate is taken from the first listing's lat/lon, not the actual search location. If the first listing happens to be far from the search center, all distance calculations are inaccurate and sorting is wrong.
- Safe modification: Use a proper geocoding API (Google Maps, Nominatim) to resolve the search query to coordinates. Use those as the actual center point.
- Test coverage: No tests exist for this function.

**Frontend State via Global Variable:**
- Files: `static/script.js` (line 9)
- Why fragile: `currentListings` is a mutable global array. Any future feature (sorting, filtering, pagination) that modifies this array can silently corrupt state for other features.
- Safe modification: Encapsulate state in a module or use a simple state management pattern. Ensure state mutations go through a single update function.
- Test coverage: No frontend tests exist.

## Scaling Limits

**RentCast API Quota:**
- Current capacity: Depends on plan (free tier is ~50 calls/month).
- Limit: Each search uses 1-2 API calls. With no caching, a few active users can exhaust the quota within hours.
- Scaling path: Implement response caching with TTL. Consider storing listing data in a local database and syncing periodically rather than real-time proxying.

**Single-Process Development Server:**
- Current capacity: One concurrent request.
- Limit: Any concurrent user request blocks until the current RentCast API call completes (~1-5 seconds).
- Scaling path: Deploy with gunicorn (4+ workers) behind nginx. For higher scale, switch to an async framework (FastAPI) with connection pooling.

**No Database:**
- Current capacity: Zero persistent data storage.
- Limit: Cannot implement user accounts, saved searches, search history, favorites, or any stateful feature.
- Scaling path: Add SQLite for MVP, PostgreSQL for production. Use an ORM like SQLAlchemy.

## Dependencies at Risk

**Flask Development Server Used as Runtime:**
- Risk: There is no production WSGI server in `requirements.txt` (no gunicorn, no uwsgi). The only way to run the app is `python server.py` which starts the Werkzeug development server.
- Impact: Not suitable for production deployment. Poor performance, security risks (debug mode), no graceful restarts.
- Migration plan: Add `gunicorn>=21.0.0` to `requirements.txt`. Add a `Procfile` or startup script: `gunicorn -w 4 -b 0.0.0.0:5000 server:app`.

**No Minimum Python Version Specified:**
- Risk: No `.python-version`, `pyproject.toml`, or runtime specification exists. The code uses f-strings and type hints (Python 3.6+) but this is not documented.
- Impact: Developers or deployment environments may use incompatible Python versions.
- Migration plan: Add a `.python-version` file (e.g., `3.11`) or a `pyproject.toml` specifying `requires-python = ">=3.10"`.

## Missing Critical Features

**No Test Suite:**
- Problem: Zero test files exist in the entire project. No unit tests, integration tests, or end-to-end tests.
- Blocks: Cannot safely refactor, cannot run CI checks, cannot verify bug fixes. Any change risks breaking existing functionality without detection.

**No Logging:**
- Problem: The server uses no logging framework. Errors are returned to clients but not recorded server-side. There is no way to diagnose issues, track API usage, or monitor errors in production.
- Blocks: Debugging production issues, monitoring API quota usage, detecting abuse.

**No Deployment Configuration:**
- Problem: No Dockerfile, docker-compose, Procfile, or any deployment manifest exists. No CI/CD pipeline configuration.
- Blocks: Reproducible deployment, automated builds, production hosting.

**No Environment Validation on Startup:**
- Problem: If `RENTCAST_API_KEY` is missing, the app starts successfully but every search fails with a 400 error. There is no startup check that fails fast.
- Blocks: Quick detection of misconfiguration in deployment environments.

## Test Coverage Gaps

**Entire Application is Untested:**
- What's not tested: Every function, every route, every edge case.
- Files: `server.py`, `static/script.js`
- Risk: Any change to the codebase (refactoring, bug fixes, new features) can silently break existing functionality. The search logic, address matching, distance calculation, error handling, and input validation are all untested.
- Priority: High -- this is the single most impactful concern. Before any other work, a basic test suite should be established covering:
  1. `/api/search` with valid parameters (mock RentCast API)
  2. `/api/search` with invalid parameters (missing query, bad radius/limit)
  3. `/api/health` endpoint
  4. `calculate_distance` with known coordinate pairs
  5. `geocode_from_listings` with empty/populated listing arrays
  6. Address matching logic in specific search

---

*Concerns audit: 2026-03-06*
