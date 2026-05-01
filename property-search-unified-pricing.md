# Unified Pricing System — Property Search Website

**Audience:** the coding agent building the GMCC property-search website.
**Author context:** the MLO portal owner has authored this with knowledge of every pricing service that already exists. The property-search agent should treat the MLO portal (`mlo.joingmcc.com`) as a black-box service: call its APIs, don't try to replicate its logic.

---

## 1. Goal

Let an LO on the property-search site fan a single scenario across every GMCC program in one round-trip and render unified results.

```
property-search frontend → property-search backend
        │
        │ POST mlo.joingmcc.com/api/public/pricing/quote
        ▼
MLO portal aggregator runs Loannex + QM + BWS in parallel
        │
        ▼
Unified JSON back to property-search → rendered however property-search wants
```

The property-search website **already exists** and owns:
- Property data (address → state, value, type, units, etc.)
- Its own program-matching rules (which programs to surface for which property — out of scope here).
- All UI (property card, scenario modal, results display).

This doc only specs the **new** API surface on the MLO portal that property-search calls. If property-search asks to price a program that turns out not to be eligible for the scenario, the response just says so per-program — no separate eligibility logic on the property-search side.

### Non-goals (Phase 1)
- EPPS pricing — defer until the EPPS API surface is reliable enough.
- LO self-service to enroll in Loannex — if they don't have an account, surface a clear error pointing at Jarrad.
- Loan creation / lock — this is a comparison tool only.

---

## 2. Phase plan

| Phase | Programs | Status |
|---|---|---|
| **Phase 1 (this doc)** | Loannex (Onyx, DSCR, anything Loannex returns), QM jumbo (Thunder, Jubilant, Fabulous), Buy-Without-Sell (Cronus, Onyx, Poseidon) | Build now |
| Phase 2 | EPPS (Nebula, conventional, FHA, VA) | When EPPS API stabilizes |
| Phase 3 | BPL (Ocean, Hermes, Radiant); CRA (Celebrity, GrandSlam, Home Run) | As internal pricing engines are built |

---

## 3. Architecture

The property-search website should **not** integrate directly with Loannex, gmcc-processor, or rate-sheet JSON files. Those credentials and rate sheets all live in the MLO portal, which already aggregates them. Instead, build a single integration to a new MLO-portal endpoint that fans out internally.

```
┌────────────────────────────────────────┐
│  Property Search website (this app)    │
│                                        │
│  /property/[address] page              │
│       │                                │
│       │ POST /api/pricing/quote        │
│       ▼                                │
│  Property-search BACKEND               │
│       │                                │
│       │ POST mlo.joingmcc.com/api/     │
│       │      public/pricing/quote      │
└───────┼────────────────────────────────┘
        │ HTTPS, signed request
        ▼
┌────────────────────────────────────────┐
│  MLO Portal (mlo.joingmcc.com)         │
│  NEW: /api/public/pricing/quote        │
│                                        │
│  Fans out IN PARALLEL to:              │
│   ├── Loannex (api.loannex.com)        │
│   ├── gmcc-processor /aiChat (QM)      │
│   └── In-process BWS engine            │
│       (priceAll() in lib/pricing/...)  │
│                                        │
│  Aggregates → returns unified JSON     │
└────────────────────────────────────────┘
```

### Why this shape

- **One contract for property-search to learn.** Future programs (EPPS, BPL, CRA) plug in on the MLO portal side without touching property-search.
- **Credentials stay put.** Loannex `client_id`/`secret`, the gmcc-processor service account, and the BWS rate sheets all already live in the MLO portal. No new secret distribution.
- **Rate sheet freshness.** The BWS engine reads `lib/pricing/data/{program}/current.json` from the MLO portal's build. The cron job already keeps these updated daily. Property-search would have to re-implement that pipeline otherwise.

---

## 4. The new MLO-portal endpoint

### `POST /api/public/pricing/quote`

