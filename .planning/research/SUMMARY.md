# Project Research Summary

**Project:** GMCC Listing Agent -- AI Loan Program Matching (Milestone 2)
**Domain:** RAG-based AI program matching for internal mortgage LO tool
**Researched:** 2026-03-06
**Confidence:** MEDIUM-HIGH

## Executive Summary

The GMCC Listing Agent adds AI-powered loan program matching to an existing Flask + vanilla JS property search tool. The core technical challenge is extracting structured eligibility rules from 5-15 GMCC guideline PDFs and matching them against property listing data from RentCast. Research across all four areas converges on one dominant recommendation: **use a hybrid approach where structured rules handle deterministic matching and the LLM handles explanations and edge cases, rather than relying on pure RAG for eligibility decisions.** This is the single most important architectural decision for the project. Getting it wrong means nondeterministic matching, hallucinated program details, and rapid LO trust erosion.

The recommended stack is deliberately minimal: Gemini 2.0 Flash for LLM inference (cheapest option within project constraints), Google text-embedding-004 for embeddings, ChromaDB for vector storage (in-process, zero infrastructure), PyMuPDF for PDF extraction, Flask-Login with SQLite for auth, and no RAG framework -- direct API calls only. Total new dependencies: 6 packages. API costs at projected scale (20 LOs, 50 searches/day) are approximately $15/month. The architecture extends the existing Flask monolith with new `rag/` and `auth/` modules rather than introducing microservices or infrastructure complexity.

The critical risks are: (1) PDF table/matrix extraction destroying the structure that defines program eligibility rules -- loan guidelines are table-dense and naive extraction produces garbled output; (2) LLM hallucinating plausible but incorrect program terms when retrieval is incomplete -- wrong information is worse than no information for LOs; and (3) no ground truth dataset to validate matching accuracy, making it impossible to know if the system is correct. All three risks are mitigated by the hybrid structured-rules approach: extract rules into validated JSON once, match deterministically, and use the LLM only for natural language explanations with source attribution.

## Key Findings

### Recommended Stack

The stack is optimized for cost and operational simplicity within a single-server Flask architecture. All AI components use Google's ecosystem (Gemini + embeddings) to avoid managing multiple API keys and billing relationships. See `.planning/research/STACK.md` for full details.

**Core technologies:**
- **Gemini 2.0 Flash** (`google-genai` SDK): LLM inference for matching explanations and structured extraction -- best cost/performance ratio at ~$0.10/1M input tokens
- **Google text-embedding-004** (same SDK): Vectorize program guideline chunks -- effectively free at this scale
- **ChromaDB** (>=0.5.0): In-process vector store with persistent disk storage and metadata filtering -- zero infrastructure overhead for 5-15 documents
- **PyMuPDF** (>=1.24.0): Table-aware PDF text extraction -- handles the complex layouts found in mortgage guideline PDFs
- **Flask-Login** (>=0.6.3) + SQLite: Session-based auth for <50 internal users -- right complexity level for an internal tool
- **No RAG framework**: Direct API calls for a single-step pipeline -- LangChain/LlamaIndex add abstraction without value here

**Critical version note:** Google's Python SDK may be `google-genai` or `google-generativeai` -- verify at install time. ChromaDB had breaking API changes between 0.4.x and 0.5.x -- pin exact version.

### Expected Features

The tool fills a unique gap: no existing product combines "search active listings" with "show which of MY lender's programs apply." The competitive frame is "faster and more reliable than an LO's mental recall," not "replace a PPE like Optimal Blue." See `.planning/research/FEATURES.md` for full analysis.

**Must have (table stakes):**
- Program badges on property cards (at-a-glance matching -- the "wow moment")
- Program match detail on click (per-criterion pass/fail -- the "credibility" feature)
- Match confidence indicators (Strong / Possible / Needs Verification)
- Property type, loan amount, and location eligibility matching
- RAG knowledge base from actual GMCC guideline PDFs
- User authentication (login gate for internal tool)

