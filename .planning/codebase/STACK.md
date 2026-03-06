# Technology Stack

**Analysis Date:** 2026-03-06

## Languages

**Primary:**
- Python 3.12+ - Backend server (`server.py`)

**Secondary:**
- JavaScript (ES6+, vanilla) - Frontend interactivity (`static/script.js`)
- HTML5 - Page structure (`static/index.html`)
- CSS3 - Styling with custom properties (`static/styles.css`)

## Runtime

**Environment:**
- Python 3.12+ (local system Python; no `.python-version` or `runtime.txt` pinning detected)

**Package Manager:**
- pip
- Lockfile: **missing** - only `requirements.txt` with minimum version constraints (e.g., `flask>=3.0.0`)

## Frameworks

**Core:**
- Flask >=3.0.0 - Web server and API routing (`server.py`)
- Flask-CORS >=4.0.0 - Cross-origin request handling (`server.py`, line 17)

**Testing:**
- Not detected - no test framework or test files present

**Build/Dev:**
- None - no build tooling. Flask dev server (`app.run(debug=True)`) is the only dev server. No bundler, transpiler, or task runner.

## Key Dependencies

**Critical:**
- `flask` >=3.0.0 - Serves both the API and static frontend files. Single entry point for the entire application.
- `requests` >=2.31.0 - HTTP client for proxying requests to the RentCast API (`server.py`, lines 119, 147, 197)
- `python-dotenv` >=1.0.0 - Loads `.env` file for API key configuration (`server.py`, line 14)

**Infrastructure:**
- `flask-cors` >=4.0.0 - Enables CORS on all routes (`server.py`, line 17)

**Frontend (CDN):**
- Google Fonts: Inter (weights 400, 500, 600, 700) - loaded via `<link>` in `static/index.html` (line 9-10)

## Configuration

**Environment:**
- Environment variables loaded from `.env` file via `python-dotenv`
- `.env` file present (not committed; listed in `.gitignore`)
- Required env var: `RENTCAST_API_KEY` - API key for RentCast property data service

**Application Constants (hardcoded in `server.py`):**
- `API_BASE_URL`: `https://api.rentcast.io/v1/listings/sale` (line 21)
- `DEFAULT_LIMIT`: 20 (line 22)
- `MAX_LIMIT`: 50 (line 23)
- Dev server port: 5000 (line 277)

**Build:**
- No build configuration. The application runs directly via `python server.py`.
- No `Procfile`, `Dockerfile`, or CI/CD config detected.

## Platform Requirements

**Development:**
- Python 3.12+ installed
- pip for dependency installation (`pip install -r requirements.txt`)
- A valid RentCast API key in `.env`
- No virtual environment tooling enforced (`.gitignore` lists `.venv/` and `venv/`)

**Production:**
- No production deployment configuration detected
- Flask's built-in dev server is the only server (`debug=True` is hardcoded)
- No WSGI server (gunicorn, uwsgi) in dependencies
- No containerization or platform config files

## Frontend Architecture

**Approach:** Server-rendered HTML with vanilla JavaScript
- No frontend framework (React, Vue, etc.)
- No module bundler or build step
- Single HTML page (`static/index.html`) with one JS file (`static/script.js`) and one CSS file (`static/styles.css`)
- Flask serves static files directly from the `static/` folder

**CSS Design System:**
- Custom properties (CSS variables) defined in `:root` of `static/styles.css` (lines 5-35)
- Color palette: slate-based neutrals with blue accent
- Typography: Inter font family via Google Fonts CDN
- Responsive breakpoints: 768px (tablet), 480px (mobile)

---

*Stack analysis: 2026-03-06*
