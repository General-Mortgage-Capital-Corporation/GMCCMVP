# Coding Conventions

**Analysis Date:** 2026-03-06

## Naming Patterns

**Files:**
- Use lowercase single-word filenames: `server.py`, `script.js`, `styles.css`, `index.html`
- No multi-word filenames exist yet; if adding new files, use `snake_case` for Python (e.g., `api_utils.py`) and `kebab-case` or `camelCase` for JS/CSS

**Functions (Python):**
- Use `snake_case` for all functions: `search_listings()`, `calculate_distance()`, `geocode_from_listings()`
- Use descriptive verb-noun naming: `search_listings`, `health_check`, `serve_static`

**Functions (JavaScript):**
- Use `camelCase` for all functions: `formatPrice()`, `searchListings()`, `handleSearch()`, `createPropertyCard()`
- Prefix event handlers with `handle`: `handleSearch()`, `handleSearchTypeChange()`, `handleRadiusChange()`
- Prefix UI state functions with action verbs: `showLoading()`, `showError()`, `hideError()`, `showMessage()`
- Prefix display/render functions with `render` or `create`: `renderListings()`, `createPropertyCard()`
- Prefix formatters with `format`: `formatPrice()`, `formatSqft()`, `formatPhone()`, `formatDistance()`

**Variables (Python):**
- Constants use `UPPER_SNAKE_CASE`: `API_KEY`, `API_BASE_URL`, `DEFAULT_LIMIT`, `MAX_LIMIT`
- Local variables use `snake_case`: `search_query`, `is_zip`, `exact_match_found`, `center_lat`

**Variables (JavaScript):**
- Module-level state uses `camelCase`: `currentListings`
- Local variables use `camelCase`: `searchType`, `errorBanner`, `avgPrice`

**CSS Classes:**
- Use BEM-like `kebab-case`: `property-card`, `property-card-content`, `property-price`
- Component prefix pattern: `property-*`, `modal-*`, `stat-*`, `form-*`, `btn-*`, `badge-*`
- State/modifier suffixes: `form-group-large`, `form-group-button`, `btn-primary`, `badge-days`, `badge-type`

**HTML IDs:**
- Use `camelCase`: `searchForm`, `resultsGrid`, `searchQuery`, `modalOverlay`, `statAvgPrice`

## Code Style

**Formatting:**
- No automated formatter configured (no Prettier, Black, or similar)
- Python: 4-space indentation
- JavaScript: 4-space indentation
- CSS: 4-space indentation
- HTML: 4-space indentation
- When adding formatting tools, configure 4-space indentation to match existing code

**Linting:**
- No linter configured (no ESLint, Flake8, Pylint, or similar)
- Code is manually kept consistent

**Line Length:**
- No enforced maximum; lines tend to stay under 120 characters
- Long template literals in JS span multiple lines freely

## Import Organization

**Python (`server.py`):**
1. Standard library imports (`os`, `math`)
2. Third-party framework imports (`flask`, `flask_cors`)
3. Third-party utility imports (`dotenv`, `requests`)

```python
import os
import math
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests
```

**JavaScript (`static/script.js`):**
- No module imports; uses plain `<script>` tag loading
- All functions are global scope
- No ES modules, no bundler, no import/export

**CSS (`static/styles.css`):**
- No imports; single stylesheet linked from HTML
- Google Fonts loaded via `<link>` tags in `static/index.html`

## Code Organization

**Python - Section Pattern:**
- Module docstring at top
- Imports
- Environment loading (`load_dotenv()`)
- App initialization (`Flask(__name__)`, `CORS(app)`)
- Constants
- Utility/helper functions
- Route handlers (decorated with `@app.route`)
- Main block (`if __name__ == '__main__'`)

**JavaScript - Section Pattern:**
- File-level JSDoc comment
- Sections separated by comment banners using `=` characters:
```javascript
// =============================================================================
// State & Configuration
// =============================================================================
```
- Sections in order: State & Configuration, Utility Functions, API Functions, UI Functions, Modal Functions, Event Handlers, Initialization