**Should have (differentiators):**
- DSCR/rental program matching with rent estimation (highest-value differentiator -- GMCC's specialty lending play)
- Talking points generation (LLM-generated plain-English summaries per match)
- Program comparison view (side-by-side for LO conversations with realtors)
- Search result filtering by program eligibility (invert the flow: "show me DSCR-eligible properties")
- Multi-property program summary (area-level view: "12 of 20 qualify for FHA")

**Defer (v2+):**
- Rate sheet awareness (separate daily data pipeline)
- Saved searches with alerts (requires background jobs and notifications)
- Branch manager dashboard (analytics layer -- needs user base first)
- Listing agent contact integration (wait until talking points are polished)

### Architecture Approach

The architecture adds three new components alongside the existing search flow: a PDF ingestion pipeline (admin-time), a ChromaDB vector store, and an LLM-powered matching endpoint. The existing search flow remains untouched -- matching is a parallel enrichment step triggered per listing. ChromaDB runs in-process (no separate server). The matching pipeline is ~50-300 lines of direct Python, not a framework. See `.planning/research/ARCHITECTURE.md` for data flows and component details.

**Major components:**
1. **PDF Ingestion Pipeline** (`rag/ingest.py`) -- Extracts text from guideline PDFs, chunks by logical section, embeds and stores in ChromaDB. Runs at admin time, not query time.
2. **Matching Engine** (`rag/matcher.py`) -- Takes listing data, retrieves relevant program chunks, calls LLM for structured matching assessment. Returns JSON with match levels, reasons, and caveats.
3. **LLM Provider Abstraction** (`rag/providers.py`) -- Wraps Gemini/OpenAI behind an interface so providers can be swapped without code changes.
4. **Auth Layer** (`auth/`) -- Flask-Login with SQLite user storage. Session-based, `@login_required` on all API endpoints.
5. **Frontend Integration** -- Match badges on cards (green/yellow/gray), match details in modal, loading states for async LLM calls, login page.

### Critical Pitfalls

Research identified 14 pitfalls, 5 critical. The top pitfalls all point toward the same solution: structured matching over pure RAG. See `.planning/research/PITFALLS.md` for complete analysis.

1. **PDF table/matrix destruction** -- Mortgage guidelines are table-dense. Naive extraction garbles row/column relationships that define eligibility rules. Use table-aware extraction (PyMuPDF with layout awareness), and validate extracted data against source PDFs. Consider manual-assisted extraction for 5-15 programs.

2. **Token-based chunking splits rules mid-section** -- Standard 500-token chunking separates eligibility criteria from their conditions. Chunk by program section instead. With only 5-15 programs, consider no chunking at all -- structured JSON per program may fit entirely in context.

3. **Over-relying on RAG for a rule-based problem** -- Program matching is fundamentally deterministic (property type in list? price in range? location eligible?). Use LLM to extract structured rules once, then match with code. Reserve RAG/LLM for explanations and edge cases.

4. **No ground truth dataset** -- Without 20-30 validated property-to-program test cases, there is no way to measure accuracy or detect regressions. Must be created before or during the knowledge base build phase, not after.

5. **LLM hallucinating program details** -- The LLM fills gaps with industry-standard values that may not match GMCC's specific terms. Mitigate with structured matching first (LLM explains, does not decide), source attribution on all details, temperature 0, and confidence indicators.

## Implications for Roadmap

Based on combined research, the project naturally divides into 5 phases driven by technical dependencies. The critical path is: PDF extraction --> structured rules --> matching engine --> UI integration. Everything else builds on top.

### Phase 1: Program Knowledge Base

**Rationale:** Everything downstream depends on having program data extracted and validated. This is also the highest-risk component (PDF parsing quality, chunking strategy) and benefits from early validation. Must be solved before any matching logic.
**Delivers:** Structured JSON rule sets for each GMCC program + ChromaDB vector store populated with program chunks for explanation retrieval.
**Addresses:** "Program data from guideline PDFs" (table stakes), foundation for all matching features.
**Avoids:** Pitfalls 1 (table destruction), 2 (bad chunking), 3 (over-relying on RAG), 4 (no ground truth).
**Stack:** PyMuPDF, ChromaDB, Google text-embedding-004.
**Key deliverable:** A validation dataset of 20-30 property-to-program test cases created with a GMCC LO, plus extracted structured rules that pass this validation.

### Phase 2: Matching Engine

**Rationale:** Depends on Phase 1 (populated knowledge base). Can be tested via CLI scripts before wiring to API, which enables rapid prompt iteration and accuracy tuning.
**Delivers:** Given listing data, returns structured program matches with confidence levels, reasons, and caveats.
**Addresses:** Core matching logic, match confidence indicators, property type / loan amount / location eligibility.
**Avoids:** Pitfalls 5 (hallucination -- structured matching first), 8 (per-listing LLM cost -- deterministic matching is instant), 9 (embedding mismatch -- metadata-filtered retrieval).
**Stack:** Gemini 2.0 Flash, direct API calls, provider abstraction layer.
**Architecture:** Deterministic rule matching for eligibility decisions. LLM call only for generating natural-language explanations. Cache results by listing address with 1-hour TTL.

### Phase 3: API Endpoints + Frontend Integration

**Rationale:** Depends on Phase 2 (matching engine to call). This is the phase that produces visible end-to-end value -- the "wow moment" of program badges appearing on property cards.
**Delivers:** `/api/match` and `/api/programs` endpoints wired to the frontend. Program badges on cards, match details in modal, loading states.
**Addresses:** Program badges on cards (table stakes), program match detail on click (table stakes), multi-property program summary.
**Avoids:** Pitfalls 10 (no explainability -- per-criterion checklist in modal), 13 (ambiguous match language -- "property eligible" not "qualifies").
**Stack:** Existing Flask server (extended), existing vanilla JS frontend (new render functions).

### Phase 4: Authentication

**Rationale:** Depends on Phase 3 (endpoints to protect). Adding auth before the matching flow works end-to-end creates testing friction. Auth is middleware that wraps existing endpoints without changing matching logic.
**Delivers:** Login page, session management, `@login_required` on all API routes, user management via SQLite.
**Addresses:** User authentication (table stakes).
**Avoids:** Existing security concern (no auth on current app).
**Stack:** Flask-Login, Werkzeug password hashing, SQLite (built-in), gunicorn for production, flask-limiter for rate limiting.

### Phase 5: Enhanced Matching + Admin Tools

**Rationale:** Quality-of-life and differentiator features that build on proven core matching. DSCR matching is the highest-value differentiator and depends on rent estimation. Admin tools depend on the ingestion pipeline (Phase 1) and auth (Phase 4).
**Delivers:** DSCR/rental program matching, talking points generation, admin UI for PDF upload and re-ingestion, program data freshness timestamps.
**Addresses:** DSCR matching (differentiator), talking points (differentiator), program update workflow (operational need).
**Avoids:** Pitfalls 7 (stale data -- admin update workflow), 14 (rate sheet mixing -- separate data concerns from guidelines).
**Stack:** RentCast rent estimate API (if available), Gemini for talking points generation.

### Phase Ordering Rationale

- **Phase 1 first** because it carries the most technical risk (PDF quality, extraction accuracy) and every other phase depends on it. Early validation prevents building on a broken foundation.
- **Phase 2 before Phase 3** because the matching engine needs prompt iteration and accuracy tuning. This is faster via CLI scripts than through the full browser UI.
- **Phase 3 before Phase 4** because end-to-end visibility is needed to validate the product concept. Auth added too early blocks testing and iteration.
- **Phase 4 before Phase 5** because admin tools require auth (admin role), and rate limiting should be in place before adding more API endpoints.
- **Phase 5 last** because DSCR matching and admin tools are high-value but not prerequisites for the core loop. Manual CLI-based ingestion works fine while the admin UI is being built.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** PDF extraction quality is highly dependent on actual GMCC guideline PDF formats. Need real sample PDFs early to validate extraction approach. The structured-vs-RAG decision also needs validation with actual program complexity.
- **Phase 2:** Prompt engineering for matching accuracy will require iteration. The validation dataset from Phase 1 is the testing backbone.
- **Phase 5 (DSCR matching):** Rent estimation approach depends on RentCast API capabilities (separate rent estimate endpoint?) or comparable rent data. Needs API investigation.

Phases with standard patterns (skip deep research):
- **Phase 3:** Flask API endpoints + vanilla JS frontend integration is well-documented, established pattern. No novel technical challenges.
- **Phase 4:** Flask-Login session auth is a solved problem with extensive documentation and examples. Straightforward implementation.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All recommended technologies are mature, stable, and well-suited to the scale. Only uncertainty: exact Google SDK package name (verify at install). |
| Features | MEDIUM | Feature prioritization is sound, but competitive landscape claims could not be verified via web search. Core insight (property-side matching fills a gap) is strong. |
| Architecture | MEDIUM-HIGH | RAG patterns are well-established. The hybrid structured-rules + LLM-for-explanation approach has strong consensus. Specific ChromaDB and Gemini API surfaces may have changed. |
| Pitfalls | HIGH | All critical pitfalls are well-documented failure modes in RAG systems. The structured-matching recommendation appears independently in FEATURES, ARCHITECTURE, and PITFALLS research. |

**Overall confidence:** MEDIUM-HIGH. The convergence across all four research areas on the hybrid structured-matching approach is the strongest signal. Stack choices are conservative and appropriate for scale. The main uncertainty is around PDF extraction quality with actual GMCC documents -- this can only be resolved with real data in Phase 1.

### Gaps to Address

- **Actual GMCC guideline PDF format:** All extraction strategy recommendations are based on typical mortgage guideline PDF structures. Real PDFs may have unexpected layouts. Get sample PDFs before Phase 1 planning.
- **Google SDK package name:** `google-genai` vs `google-generativeai` -- verify at install time. Low risk but noted by STACK research.
- **RentCast rent estimation:** DSCR matching (Phase 5) depends on rent estimates. Unclear if RentCast has a separate rent estimate API or if comparable rent data is sufficient. Investigate before Phase 5 planning.
- **Conforming loan limits data:** County-level FHFA loan limits are needed for accurate location-based matching. Need a data source (FHFA publishes annually). Structured data, not RAG.
- **Ground truth validation set:** Requires a GMCC LO or product specialist to create 20-30 test cases. This is a people dependency, not a technical one. Must be coordinated during Phase 1.

## Sources

### Primary (HIGH confidence)
- Project constraints and scope from `.planning/PROJECT.md`
- Existing codebase analysis from `.planning/codebase/STACK.md`, `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`
- RAG architecture patterns -- well-established, technology-agnostic patterns with industry-wide adoption

### Secondary (MEDIUM confidence)
- Package versions and API surfaces from training data (through May 2025) -- mature packages but exact latest versions need verification at install time
- Mortgage industry domain knowledge -- program structures, guideline formats, LO workflows
- Competitive landscape for mortgage tech tools (Optimal Blue, Polly, LoanTek) -- based on training data, not current product features

### Tertiary (LOW confidence)
- Exact Gemini 2.0 Flash pricing ($0.10/1M input) -- verify against current Google AI Studio pricing
- ChromaDB 0.5.x API surface -- verify against current documentation at implementation time

---
*Research completed: 2026-03-06*
*Ready for roadmap: yes*
