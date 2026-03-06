# Roadmap: GMCC Listing Agent

## Overview

Transform the existing property search MVP into an AI-powered listing tool where loan officers see which GMCC loan programs match each property. The critical path runs through PDF extraction into structured rules, then deterministic matching, then UI integration. DSCR matching extends the engine for investment properties. Authentication locks down the tool for internal use. Each phase delivers a testable capability that builds on the last.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Program Knowledge Base** - Extract GMCC guideline PDFs into structured rules and vector store (completed 2026-03-06)
- [ ] **Phase 2: Matching Engine** - Deterministic program matching against property listing data
- [ ] **Phase 3: Frontend Integration** - Program match badges on cards and detailed breakdowns in modal
- [ ] **Phase 4: DSCR Matching** - Rent estimation and DSCR program matching for investment properties
- [ ] **Phase 5: Authentication** - Microsoft OAuth SSO login for GMCC internal users

## Phase Details

### Phase 1: Program Knowledge Base
**Goal**: GMCC loan program rules are extracted from guideline PDFs into structured, queryable data that can be updated without code changes
**Depends on**: Nothing (first phase)
**Requirements**: KB-01, KB-02, KB-03
**Success Criteria** (what must be TRUE):
  1. Running the ingestion script against a GMCC guideline PDF produces a structured JSON rule set with property types, location restrictions, loan amount ranges, and LTV limits
  2. Program rule chunks are stored in ChromaDB and retrievable by semantic query (e.g., "what property types does program X allow")
  3. Dropping an updated PDF into the input directory and re-running ingestion updates the stored rules without any code changes
**Plans**: 2 plans

Plans:
- [ ] 01-01-PLAN.md -- Pydantic schemas, PDF extraction, and LLM structuring pipeline (KB-01)
- [ ] 01-02-PLAN.md -- ChromaDB vector store, CLI ingestion pipeline, and end-to-end validation (KB-02, KB-03)

### Phase 2: Matching Engine
**Goal**: Given any property listing, the system returns which GMCC programs could apply with per-criterion eligibility status
**Depends on**: Phase 1
**Requirements**: MATCH-01, MATCH-02, MATCH-03, MATCH-04
**Success Criteria** (what must be TRUE):
  1. Passing a property listing (price, type, location, county) to the matching function returns a list of all GMCC programs with a match/no-match/unverified status for each
  2. Each program match result includes per-criterion pass/fail/unknown breakdown (property type eligible, loan amount in range, location allowed)
  3. When a listing is missing data needed for a criterion (e.g., no county info), that criterion shows "unverified" rather than failing the program
  4. Eligibility decisions are made by deterministic rule checking against structured JSON; the LLM is only called to generate natural-language explanations
**Plans**: 2 plans

Plans:
- [ ] 02-01-PLAN.md -- Core matching engine: Pydantic models, property type mapping, geocode fallback, and deterministic matching logic (MATCH-01, MATCH-02, MATCH-03)
- [ ] 02-02-PLAN.md -- Flask API endpoints and on-demand LLM explanation generation (MATCH-01, MATCH-04)

### Phase 3: Frontend Integration
**Goal**: Loan officers see program match results directly on property cards and can drill into per-program breakdowns
**Depends on**: Phase 2
**Requirements**: UI-01, UI-02, UI-03, UI-04
**Success Criteria** (what must be TRUE):
  1. Each property card in search results displays a badge showing the number of matched GMCC programs
  2. Clicking a property card opens the detail modal with a "Matching Programs" section showing per-program eligibility breakdown (which criteria passed, failed, or are unverified)
  3. User can filter the search results list to show only properties eligible for a specific GMCC program
  4. While matching results are loading (async after search), property cards show a loading indicator that resolves to the match badge
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: DSCR Matching
**Goal**: Investment properties are evaluated for DSCR loan programs using estimated rent data
**Depends on**: Phase 2
**Requirements**: DSCR-01, DSCR-02, DSCR-03
**Success Criteria** (what must be TRUE):
  1. Investment properties have an estimated monthly rent value sourced from RentCast or comparable data
  2. The system calculates an estimated DSCR ratio (Monthly Rent / Monthly PITIA) and compares it against DSCR program minimum thresholds
  3. DSCR-eligible properties show DSCR program matches alongside standard program matches (in both the card badge count and the detail modal breakdown)
**Plans**: TBD

Plans:
- [ ] 04-01: TBD

### Phase 5: Authentication
**Goal**: Only authenticated GMCC staff can access the tool, with login via company Microsoft accounts
**Depends on**: Phase 3
**Requirements**: AUTH-01, AUTH-02, AUTH-03
**Success Criteria** (what must be TRUE):
  1. User can log in using their Microsoft/Outlook company email via OAuth SSO (no separate password to manage)
  2. After logging in, refreshing the browser keeps the user logged in (session persists)
  3. Hitting any API endpoint or page without authentication redirects to the login screen
**Plans**: TBD

Plans:
- [ ] 05-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Program Knowledge Base | 2/2 | Complete   | 2026-03-06 |
| 2. Matching Engine | 0/2 | Planning complete | - |
| 3. Frontend Integration | 0/0 | Not started | - |
| 4. DSCR Matching | 0/0 | Not started | - |
| 5. Authentication | 0/0 | Not started | - |
