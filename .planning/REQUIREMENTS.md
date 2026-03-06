# Requirements: GMCC Listing Agent

**Defined:** 2026-03-06
**Core Value:** Loan officers walk into any listing conversation already knowing which GMCC programs could work for that property

## v1 Requirements

Requirements for initial release. Each maps to roadmap phases.

### Knowledge Base

- [x] **KB-01**: System can parse GMCC loan program guideline PDFs into structured JSON rule sets (property types, location restrictions, loan amount ranges, LTV limits)
- [x] **KB-02**: System stores program rules in a vector store (ChromaDB) for explanation retrieval alongside structured JSON for deterministic matching
- [x] **KB-03**: Program data can be updated by re-ingesting updated guideline PDFs without code changes

### Program Matching

- [x] **MATCH-01**: System matches each property listing against all GMCC programs based on available listing data (price, property type, location, county)
- [x] **MATCH-02**: Each program match includes per-criterion pass/fail/unknown status (property type eligible, loan amount in range, location allowed)
- [x] **MATCH-03**: When listing data is insufficient to determine eligibility, system marks criterion as "unverified" rather than excluding the program
- [x] **MATCH-04**: Matching uses deterministic rule checking for eligibility decisions and LLM only for generating natural-language explanations

### DSCR Matching

- [ ] **DSCR-01**: System estimates potential rent for investment properties using available data (RentCast rent estimate API or comparable data)
- [ ] **DSCR-02**: System calculates estimated DSCR ratio (Monthly Rent / Monthly PITIA) and matches against DSCR program minimums
- [ ] **DSCR-03**: DSCR-eligible properties are flagged with DSCR program matches alongside standard program matches

### UI Integration

- [x] **UI-01**: Property cards display number of matched programs as a badge/indicator
- [x] **UI-02**: Property detail modal includes a "Matching Programs" section with per-program eligibility breakdown
- [x] **UI-03**: User can filter search results to show only listings eligible for a specific GMCC program
- [x] **UI-04**: Loading states shown while AI matching processes (matching may be async after initial search results load)

### Authentication

- [ ] **AUTH-01**: User can log in via Microsoft/Outlook company email (OAuth SSO)
- [ ] **AUTH-02**: User session persists across browser refresh
- [ ] **AUTH-03**: All API endpoints require authentication (unauthenticated requests redirected to login)

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Validation

- **VAL-01**: Validated ground truth dataset of 20-30 property-to-program test cases to verify matching accuracy

### Enhanced Matching

- **EMATCH-01**: Match confidence indicators (Strong Match / Possible Match / Needs Verification) based on data completeness
- **EMATCH-02**: Talking points generation — LLM-generated plain-English summaries for each matched program
- **EMATCH-03**: Program comparison view — side-by-side comparison of 2-3 matching programs for a property
- **EMATCH-04**: Multi-property program summary — area-level view ("12 of 20 qualify for FHA, 8 for DSCR")

### Admin & Operations

- **ADMIN-01**: Admin UI for uploading and re-ingesting guideline PDFs
- **ADMIN-02**: Rate sheet awareness — incorporate daily rate sheet data for approximate rate ranges
- **ADMIN-03**: Branch manager dashboard with usage analytics

### Outreach

- **OUT-01**: Listing agent contact integration — copy-ready talking points with property details for outreach
- **OUT-02**: Email templates with property details and matching loan scenarios
- **OUT-03**: PDF flyer generation — branded one-pager showing loan options for a specific property

### Prospecting

- **PROS-01**: Saved searches with alerts when new matching listings appear
- **PROS-02**: Open house finder for properties via web search

## Out of Scope

| Feature | Reason |
|---------|--------|
| Full borrower qualification (credit score, DTI, income) | No buyer data from listings; makes this a different product (LOS/POS) |
| Automated email/SMS outreach to listing agents | Compliance risk, spam risk, reputation risk — LOs need control |
| Direct MLS integration / IDX feed | Expensive, complex, regionally fragmented — RentCast already aggregates |
| Real-time rate lock / pricing | Requires LOS integration and investor pricing feeds — full PPE territory |
| Consumer-facing portal | Changes compliance requirements (TILA, RESPA), dilutes LO-specific value |
| Custom LLM fine-tuning | Expensive, hard to update — RAG with structured extraction handles this better |
| Map-based visualization | Adds frontend complexity without improving core matching workflow |
| Multi-lender comparison | Requires competitor data, might recommend against GMCC |
| Connecting to existing general AI chatbot backend | Too broad — focused RAG more reliable for specific matching |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| KB-01 | Phase 1 | Complete |
| KB-02 | Phase 1 | Complete |
| KB-03 | Phase 1 | Complete |
| MATCH-01 | Phase 2 | Complete |
| MATCH-02 | Phase 2 | Complete |
| MATCH-03 | Phase 2 | Complete |
| MATCH-04 | Phase 2 | Complete |
| UI-01 | Phase 3 | Complete |
| UI-02 | Phase 3 | Complete |
| UI-03 | Phase 3 | Complete |
| UI-04 | Phase 3 | Complete |
| DSCR-01 | Phase 4 | Pending |
| DSCR-02 | Phase 4 | Pending |
| DSCR-03 | Phase 4 | Pending |
| AUTH-01 | Phase 5 | Pending |
| AUTH-02 | Phase 5 | Pending |
| AUTH-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0

---
*Requirements defined: 2026-03-06*
*Last updated: 2026-03-06 after initial definition*
