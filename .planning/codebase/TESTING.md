# Testing Patterns

**Analysis Date:** 2026-03-06

## Test Framework

**Runner:**
- None configured. No test framework is installed or set up.
- No test configuration files exist (no `pytest.ini`, `setup.cfg`, `jest.config.*`, `vitest.config.*`, or `pyproject.toml`).
- `requirements.txt` contains only runtime dependencies.

**Assertion Library:**
- None

**Run Commands:**
```bash
# No test commands exist yet.
# Recommended setup (see below).
```

## Test File Organization

**Location:**
- No test files exist anywhere in the project.

**Naming:**
- Not established. Recommended convention when adding tests:
  - Python: `tests/test_<module>.py` (e.g., `tests/test_server.py`)
  - JavaScript: `tests/<module>.test.js` (e.g., `tests/script.test.js`) or co-located `static/script.test.js`

**Recommended Structure:**
```
tests/
├── test_server.py          # Python backend tests
├── conftest.py             # Shared pytest fixtures
└── test_script.js          # Frontend JS tests (if added)
```

## Current State: No Tests

The project has zero automated tests. This section documents the recommended approach for adding tests based on the codebase conventions and architecture.

## Recommended Test Setup

### Python Backend

**Framework:** pytest (industry standard for Flask apps)

**Install:**
```bash
pip install pytest pytest-cov
```

**Add to `requirements.txt` or create `requirements-dev.txt`:**
```
pytest>=8.0.0
pytest-cov>=4.0.0
```

**Configuration -- create `pytest.ini` or add to `pyproject.toml`:**
```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_functions = test_*
```

**Run Commands (after setup):**
```bash
pytest                     # Run all tests
pytest -v                  # Verbose output
pytest --cov=.             # With coverage
pytest -x                  # Stop on first failure
```

### Flask Test Client Pattern

Use Flask's built-in test client for API endpoint testing. Based on the app structure in `server.py`:

```python
# tests/conftest.py
import pytest
from server import app

@pytest.fixture
def client():
    """Create a test client for the Flask app."""
    app.config['TESTING'] = True
    with app.test_client() as client:
        yield client

@pytest.fixture
def mock_api_key(monkeypatch):
    """Set a fake API key for testing."""
    monkeypatch.setattr('server.API_KEY', 'test-api-key-123')
```

### Test Structure

**Suite Organization:**
```python
# tests/test_server.py

class TestHealthCheck:
    """Tests for /api/health endpoint."""

    def test_health_returns_200(self, client):
        response = client.get('/api/health')
        assert response.status_code == 200

    def test_health_reports_api_configured(self, client, mock_api_key):
        response = client.get('/api/health')
        data = response.get_json()
        assert data['status'] == 'healthy'
        assert data['api_configured'] is True

class TestSearchListings:
    """Tests for /api/search endpoint."""

    def test_search_requires_query(self, client, mock_api_key):
        response = client.get('/api/search')
        data = response.get_json()
        assert response.status_code == 400
        assert data['success'] is False

    def test_search_rejects_missing_api_key(self, client):
        response = client.get('/api/search?query=90210')
        data = response.get_json()
        assert response.status_code == 400
        assert 'API key not configured' in data['error']
```

**Patterns:**
- Group tests by endpoint/feature using classes
- Use descriptive `test_<what>_<condition>` naming
- Each test asserts one behavior
- Use fixtures for shared setup (client, mock API key)

## Mocking

**Framework:** `unittest.mock` (stdlib) or `pytest-mock`

**Patterns:**
```python
# Mock external RentCast API calls
from unittest.mock import patch, MagicMock

class TestSearchArea:
    @patch('server.requests.get')
    def test_area_search_returns_listings(self, mock_get, client, mock_api_key):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [
            {
                'formattedAddress': '123 Main St, Los Angeles, CA 90001',
                'price': 500000,
                'latitude': 34.05,
                'longitude': -118.25,
                'bedrooms': 3,
                'bathrooms': 2,
                'squareFootage': 1500,
                'propertyType': 'Single Family',
                'daysOnMarket': 14,
                'status': 'Active'
            }
        ]
        mock_get.return_value = mock_response

        response = client.get('/api/search?query=90001&search_type=area&radius=5&limit=10')
        data = response.get_json()

        assert data['success'] is True
        assert len(data['listings']) == 1
        assert data['listings'][0]['price'] == 500000

    @patch('server.requests.get')
    def test_handles_api_timeout(self, mock_get, client, mock_api_key):
        import requests as req
        mock_get.side_effect = req.exceptions.Timeout()

        response = client.get('/api/search?query=90001&search_type=area')
        data = response.get_json()

        assert response.status_code == 504
        assert 'timed out' in data['error']
```

**What to Mock:**
- All `requests.get()` calls to the RentCast API (external dependency)
- `os.getenv()` / `API_KEY` when testing API key validation logic
- Any future external service calls

