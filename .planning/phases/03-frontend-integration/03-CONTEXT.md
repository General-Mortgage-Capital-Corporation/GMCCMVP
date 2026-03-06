# Phase 3: Frontend Integration - Context

**Gathered:** 2026-03-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Add program match results to the existing vanilla JS frontend: badge on property cards showing match count, "Matching Programs" section in the detail modal with per-program eligibility breakdown and on-demand LLM explanations, program filter to narrow search results, and async loading states while matching runs after search.

</domain>

<decisions>
## Implementation Decisions

### Match Badge on Property Cards
- Add a program count badge in the existing `.property-badges` row, alongside "days on market" and property type badges
- Badge text: "N Programs" (e.g., "3 Programs") — counts both Eligible and Potentially Eligible together (decided in Phase 2)
- Badge styling: green pill using existing `--color-success` / `--color-success-light` CSS variables for consistency
- If zero matching programs: no badge shown (avoid "0 Programs" noise)
- While matching is loading: show a small skeleton/pulse badge placeholder in the same position

### Program Breakdown in Modal
- New "Matching Programs" section inserted after the Property Details section in the modal (high-visibility placement)
- Only show Eligible and Potentially Eligible programs (hide Ineligible — reduces clutter for LO)
- Each program rendered as an expandable card within the section:
  - **Collapsed (default):** Program name + status badge (green "Eligible" or amber "Potentially Eligible") + best tier name
  - **Expanded:** 4-criteria grid showing property_type, loan_amount, location, unit_count — each with pass/fail/unverified icon and detail text
- Pass = green checkmark, Fail = red X, Unverified = gray question mark — simple, scannable
- "Get Talking Points" button at bottom of expanded program card — calls POST /api/explain and renders LLM response inline below the criteria
- Talking points area shows a loading spinner while Gemini responds, then renders the markdown-like text
- If no programs match at all: show a muted message "No matching GMCC programs found for this property"

### Program Filter
- Filter bar appears above the results grid, below the stats bar — only visible after search results have loaded and matching is complete
- Dropdown/select with options: "All Programs" (default) + each program name that has at least one matching listing
- Filtering is client-side: show/hide property cards based on their stored match data (no additional API calls)
- Filter summary text next to dropdown: "Showing 8 of 10 properties" when filtered
- When filter is active and a program is selected, cards without that program match are hidden via CSS class toggle

### Async Loading Flow
- After /api/search returns listings and cards render, fire POST /api/match for each listing in parallel (individual calls to existing endpoint)
- Store match results on each listing object in the `currentListings` array (attach `.matchData` property)
- Progressive reveal: as each match response returns, update that card's badge from loading skeleton to actual count
- If a match call fails for a listing, show no badge (silent failure — don't block other listings)
- Modal: if user opens a card before its match data has loaded, show "Loading program matches..." placeholder in the Matching Programs section
- Program filter dropdown populates only after all match calls complete (or after a reasonable timeout)
- No batch endpoint needed — 10-20 parallel fetch calls is performant enough for the expected result sizes

### Claude's Discretion
- Exact animation/transition for badge loading skeleton
- Whether expanded program cards use accordion (one at a time) or independent expand/collapse
- Exact icon implementation for pass/fail/unverified (SVG inline, emoji, or CSS)
- Loading spinner design for the "Get Talking Points" response
- Mobile responsive adjustments for the program section in modal

</decisions>

<specifics>
## Specific Ideas

- Program badge on cards should feel like the existing "days on market" and property type badges — same visual weight, just a different color (green) to distinguish it as a new data type
- The Matching Programs section in the modal should feel like the existing Property Details and Listing Information sections — consistent section title styling, grid layout
- LLM talking points should render as clean text, not raw markdown — since Gemini returns markdown, basic rendering (bold, bullets) would improve readability

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `.badge` CSS class with pill styling (rounded, small text, colored background) — reuse for program count badge
- `.modal-section` / `.modal-section-title` / `.modal-grid` — reuse for Matching Programs section layout
- `createPropertyCard()` in script.js — extend to include badge placeholder and match badge rendering
- `openPropertyModal()` in script.js — extend to include Matching Programs section
- CSS custom properties (`--color-success`, `--color-success-light`, `--color-warning`, `--color-warning-light`) — map to Eligible and Potentially Eligible states
- `currentListings` array — attach match data per listing for client-side filter and modal access

### Established Patterns
- Vanilla JS DOM manipulation (createElement, innerHTML templates) — no framework, keep consistent
- CSS-only styling with custom properties — no CSS-in-JS or utility classes
- Fetch API for backend calls — same pattern for /api/match and /api/explain
- Modal opens via `openPropertyModal(listing)` — listing object passed directly, match data will be available on it

### Integration Points
- `handleSearch()` in script.js — after search completes, trigger parallel match calls
- `createPropertyCard()` — add badge element (loading or resolved)
- `openPropertyModal()` — add Matching Programs section with criteria breakdown
- POST /api/match endpoint (existing from Phase 2) — accepts listing JSON, returns program results
- POST /api/explain endpoint (existing from Phase 2) — accepts {program_name, listing, tier_name}, returns explanation text

</code_context>

<deferred>
## Deferred Ideas

None — all decisions made within phase scope

</deferred>

---

*Phase: 03-frontend-integration*
*Context gathered: 2026-03-06*
