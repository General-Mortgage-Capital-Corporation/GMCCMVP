# Phase 2: Matching Engine - Context

**Gathered:** 2026-03-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Given any property listing from RentCast, return which GMCC loan programs could apply with per-criterion eligibility status. Matching is deterministic against structured JSON rules. LLM is used only for on-demand natural-language explanations. UI integration is Phase 3.

</domain>

<decisions>
## Implementation Decisions

### Property Data Mapping
- Static lookup table for RentCast property types to program rule terms (e.g., "Single Family" -> "SFR", "Condo" -> "Condo")
- Assume transaction type is "Purchase" for all active listings (this is a listing search tool for active sales)
- Skip occupancy type filtering — show all occupancy tiers as potential matches since occupancy is unknown without buyer data
- Use listing price as proxy for loan amount when checking against min/max_loan_amount tier ranges
- Reverse geocode coordinates to get county for location restriction matching (external geocoding API needed)
- Parse state from RentCast address string for state-level restrictions

### Overall Match Status
- Two-tier status: "Eligible" (all checkable criteria pass, none unverified) and "Potentially Eligible" (some pass, some unverified, none fail). Any criterion fail = excluded
- Property card badge counts both Eligible and Potentially Eligible together; detail modal distinguishes the two
- Program-level rollup: show "Thunder: Eligible" with best-matching tier highlighted; detail view lists which tiers matched
- Per-criterion breakdown always shows all criteria (property type, loan amount, location, unit count) with pass/fail/unverified — consistent view so LO always knows what was checked

### LLM Explanations
- On-demand only — generate when LO clicks into program detail (not eagerly with every search)
- Content: 2-3 sentence program summary + bullet-point talking points the LO could use with a listing agent
- Use ChromaDB vector context (original guideline chunks) alongside structured JSON to produce richer, grounded explanations
- Use Gemini Flash (gemini-2.5-flash) — already configured, consistent with Phase 1

### Claude's Discretion
- Specific reverse geocoding provider (Census Bureau, Google, etc.)
- Exact matching function API signature and return types
- Caching strategy for match results and explanations
- Error handling for geocoding failures

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rag/schemas.py`: ProgramRules and EligibilityTier Pydantic models — tier data structure is the matching input
- `rag/vectorstore.py`: `query_program_info(query, program_name)` — query ChromaDB for guideline chunks to feed into LLM explanations
- `rag/config.py`: Gemini model config, API keys, directory paths — reuse for LLM explanation calls
- `data/programs/thunder.json`: Structured rules with 44 tiers — the rule data the matcher checks against

### Established Patterns
- Pydantic models for structured data (schemas.py) — matching results should follow this pattern
- Gemini client initialization from config — reuse for explanation generation
- Flask JSON API responses (server.py) — matching endpoint should follow existing response format

### Integration Points
- `server.py` `/api/search` returns listing data — matching runs against these listings
- New `/api/match` or `/api/explain` endpoint(s) needed on Flask server
- `data/programs/*.json` files are the rule source — matcher loads all program JSONs at startup or on-demand

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-matching-engine*
*Context gathered: 2026-03-06*
