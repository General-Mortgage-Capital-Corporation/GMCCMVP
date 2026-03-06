# GMCC Listing Agent

## What This Is

An AI-powered property listing tool for GMCC loan officers and branch managers. LOs search for active sale listings and instantly see which GMCC loan programs could apply to each property based on available data (price, location, property type, estimated rent). Built on top of an existing RentCast-powered property search MVP.

## Core Value

Loan officers walk into any listing conversation already knowing which GMCC programs could work for that property — turning cold outreach into prepared, credible engagement.

## Requirements

### Validated

- Property area search by address or zip code with radius — existing
- Property specific address lookup with fallback — existing
- Property detail view with listing info, location, and contact info — existing
- Distance-based sorting from search center — existing
- Responsive UI with property cards and detail modal — existing

### Active

- [ ] AI-powered loan program matching per listing (badges on cards + detailed breakdown on click)
- [ ] Focused RAG knowledge base built from GMCC program guideline PDFs (5-15 programs)
- [ ] Program matching based on available listing data: price, location, property type, estimated rent
- [ ] User authentication for GMCC LOs and branch managers
- [ ] Rate sheet awareness (periodic updates to keep program data current)

### Out of Scope

- Connecting to the existing general AI chatbot backend — too broad, building focused RAG instead
- Buyer-specific matching (credit score, DTI, down payment) — no buyer data available from listings
- Outreach tools (email templates, PDF flyers) — future feature after core matching works
- Open house finder via web search — nice to have, defer
- Save/share/favorites workflow — future feature
- External user access (realtors, referral partners) — internal only for now
- Mobile native app — web-first

## Context

- Existing Flask + vanilla JS MVP pulls active sale listings from RentCast API
- RentCast provides: price, address, property type, bedrooms/bathrooms, sqft, days on market, listing agent/office contact info, coordinates
- RentCast does NOT provide: open house schedules, estimated rent (may need separate API call or estimation)
- GMCC has 5-15 loan programs, each with a primary guideline PDF and daily rate sheets
- Program rules include: property type eligibility, location restrictions, loan amount limits, LTV thresholds, investor/rental rules (DSCR)
- Without buyer info, matching is "these programs could work" not "this is the best program" — still very valuable for LO preparation
- Company has an existing RAG-based AI chatbot with a large general knowledge base, but a smaller focused RAG is preferred for reliability and relevance
- Preferred AI providers: Gemini or OpenAI (cost-conscious, Claude considered unnecessary for this use case)

## Constraints

- **AI Provider**: Gemini or OpenAI — avoid expensive models, optimize for cost
- **Data Source**: RentCast API for listings, GMCC guideline PDFs for program rules
- **Architecture**: Build on existing Flask backend — no full rewrite
- **Users**: GMCC internal staff only (LOs + branch managers) — requires authentication
- **Program Data**: Must be updatable as programs change — not hardcoded

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Focused RAG over general chatbot | General chatbot KB too broad, focused RAG more reliable for specific matching task | — Pending |
| Gemini/OpenAI over Claude | Cost optimization — matching task doesn't need most capable model | — Pending |
| Property-side matching only | No buyer data available from listings, still valuable for LO prep | — Pending |
| Login required | Multiple LOs and branch managers need access, protect internal tool | — Pending |
| Defer outreach tools | Core matching is the demo moment, outreach adds complexity | — Pending |

---
*Last updated: 2026-03-06 after initialization*
