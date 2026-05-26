# GMCC Property Search Dashboard

An internal tool for GMCC loan officers (LOs). Given an address or filter, it pulls real-estate listings, runs them against GMCC's loan-program eligibility rules (deterministic + census-enriched), and surfaces matching programs. It also covers downstream LO workflows: CRA eligibility checks, refi prospecting, marketing emails, branded PDF fliers, and an AI chat agent that can drive the whole loop.

This document is the take-over guide. Read it end-to-end before touching anything in production.

---

## Table of Contents

1. [What ships in this repo](#what-ships-in-this-repo)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Local development](#local-development)
5. [Environment variables](#environment-variables)
6. [External services & accounts](#external-services--accounts)
7. [Vercel deployment](#vercel-deployment)
8. [Branch strategy](#branch-strategy)
9. [Authentication & access control](#authentication--access-control)
10. [Features (tab-by-tab)](#features-tab-by-tab)
11. [Loan programs](#loan-programs)
12. [Data files](#data-files)
13. [API routes](#api-routes)
14. [Caching (Upstash Redis)](#caching-upstash-redis)
15. [Cron jobs](#cron-jobs)
16. [Analytics (PostHog)](#analytics-posthog)
17. [Testing](#testing)
18. [Operational runbook & gotchas](#operational-runbook--gotchas)
19. [Roadmap / planned work](#roadmap--planned-work)

---

## What ships in this repo

Two separately deployed services living in one git repo:

| Service | Path | Stack | Vercel project |
|---|---|---|---|
| **Frontend** | [frontend/](frontend/) | Next.js 16 (App Router) + React 19 + Tailwind 4 + TS | `gmccmvp` |
| **Python backend** | repo root (entry [server.py](server.py)) | Flask 3 on `@vercel/python` (serverless) | `gmcc-listing-python` |

A third runtime — **Firebase Cloud Functions** — hosts the PDF flier generator (`fillPdfFlier`) and the MSAL → Firebase token exchanger. Source is **not** in this repo; it lives in a separate Firebase project (`gmcc-66e1e`). See [FILL_PDF_FLIER_API.md](FILL_PDF_FLIER_API.md) and [EXCHANGE_MSAL_TOKEN_API.md](EXCHANGE_MSAL_TOKEN_API.md) for their public contracts.

---

## Architecture

```
                      Browser (LO at gmccmvp.vercel.app)
                                 │
                                 ▼
        ┌──────────────────────────────────────────────────┐
        │     Next.js (Vercel, project = gmccmvp)          │
        │                                                  │
        │  middleware.ts          → gmcc_session cookie     │
        │  /api/auth/sso-exchange → MSAL → Firebase token   │
        │  /api/search            → RentCast (server-side) │
        │  /api/match[-batch]     → proxy to Python        │
        │  /api/chat              → AI SDK ToolLoopAgent   │
        │  /api/refi/*            → proxy to Python        │
        │  /api/refi/access       → M365 group / allowlist │
        │  /api/cron/*            → Vercel Cron handlers   │
        │  /api/generate-flier    → Firebase Cloud Func    │
        │  /api/suggest-email     → Gemini                 │
        │  /api/pricing/*         → MLO pricing engine      │
        └──────────────────────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
 ┌───────────────┐   ┌──────────────────────────┐   ┌────────────────┐
 │ Python (Flask │   │   External APIs          │   │ Firebase Cloud │
 │   on Vercel)  │   │  RentCast                │   │   Functions    │
 │               │   │  Google Places / Maps    │   │ fillPdfFlier   │
 │ /api/match    │   │  Gemini Flash            │   │ exchangeMsal…  │
 │ /api/explain  │   │  AI Gateway (Claude)     │   │                │
 │ /api/refi/*   │   │  FFIEC GeoMap            │   │ Firebase Auth, │
 │ /api/programs │   │  Census ACS              │   │ Firestore      │
 │ matching/     │   │  PropertyRadar           │   │ (sentEmails,   │
 │ census, etc.  │   │  Microsoft Graph         │   │  flyers, etc.) │
 └───────┬───────┘   │  PostHog                 │   └────────────────┘
         │           └──────────────────────────┘
         ▼
 ┌──────────────────────┐
 │ Upstash Redis        │
 │ (shared cache:       │
 │  geocode, ACS,       │
 │  refi:search,        │
 │  pr:spend:records)   │
 └──────────────────────┘
```

Three things to internalize:

1. **The Python service is pure matching.** It has no DB, no auth, and the only third-party key it needs is `GEMINI_API_KEY` (for AI talking points) plus `PROPERTY_RADAR_API_ACCESS_TOKEN` (for refi). Everything else lives in Next.js.
2. **Auth is layered.** Browser signs in with MSAL → Next.js exchanges that for a Firebase token via Cloud Function → Next.js sets a `gmcc_session` cookie → all subsequent API calls send `Authorization: Bearer <firebase-id-token>`. The cookie is a UX marker only; per-request auth happens inside each API route.
3. **Upstash Redis is the production source of truth for cache.** Local file caches exist for dev convenience but are no-ops on Vercel (`/var/task` is read-only).

---

## Repository layout

```
GMCCMVP/
├── server.py                  Flask app (entry for @vercel/python)
├── vercel.json                Python backend Vercel config
├── Procfile                   Local gunicorn process def
├── requirements.txt           Python deps
├── pytest.ini
│
├── matching/                  Python matching engine
│   ├── matcher.py             Rule-based eligibility engine
│   ├── census.py              FFIEC + Census ACS lookup (with retry)
│   ├── geocode.py             Address normalization
│   ├── explain.py             Gemini-powered talking points
│   ├── models.py              Pydantic models (ListingInput, results)
│   ├── property_types.py
│   ├── propertyradar.py       PR API client + quota log
│   ├── refi_presets.py        6 curated refi scenarios
│   ├── refi_search.py         UI-filter → PR Criteria normalizer + tract enrichment
│   └── cache.py               Upstash Redis client
│
├── rag/                       (Legacy folder — RAG was removed March 2026.
│   ├── schemas.py             Schemas + config still live here.)
│   └── config.py
│
├── data/
│   ├── programs/              22 program JSONs — eligibility rules per program
│   ├── knowledge/             RAG knowledge base for the AI agent (markdown)
│   ├── tract_lookup.json      FFIEC tract data, derived from CensusTractList2026.xlsx
│   ├── diamond_tracts.json
│   ├── county_fips.json
│   ├── msa_lookup.json
│   ├── pr_cache/              Local refi cache (gitignored, dev-only)
│   ├── pr_quota_log.jsonl     Local refi quota log (gitignored, dev-only)
│   └── *.pdf, *.pptx          Original program guideline files (reference)
│
├── tests/                     pytest — matching engine + API contract tests
│   ├── conftest.py
│   ├── test_api_match.py
│   ├── test_matching.py
│   └── test_schemas.py
│
├── scripts/
│   ├── pr_spike.py            One-shot PropertyRadar exploration script
│   └── DAY1_FINDINGS.md
│
├── frontend/                  Next.js app (separate Vercel project)
│   ├── package.json
│   ├── next.config.ts         outputFileTracingRoot hoisted to repo root so
│   │                          /api/chat can read ../data/{knowledge,programs}
│   ├── vercel.json            Cron schedules + security headers
│   ├── src/
│   │   ├── middleware.ts      Auth gate (session cookie check)
│   │   ├── app/
│   │   │   ├── page.tsx       Main dashboard (6 tabs)
│   │   │   ├── layout.tsx
│   │   │   ├── login/         Login page
│   │   │   └── api/           All Next.js API routes (see "API routes" below)
│   │   ├── components/        React components grouped by feature
│   │   │   ├── auth/, cra/, chat/, flier/, marketing/, pricing/, program/,
│   │   │   ├── property/, refi/, search/, shared/
│   │   │   └── (top-level: PropertyCard, PropertyModal, FollowUpDashboard, …)
│   │   ├── contexts/AuthContext.tsx
│   │   ├── hooks/             useSearch, usePagination, useRateSheets
│   │   ├── lib/
│   │   │   ├── api.ts                Frontend → backend client
│   │   │   ├── python-client.ts      Server-side proxy to Flask
│   │   │   ├── agents/gmcc-agent.ts  AI SDK ToolLoopAgent definition
│   │   │   ├── tools/                21 agent tools (one per file)
│   │   │   ├── pricing/              MLO pricing engine wrappers
│   │   │   ├── rate-sheets/          SharePoint rate-sheet sync
│   │   │   ├── services/             Email draft, follow-up, realtor research
│   │   │   ├── voice/                TTS + speech recognition
│   │   │   ├── auth-token.ts, authed-fetch.ts, firebase-auth.ts,
│   │   │   ├── firestore-admin.ts, graph-client.ts, graph-groups.ts,
│   │   │   ├── msal-config.ts, posthog.ts, refi-access.ts,
│   │   │   ├── rentcast.ts, require-auth.ts, redis-cache.ts,
│   │   │   ├── ratelimit.ts, recent-searches.ts, headshot-store.ts,
│   │   │   ├── lo-info-store.ts, signature-store.ts, match-stream.ts,
│   │   │   └── utils.ts
│   │   └── types/             Shared TS types
│   ├── scripts/               One-off ops scripts (usage-report, follow-up
│   │                           audits, rate-sheet sync triggers)
│   └── public/, assets/
│
├── EXCHANGE_MSAL_TOKEN_API.md Cloud-function contract (MSAL → Firebase)
├── FILL_PDF_FLIER_API.md      Cloud-function contract (PDF flier generator)
├── property-search-unified-pricing.md  Pricing engine design doc
└── .env.example               Python backend env template
```

The `.planning/` directory holds GSD planning documents and is not deployed.

---

## Local development

### Prerequisites

- Python 3.11+ (Vercel runs 3.12)
- Node.js 22.x (the Vercel CLI version installed via nvm)
- `vercel` CLI (`npm i -g vercel@latest` — keep current; CLI 54.5.0+ at time of writing)
- Access to the GMCC Vercel team (`gmcc`)
- Access to the Firebase project `gmcc-66e1e`
- Access to the Azure AD app registration for SSO
- An Upstash Redis database (or share creds with prod for cache parity)

### 1. Python backend

```bash
pip install -r requirements.txt
cp .env.example .env             # fill in keys
python server.py                  # http://localhost:5001
```

Or production-style with gunicorn:

```bash
gunicorn server:app --workers 4 --threads 4 --bind 0.0.0.0:5001
```

### 2. Next.js frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local  # fill in keys
npm run dev                        # http://localhost:3000
```

The frontend proxies matching calls to `PYTHON_SERVICE_URL` (default `http://localhost:5001`).

### Pulling env vars from Vercel (recommended)

```bash
# Frontend
cd frontend && vercel link        # link to project "gmccmvp"
vercel env pull .env.local

# Backend
cd ..        && vercel link        # link to project "gmcc-listing-python"
vercel env pull .env
```

---

## Environment variables

### Python backend (`.env` at repo root)

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | yes (for `/api/explain`) | Gemini Flash — talking-points generation |
| `PROPERTY_RADAR_API_ACCESS_TOKEN` | yes (for refi) | PropertyRadar API |
| `PROPERTY_RADAR_DAILY_RECORD_CAP` | no (default 500) | Hard per-day record cap. Prevents runaway spend |
| `UPSTASH_REDIS_REST_URL` | recommended | Shared cache (geocode, ACS, refi search, daily-spend counter) |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | Pair with the URL above |
| `FRONTEND_ORIGIN` | optional | Extra allowed CORS origin (e.g. ad-hoc preview URL) |
| `FLASK_DEBUG` | dev only | Enables Flask debug mode |
| `PORT` | dev only | Defaults to 5001 |

### Next.js frontend (`frontend/.env.local`)

**Server-side keys (never prefix with `NEXT_PUBLIC_`):**

| Variable | Purpose |
|---|---|
| `RENTCAST_API_KEY` | Property search + marketing search |
| `GOOGLE_PLACES_API_KEY` | Server-side Places autocomplete & Maps |
| `GEMINI_API_KEY` | Email subject/body suggestions |
| `PYTHON_SERVICE_URL` | URL of Flask backend (`http://localhost:5001` or Vercel URL) |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway — Claude Sonnet for chat agent |
| `FIREBASE_PROJECT_ID` | Firebase Admin SDK (verifyIdToken, Firestore reads) |
| `FIREBASE_CLIENT_EMAIL` | Firebase Admin service account |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin service account (note: escape newlines) |
| `AZURE_CLIENT_SECRET` / `AZURE_CLIENT_SECRET_VALUE` | Microsoft Graph (sendMail, group membership) |
| `MLO_PRICING_API_URL` | MLO pricing engine endpoint |
| `MLO_PRICING_API_KEY` | MLO pricing engine auth |
| `APIFY_API_TOKEN` | Realtor research (Apify-hosted scrapers) |
| `ELEVENLABS_TTS_API_KEY` | Voice readout in agent chat |
| `CRON_SECRET` | Shared secret for Vercel Cron handlers |
| `CHAT_TTL_DAYS` | Days to keep chat history (default 4) |
| `POSTHOG_PERSONAL_API_KEY` | (Dev-only, not deployed) Dashboard API access |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Cache + ratelimit |
| `REFI_FINDER_GROUP_ID` *or* `REFI_FINDER_GROUP_MAIL` | M365 group gating refi access |
| `REFI_FINDER_ALLOWED_EMAILS` | Escape-hatch allowlist (comma-separated) |
| `REFI_FINDER_ALLOWED_DOMAINS` | Escape-hatch domain allowlist |

**Client-side (`NEXT_PUBLIC_*` — embedded in the browser bundle):**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase Auth client SDK |
| `NEXT_PUBLIC_AZURE_CLIENT_ID` | MSAL client id |
| `NEXT_PUBLIC_AZURE_TENANT_ID` | MSAL tenant id |
| `NEXT_PUBLIC_POSTHOG_KEY` | PostHog project token |
| `NEXT_PUBLIC_POSTHOG_HOST` | PostHog host (`https://us.posthog.com` for US cloud) |
| `NEXT_PUBLIC_CLOUD_FUNCTIONS_URL` | Firebase Functions base URL |
| `NEXT_PUBLIC_BASE_URL` / `NEXT_PUBLIC_APP_URL` | Public URL of this deployment |

**Vercel-injected (do not set manually):** `VERCEL_URL`, `NODE_ENV`.

---

## External services & accounts

| Service | What it powers | Where keys live |
|---|---|---|
| **Vercel** (`gmcc` team) | Hosting both projects | n/a |
| **RentCast** | Property listings + marketing search | `RENTCAST_API_KEY` |
| **Google Cloud** (Places, Maps JS) | Address autocomplete, map widget | `GOOGLE_PLACES_API_KEY` (restrict by domain in prod) |
| **Google AI Studio** (Gemini Flash) | Talking points, email suggestions | `GEMINI_API_KEY` |
| **Vercel AI Gateway** | Claude Sonnet for the agent (unified provider API, observability) | `AI_GATEWAY_API_KEY` |
| **FFIEC GeoMap + Census ACS** | Census tract + demographics | None (public, has retry for flakiness) |
| **PropertyRadar** (Solo plan + API trial) | Refi prospecting | `PROPERTY_RADAR_API_ACCESS_TOKEN` |
| **Firebase** (project `gmcc-66e1e`) | Auth, Firestore (sentEmails, flyers, LO profiles), Cloud Functions | Multiple |
| **Microsoft Azure AD** | LO SSO (MSAL) | `NEXT_PUBLIC_AZURE_*` + `AZURE_CLIENT_SECRET` |
| **Microsoft Graph** | Send email as LO, resolve M365 group membership | App-only creds via `AZURE_CLIENT_SECRET` |
| **Upstash Redis** | Shared cache + ratelimit + daily-spend counter | `UPSTASH_REDIS_REST_*` |
| **Apify** | Realtor research scrapers | `APIFY_API_TOKEN` |
| **ElevenLabs** | Voice readout of agent responses | `ELEVENLABS_TTS_API_KEY` |
| **PostHog** | Product analytics | `NEXT_PUBLIC_POSTHOG_KEY` + `POSTHOG_PERSONAL_API_KEY` |
| **MLO Pricing engine** | Live rate quotes for pricing tab | `MLO_PRICING_API_*` |
| **SharePoint** | Source of truth for rate sheets | Microsoft Graph creds |

When you take over, **rotate any shared secrets** (Firebase service account, Azure client secret, RentCast key, PropertyRadar token, AI Gateway key) before doing anything else.

---

## Vercel deployment

Two projects under the `gmcc` team:

| Project | Root | Framework | Build |
|---|---|---|---|
| `gmccmvp` (frontend) | `frontend/` | Next.js | `next build` |
| `gmcc-listing-python` (backend) | `/` | `@vercel/python` | `pip install -r requirements.txt` |

[vercel.json](vercel.json) at the repo root wires `server.py` into `@vercel/python` and routes all traffic to it. [frontend/vercel.json](frontend/vercel.json) wires up cron jobs and global security headers.

`gmccmvp-two` is an older frontend Vercel project still active for some legacy workflows; treat it as deprecated.

**Env vars are NOT shared between Vercel projects.** Set them in each project's Settings → Environment Variables (scope: Production / Preview / Development separately). The frontend's `PYTHON_SERVICE_URL` must point at the backend Vercel project's URL for the matching scope.

### vercel.json highlights

- `vercel.json` at root: `@vercel/python` build for `server.py` + catch-all route.
- `frontend/vercel.json`:
  - Crons: `/api/cron/follow-ups` hourly, `/api/cron/sync-rate-sheets` daily at 17:00 UTC.
  - Global headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
  - `/blank.html` overrides X-Frame-Options to `SAMEORIGIN` and disables cache — required for MSAL silent SSO via hidden iframe.

### Deploying

Both projects auto-deploy on push:
- Push to `master` → production deploy on both projects.
- Push to `develop` → preview deploy on both projects (preview URL pattern: `gmccmvp-git-develop-gmcc.vercel.app`).
- Other branches → ad-hoc preview URLs.

Manual deploy from CLI:

```bash
cd frontend && vercel --prod        # production
cd frontend && vercel               # preview
```

---

## Branch strategy

| Branch | Role |
|---|---|
| `master` | Production. Both Vercel projects deploy from here. |
| `develop` | Staging / preview. Same Vercel projects expose preview URLs. Internal staff test here before merge to master. |
| feature branches | Per-feature; produce ad-hoc previews. |

`develop` replaced an older stale `feat/ai-agent-chat` branch in May 2026. Use `develop` for any new in-flight work that should be visible to internal testers.

**Azure AD app registration redirect URIs** must include every preview URL pattern you want SSO to work on (the MSAL client uses `window.location.origin`). If you create a new long-lived branch with its own preview URL, add it to the SPA redirect-URI list in Azure.

---

## Authentication & access control

### Sign-in flow

1. User hits any page → middleware checks for `gmcc_session` cookie → redirects to `/login` if missing.
2. `/login` renders a "Sign in with Microsoft" button. MSAL pops up GMCC's Azure AD tenant.
3. The browser MSAL access token is POSTed to `/api/auth/sso-exchange`, which calls the Firebase Cloud Function `exchangeMsalToken` → returns a Firebase custom token.
4. Browser signs into Firebase Auth with that custom token, gets a Firebase ID token.
5. ID token is POSTed to `/api/auth/session` → Next.js calls `verifyIdToken` (Firebase Admin) → sets `gmcc_session` HttpOnly cookie.
6. All subsequent API calls include `Authorization: Bearer <firebase-id-token>` (see [authed-fetch.ts](frontend/src/lib/authed-fetch.ts) and [require-auth.ts](frontend/src/lib/require-auth.ts)).

### Refi Finder gating

Refi Finder is private-beta gated. Access is granted to any user matching **any** of:

1. Member of the M365 group identified by `REFI_FINDER_GROUP_ID` (UUID, preferred) or `REFI_FINDER_GROUP_MAIL` (resolved via Graph, cached 1h). Member list cached 10 min per Node instance.
2. Email present in `REFI_FINDER_ALLOWED_EMAILS` (comma-separated).
3. Email domain present in `REFI_FINDER_ALLOWED_DOMAINS` (comma-separated).

Implemented in [frontend/src/lib/refi-access.ts](frontend/src/lib/refi-access.ts) and checked by `/api/refi/access` plus every `/api/refi/*` route.

### Microsoft Graph permissions required

App-only (client credentials):
- `Mail.Send` — for `sendMail` outbound flow
- `GroupMember.Read.All` — for refi group membership resolution

---

## Features (tab-by-tab)

The dashboard has six tabs ([frontend/src/app/page.tsx](frontend/src/app/page.tsx)):

### 1. AI Marketing Agent (`chat`, default landing tab)

Natural-language interface that drives the whole workflow — search, match, draft email, send, generate flier, record follow-up.

- **Backend**: [/api/chat](frontend/src/app/api/chat/route.ts) using AI SDK v6 `ToolLoopAgent` with Claude Sonnet via AI Gateway.
- **Agent definition**: [frontend/src/lib/agents/gmcc-agent.ts](frontend/src/lib/agents/gmcc-agent.ts).
- **Tools** (21, one file each in [frontend/src/lib/tools/](frontend/src/lib/tools/)): `search-properties`, `lookup-property`, `match-programs`, `lookup-programs`, `search-by-program`, `check-cra-eligibility`, `draft-email`, `send-email`, `search-sent-emails`, `record-follow-up`, `research-realtor`, `fetch-property-photo`, `generate-flyer`, `generate-csv`, `query-admiral` (pricing), `search-knowledge`, `web-search`, `ask-user`, `ask-for-confirmation`, plus dataset/flyer store helpers.
- **Knowledge base**: markdown in [data/knowledge/](data/knowledge/) (read directly at runtime — no vector store). `next.config.ts` uses `outputFileTracingIncludes` to bundle `data/` into the `/api/chat` function on Vercel; without that hoist, the agent's `searchKnowledge` tool silently returns nothing in production.
- **Persistence**: chat history in Upstash Redis with `CHAT_TTL_DAYS` expiry (default 4). Browsable via `/api/chat/history`.
- **Voice**: optional speech-in (`use-speech-recognition.ts`) and ElevenLabs TTS readout (`tts-engine.ts`).

### 2. CRA Check (`cra`)

Quick "is this address in an LMI tract?" lookup with a side-by-side loan-comparison flyer. Calls Python `/api/match` and renders LMI/CRA-eligible programs.

### 3. Find Properties (`find`)

Address or radius search via RentCast → for each listing call `/api/match-batch` → render program badges. Property modal shows MSA/Census panel + full program eligibility details.

### 4. Search by Program (`program`)

Reverse direction: pick a program → get a streamed result set of listings in counties where that program applies (uses `programSearchStream` and `/api/program-locations` to bound the query).

### 5. Marketing Search (`marketing`)

Filter-driven RentCast search across regions, with table view + extra filters (price, type, days-on-market) and PostHog event instrumentation.

### 6. Refi Finder (`refi`) — private beta

PropertyRadar-powered refi prospecting. Preset → preview count (free) → fetch records (paid, capped) → drill-in modal → unlock phone/email (separately billed) → CSV export.

See the [project memory](#) and the architecture below.

```
Backend (Flask):
  matching/propertyradar.py    Thin PR API client + per-call quota log
  matching/refi_presets.py     6 curated presets (rate/term, cash-out, FHA→conv, IRRRL, ARM reset, recent-purchase)
  matching/refi_search.py      UI-filter → PR Criteria normalizer + tract enrichment + 2-tier cache
  matching/cache.py            refi:search:* Redis namespace (cross-LO)
  server.py                    /api/refi/{presets,preview,search,unlock-contact,unlock-preview,quota}

Frontend:
  src/app/api/refi/*           proxy routes
  src/components/refi/         RefiFinderTab orchestrator, results table, detail + unlock modals
```

Critical PropertyRadar gotchas (each one cost real records to learn — keep them):

- **API trial is separate from the regular trial.** Activate via PR Account Settings → API → "Get API Free Trial". Otherwise every call returns `access_denied`.
- **`Fields=All` is NOT a superset of `LimitedREI`** — it drops loan + owner fields. Use the curated `REFI_GRID_FIELDS` constant in [matching/propertyradar.py](matching/propertyradar.py).
- **50-field hard cap on `Fields`.** Fieldset names expand into their constituents for counting.
- **Cost is per row, not per field.** Fetching one record with one field or fifty costs the same.
- **`Purchase=0` previews are free.** Always preview before fetching.
- **`FirstPurpose` enum** is `CashOut|Construction|ELOC|PMoney|R&TRefi|Reverse|Wrap|Unknown` — not the `P/R/C/U` shorthand the reference doc lists.
- **Phone/email unlocks are a SEPARATE paid budget** (~8¢ each on Solo plan), not against the record quota.

Cost rails:

- All paid calls go through `propertyradar.fetch_search` / `get_property` / `get_transactions` / `get_document`, which log to `data/pr_quota_log.jsonl` (local) and increment Redis `pr:spend:records:<UTC-date>` (production).
- `PROPERTY_RADAR_DAILY_RECORD_CAP` (default 500) enforces a hard cap. `QuotaCapExceeded` → 429 `{code: 'daily_cap'}`.
- UI ALWAYS shows explicit cost copy before any paid action ("Fetching the first 25 will charge 25 records (9,975 remaining)").

---

## Loan programs

Program eligibility rules live in [data/programs/](data/programs/) as JSON, one file per program. Schema is defined by `ProgramRules` in [rag/schemas.py](rag/schemas.py).

**Primary programs** (shown as badges in search results and the program-filter dropdown):

- GMCC Jumbo CRA
- GMCC Diamond CRA
- GMCC Fabulous Jumbo
- GMCC Grandslam
- GMCC $10K Grant
- GMCC Special Conforming

**Secondary programs** (shown only inside the property modal under "Additional Program Matches"):

- GMCC Hermes
- GMCC Ocean
- GMCC Celebrity Jumbo
- GMCC Massive
- GMCC Universe
- GMCC Buy Without Sell First

The `SECONDARY_PROGRAM_NAMES` constant in [matching/matcher.py](matching/matcher.py) controls this split.

To add a program:

1. Drop a new JSON in [data/programs/](data/programs/) matching the existing schema (tiers, criteria, county FIPS, state restrictions, loan limits, occupancy, property types, etc.).
2. If it's secondary-only, add the `program_name` to `SECONDARY_PROGRAM_NAMES`.
3. Verify with `pytest tests/test_matching.py`.
4. The Thunder program was deleted in March 2026 — don't restore it without checking with product.

---

## Data files

| File | Origin | Used by |
|---|---|---|
| `data/programs/*.json` | Hand-curated from program PDFs/PPTs (kept alongside in `data/` for reference) | `matching/matcher.py` |
| `data/tract_lookup.json` | Derived from `CensusTractList2026.xlsx` | `matching/census.py` (LMI lookups) |
| `data/diamond_tracts.json` | GMCC Diamond program's eligible tract list | Diamond CRA matching |
| `data/county_fips.json` | County FIPS → name, state, lat/lng, cities | Server.py county helpers |
| `data/msa_lookup.json` | County FIPS → MSA | Display in property modal |
| `data/knowledge/marketing-guidance.md` | LO copywriting reference | Agent's `searchKnowledge` tool |
| `data/pr_cache/` | Local-dev refi cache (gitignored) | `matching/refi_search.py` |
| `data/pr_quota_log.jsonl` | Local-dev quota log (gitignored) | `matching/propertyradar.py` |

To regenerate `tract_lookup.json` from a new FFIEC release: drop the new `CensusTractList<year>.xlsx` in `data/` and run the conversion script (TODO — script not currently in repo; do it ad-hoc or write one).

---

## API routes

### Flask backend ([server.py](server.py))

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness |
| GET | `/api/cache-stats` | Upstash key counts by namespace |
| GET | `/api/programs` | List all loadable programs |
| POST | `/api/match` | Match one listing → returns programs + census data |
| POST | `/api/match-batch` | Up to 50 listings in parallel (`ThreadPoolExecutor`) |
| POST | `/api/program-rules` | Raw JSON for given program names |
| POST | `/api/explain` | Gemini Flash talking points for a (listing, program) pair |
| GET | `/api/program-locations` | Program → state → county hierarchy |
| GET | `/api/county-info` | 5-digit FIPS → lat/lng/state |
| GET | `/api/refi/presets` | Catalog of refi presets |
| POST | `/api/refi/preview` | Free record count for filter |
| POST | `/api/refi/search` | Paid, paged record fetch (tract-enriched) |
| POST | `/api/refi/unlock-preview` | Cost preview for phone/email unlock |
| POST | `/api/refi/unlock-contact` | Paid phone/email unlock |
| GET | `/api/refi/quota` | Today's PR record spend + remaining cap |

CORS allows `localhost:3000`, the `gmccmvp-two*.vercel.app` pattern, plus an optional `FRONTEND_ORIGIN`. If you stand up a new frontend Vercel project, add its origin pattern in [server.py](server.py).

### Next.js routes (`frontend/src/app/api/**`)

Major handlers:

- `auth/sso-exchange` — MSAL → Firebase token swap
- `auth/session` — set/clear `gmcc_session` cookie (verifies Firebase ID token)
- `search`, `marketing-search` — RentCast wrappers
- `match`, `match-batch` — proxy to Flask
- `programs`, `program-locations`, `program-search` — proxy to Flask
- `chat` — AI agent endpoint (streaming)
- `chat/history`, `chat/download` — conversation persistence
- `cra-check` — CRA tab backend
- `refi/{access,presets,preview,quota,search,unlock-contact,unlock-preview}` — proxy + access gate
- `realtor-research` — Apify scrapers
- `suggest-email`, `suggest-multi-email` — Gemini email drafts
- `follow-up` — record/dismiss follow-up reminders
- `generate-flier` — POSTs to Firebase Cloud Function `fillPdfFlier`
- `pricing/*` — MLO pricing engine integration
- `rate-sheets/*` — read latest rate sheet
- `place-details`, `place-photo`, `autocomplete`, `maps-key` — Google Places helpers
- `zillow-photos` — fallback photo lookup
- `tts` — ElevenLabs proxy
- `admin/usage` — per-LO email stats (Firestore aggregation)
- `cron/follow-ups` — hourly follow-up dispatcher
- `cron/sync-rate-sheets` — daily SharePoint → cache sync
- `health` — liveness

Auth: every authenticated route uses `requireAuth` from [require-auth.ts](frontend/src/lib/require-auth.ts) which validates the Firebase Bearer token via Firebase Admin. Cron routes validate `Authorization: Bearer <CRON_SECRET>` instead.

---

## Caching (Upstash Redis)

A single Upstash database. Namespaced keys, no `KEYS` scans in prod paths.

| Namespace | TTL | Cross-LO | Purpose |
|---|---|---|---|
| `geocode:*` | long | yes | FFIEC GeoMap address-geocode results |
| `acs:*` | long | yes | Census ACS demographics by tract |
| `refi:search:*` | 24h | yes | Hashed PropertyRadar query results |
| `pr:spend:records:<UTC-date>` | 48h | yes | Daily PR record-spend counter (INCRBY atomic) |
| `chat:*` | `CHAT_TTL_DAYS` | per-user | Conversation history |
| `ratelimit:*` | short | per-IP/user | API rate limits ([ratelimit.ts](frontend/src/lib/ratelimit.ts)) |

Cache keys for refi search are SHA256 of normalized criteria + page + limit (stable JSON sort, so filter key order is irrelevant). `cache_hit: true|false` is returned in every search response; UI shows a "cached · no records charged" pill when true.

The Python-side wrapper is [matching/cache.py](matching/cache.py). The Next.js wrapper is [frontend/src/lib/redis-cache.ts](frontend/src/lib/redis-cache.ts). Both read the same Upstash REST URL/token.

---

## Cron jobs

Two Vercel Cron jobs declared in [frontend/vercel.json](frontend/vercel.json):

| Schedule (UTC) | Path | Purpose |
|---|---|---|
| `0 * * * *` (hourly) | `/api/cron/follow-ups` | Scan Firestore `sentEmails`, send follow-up nudges where rules match. |
| `0 17 * * *` (daily 17:00 UTC) | `/api/cron/sync-rate-sheets` | Pull latest rate sheet from SharePoint into Upstash cache. |

Both validate `Authorization: Bearer ${CRON_SECRET}`. To test locally:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/follow-ups
```

Drain / audit scripts live in `frontend/scripts/`:

- `check-follow-ups.ts` — dry-run the follow-up rules
- `drain-follow-up-backlog.ts` — manual catch-up
- `check-recipient-overlap.ts` — detect double-sends
- `usage-report.ts` — per-LO email activity report

Run with `cd frontend && npx tsx scripts/<name>.ts`.

---

## Analytics (PostHog)

Project token: `NEXT_PUBLIC_POSTHOG_KEY` (env). Project id: `394518`. Dashboard: "GMCC LO Activity" (id `1503275`).

Events emitted from the client (see [posthog.ts](frontend/src/lib/posthog.ts)):

- `user_signed_in`
- `property_search` (all three search tabs)
- `cra_check`
- `property_viewed`
- `agent_message_sent`
- `email_sent`
- `flyer_previewed`, `flyer_downloaded`, `agent_flyer_downloaded`
- `follow_up_sent`, `follow_up_dismissed`
- `tab_changed`

Plus PostHog autocapture (pageviews + clicks).

When you add a new LO-facing action, sprinkle a `trackEvent(...)` call so the dashboard stays current. Dashboard tiles use `InsightVizNode` wrapping a `TrendsQuery` — a bare `TrendsQuery` at the top level renders empty. Personal API key (`POSTHOG_PERSONAL_API_KEY`) is dev-only; do not deploy.

---

## Testing

```bash
pytest                                # Python: matching engine + API contract
cd frontend && npm run lint            # Frontend: eslint
cd frontend && npx tsc --noEmit        # Frontend: type-check
```

`pytest.ini` defines an `integration` marker for tests that hit the live Gemini API; those are skipped unless a key is present.

There is **no automated frontend test suite** yet. Smoke-test in the browser:

1. Local dev with both servers running.
2. Hit each tab (find, program, marketing, cra, refi, chat).
3. For chat: send "search for houses in 95014 under $2M" and confirm tool calls fire.
4. For refi: pick "Rate-and-term refi" preset → enter zip `95014` → "Preview" should return ~44 rows (free) → "Fetch 25" should succeed and the quota counter should tick up.
5. For CRA: enter `1 Apple Park Way, Cupertino, CA 95014` → confirm non-LMI tract is identified correctly.

Useful refi test markets (validated during build):

- `95014` Cupertino, CA — high-AVM, high-equity, ~44 matches on rate-term-refi preset
- `77002` Houston, TX — non-disclosure state, exposes missing-LTV code paths
- `33139` Miami Beach, FL — condo-heavy, large universe (~252), tests pagination

---

## Operational runbook & gotchas

Hard-won lessons. Read before deploying or refactoring.

### Vercel / deployment

- **Env vars don't apply to existing deployments.** After changing an env var in the Vercel dashboard, redeploy *without* the build cache — "Redeploy with build cache" reuses old bundles.
- **`/var/task` is read-only on Vercel.** Any code that writes to disk under the repo root will 500 in prod. All local-file writes in `matching/cache.py` and `matching/propertyradar.py` are wrapped in `try/except OSError`. Don't undo that.
- **`next.config.ts` hoists `outputFileTracingRoot` one level up** so the chat agent can read `../data/knowledge` and `../data/programs` at runtime. Removing this silently breaks the agent in production.
- **Backend Vercel project had Deployment Protection enabled** on previews at one point and blocked frontend → backend calls with 401. Confirm it's off on `gmcc-listing-python` (the backend is a private API; the frontend's MSAL gate is the real boundary).
- **`/blank.html` headers are special.** MSAL silent SSO requires `X-Frame-Options: SAMEORIGIN` and `Cache-Control: no-store`. The rest of the site is `DENY`. Don't collapse the rule.

### Auth / MSAL

- **MSAL silent SSO uses `/blank.html` as the redirect target** via a hidden iframe. If you change the redirect URI, also change Azure AD's allowed SPA redirect URIs.
- **Azure AD app registration must list every preview URL** you want SSO to work on. The frontend uses `window.location.origin` for the MSAL config.
- **Firebase Admin SDK key is sensitive.** `FIREBASE_PRIVATE_KEY` needs newlines escaped (`\n` literal) when set as a Vercel env var.
- **Azure client secret expires.** Set a reminder; rotate before expiry.

### PropertyRadar (Refi)

See ["Critical PropertyRadar gotchas"](#6-refi-finder-refi--private-beta) above. Plus:

- **Daily record cap rolls at UTC 00:00** (= 4pm Pacific / 5pm PDT). A local-midnight reset is a future knob, not built yet.
- **The audit log file didn't exist on Vercel originally**, so `_today_spend()` returned 0 and the cap was a no-op. Redis-backed counter fixed it; don't remove the Redis path.
- **Phone/email unlocks are NOT in the records cap** — they're a separate PR billing budget. Add a separate Redis counter (`pr:spend:unlocks:<date>`) if/when we want to limit blast radius on bulk unlocks.

### Census / FFIEC

- **Census ACS is flaky.** `matching/census.py` retries up to 3 times and guards against HTML 5xx responses (Census sometimes returns an error page with a 200 status). This fixed intermittent blank `tract_minority_pct`.
- **FFIEC GeoMap requires no key** but is rate-limited. Geocode results are cached aggressively in Upstash; do not bypass.

### Cron jobs

- **CRON_SECRET must be set in Vercel** or every cron run will 401 itself.
- **Hourly follow-ups can rapidly send many emails** if Firestore has a backlog. Use `drain-follow-up-backlog.ts` to dry-run before unleashing.

### Removed / archived

- **Thunder program** was deleted in March 2026. Files still exist as reference PDFs but no JSON in `data/programs/`.
- **ChromaDB / RAG vector pipeline** was removed in March 2026. The `rag/` folder now only contains `schemas.py` and `config.py`. Dependencies (`pymupdf4llm`, `chromadb`, `click`) are gone from `requirements.txt`.
- **`gmccmvp-two`** Vercel project is the older frontend; treat as deprecated but don't delete without checking whether anyone still hits it.

---

## Roadmap / planned work

In flight or queued (May 2026):

- **Refi Finder v1 → v2**: GMCC pricing comparison column, "send to email outreach" row action, LMI tract badge, smarter universe-level caching at `(zip, preset)` granularity, save/name searches per LO. See the project memory for the ranked list.
- **AI Calling Agent**: researched and planned, blocked on compliance review. Do not start implementation without TCPA / state DNC clearance.
- **PostHog events for refi**: `refi_finder.preset_picked`, `refi_finder.search_fetched`, `refi_finder.contact_unlocked`.
- **Integration into GMCC main website** — two paths:
  - **A. Embed as iframe / sub-route** — minimal refactor. Mount at e.g. `/tools/property-search`.
  - **B. Migrate matching to TypeScript** — port `matching/matcher.py` + `matching/census.py` to TS, run as Next.js API routes, drop the Python project. Recommended for tighter integration. The engine is pure rule-based logic with no external state, so the port is mechanical.

---

## Quick links

- Cloud Function contracts: [FILL_PDF_FLIER_API.md](FILL_PDF_FLIER_API.md), [EXCHANGE_MSAL_TOKEN_API.md](EXCHANGE_MSAL_TOKEN_API.md)
- Pricing design doc: [property-search-unified-pricing.md](property-search-unified-pricing.md)
- Original program guidelines: PDFs and PPTs in `data/` and repo root
- Vercel team: `gmcc` — projects `gmccmvp` (frontend), `gmcc-listing-python` (backend)
- Firebase project: `gmcc-66e1e`
- PostHog project id: `394518`
- Develop preview: `https://gmccmvp-git-develop-gmcc.vercel.app`

If you're picking this up cold and something here is wrong or stale, fix it in this file before doing anything else. The README is the contract.
