# GMCC Property Search Dashboard

A property search tool that matches real estate listings against GMCC loan programs using RentCast listing data, FFIEC census tract data, and deterministic eligibility rules.

## Architecture

The project is split into two separately deployed services:

```
frontend/        ← Next.js app (Vercel)
server.py        ← Python/Flask matching microservice (Vercel, @vercel/python)
```

```
Browser → Next.js (Vercel)
            ├── /api/search, /api/marketing-search   → RentCast API (server-side)
            ├── /api/match, /api/programs, etc.       → Python microservice
            └── /api/generate-flier                  → Firebase Cloud Functions
```

- **Next.js** handles all RentCast API calls, Google Places autocomplete, and PDF flier generation via Firebase
- **Python microservice** handles program matching, FFIEC census tract lookup, and Census Bureau geocoding — it has no external API key requirements of its own
- **Firebase Cloud Functions** (`fillPdfFlier`) generates branded PDF fliers — deployed separately, source not in this repo

---

## Local Development

### 1. Python backend

```bash
pip install -r requirements.txt
cp .env.example .env        # fill in your keys
python server.py             # runs on http://localhost:5001
```

### 2. Next.js frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local   # fill in your keys
npm run dev                         # runs on http://localhost:3000
```

The frontend proxies matching requests to `http://localhost:5001` by default (set via `PYTHON_SERVICE_URL`).

---

## Environment Variables

### Python backend (`/.env`)

| Variable | Description |
|---|---|
| `RENTCAST_API_KEY` | Not used by Python — listed here for reference only |
| `GEMINI_API_KEY` | Gemini Flash for AI talking points (`/api/explain`) |
| `GOOGLE_PLACES_API_KEY` | Not used by Python — listed here for reference only |

> The Python service itself only needs `GEMINI_API_KEY`. All other keys live in the Next.js env.

### Next.js frontend (`/frontend/.env.local`)

See `frontend/.env.local.example` for the full list with descriptions.

| Variable | Where used |
|---|---|
| `RENTCAST_API_KEY` | Server-side: property search and marketing search routes |
| `GOOGLE_PLACES_API_KEY` | Server-side: address autocomplete and Maps widget |
| `GEMINI_API_KEY` | Server-side: email subject/body suggestion |
| `PYTHON_SERVICE_URL` | Server-side: URL of the Python matching microservice |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Client-side: Firebase Auth (sign-in for flier generation) |
| `NEXT_PUBLIC_AZURE_CLIENT_ID` | Client-side: Azure AD / MSAL (GMCC SSO) |
| `NEXT_PUBLIC_AZURE_TENANT_ID` | Client-side: Azure AD tenant |

---

## Vercel Deployment

Both services are deployed on Vercel from the same repo but as separate projects:

| Project | Root directory | Runtime |
|---|---|---|
| Frontend | `frontend/` | Node.js (Next.js) |
| Python backend | `/` (repo root) | `@vercel/python` (serverless) |

**Environment variables** must be set in each Vercel project's Settings → Environment Variables panel separately — they are not shared.

The frontend `PYTHON_SERVICE_URL` must point at the deployed Python backend URL (e.g. `https://your-python-project.vercel.app`).

### Transferring to a GitHub organization

When transferring the repo:
1. Transfer on GitHub (Settings → Transfer)
2. In the Vercel dashboard, go to each project → Settings → Git → Disconnect → Reconnect to the new org/repo path
3. All environment variables, custom domains, and deployment history are preserved

---

## Programs

Program eligibility rules live in `data/programs/` as JSON files. Each file defines tiers with criteria (county FIPS, LMI tract requirement, state restrictions, loan limits, etc.).

**Primary programs** (shown as badges in search results and filter dropdowns):
- GMCC Jumbo CRA
- GMCC Diamond
- GMCC Fabulous Jumbo
- GMCC Grandslam
- GMCC $10K Grant
- GMCC Special Conforming

**Secondary programs** (shown only in property modal under "Additional Program Matches"):
- GMCC Hermes
- GMCC Ocean
- GMCC Celebrity Jumbo
- GMCC Massive
- GMCC Universe
- GMCC Buy Without Sell First

To add a new program: create a JSON file in `data/programs/` following the existing schema, then add the program name to `SECONDARY_PROGRAM_NAMES` in `matching/matcher.py` if it should be secondary-only.

---

## Key Source Files

| File | Purpose |
|---|---|
| `server.py` | Flask app — all API routes |
| `matching/matcher.py` | Rule-based eligibility engine |
| `matching/census.py` | Census Bureau geocoder + FFIEC tract lookup + ACS demographics |
| `matching/models.py` | Pydantic models (ListingInput, ProgramResult, etc.) |
| `rag/schemas.py` | EligibilityTier and ProgramRules schemas |
| `data/programs/` | Program rule JSONs |
| `data/tract_lookup.json` | Pre-processed FFIEC tract data (from CensusTractList2026.xlsx) |
| `data/county_fips.json` | County FIPS → name, state, lat/lng, cities |
| `frontend/src/app/` | Next.js pages and API routes |
| `frontend/src/components/` | React components |
| `FILL_PDF_FLIER_API.md` | Firebase Cloud Function API spec for PDF generation |

---

## Integration Notes

This dashboard is intended to be integrated into the GMCC main website. The current architecture supports two integration paths:

**Option A — Embed as iframe or sub-route**: Deploy as-is and embed via iframe or mount at a sub-path (e.g. `/tools/property-search`). Minimal refactor required.

**Option B — Migrate matching to TypeScript**: Port `matching/matcher.py` and `matching/census.py` to TypeScript and run everything as Next.js API routes. Eliminates the separate Python deployment. Recommended for tighter integration.

The matching engine is pure rule-based logic with no external state — it's straightforward to port if needed.