**CSS - Section Pattern:**
- Sections separated by comment banners:
```css
/* ==========================================================================
   Section Name
   ========================================================================== */
```
- Sections in order: Variables (:root), Reset, Layout, Header, Search Section, Stats Bar, Message Banner, Results Grid, Property Card, No Results, Modal, Footer, Responsive, Utilities

## Error Handling

**Python Backend (`server.py`):**
- All API routes return JSON with a consistent envelope: `{ success: bool, error?: string, listings?: [], total?: int, ... }`
- Error responses include appropriate HTTP status codes: 400 (bad input), 401 (auth), 429 (rate limit), 500 (server error), 504 (timeout)
- External API calls wrapped in `try/except` blocks catching `requests.exceptions.Timeout` and `requests.exceptions.RequestException`
- User-facing error messages are human-readable strings, not raw exception details
- Pattern for error responses:
```python
return jsonify({
    'success': False,
    'error': 'Human-readable error message.'
}), 400
```

**JavaScript Frontend (`static/script.js`):**
- API calls wrapped in `try/catch` inside `async` functions
- Errors displayed via `showError()` which auto-hides after 5 seconds
- `finally` block used to reset loading state regardless of outcome
- Pattern:
```javascript
try {
    const result = await searchListings(query, radius, limit, searchType);
    if (result.success) {
        // handle success
    } else {
        showError(result.error || 'An error occurred while searching.');
    }
} catch (error) {
    showError('Failed to connect to the server. Please try again.');
} finally {
    showLoading(false);
}
```

## API Response Envelope

All `/api/*` endpoints return this JSON structure:

**Success:**
```json
{
    "success": true,
    "listings": [...],
    "total": 5,
    "exact_match": false,
    "message": null
}
```

**Error:**
```json
{
    "success": false,
    "error": "Human-readable error message."
}
```

Always check `result.success` before accessing data fields.

## Logging

**Framework:** `print()` statements only (no logging framework)
- Startup banner printed with `print()` in `__main__` block
- No request logging, no structured logging
- Flask's built-in debug logging active when `debug=True`

## Comments

**When to Comment:**
- Module-level docstrings on Python files describing purpose
- Docstrings on all Python functions explaining purpose, parameters, and return values
- Inline comments for non-obvious logic (e.g., `# Earth's radius in miles`, `# Determine if input is a zip code`)
- Section-separator comments in JS and CSS to organize code into logical blocks

**Python Docstrings:**
```python
def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculate distance between two coordinates using Haversine formula.
    Returns distance in miles.
    """
```

**JavaScript JSDoc:**
- Single file-level JSDoc comment only: `/** Property Search Dashboard - Frontend JavaScript */`
- No per-function JSDoc

## Function Design

**Size:** Functions are small to medium (5-40 lines). The longest function is `search_listings()` at ~180 lines in `server.py` -- this is an outlier and a candidate for refactoring.

**Parameters:**
- Python: Use type hints on utility functions (`lat1: float`) but not on route handlers
- JavaScript: No type annotations; plain parameter names

**Return Values:**
- Python API routes always return `jsonify({...}), status_code` tuples
- Python utility functions return typed values: `float`, `tuple`
- JavaScript: UI functions return `void`; `createPropertyCard()` returns a DOM element; `searchListings()` returns a Promise

## Module Design

**Exports:** Not applicable -- no module system in use. Python is a single file. JavaScript uses global functions.

**Barrel Files:** None

## CSS Design Tokens

Use CSS custom properties defined in `:root` in `static/styles.css` for all colors, shadows, radii, and fonts:
```css
var(--color-primary)
var(--color-accent)
var(--shadow-md)
var(--radius-lg)
var(--font-sans)
```
Never use hardcoded color values in new CSS; always reference existing design tokens or add new ones to `:root`.

## HTML Patterns

- Semantic HTML5 elements: `<header>`, `<main>`, `<section>`, `<footer>`
- Dynamic content rendered via JavaScript DOM manipulation (`createElement`, `innerHTML`)
- Initial state hidden with `style="display: none;"` on sections that appear after user interaction
- IDs for JS-targeted elements; classes for styling

---

*Convention analysis: 2026-03-06*
