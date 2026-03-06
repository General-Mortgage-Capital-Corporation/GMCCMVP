# Codebase Structure

**Analysis Date:** 2026-03-06

## Directory Layout

```
GMCCMVP/
├── .env                # Environment variables (RENTCAST_API_KEY) - gitignored
├── .gitignore          # Git ignore rules
├── .planning/          # Planning and analysis documents
│   └── codebase/       # Codebase analysis docs (this file)
├── README.md           # Project overview and setup instructions
├── requirements.txt    # Python dependencies (4 packages)
├── server.py           # Flask backend - API proxy, static serving, all server logic
└── static/             # Frontend assets served by Flask
    ├── index.html      # Single-page HTML shell with search form, results grid, modal
    ├── script.js       # All frontend JavaScript - API calls, DOM rendering, event handlers
    └── styles.css      # All styles - CSS custom properties, responsive design
```

## Directory Purposes

**Root (`/`):**
- Purpose: Project root containing the single backend file and configuration
- Contains: `server.py` (the entire backend), `requirements.txt`, `.env`, `.gitignore`, `README.md`
- Key files: `server.py` is the only Python file and the sole backend entry point

**`static/`:**
- Purpose: Frontend assets served by Flask's static file handler
- Contains: HTML, JavaScript, and CSS files -- no build step, no bundling
- Key files: `index.html` (page structure), `script.js` (all behavior), `styles.css` (all styling)
- Note: Flask serves this directory via `send_from_directory('static', ...)` configured at `server.py` line 16

**`.planning/codebase/`:**
- Purpose: Codebase analysis documentation for planning and execution
- Contains: Markdown analysis files (ARCHITECTURE.md, STRUCTURE.md, etc.)
- Generated: Yes, by GSD mapping process
- Committed: Yes

## Key File Locations

**Entry Points:**
- `server.py`: Flask application entry point. Run with `python server.py`. Starts on port 5000.
- `static/index.html`: Browser entry point. Served at `GET /`.

**Configuration:**
- `.env`: Environment variables. Contains `RENTCAST_API_KEY`. Never committed.
- `requirements.txt`: Python package dependencies (flask, flask-cors, requests, python-dotenv).
- `.gitignore`: Ignores `.env`, `__pycache__/`, `*.pyc`, `.venv/`, `venv/`.

**Core Logic:**
- `server.py` (278 lines): ALL backend logic lives here. Contains:
  - Lines 26-41: `calculate_distance()` -- Haversine formula for distance between coordinates
  - Lines 44-53: `geocode_from_listings()` -- Extracts center coordinates from first listing
  - Lines 56-65: Static file serving routes (`/` and `/static/<path>`)
  - Lines 68-258: `search_listings()` -- Main search endpoint with area/specific branching
  - Lines 261-267: `health_check()` -- Health endpoint
  - Lines 270-277: App startup with `__main__` block

- `static/script.js` (449 lines): ALL frontend logic lives here. Contains:
  - Lines 1-39: Utility functions (formatPrice, formatSqft, formatPhone, formatDistance)
  - Lines 45-55: API function (`searchListings`) -- single fetch call
  - Lines 61-197: UI functions (showLoading, showError, updateStats, createPropertyCard, renderListings)
  - Lines 203-354: Modal functions (openPropertyModal, closeModal)
  - Lines 360-448: Event handlers and DOMContentLoaded initialization

- `static/styles.css` (667 lines): ALL styles. Contains:
  - Lines 1-35: CSS custom properties (colors, shadows, radii, font)
  - Lines 56-68: Layout (`.app`, `.main`)
  - Lines 74-105: Header
  - Lines 111-270: Search section (form, inputs, buttons, range slider)
  - Lines 276-304: Stats bar
  - Lines 310-346: Results grid
  - Lines 352-447: Property cards
  - Lines 453-473: No results state
  - Lines 479-600: Modal
  - Lines 606-617: Footer
  - Lines 623-658: Responsive breakpoints (768px, 480px)

**Testing:**
- No test files exist in the codebase.

## Naming Conventions

**Files:**
- Backend: Single `server.py` file, snake_case
- Frontend: Lowercase single-word names (`index.html`, `script.js`, `styles.css`)
- Config: Standard names (`requirements.txt`, `.env`, `.gitignore`)

**Python Functions:**
- snake_case: `calculate_distance()`, `search_listings()`, `health_check()`, `geocode_from_listings()`

**JavaScript Functions:**
- camelCase: `formatPrice()`, `searchListings()`, `handleSearch()`, `createPropertyCard()`, `openPropertyModal()`

**CSS Classes:**
- BEM-like with hyphens: `.property-card`, `.property-card-content`, `.modal-section-title`, `.btn-primary`
- Semantic naming: `.search-section`, `.results-grid`, `.stats-bar`

**HTML IDs:**
- camelCase: `searchForm`, `searchQuery`, `resultsSection`, `modalOverlay`, `statsBar`

## Where to Add New Code

**New API Endpoint:**
- Add route handler in `server.py` following the pattern of `search_listings()` or `health_check()`
- Use the `@app.route()` decorator
- Return JSON via `jsonify()` with `{success: bool, ...}` envelope
- Add error handling with try/except around external API calls

**New Frontend Feature:**
- Add HTML structure in `static/index.html`
- Add behavior in `static/script.js` -- follow the section-comment pattern (`// ===== Section Name =====`)
- Add styles in `static/styles.css` -- follow the section-comment pattern (`/* ======= Section ======= */`)
- Bind event listeners in the `DOMContentLoaded` block at the bottom of `script.js`

**New Utility Function:**
- Python utilities: Add as module-level functions in `server.py` above the route handlers
- JavaScript utilities: Add in the "Utility Functions" section of `static/script.js` (after line 14)

**New Python Dependency:**
- Add to `requirements.txt` with minimum version (e.g., `package>=1.0.0`)
- Import at top of `server.py`

**New Static Asset (images, icons, etc.):**
- Place in `static/` directory
- Reference via `/static/filename` in HTML/CSS/JS
- Flask serves automatically via the existing `/static/<path:filename>` route

## Special Directories

**`.planning/`:**
- Purpose: Contains codebase analysis and planning documents
- Generated: Yes, by GSD mapping
- Committed: Yes

**`__pycache__/`:**
- Purpose: Python bytecode cache
- Generated: Yes, automatically by Python
- Committed: No (gitignored)

**`.venv/` or `venv/`:**
- Purpose: Python virtual environment
- Generated: Yes, by user during setup
- Committed: No (gitignored)

## Scale Notes

This is a small MVP codebase:
- 3 source files total (1 Python, 1 JS, 1 CSS) plus 1 HTML template
- ~1,400 total lines of source code
- No build pipeline, no bundler, no transpilation
- No database, no ORM, no migrations
- No test infrastructure
- Monolithic file structure -- if the project grows, it will need to be split into modules

---

*Structure analysis: 2026-03-06*