Property-search backend → MLO portal. The MLO portal owns this endpoint; it must be **added by the MLO portal team** (the agent reading this doc does NOT build this — it specs the contract that they'll build to).

### Request

The scenario is a superset of every field every engine needs. The aggregator translates this into each engine's native shape internally. Property-search sends one canonical scenario.

```jsonc
{
  "lo_email": "alex@gmccloan.com",
  "programs": ["loannex", "qm_jumbo", "bws"],
  "scenario": {
    // ── REQUIRED in every request ──────────────────────────────────────
    "state": "CA",                  // 2-letter state code
    "loan_amount": 1500000,
    "fico": 740,
    "loan_purpose": "purchase",     // purchase | rate_term_refi | cash_out_refi
    "occupancy": "primary",         // primary | second_home | investment
    "property_type": "sfr",         // sfr | condo | townhouse | multi_unit | manufactured | pud
    "borrower_residency": "us_citizen",  // us_citizen | permanent_resident | npra | foreign_national | other
    "doc_type": "full_doc",         // see "Doc type values" table below
    "dti": 42,                       // back-end DTI as %

    // ── REQUIRED CONDITIONALLY ─────────────────────────────────────────
    // Required if property_type = multi_unit:
    "property_units": 2,            // 1-4

    // Required if loan_purpose = purchase:
    "purchase_price": 2000000,

    // Required if loan_purpose = cash_out_refi:
    "cash_out_amount": 250000,

    // Required if property_type = condo:
    "condo_type": "warrantable",    // warrantable | non_warrantable | condotel

    // Required for QM "Fabulous" product. If absent, Fabulous pricing falls
    // back to non-county-aware rates and may be less accurate for high-balance
    // counties. Send it whenever you have it.
    "county": "Los Angeles",

    // ── OPTIONAL — sent if known, otherwise defaulted (see Assumptions) ─
    "appraised_value": 2000000,     // see Assumptions
    "ltv": 75,                       // see Assumptions
    "lock_period": 30,               // 15 | 30 | 45 | 60. Default 30.
    "loan_type": "first_lien",      // first_lien | second_lien | heloc. Default first_lien.
    "self_employed": false,
    "first_time_homebuyer": false,
    "first_time_investor": false,
    "interest_only": false,
    "forty_year_term": false,
    "buy_without_sell": false,
    "escrow_waived": false,         // false = escrows active. Default false.
    "short_term_rental": false,     // for investment-property scenarios
    "rural_property": false,
    "non_warrantable_condo": false, // shorthand alias; same effect as condo_type = non_warrantable
    "buydown_type": "none",         // none | 3-2-1 | 2-1 | 1-1 | 1-0
    "prepay_penalty_months": 0,     // 0 | 12 | 24 | 36 | 60
    "subordinate_loan_amount": 0,   // for QM Thunder + any second-lien combo
    "secondary_financing_type": "none", // none | first_to_be_paid_off | first_with_second

    // ── CREDIT EVENTS — every field defaults to "none" if omitted ──────
    "credit_event": {
      "mortgage_late_payment": "none",  // none | within_12mo | within_24mo
      "bankruptcy":             "none", // none | chapter_7_lt_4yr | chapter_7_gte_4yr | chapter_13_lt_4yr | chapter_13_gte_4yr
      "foreclosure":            "none", // none | lt_4yr | gte_4yr
      "deed_in_lieu":           "none", // none | lt_4yr | gte_4yr
      "short_sale":             "none"  // none | lt_4yr | gte_4yr
    },

    // ── HELOC / SECOND LIEN extras (only if loan_type ≠ first_lien) ────
    "heloc_drawn_amount": 0,
    "heloc_line_amount": 0,
    "cltv": null,
    "hcltv": null
  }
}
```

#### `programs` values

Any subset of:

| Value | Returns |
|---|---|
| `loannex` | Whatever Loannex's per-LO account returns (Onyx, DSCR, etc.) — typically multiple result rows. |
| `qm_jumbo` | Thunder, Jubilant, Fabulous (gmcc-processor). |
| `bws` | Cronus, Onyx (BWS rate-sheet path), Poseidon — three result rows. |

Note: `loannex` and `bws` can both surface "Onyx". They come back as separate result rows with different `engine` values (`loannex` vs `bws`) — they are pricing the same program through different ladders. Property-search renders both and lets the LO pick.

#### Doc type values (`scenario.doc_type`)

Superset across all engines. The aggregator translates per-engine.

| Value | Loannex `incomeDocumentation` | BWS `doc_type` |
|---|---|---|
| `full_doc` | `FullDocumentation` | `full_doc` |
| `streamlined` | `FullDocumentation` (alt-doc family treated as full) | `streamlined_doc` |
| `1099_12mo` | `Income12Mo1099` | `1099` |
| `1099_24mo` | `Income24Mo1099` | `1099` |
| `asset_depletion` | `AssetDepletion` | `asset_depletion` |
| `bank_stmt_12mo_personal` | `BankStatements12MoPersonal` | `12mo_bank_statement` |
| `bank_stmt_12mo_business` | `BankStatements12MoBusiness` | `12mo_bank_statement` |
| `bank_stmt_24mo_personal` | `BankStatements24MoPersonal` | `12mo_bank_statement` |
| `bank_stmt_24mo_business` | `BankStatements24MoBusiness` | `12mo_bank_statement` |
| `cpa_pnl_12mo` | `PnL12MoCpaPrepared` | `12mo_cpa_pnl` |
| `cpa_pnl_24mo` | `PnL24MoCpaPrepared` | `12mo_cpa_pnl` |
| `wvoe` | `WrittenVerificationOfEmployment` | `wvoe` |
| `dscr` | `DebtServiceCoverageRatio` | (routes to Poseidon DSCR tier) |

#### Assumptions / defaults the aggregator fills in

**Every default below is overridable.** If property-search sends a value for a field, it wins — the aggregator only fills in fields you didn't send (i.e., `undefined`). The defaults exist purely so a minimal scenario form can run a quote without forcing the LO to fill 25 fields. If the LO's actual scenario differs from these conservative defaults, just send the real values.

Conservative ≠ "best chance of qualifying" — it just means the most generic, common case (clean credit, no buydown, full doc, etc.). The defaults don't hide eligibility issues; they assume "vanilla" and leave anything non-vanilla to the LO to specify.

- **`appraised_value`** — defaults to `purchase_price` on purchases; for refis defaults to `loan_amount / (ltv/100)` if `ltv` is given, else request is rejected.
- **`ltv`** — defaults to `round(loan_amount / appraised_value × 100, 2)` if both are given, else request is rejected.
- **`purchase_price`** — for refis, defaults to `appraised_value`. For purchases, **required**.
- **`lock_period`** — `30`.
- **`loan_type`** — `first_lien`.
- **`escrow_waived`** — `false` (escrows active).
- **`buydown_type`** — `none`.
- **`prepay_penalty_months`** — `0`.
- **`credit_event.*`** — every sub-field `none` (clean credit).
- **`self_employed`, `first_time_homebuyer`, `first_time_investor`, `short_term_rental`, `rural_property`, `interest_only`, `forty_year_term`, `buy_without_sell`** — `false`.
- **`condo_type`** — `warrantable` if `property_type = condo` and not specified.
- **`subordinate_loan_amount`** — `0`.
- **`secondary_financing_type`** — `none`.

The aggregator returns a `defaults_applied: ["loan_type", "credit_event", ...]` array in the response so property-search can surface which assumptions were made if needed.

### Response

```jsonc
{
  "request_id": "uuid",
  "scenario_summary": "$1.5M purchase, CA, 75% LTV, 740 FICO, full-doc",
  "results": [
    {
      "program": "onyx",
      "engine": "loannex",          // which backend produced this
      "status": "eligible",          // eligible | ineligible | unavailable | error
      "headline": {                   // for the comparison card
        "best_rate": 6.500,
        "best_points": -0.250,        // negative = rebate
        "best_lock_days": 30,
        "in_target_band": true
      },
      "rates": [                      // full rate ladder for drill-in
        {
          "rate": 6.250,
          "lock_days": 30,
          "price": 99.875,
          "cost_points": 0.125,
          "rebate_points": 0,
          "in_target_band": false
        }
        // ...
      ],
      "conditions": [
        "24mo reserves required on departing property"
      ],
      "rate_sheet_as_of": "2026-04-30",
      "stale_days": 0
    },
    {
      "program": "thunder",
      "engine": "gmcc_processor",
      "status": "ineligible",
      "reasons": ["DTI exceeds 50% limit"]
    },
    {
      "program": "loannex",
      "engine": "loannex",
      "status": "error",
      "error_code": "no_loannex_account",
      "error_message": "alex@gmccloan.com is not provisioned in Loannex. Reach out to Jarrad to get set up."
    }
    // ...one entry per requested program
  ],
  "errors": []                        // top-level transport errors only
}
```

### Behavior contract

- Always returns 200 unless the entire request is malformed. Per-program failures are reported as `status: "error"` entries so the UI can render partial results.
- Each engine call gets a hard timeout (Loannex: 10s, gmcc-processor: 15s, BWS: in-process so basically instant). Timeouts surface as `status: "error"` with `error_code: "timeout"`.
- Engines run **in parallel** server-side. Total response time ≈ slowest engine, not sum.

---

## 5. Auth

### Property-search → MLO portal (locked: shared secret for v1)

**Phase 1: shared secret header.** Property-search backend includes `Authorization: Bearer <PROPERTY_SEARCH_API_KEY>` on every request. MLO portal validates against an env var. Property-search puts the LO's verified email in the request body (`lo_email`); MLO portal trusts that field.

```
Authorization: Bearer <PROPERTY_SEARCH_API_KEY>
Content-Type: application/json
```

**Phase 2 (post-launch): signed JWT.** Migrate to a short-lived (5-min) JWT signed with the shared secret, payload `{ email, exp }`. MLO portal verifies the signature and ignores any `lo_email` body field — uses the JWT-claimed email instead. Tight per-request scope; no impersonation possible if the key leaks. Migration is non-breaking: the MLO portal can accept either auth mode in parallel during cutover.

The MLO portal in either case:
1. Verifies the request is from property-search (shared secret or JWT signature).
2. Lowercases the LO email and uses it to look up `loannex_users[email].userGuid` in Firestore.

### Property-search → its own backend (the user's session)

Property-search already authenticates LOs with Microsoft / Azure AD. The property-search backend **must** extract the email from its verified session — not from a query string, form field, or client-provided header. Trusting client input there would let any LO request pricing as another LO.

```ts
// property-search backend, /api/pricing/quote handler:
const session = await getServerSession();
if (!session?.user?.email) return res.status(401);
const email = session.user.email.toLowerCase();
// ...forward to MLO portal with this email in the body
```

### What the MLO portal does internally

| Engine | Auth strategy | Per-LO check |
|---|---|---|
| Loannex | Looks up `loannex_users[email].userGuid` in Firestore. Mints a fresh Loannex token (`GET /Token` with `clientId` + `secret` headers), then calls `POST /Loans/Prices/{userGuid}`. | **Required.** If no userGuid → return `error_code: "no_loannex_account"`. |
| QM (gmcc-processor) | Mints a Firebase custom token for uid `property-search:{email}`, exchanges for ID token via Google Identity Toolkit, calls `/aiChat` with `Authorization: Bearer <id_token>`. | None — just needs a valid email. |
| BWS (Cronus/Onyx/Poseidon) | None. Reads `lib/pricing/data/{program}/current.json` and runs `priceAll()` in-process. | None — pricing is public-ish; eligibility runs through `validateScenario`. |

---

## 6. "Best rate" / headline strategy

The aggregator returns a `headline` field per result row (or omits it if the row is ineligible / has no rate ladder). It's a **convenience for at-a-glance comparison cards** — not an authoritative judgment of which rate is "best" for the borrower. There's no objectively correct answer; "best" depends on whether the LO is optimizing for lowest rate, lowest cost, biggest rebate, target band for LO commission, etc.

### What the aggregator picks

The same simple rule for every engine, for consistency:

1. Among rows priced at par or rebate (`price ≥ 100`), pick the **lowest rate**. That's the best-rate-no-points option — what most borrowers would shop on.
2. If every row would require the borrower to pay points (price < 100), pick the **lowest-cost** row.
3. Tie-break by lowest rate.

This is intentionally borrower-friendly and engine-agnostic. The previous BWS-side preference for "rebate target band 101.0–101.5" (which is an LO-commission optimization, not a borrower-shopping signal) was dropped during implementation so the contract is consistent.

### Recommended approach for property-search

`headline` is fine as a default for the comparison card glance, but the **full rate ladder** in `result.rates` is always the source of truth. We strongly recommend:

- **Comparison card:** show "From X.XX%" using either `headline.best_rate` (the aggregator's pick) or the absolute lowest rate in `rates`. Keep the UI choice on your side.
- **Drill-in:** show the full rate ladder + adjusters and let the LO pick the rate × cost trade-off they want.
- **AI "best fit" recommendation (optional):** if you want a one-line "we'd suggest program X because…" summary, run a Claude/GPT call AFTER you have the structured `results` JSON. Pass the borrower scenario + the array of result rows and ask the LLM to recommend a program with reasoning. **Don't let the LLM generate or modify rate numbers** — only let it read the structured data and write prose recommendations on top.

The aggregator deliberately doesn't bake an LLM into the response path. It's slow, it's expensive per call, and "best fit" is a UX layer that property-search owns.

---

## 7. Post-implementation findings (read these before designing the UI)

Real numbers from a sample quote (CA, $1.5M purchase, 740 FICO, 75% LTV, full-doc, primary):

| Engine | Rows returned | Notes |
|---|---|---|
| **Loannex** | ~350 eligible | One row per (program × mortgage product × investor combo). For a single program "Easy Choice — Full Documentation" alone, there are separate rows for 5/6 ARM, 7/6 ARM, 10/6 ARM, 30Y Fixed, etc. — each with 9–10 rate options. |
| **gmcc_processor (QM)** | 3 (1 eligible Thunder, 2 ineligible) | One row per QM product. State + occupancy gate eligibility cleanly. |
| **BWS** | 3 | One row per program (Cronus, Onyx, Poseidon). Each carries the full rate ladder for the requested lock period. |

### Implications for property-search UI

- **Loannex's row count is large and varies by scenario.** A naive list will overwhelm the user. Recommended approaches (any of these):
  - Group by `program` prefix (e.g. "Easy Choice — Full Documentation") and collapse all mortgage-product variants underneath.
  - Show only the LO's preferred product types (30Y Fixed, 5/6 ARM) as a default filter.
  - Show top-N best-rate rows per program.
- The `program` field in each result row is already a human-readable string like `"Easy Choice - Full Documentation — 5/6 ARM (30 Yr. Term)"`, suitable for direct display.
- **BWS results are pre-bundled per program** — one row per program with the entire ladder inside. Renders cleanly as 3 cards.
- **QM results are pre-bundled per product** — one row per Thunder/Jubilant/Fabulous. Renders cleanly as 3 cards.

### Other observations

- Ineligibility messages from the QM engine are user-facing quality (e.g., *"Fabulous is only available in Florida"*, *"Jubilant is not available in this state. Jubilant is available in all US states except HI, AK, CA, and FL"*). Property-search can render these verbatim.
- BWS conditions (e.g., "24mo reserves on departing PITIA") come from `validateScenario`'s `quoteConditions` helper. Render in amber/warning color, not red.
- `defaults_applied` came back with ~16 fields for a typical minimal scenario. Property-search can surface these as "We assumed: clean credit, no buydown, …" if it wants the LO to verify.

---

## 8. Error handling reference

The aggregator surfaces every per-program failure inside the response (status 200 unless the request itself is malformed). Property-search is free to render however it wants; this is what each `error_code` means.

| `status` / `error_code` | Meaning |
|---|---|
| `eligible` | Engine returned a rate ladder. `headline` and `rates` populated. |
| `ineligible` (with `reasons`) | Engine returned eligibility data and the scenario doesn't qualify. Reasons array tells the LO what to change. |
| `error` + `no_loannex_account` | LO email not in `loannex_users` Firestore collection. Action: email Jarrad. The aggregator includes the LO email in `error_message`. |
| `error` + `timeout` | Engine exceeded its hard timeout (Loannex 10s, gmcc-processor 15s). Retryable. |
| `error` + `upstream_5xx` | Engine returned 5xx or non-JSON. Retryable. |
| `error` + `malformed_scenario` | Scenario is missing a required field or violates a rule the aggregator enforces (e.g., neither `appraised_value` nor `ltv` provided on a refi). Non-retryable until fixed. |
| `error` + `unknown` | Catch-all. `error_message` carries the raw cause. |

---

## 9. Caching, freshness, idempotency

- **Server-side cache (MLO portal):** cache full responses keyed by `(scenario, programs, lo_email)` for 5 minutes. Loannex sheets can update intraday so don't cache longer.
- **Loannex token cache:** ~50-minute TTL per process (Loannex tokens last 60 minutes). Saves ~300ms per request after warm-up.
- **Stale BWS data:** the response includes `rate_sheet_as_of` and `stale_days` per BWS row. Property-search renders however it likes.
- **Idempotency:** clients can pass an `Idempotency-Key` header to dedupe accidental double-submits. Optional; not Phase 1 critical.

---

## 10. Phase 1 endpoint surface (added on MLO portal)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/public/pricing/quote` | The aggregator. Phase 1 must-have. |
| `GET` | `/api/public/pricing/health` | Returns `{ loannex: "ok", gmcc_processor: "ok", bws: "ok" }`. Optional but cheap. |

Both under `/api/public/...` — distinct from LO-facing portal routes (`/api/loannex/pricing` etc.) which require a NextAuth session.

### Per-engine implementation details (for the MLO portal team building the aggregator)

#### Loannex (called internally by `/api/public/pricing/quote`)

```
Step 1: GET https://api.loannex.com/Token
  Headers: { clientId, secret }
  → { data: { authenticationToken } }

Step 2: POST https://api.loannex.com/Loans/Prices/{userGuid}
  Headers: { Authorization: "Bearer <token>", Content-Type: "application/json" }
  Body: { data: { nexApp: <scenario>, filter?: {...} } }
  → { data: { prices, programs, products, mortgageProducts, investors, ... } }
```

`<scenario>` shape: see [Loannex `nexApp` schema](app/(portal)/loan-portal/pricing/components/LoannexEngine.tsx) — the existing engine UI is the source of truth.

`userGuid` lookup: Firestore `loannex_users` collection, doc ID = lowercased email, field = `userGuid`.

#### QM via gmcc-processor (called internally by `/api/public/pricing/quote`)

```
POST https://us-central1-gmcc-processor.cloudfunctions.net/aiChat
  Headers: { Authorization: "Bearer <firebase_id_token>", Content-Type: "application/json" }
  Body: {
    conversationId: "property-search:<email>:<request_id>",
    messages: [{ role: "user", content: "price" }],
    products: ["thunder", "jubilant", "fabulous"],
    formSubmit: <PricingScenario>,
    drillIn?: <product_id>,
    newScenario: true
  }
```

Returns SSE stream. Parse line-by-line; collect `comparison`, `pricing`, `form` events. If `form` event fires, the scenario is missing required fields — surface to UI.

Token mint: see `lib/services/voiceAgent/pricingEngineAuth.ts` — uses `PRICING_ENGINE_PROJECT_ID`, `PRICING_ENGINE_CLIENT_EMAIL`, `PRICING_ENGINE_PRIVATE_KEY`, `PRICING_ENGINE_API_KEY` env vars. uid = `property-search:<email>`.

#### BWS (in-process inside MLO portal)

```ts
import { priceAll } from "@/lib/pricing/cronus-onyx";
import { validateScenario, quoteConditions } from "@/lib/pricing/validate";

const validations = {
  cronus: validateScenario(input, "cronus"),
  onyx: validateScenario(input, "onyx"),
  poseidon: validateScenario(input, "poseidon"),
};
const quote = priceAll(input);
// Map per-program eligibility + pricing into the unified result shape.
```

`PricingInput` shape: see `lib/pricing/cronus-onyx/types.ts`. The unified scenario passed in the request body needs to be normalized to this — straightforward 1:1 except for the Poseidon tier (default `"a_plus"` if not provided; the engine auto-falls-back through tiers).

---

## 11. Build order (MLO portal side) — STATUS: complete, awaiting deploy

Property-search is independent and starts whenever the contract is firm. The MLO portal owns this work.

1. **Refactor existing Loannex code** into `lib/services/pricing/loannex.ts` — lift out of `app/api/loannex/pricing/route.ts` so the in-portal route and the new public route share the same Loannex caller. ~half day.
2. **Build `lib/services/pricing/qmJumbo.ts`** wrapping `callPricingEngine` from the voice-agent client. ~half day.
3. **Build `lib/services/pricing/bws.ts`** wrapping `priceAll` + `validateScenario`. ~half day.
4. **Define the unified scenario type and translators** in `lib/services/pricing/scenario.ts` — `toLoannexNexApp(scenario)`, `toQmFormSubmit(scenario)`, `toBwsInput(scenario)`. Apply the assumptions/defaults table here. ~1 day.
5. **Build the aggregator endpoint** `/api/public/pricing/quote` — fan-out, per-engine timeout, response shape, shared-secret auth. ~1 day.
6. **Build `/api/public/pricing/health`.** ~half day.
7. **Add Loannex token cache + 5-min response cache.** ~half day.
8. **Smoke-test scripts in `scripts/test/pricing-quote-smoke.sh`** covering: clean LO with all 3 engines eligible; LO without Loannex account (expect `no_loannex_account`); ineligible scenario (expect ineligible rows); timeout simulation. ~1 day.
9. **Hand off to property-search team** with this doc + the smoke-test scripts as canonical examples. They now have everything: contract, sample requests, sample responses, error codes.

Rough total: ~5 working days for MLO portal side.

---

## 10. Success criteria

- A property-search-initiated quote with `programs: ["loannex", "qm_jumbo", "bws"]` returns a complete unified result in <5s for a typical scenario.
- A LO without a Loannex account never blocks the rest of the response — they get one `no_loannex_account` row and the other engines render normally.
- All numbers in the response match what the existing MLO-portal pricing engines produce for the same scenario. No drift, no secondary pricing logic anywhere.
- Adding a 4th engine (Phase 2: EPPS) requires zero changes on the property-search side — just a new value in the `programs` array and new result rows.
- Loannex pricing on a fresh request takes <2s end-to-end with the token cache warm.

---

## 11. Open questions (parking lot)

1. **Idempotency / dedupe** — formalize the `Idempotency-Key` header? Not blocking.
2. **Audit log** — should every `/api/public/pricing/quote` call be logged for analytics (which LO, which programs, which scenarios)? Recommend yes, but implement after Phase 1 ships.
3. **Rate limit per LO** — to prevent runaway loops on the property-search side. Recommend 60 requests/minute per LO email; revisit with usage data.
4. **EPPS readiness** — track separately; the aggregator design accommodates a 4th engine without contract changes.
