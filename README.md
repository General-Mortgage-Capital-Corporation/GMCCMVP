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
15. [Email deliverability (Bouncer)](#email-deliverability-bouncer)
16. [Cron jobs](#cron-jobs)
17. [Analytics (PostHog)](#analytics-posthog)
18. [Testing](#testing)
19. [Operational runbook & gotchas](#operational-runbook--gotchas)
20. [Roadmap / planned work](#roadmap--planned-work)

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
                      Browser (LO at gmccmvp-two.vercel.app)
                                 │
                                 ▼
        ┌──────────────────────────────────────────────────┐
        │     Next.js (Vercel)                             │
        │                                                  │
        │  middleware.ts             → gmcc_session cookie  │
        │  /api/auth/sso-exchange    → MSAL → Firebase tok  │
        │  /api/search               → RentCast            │
        │  /api/match[-batch]        → proxy to Python     │
        │  /api/chat                 → AI SDK ToolLoopAgent│
        │  /api/refi/*               → proxy to Python     │
        │  /api/refi/unlock-search   → credit-gated search │
        │  /api/refi/unlock-contact… → credit-gated contact│
        │  /api/refi/activity        → user history page   │
        │  /api/refi-subscription/*  → Bill.com proxies    │
        │  /api/reverse-geocode      → Google Geocoding    │
        │  /api/cron/*               → Vercel Cron handlers│
        │  /api/generate-flier       → Firebase Cloud Func │
        │  /api/suggest-email        → Gemini              │
        │  /api/pricing/*            → MLO pricing engine  │
        └──────────────────────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       ▼                         ▼                         ▼
 ┌───────────────┐   ┌──────────────────────────┐   ┌─────────────────────┐
 │ Python (Flask │   │   External APIs          │   │ Firebase Cloud Fns  │
 │   on Vercel)  │   │  RentCast                │   │ fillPdfFlier        │
 │               │   │  Google Places / Maps    │   │ exchangeMsalToken   │
 │ /api/match    │   │  Gemini Flash            │   │ billcomWebhook      │
 │ /api/explain  │   │  AI Gateway (Claude)     │   │ billcomAddon*       │
 │ /api/refi/*   │   │  FFIEC GeoMap            │   │ billcomCancel…      │
 │ /api/programs │   │  Census ACS              │   │ billcomRefiFinder…  │
 │ matching/     │   │  PropertyRadar           │   ├─────────────────────┤
 │ census, etc.  │   │  Microsoft Graph         │   │ Firebase Auth +     │
 └───────┬───────┘   │  PostHog                 │   │ Firestore (gmcc-66e1e):
         │           │  Bill.com (via cloud fns)│   │  users/{email}/…    │
         │           └──────────────────────────┘   │  subscriptions/…    │
         ▼                                          │  creditPacks/…       │
 ┌──────────────────────────┐                       │  meta/refiFinder    │
 │ Upstash Redis            │                       │  sentEmails, flyers │
 │  geocode, ACS            │                       └─────────────────────┘
 │  refi:search   (3d TTL)  │
 │  refi:contacts (365d TTL)│
 │  pr:spend:records        │
 │  chat history            │
 └──────────────────────────┘
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
│   ├── propertyradar.py       PR API client (daily cap retired May 2026)
│   ├── refi_presets.py        6 curated refi scenarios
│   ├── refi_search.py         UI-filter → PR Criteria normalizer + tract enrichment
│   └── cache.py               Upstash Redis client (3d search, 365d contacts)
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
│   │   ├── hooks/             useSearch, usePagination, useRateSheets,
│   │   │                       useRefiSubscription (polled credit balance)
│   │   ├── lib/
│   │   │   ├── api.ts                Frontend → backend client
│   │   │   ├── python-client.ts      Server-side proxy to Flask
│   │   │   ├── cloud-functions.ts    Bill.com cloud-fn helpers (refi credits)
│   │   │   ├── agents/gmcc-agent.ts  AI SDK ToolLoopAgent definition
│   │   │   ├── tools/                21 agent tools (one per file)
│   │   │   ├── refi-credits/         Credit-deduction infrastructure:
│   │   │   │   ├── cycle.ts          Dynamic cycleId from planAnniversary
│   │   │   │   ├── meta.ts           meta/refiFinder cached reader
│   │   │   │   ├── pool-resolver.ts  user → personal pool vs company_buffer
│   │   │   │   ├── subscription.ts   active / buffer / expired / never_subscribed
│   │   │   │   ├── deduct.ts         Atomic deduct + refund + lazy buffer reset
│   │   │   │   ├── activity.ts       logActivity + paginated listActivity
│   │   │   │   ├── perform-unlock.ts Shared deduct→PR→log→refund orchestrator
│   │   │   │   └── types.ts          Shared TS types
│   │   │   ├── pricing/              MLO pricing engine wrappers
│   │   │   ├── rate-sheets/          SharePoint rate-sheet sync
│   │   │   ├── services/             Email draft, follow-up, realtor research
│   │   │   ├── voice/                TTS + speech recognition
│   │   │   ├── auth-token.ts, authed-fetch.ts, firebase-auth.ts,
│   │   │   ├── firestore-admin.ts, graph-client.ts,
│   │   │   ├── msal-config.ts, posthog.ts,
│   │   │   ├── refi-access.ts        Auth-only after Phase 4 gate flip
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
| `UPSTASH_REDIS_REST_URL` | recommended | Shared cache (geocode, ACS, refi search, contacts) |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | Pair with the URL above |
| `FRONTEND_ORIGIN` | optional | Extra allowed CORS origin (e.g. ad-hoc preview URL) |
| `FLASK_DEBUG` | dev only | Enables Flask debug mode |
| `PORT` | dev only | Defaults to 5001 |

> **Retired:** `PROPERTY_RADAR_DAILY_RECORD_CAP` was removed in May 2026 when the per-user credit system shipped. Per-user subscription caps (5K/200) and the buffer cap (2K/200) constrain spend at finer-grained layers above this client.

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
| `REFI_FINDER_PAYMENTS_DISABLED` | Set to `true` to hide Subscribe + Recharge CTAs (coming-soon mode). Mirrors the MLO portal's flag of the same name. Active subscribers and buffer users are unaffected. |
| `BOUNCER_API_KEY` | Bouncer email-deliverability API. Sends are hard-blocked unless the recipient is verified `deliverable`. Pre-paid non-expiring credits; results cached 90 days in Firestore. Leave unset locally and the system fails open (returns `unknown`, send still blocked client-side). |

> **Retired:** `REFI_FINDER_GROUP_ID` / `REFI_FINDER_GROUP_MAIL` / `REFI_FINDER_ALLOWED_EMAILS` / `REFI_FINDER_ALLOWED_DOMAINS` were retired in May 2026 (Phase 4 of the credit-system migration). The new access gate is subscription state + `meta/refiFinder.bufferAllowlist` in Firestore. Delete these env vars from Vercel.

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
| **Bouncer** (usebouncer.com) | Email deliverability verification — gate every outbound LO email | `BOUNCER_API_KEY` |

When you take over, **rotate any shared secrets** (Firebase service account, Azure client secret, RentCast key, PropertyRadar token, AI Gateway key) before doing anything else.

---

## Vercel deployment

Two projects under the `gmcc` team:

| Project | Root | Framework | Build |
|---|---|---|---|
| `gmccmvp` (frontend) | `frontend/` | Next.js | `next build` |
| `gmcc-listing-python` (backend) | `/` | `@vercel/python` | `pip install -r requirements.txt` |

[vercel.json](vercel.json) at the repo root wires `server.py` into `@vercel/python` and routes all traffic to it. [frontend/vercel.json](frontend/vercel.json) wires up cron jobs and global security headers.

**Production URL is `gmccmvp-two.vercel.app`** (the Vercel project may still be named `gmccmvp` — the public alias was kept as `-two` for historical reasons; check the Vercel dashboard if you need to confirm project ↔ alias mapping).

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

1. User hits any page → middleware checks for `gmcc_session` cookie → redirects to `/login` if missing. Middleware also forces `/login` when the URL carries `?sso_hint=` (MLO portal handoff), even if the cookie is present — otherwise a stale cookie would skip the silent-SSO logic that only runs on `/login`.
2. `/login` renders a "Sign in with Microsoft" button. MSAL pops up GMCC's Azure AD tenant. If `?sso_hint=` is present, MSAL `ssoSilent` runs first via a hidden iframe pointed at `/blank.html` — if Azure has a live tenant session, the user is signed in without a click.
3. The browser MSAL access token is POSTed to `/api/auth/sso-exchange`, which calls the Firebase Cloud Function `exchangeMsalToken` → returns a Firebase custom token.
4. Browser signs into Firebase Auth with that custom token, gets a Firebase ID token.
5. ID token is POSTed to `/api/auth/session` → Next.js calls `verifyIdToken` (Firebase Admin) → sets `gmcc_session` HttpOnly cookie. Cookie lifetime: 90 days (matches the typical AAD refresh-token sliding window). The cookie is a UX marker only; the real auth check is the Bearer token on each API call.
6. All subsequent API calls include `Authorization: Bearer <firebase-id-token>` (see [authed-fetch.ts](frontend/src/lib/authed-fetch.ts) and [require-auth.ts](frontend/src/lib/require-auth.ts)).

**Zombie-cookie protection.** Because the cookie's lifetime is decoupled from the real session, a user can end up with a valid cookie but expired Firebase/MSAL state. [AuthContext](frontend/src/contexts/AuthContext.tsx) detects this on mount — if localStorage has no usable user and MSAL silent refresh can't recover one, it `DELETE`s the cookie and bounces to `/login`. Without this, the gate would let the user through to a signed-out dashboard where every API call 401s.

### Refi Finder gating (credit system)

Phase 4 of the credit-system migration (May 2026) retired the env-var allowlist. Access is now subscription-based:

| User state | Behavior |
|---|---|
| **Active subscription** (`creditPacks/refi_finder.cycleEndsAt > now`) | Full UI, deducts from per-user pool. Auto-renews every 30 days via Bill.com. |
| **On bufferAllowlist** (`meta/refiFinder.bufferAllowlist[]` in Firestore) | Full UI, deducts from `creditPacks/company_buffer` (shared 200 contact / 2K property). For dev + managerial staff. |
| **Expired** (paid before, cycle ended, not renewed) | "Your cycle has ended" pitch with Resubscribe button. |
| **Never subscribed** | Marketing pitch + Subscribe ($100/mo) CTA. |

Logic lives in [frontend/src/lib/refi-credits/subscription.ts](frontend/src/lib/refi-credits/subscription.ts) (`resolveSubscription`). It reads:
- `users/{email}/creditPacks/refi_finder` for the per-user pack
- `subscriptions/{email}` for `autoRenewCanceled` (this is the MLO portal's path — flat doc with `refi_finder` as a nested field, NOT a subcollection)
- `meta/refiFinder.bufferAllowlist` for the internal escape hatch

**Cycle math is derived, not stored.** [`cycle.ts`](frontend/src/lib/refi-credits/cycle.ts) computes the active `cycleId` from `meta/refiFinder.planAnniversary` + today's date on every request, so the system has no cron to flip a month-rollover field. Buffer reset is lazy too — first deduction past `cycleStart` does the reset inside the same atomic transaction.

To add/remove bufferAllowlist members: edit the array in `meta/refiFinder` in the Firebase console. No deploy required.

[`refi-access.ts`](frontend/src/lib/refi-access.ts) is now auth-only (verify Firebase ID token, return email). The legacy `/api/refi/access` endpoint reports `has_access` for any signed-in user; the real UI gate is the subscription check inside [`RefiFinderGate.tsx`](frontend/src/components/refi/RefiFinderGate.tsx).

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

### 6. Refi Finder (`refi`) — paid subscription tier

PropertyRadar-powered refi prospecting with a per-user $100/mo credit system. Preset → preview (free) → confirm cost → fetch records (deducts property credits) → drill-in modal → reveal email or text per row (deducts contact credits) → CSV export → activity log of every unlock.

#### Architecture

```
Frontend:
  components/refi/
    RefiFinderGate.tsx     Subscription/buffer wrap; mounts pitch panel
                           or tab + sub-toggle (Search | History)
    RefiFinderTab.tsx      Preset picker, filter form, search flow
    CreditsHeaderPill.tsx  Compact balance in global header (active/buffer only)
    CreditsCard.tsx        Full balance + recharge + cancel-auto-renew
    SubscribeDialog.tsx    SLA acknowledge + Bill.com payment kickoff
    UnlockConfirmDialog.tsx Itemized cost confirmation (batch actions)
    RefiResultsTable.tsx   Two-column Email / Text reveal buttons (credit mode)
    RefiDetailModal.tsx    Drill-in panel
    ActivityLogTable.tsx   User-facing history with revealed values + cached badges
  hooks/useRefiSubscription.ts  Polled status (8s; 3s aggressive during payments)
  lib/cloud-functions.ts        Server-side Bill.com proxies

Next.js routes:
  /api/refi-subscription/
    status                 Read Firestore subscription/buffer state
    acknowledge            SLA marker before invoice creation
    subscribe              Create $100 invoice via billcomAddonCreateInvoice
    recharge               Create $20 / +200 contact-credit invoice
    cancel                 Stop auto-renewal (keeps current cycle's credits)
  /api/refi/
    unlock-search          Credit-gated wrapper around Python /api/refi/search
                           (deduct → call → log → refund on cache_hit OR short rows)
    unlock-contact-paid    Credit-gated wrapper around Python /api/refi/unlock-contact
                           Splits into up to 3 PR calls (email/text/both),
                           per-channel refund when PR returns null
    activity               Paginated user activity log
    {access, presets, preview, search, quota, ...}  Legacy paths still mounted

Python (Flask):
  matching/propertyradar.py    Thin PR API client (no daily cap after May 2026)
  matching/refi_presets.py     6 curated presets
  matching/refi_search.py      Filter → PR Criteria + tract enrichment + 2-tier cache
  matching/cache.py            refi:search 3d / refi:contacts 365d
  server.py                    /api/refi/{presets, preview, search,
                                          unlock-contact, unlock-preview, quota}
```

#### Firestore credit-system schema (Firebase project `gmcc-66e1e`, shared with MLO portal)

```
users/{email}/creditPacks/refi_finder   ← Bill.com webhook writes; we only deduct
  { contactCredits, propertyCredits, cycleEndsAt, billcomCustomerId, history,
    pendingRecharge?, updatedAt }

users/{email}/refiFinderActivity/{auto-id}   ← we write one per discrete action
  { ts, action, propertyId, propertyAddress, ownerName?, creditsUsed,
    propertyRadarRef, drewFromBuffer, balanceAfter,
    revealedValue?, failureReason?, fromCache? }

subscriptions/{email}                     ← legacy path, refi_finder as a field
  { refi_finder: { paymentStatus, billcomRecurringInvoiceId, nextBillingDate,
                   autoRenewCanceled? } }

creditPacks/company_buffer                ← shared by bufferAllowlist
  { contactCredits, propertyCredits, lastResetAt }

creditPacks/company_usage_{cycleId}       ← cycle-total counters (cycleId derived,
                                            see cycle.ts)
  { contactCreditsUsed, propertyCreditsUsed, cycleStart, cycleEnd }

meta/refiFinder                           ← central config
  { bufferAllowlist: ["naitik.poddar@gmccloan.com", "jjin@gmccloan.com"],
    planAnniversary: 19,           // PR billing day of the month
    currentCycleId: "2026-05"      // STALE — we compute this ourselves now
  }
```

#### Cost model

- 1 search row = 1 property credit (deducted upfront; refunded for cached results AND rows PR didn't return)
- 1 email reveal = 1 contact credit (refunded if PR returns null)
- 1 text reveal = 1 contact credit (refunded if PR returns null)
- All deductions go through atomic Firestore transactions in [`deduct.ts`](frontend/src/lib/refi-credits/deduct.ts).
- After-payment latency: ~4-5 min for the Bill.com webhook to fire and the balance to refresh.

#### Cross-LO caching

| Cache | TTL | Effect |
|---|---|---|
| `refi:search:<hash>` | 3 days | Any team member's repeat search is free for everyone for 3 days |
| `refi:contacts:<radar_id>` | **365 days** | Once any team member unlocks a property's contact, everyone gets it free for a year (PR ownership is permanent — see [propertyradar.py:322](matching/propertyradar.py#L322)) |

#### Critical PropertyRadar gotchas (keep these)

- **API trial is separate from the regular trial.** Activate via PR Account Settings → API → "Get API Free Trial".
- **`Fields=All` is NOT a superset of `LimitedREI`** — drops loan + owner fields. Use `REFI_GRID_FIELDS` in [matching/propertyradar.py](matching/propertyradar.py).
- **50-field hard cap on `Fields`.** Fieldset names expand into their constituents.
- **Cost is per row, not per field.**
- **`Purchase=0` previews are free.** Always preview before fetching.
- **`FirstPurpose` enum** is `CashOut|Construction|ELOC|PMoney|R&TRefi|Reverse|Wrap|Unknown`.
- **Phone/email unlocks are a SEPARATE paid budget at PR** (~4¢ on the company plan).
- **PR ownership is permanent.** Once we buy a contact, future `GET /properties/{id}/persons` calls return the owned values inline at no extra cost. Our 365-day Redis cache reflects this.

Untested but likely viable: `fetch_property_persons(purchase=0)` for free ownership detection. If verified, we can wire a "L2 ownership check before paid unlock" path that makes unlocks free indefinitely (not just within the 365-day cache window). See the roadmap.

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

**Auth & session**
- `auth/sso-exchange` — MSAL → Firebase token swap
- `auth/session` — set/clear `gmcc_session` cookie (verifies Firebase ID token; 90d lifetime)

**Search & geo**
- `search`, `marketing-search` — RentCast wrappers
- `place-details`, `place-photo`, `autocomplete`, `maps-key` — Google Places helpers
- `reverse-geocode` — lat/lng → street address (Google Geocoding; used by "Use current location" button)
- `zillow-photos` — fallback photo lookup

**Match & programs**
- `match`, `match-batch` — proxy to Flask
- `programs`, `program-locations`, `program-search` — proxy to Flask
- `cra-check` — CRA tab backend

**AI agent**
- `chat` — AI SDK ToolLoopAgent endpoint (streaming)
- `chat/history`, `chat/download` — conversation persistence

**Refi Finder (credit-gated)**
- `refi-subscription/{status, acknowledge, subscribe, recharge, cancel}` — Bill.com cloud-fn proxies + Firestore status read
- `refi/unlock-search` — credit-gated search (deducts property credits, refunds on cache or short rows)
- `refi/unlock-contact-paid` — credit-gated contact reveal (deducts contact credits, partial refund on null channels)
- `refi/activity` — paginated activity log read

**Refi Finder (legacy / free-tier paths still mounted)**
- `refi/{access, presets, preview, quota, search, unlock-contact, unlock-preview}` — Phase 4 made `access` always return `has_access`; the others are still callable but not gated by the new credit system

**Communications & content**
- `realtor-research` — Apify scrapers
- `suggest-email`, `suggest-multi-email` — Gemini email drafts
- `follow-up` — record/dismiss follow-up reminders
- `generate-flier` — POSTs to Firebase Cloud Function `fillPdfFlier`
- `pricing/*` — MLO pricing engine integration
- `rate-sheets/*` — read latest rate sheet
- `tts` — ElevenLabs proxy

**Admin & ops**
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
| `census:geocode:*` | 90 days | yes | FFIEC GeoMap address geocode |
| `census:coord:*` | 90 days | yes | Coordinate (lat/lng) reverse geocode |
| `census:acs:*` | 30 days | yes | Census ACS demographics by tract |
| `refi:search:*` | **3 days** | yes | Hashed PropertyRadar query results |
| `refi:contacts:v2:<radar_id>` | **365 days** | yes | Person records + unlocked phones/emails (PR ownership is permanent) |
| `pr:spend:records:<UTC-date>` | 48h | yes | Daily PR record-spend counter (cap retired May 2026; counter kept for ops) |
| `chat:*` | `CHAT_TTL_DAYS` | per-user | Conversation history |
| `ratelimit:*` | short | per-IP/user | API rate limits ([ratelimit.ts](frontend/src/lib/ratelimit.ts)) |

Cache keys for refi search are SHA256 of normalized criteria + page + limit (stable JSON sort, so filter key order is irrelevant). `cache_hit: true|false` is returned in every search response; UI shows a "cached · no records charged" pill when true. **The credit-gated routes (`/api/refi/unlock-search`, `/unlock-contact-paid`) refund the user's deducted credits on every cache hit** — the cross-LO cache directly translates to "no charge" for the user.

The Python-side wrapper is [matching/cache.py](matching/cache.py). The Next.js wrapper is [frontend/src/lib/redis-cache.ts](frontend/src/lib/redis-cache.ts). Both read the same Upstash REST URL/token.

### Firestore (separate from Redis — for the credit system)

| Path | Purpose | Writer |
|---|---|---|
| `users/{email}/creditPacks/refi_finder` | Per-user balance + cycleEndsAt | Bill.com webhook (grants); our deduct.ts (decrements) |
| `users/{email}/refiFinderActivity/{auto-id}` | Per-action history with revealed values | Our activity.ts |
| `subscriptions/{email}.refi_finder` | Auto-renewal state, recurring template id | Bill.com cloud functions |
| `creditPacks/company_buffer` | Shared internal pool (200/2K) | MLO portal cron (resets); our deduct.ts (decrements lazily) |
| `creditPacks/company_usage_<cycleId>` | Cycle-total counter | Our deduct.ts (FieldValue.increment) |
| `meta/refiFinder` | bufferAllowlist, planAnniversary | MLO portal admin (manual via Firebase console) |

---

## Email deliverability (Bouncer)

Every outbound LO email is gated by a real-time Bouncer call. We added this in June 2026 after IT flagged that bounces from RentCast-sourced agent emails were hurting the company's M365 sender reputation. Policy is deliberately strict: only Bouncer's `deliverable` status allows a send — `undeliverable`, `risky`, and `unknown` all block at the UI layer with no override.

### Surfaces guarded

| Surface | File | Behavior on non-deliverable |
|---|---|---|
| Single-program email modal | [EmailModal.tsx](frontend/src/components/flier/EmailModal.tsx) | Inline red banner under the field, input border turns red, modal auto-scrolls so the warning is centered. "Did you mean ...?" suggestion is a one-click swap. |
| Multi-program email modal | [MultiEmailModal.tsx](frontend/src/components/flier/MultiEmailModal.tsx) | Same as single. |
| Follow-up dashboard manual send | [FollowUpDashboard.tsx](frontend/src/components/FollowUpDashboard.tsx) | Existing red error banner reports the Bouncer reason. |
| AI agent `sendEmail` tool | [send-email.ts](frontend/src/lib/tools/send-email.ts) | Tool returns a structured `error` with the reason + suggestion. The model reports it back in chat. |
| Cron auto-send follow-ups | [cron/follow-ups/route.ts](frontend/src/app/api/cron/follow-ups/route.ts) | Reads cache only — **never spends Bouncer credits in cron**. If a prior interactive check classified the recipient as non-deliverable, the follow-up is marked `skipped_undeliverable` and never retries. |

### Verification timing — only at Send

Bouncer credits cost money even though pre-paid, so the system deliberately does **not** verify on typing / blur / form-mount. Verification fires only at the moment of a real Send click (or the agent's `sendEmail` tool execute, which runs after `askForConfirmation`). This means:

- The agent can plan + draft against an address it never ends up sending to without burning a credit.
- A user opening the modal but cancelling spends nothing.
- Repeat sends to the same address within 90 days are served from cache → zero new credits.

### Architecture

- **Server lib**: [lib/email-deliverability.ts](frontend/src/lib/email-deliverability.ts) — `verifyDeliverability(email, checkedBy)` (Bouncer call + Firestore write) and `readCachedDeliverability(email)` (cache-only, used by cron). Marked `import "server-only"` so it can't accidentally bundle into the browser.
- **Pure helpers**: [lib/email-deliverability-types.ts](frontend/src/lib/email-deliverability-types.ts) — types + `describeReason()` + `blocksSend()`. Safe for client components (no firebase-admin transitive imports).
- **Client API**: [lib/use-email-validation.ts](frontend/src/lib/use-email-validation.ts) — `verifyEmailForSend(email)` + `isSendAllowed(result)`.
- **Route**: [/api/email/validate](frontend/src/app/api/email/validate/route.ts) — auth-gated POST that wraps `verifyDeliverability`.
- **Inline notice**: [components/EmailValidationIndicator.tsx](frontend/src/components/EmailValidationIndicator.tsx) — `SendBlockedNotice` rendered after a blocked send.

### Firestore cache

- Collection: `emailValidations`
- Doc id: `base64url(lowercased email)` — round-trips losslessly, safe for any Firestore path
- TTL: 90 days (`CACHE_TTL_MS` in `email-deliverability.ts`). After expiry the next send re-verifies.
- Shared across LOs: same address checked by any LO costs one credit total, not N.
- Stored: `{ email, status, reason, didYouMean, checkedAt, checkedBy }`. `checkedBy` is audit-only.

### Bouncer status → UI mapping

| Bouncer status | Examples of `reason` | UI |
|---|---|---|
| `deliverable` | `accepted_email` | ✅ Send proceeds. |
| `undeliverable` | `rejected_email`, `no_mx`, `invalid_domain`, `email_disabled`, `inactive_mailbox` | ❌ Hard block. Reason copy from `describeReason()`. |
| `risky` | `accept_all` (catch-all), `role_based`, `disposable`, `low_quality`, `low_deliverability`, `toxic` | ❌ Hard block. Catch-all domains are blocked under this strict policy — if LOs complain about legitimate corporate catch-alls being rejected, soften `blocksSend()` in `email-deliverability-types.ts`. |
| `unknown` | `unverifiable`, `transient_failure` | ❌ Hard block with "try again" copy. |

### Fail-open posture

If `BOUNCER_API_KEY` is unset or Bouncer is unreachable, the server returns `unknown`. The client UI still blocks (since `unknown` ≠ `deliverable`), so an outage never silently lets bad sends through — it just makes every send fail until Bouncer is reachable again or the key is configured.

### Self-sends skip verification

"Send to Myself" tabs in both flyer modals skip the check entirely (`tab === "myself"`) — the LO's own address is presumed valid and we don't want to spend credits on it.

---

## Cron jobs

Two Vercel Cron jobs declared in [frontend/vercel.json](frontend/vercel.json):

| Schedule (UTC) | Path | Purpose |
|---|---|---|
| `0 * * * *` (hourly) | `/api/cron/follow-ups` | Scan Firestore `sentEmails`, send follow-up nudges where rules match. Auto-send branch reads the Bouncer cache (`emailValidations`) and skips recipients previously flagged non-deliverable — never spends Bouncer credits in cron. Skipped items are marked `followUp.status = "skipped_undeliverable"`. |
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

There is **no automated frontend test suite** yet. A smoke test for the credit infra exists:

```bash
cd frontend && npx tsx --env-file=./.env.local scripts/refi-credits-smoke.ts
# Read-only by default; verifies meta/refiFinder, bufferAllowlist seed,
# pool resolution, subscription resolution.

cd frontend && npx tsx --env-file=./.env.local scripts/refi-credits-smoke.ts --write
# Adds: deduct(1,1) → refund(1,1) → logActivity against company_buffer
# Net zero on the buffer; one extra activity entry under naitik's email.
```

Browser smoke-test:

1. Local dev with both servers running.
2. Hit each tab (find, program, marketing, cra, refi, chat).
3. For chat: send "search for houses in 95014 under $2M" and confirm tool calls fire.
4. For refi (sign in as `naitik.poddar@gmccloan.com` or `jjin@gmccloan.com` — bufferAllowlist seeded): pick "Rate-and-term refi" preset → enter zip `95014` → "Preview" should return ~44 rows (free) → "Fetch 25" pops the confirmation modal showing "25 property credits" → confirm → header pill + in-tab card both drop in lockstep → on a repeat fetch within 3 days, "cached · no records charged" pill appears and credits are refunded.
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

See ["Critical PropertyRadar gotchas"](#6-refi-finder-refi--paid-subscription-tier) above. Plus:

- **The daily record cap (`PROPERTY_RADAR_DAILY_RECORD_CAP`) is retired** as of May 2026. Per-user subscription caps + buffer caps constrain spend at a finer grain. The Redis counter `pr:spend:records:<UTC-date>` is still incremented for ops visibility — no enforcement.
- **Phone/email unlocks are a separate PR budget** — not against the record quota. Add a Redis counter (`pr:spend:unlocks:<date>`) if/when we want to limit blast radius on bulk unlocks (not built yet).

### Refi credit system

- **Cycle math is dynamic** ([cycle.ts](frontend/src/lib/refi-credits/cycle.ts)) — derived from `meta/refiFinder.planAnniversary` + today's date in UTC. `meta/refiFinder.currentCycleId` exists in Firestore but is **stale and ignored** on our side. The MLO portal team's cron will eventually rotate it; we don't depend on it.
- **Buffer reset is lazy** — first deduction past `cycleStart` resets `creditPacks/company_buffer` to 200/2K inside the same Firestore transaction. `lastResetAt` is pinned to `Timestamp.fromDate(cycleStart)` (NOT serverTimestamp) so future checks are deterministic.
- **Subscription doc lives at `subscriptions/{email}`** with `refi_finder` as a *nested field* — NOT `users/{email}/subscriptions/refi_finder`. This bit me on first pass; if you're looking for `autoRenewCanceled`, it's there.
- **Bill.com webhook owns the grant side** ([users/{email}/creditPacks/refi_finder.contactCredits/.propertyCredits](https://us-central1-gmcc-66e1e.cloudfunctions.net/billcomWebhook)). Don't write to those fields directly — your deductions only decrement.
- **`autoPayEnabled: false` in `/api/refi-subscription/acknowledge` is intentional and a no-op for refi_finder.** The deployed cloud function hard-codes `requiresRecurring = type === "refi_finder"`, so refi_finder gets a recurring template regardless of this flag. The field is load-bearing only for yearly addons (loannex, optimalblue, etc.).
- **Two polling loops were a real bug** that's been fixed — the credit pill (page-level) and the in-tab CreditsCard now share a single `useRefiSubscription` hook lifted to [page.tsx](frontend/src/app/page.tsx). Don't call the hook twice; pass props down.
- **`REFI_FINDER_PAYMENTS_DISABLED=true`** hides Subscribe + Recharge CTAs; cancel still works. Coordinate this flag with the MLO portal's matching flag so the two surfaces don't diverge.
- **Cache-hit refunds**: cross-LO cache hits on `refi:search` or `refi:contacts` refund the user's deducted credits and stamp the activity log with `fromCache: true`. See [unlock-search/route.ts](frontend/src/app/api/refi/unlock-search/route.ts) and [unlock-contact-paid/route.ts](frontend/src/app/api/refi/unlock-contact-paid/route.ts).

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

**Shipped May 2026:**
- ✅ Refi Finder credit system (Phases 1–4): per-user subscription + bufferAllowlist + atomic deductions + history + cancel/recharge
- ✅ Cross-LO cache refunds for both search (3d) and contacts (365d)
- ✅ Per-row Email + Text reveal with per-channel null-refund
- ✅ Activity log with revealed values, owner name, full address, cached badges
- ✅ Dynamic cycle math (no cron needed for month rollover)
- ✅ Lazy buffer reset inside deduction transaction
- ✅ `REFI_FINDER_PAYMENTS_DISABLED` flag for coordinated soft-launch with MLO portal
- ✅ Zombie-cookie cleanup in AuthContext
- ✅ "Use current location" button on radius search

**Shipped June 2026:**
- ✅ Refi Finder preset UX: filter-value chips on cards + active scenario header, "Modified" badge, "Reset to scenario defaults" button, prominent "Build from scratch" card, every prefilled filter auto-exposed for editing
- ✅ Bouncer email deliverability gate on all 4 outbound LO email surfaces (single + multi flyer modals, follow-up dashboard, AI agent send tool). Hard block on anything ≠ `deliverable`, 90-day Firestore cache, cron uses cache-only reads

**In flight / queued:**
- **PR `purchase=0` ownership check**: theoretically lets us serve owned contacts forever at no cost (currently 365-day Redis TTL covers ~99% of cases). 10-min API poke to verify; ~30 min to wire if confirmed. See ["PropertyRadar gotchas"](#6-refi-finder-refi--paid-subscription-tier).
- **Universe cache** at `(zip, preset)` granularity: cache 500-row supersets, apply finer filters client-side. Biggest credit-saver of all but more invasive.
- **`get_property` + `get_transactions` Python caching**: not currently called by the refi flow, but worth adding if we surface property detail or transaction history in the UI.
- **PostHog events for refi**: `refi_finder.preset_picked`, `refi_finder.search_fetched`, `refi_finder.contact_unlocked`, `refi_finder.subscribed`, `refi_finder.canceled`, `refi_finder.recharged`, `refi_finder.insufficient_credits`.
- **Refi v2 product ideas**: GMCC pricing comparison column, "send to email outreach" row action, LMI tract badge, save/name searches per LO. See [project memory](#) for the ranked list.
- **AI Calling Agent**: researched and planned, blocked on compliance review. Do not start implementation without TCPA / state DNC clearance.
- **Integration into GMCC main website** — two paths:
  - **A. Embed as iframe / sub-route** — minimal refactor. Mount at e.g. `/tools/property-search`.
  - **B. Migrate matching to TypeScript** — port `matching/matcher.py` + `matching/census.py` to TS, run as Next.js API routes, drop the Python project. Recommended for tighter integration. The engine is pure rule-based logic with no external state, so the port is mechanical.

---

## Quick links

- Cloud Function contracts: [FILL_PDF_FLIER_API.md](FILL_PDF_FLIER_API.md), [EXCHANGE_MSAL_TOKEN_API.md](EXCHANGE_MSAL_TOKEN_API.md)
- Pricing design doc: [property-search-unified-pricing.md](property-search-unified-pricing.md)
- Original program guidelines: PDFs and PPTs in `data/` and repo root
- Vercel team: `gmcc` — frontend project (prod alias: `gmccmvp-two.vercel.app`) + `gmcc-listing-python` backend
- Firebase project: `gmcc-66e1e`
- PostHog project id: `394518`
- Develop preview: `https://gmccmvp-git-develop-gmcc.vercel.app`

If you're picking this up cold and something here is wrong or stale, fix it in this file before doing anything else. The README is the contract.