**What NOT to Mock:**
- Flask test client (use real test client)
- `calculate_distance()` and `geocode_from_listings()` (pure functions -- test directly)
- JSON serialization/parsing
- URL parameter parsing

## Fixtures and Factories

**Test Data:**
```python
# tests/conftest.py

@pytest.fixture
def sample_listing():
    """A single realistic property listing."""
    return {
        'formattedAddress': '456 Oak Ave, Beverly Hills, CA 90210',
        'price': 1250000,
        'latitude': 34.0736,
        'longitude': -118.4004,
        'bedrooms': 4,
        'bathrooms': 3,
        'squareFootage': 2800,
        'lotSize': 6500,
        'yearBuilt': 1985,
        'propertyType': 'Single Family',
        'daysOnMarket': 21,
        'status': 'Active',
        'city': 'Beverly Hills',
        'state': 'CA',
        'zipCode': '90210',
        'listingAgent': {
            'name': 'Jane Smith',
            'phone': '3105551234',
            'email': 'jane@example.com'
        }
    }

@pytest.fixture
def sample_listings(sample_listing):
    """Multiple listings for testing list operations."""
    return [
        sample_listing,
        {**sample_listing, 'price': 950000, 'formattedAddress': '789 Elm St'},
        {**sample_listing, 'price': 1500000, 'formattedAddress': '321 Pine Dr'},
    ]
```

**Location:**
- Shared fixtures: `tests/conftest.py`
- Test-specific data: inline in test functions or as class-level fixtures

## Coverage

**Requirements:** None enforced currently.
- Recommend targeting 80%+ for `server.py` backend logic as a starting point.
- Pure utility functions (`calculate_distance`, `geocode_from_listings`) should have 100% coverage.

**View Coverage (after setup):**
```bash
pytest --cov=. --cov-report=html    # HTML report
pytest --cov=. --cov-report=term    # Terminal summary
```

## Test Types

**Unit Tests (Priority 1 -- add first):**
- Pure functions: `calculate_distance()`, `geocode_from_listings()` in `server.py`
- Input validation logic in `search_listings()` route
- API key checking logic
- Zip code detection (`is_zip` logic)

**Integration Tests (Priority 2):**
- Full request/response cycle through Flask test client
- `/api/search` with mocked RentCast responses for area search, specific search, no results, error cases
- `/api/health` endpoint
- Static file serving (`/`, `/static/<path>`)

**E2E Tests:**
- Not configured. Consider Playwright or Selenium if frontend testing becomes needed.
- The frontend is vanilla JS with no framework, so manual testing is currently the only frontend validation.

## Testable Units in Current Codebase

**`server.py` -- Pure Functions (easy to test, high value):**

| Function | Location | What to Test |
|---|---|---|
| `calculate_distance()` | `server.py:26` | Known coordinate pairs, zero distance, antipodal points |
| `geocode_from_listings()` | `server.py:44` | Empty list, list with coords, list without coords |

**`server.py` -- Route Handlers (require Flask test client + mocking):**

| Route | Location | What to Test |
|---|---|---|
| `GET /` | `server.py:57` | Returns 200, serves HTML |
| `GET /api/search` | `server.py:68` | Missing query, missing API key, zip vs address, area vs specific, API errors, timeout |
| `GET /api/health` | `server.py:261` | Returns status, reports API config state |

**`static/script.js` -- Pure Functions (testable with Node.js or jsdom):**

| Function | Location | What to Test |
|---|---|---|
| `formatPrice()` | `static/script.js:15` | Null, zero, large numbers |
| `formatSqft()` | `static/script.js:20` | Null, formatting |
| `formatPhone()` | `static/script.js:25` | 10-digit, non-standard, null |
| `formatDistance()` | `static/script.js:34` | < 1 mile, > 1 mile, null, 999 sentinel |

## Common Patterns

**Async Testing (for future JS tests):**
```javascript
// If using Jest/Vitest for frontend
test('searchListings fetches from API', async () => {
    global.fetch = jest.fn(() =>
        Promise.resolve({
            json: () => Promise.resolve({ success: true, listings: [] })
        })
    );

    const result = await searchListings('90210', 5, 10, 'area');
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/search'));
});
```

**Error Testing (Python):**
```python
class TestSearchErrorHandling:
    @patch('server.requests.get')
    def test_401_returns_invalid_key_message(self, mock_get, client, mock_api_key):
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_get.return_value = mock_response

        response = client.get('/api/search?query=90210&search_type=area')
        data = response.get_json()

        assert response.status_code == 401
        assert 'Invalid API key' in data['error']

    @patch('server.requests.get')
    def test_429_returns_rate_limit_message(self, mock_get, client, mock_api_key):
        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_get.return_value = mock_response

        response = client.get('/api/search?query=90210&search_type=area')
        data = response.get_json()

        assert response.status_code == 429
        assert 'rate limit' in data['error']
```

---

*Testing analysis: 2026-03-06*
