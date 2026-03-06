# Phase 3: Frontend Integration - Research

**Researched:** 2026-03-06
**Domain:** Vanilla JS frontend integration with REST API (program matching UI)
**Confidence:** HIGH

## Summary

Phase 3 adds GMCC program matching results to the existing vanilla JS property search dashboard. The frontend is a single-page application with three files (`index.html`, `script.js`, `styles.css`) using no frameworks -- plain DOM manipulation, CSS custom properties, and the Fetch API. The backend already provides `POST /api/match` (deterministic, returns per-program/tier/criterion breakdown with `eligible_count`) and `POST /api/explain` (LLM-powered, returns explanation text). The integration requires extending four existing functions (`handleSearch`, `createPropertyCard`, `openPropertyModal`, `renderListings`) and adding new UI components (filter bar, expandable program cards, talking points section).

The codebase is well-structured with clear section separators and consistent patterns. All new code must follow the established vanilla JS approach: `document.createElement` and `innerHTML` templates, CSS classes with custom properties (`--color-success`, `--color-warning`), and `fetch()` for API calls. No build tools, bundlers, or frameworks are involved.

**Primary recommendation:** Extend the existing three static files in-place. The match API returns the exact data shape needed for the UI (program_name, status, best_tier, matching_tiers with per-criterion breakdown). Wire `handleSearch` to fire parallel `fetch('/api/match')` calls after search completes, store results on `currentListings[i].matchData`, and render badge/modal/filter from that data.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- Match badge in existing `.property-badges` row, green pill using `--color-success` / `--color-success-light` CSS variables
- Badge text: "N Programs" counting Eligible + Potentially Eligible together; zero matches = no badge shown
- Loading state: skeleton/pulse badge placeholder while matching loads
- "Matching Programs" section after Property Details in modal, showing only Eligible and Potentially Eligible programs (hide Ineligible)
- Each program as expandable card: collapsed shows program name + status badge + best tier; expanded shows 4-criteria grid with pass/fail/unverified icons
- Pass = green checkmark, Fail = red X, Unverified = gray question mark
- "Get Talking Points" button at bottom of expanded card, calls POST /api/explain, renders response inline
- No programs = "No matching GMCC programs found for this property" muted message
- Filter bar above results grid, below stats bar, only visible after matching complete
- Dropdown with "All Programs" default + each program name that has at least one match
- Client-side filtering via CSS class toggle (no additional API calls)
- Filter summary text: "Showing X of Y properties"
- Parallel individual POST /api/match calls per listing (no batch endpoint)
- Progressive reveal: update each card's badge as its match response arrives
- Silent failure on match errors (no badge shown, don't block other listings)
- Modal shows "Loading program matches..." if opened before match data loaded
- Program filter dropdown populates after all match calls complete (or timeout)

### Claude's Discretion
- Exact animation/transition for badge loading skeleton
- Whether expanded program cards use accordion (one at a time) or independent expand/collapse
- Exact icon implementation for pass/fail/unverified (SVG inline, emoji, or CSS)
- Loading spinner design for the "Get Talking Points" response
- Mobile responsive adjustments for the program section in modal

### Deferred Ideas (OUT OF SCOPE)
None -- all decisions made within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| UI-01 | Property cards display number of matched programs as a badge/indicator | Badge in `.property-badges` row; extend `createPropertyCard()` to include skeleton placeholder then resolved "N Programs" badge; match data stored on listing object |
| UI-02 | Property detail modal includes "Matching Programs" section with per-program eligibility breakdown | Extend `openPropertyModal()` with new `.modal-section` after Property Details; expandable program cards with 4-criteria grid; "Get Talking Points" button calling `/api/explain` |
| UI-03 | User can filter search results to show only listings eligible for a specific GMCC program | New filter bar HTML between stats bar and results grid; `<select>` populated from collected match data; client-side show/hide via `.hidden` class on cards |
| UI-04 | Loading states shown while AI matching processes | Skeleton pulse badge on cards during match fetch; progressive reveal as each response arrives; "Loading program matches..." in modal if opened early; filter bar hidden until matching complete |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Vanilla JS (ES6+) | N/A | All DOM manipulation, fetch calls, state management | Existing project pattern -- no framework |
| CSS Custom Properties | N/A | Theming, color consistency | Existing design system in styles.css |
| Fetch API | Native | API calls to /api/match and /api/explain | Already used for /api/search |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Inter (Google Fonts) | Already loaded | Typography | Already in index.html |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Vanilla JS | Alpine.js / Petite-Vue | Would add reactivity but conflicts with existing vanilla JS pattern -- NOT recommended |
| CSS animations | JS-driven animations | CSS `@keyframes` is simpler and already used for `.btn-loader` spin animation |
| marked.js (markdown) | Manual basic rendering | Gemini returns markdown; basic bold/bullet rendering can be done with ~10 lines of regex -- no library needed for this scope |

**Installation:** No installation needed. All code is vanilla JS/CSS/HTML served as static files by Flask.

## Architecture Patterns

### Recommended Project Structure
```
static/
  index.html     # Add filter bar HTML, no other structural changes needed
  script.js      # Extend existing functions, add new matching/filter functions
  styles.css     # Add badge-programs, program card, filter bar, skeleton styles
```

No new files needed. All changes are extensions to the existing three files.

### Pattern 1: Progressive Data Enrichment
**What:** After search results render with basic listing data, fire async match calls per listing and progressively update cards as responses arrive. Match data is stored on the listing objects themselves.
**When to use:** This exact flow -- search returns listings, then match enriches them.
**Example:**
```javascript
// After renderListings(result.listings) in handleSearch:
currentListings.forEach((listing, index) => {
    listing.matchLoading = true;
    fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(listing)
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            listing.matchData = data;
            listing.matchLoading = false;
            updateCardBadge(index, data.eligible_count);
        }
    })
    .catch(() => {
        listing.matchLoading = false;
        // Silent failure -- no badge shown
    });
});
```

### Pattern 2: Card Element Lookup by Index
**What:** Each card has `data-index` attribute (already set in `createPropertyCard`). Use this to find and update specific cards without re-rendering the entire grid.
**When to use:** Updating badge on a specific card when its match response arrives.
**Example:**
```javascript
function updateCardBadge(index, eligibleCount) {
    const card = document.querySelector(`[data-index="${index}"]`);
    if (!card) return;
    const badges = card.querySelector('.property-badges');
    const skeleton = badges.querySelector('.badge-programs-loading');
    if (skeleton) skeleton.remove();
    if (eligibleCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-programs';
        badge.textContent = `${eligibleCount} Program${eligibleCount !== 1 ? 's' : ''}`;
        badges.appendChild(badge);
    }
}
```

### Pattern 3: Expandable Card in Modal
**What:** Program cards in the modal start collapsed (name + status). Clicking toggles expanded view showing criteria grid and "Get Talking Points" button.
**When to use:** The Matching Programs section in the property detail modal.
**Example:**
```javascript
function createProgramCard(program, listing) {
    const card = document.createElement('div');
    card.className = 'program-card';

    const statusClass = program.status === 'Eligible' ? 'status-eligible' : 'status-potentially';
    const statusText = program.status;

    card.innerHTML = `
        <div class="program-card-header">
            <span class="program-name">${program.program_name}</span>
            <span class="program-status ${statusClass}">${statusText}</span>
            <span class="program-tier">${program.best_tier || ''}</span>
        </div>
        <div class="program-card-body" style="display:none;">
            ${renderCriteriaGrid(program)}
            <button class="btn-talking-points" data-program="${program.program_name}" data-tier="${program.best_tier || ''}">
                Get Talking Points
            </button>
            <div class="talking-points-content"></div>
        </div>
    `;

    // Toggle expand/collapse
    card.querySelector('.program-card-header').addEventListener('click', () => {
        const body = card.querySelector('.program-card-body');
        body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    return card;
}
```

### Pattern 4: Client-Side Filter via CSS Class
**What:** When user selects a program from the filter dropdown, iterate cards and toggle `.hidden` class based on whether the card's listing has a match for that program. No re-rendering or API calls.
**When to use:** Program filter dropdown change handler.
**Example:**
```javascript
function filterByProgram(programName) {
    const cards = document.querySelectorAll('.property-card');
    let visibleCount = 0;

    cards.forEach((card, index) => {
        const listing = currentListings[index];
        if (!programName || programName === '') {
            card.classList.remove('hidden');
            visibleCount++;
        } else if (listing.matchData) {
            const hasMatch = listing.matchData.programs.some(
                p => p.program_name === programName && p.status !== 'Ineligible'
            );
            card.classList.toggle('hidden', !hasMatch);
            if (hasMatch) visibleCount++;
        } else {
            card.classList.add('hidden');
        }
    });

    updateFilterSummary(visibleCount, currentListings.length);
}
```

### Anti-Patterns to Avoid
- **Re-rendering entire grid on match response:** Each match response updates ONE card. Never call `renderListings()` again -- use targeted DOM updates via `data-index`.
- **Blocking search on match results:** Search and match are decoupled. Users see property cards immediately; match badges appear progressively.
- **Storing match data separately from listings:** Attach `.matchData` directly to the listing objects in `currentListings` array. The modal already receives the listing object, so match data travels with it.
- **Using innerHTML for user-generated content:** The LLM explanation text should be escaped or rendered through DOM methods, not raw innerHTML, to prevent XSS from Gemini responses.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Skeleton loading animation | Custom JS animation | CSS `@keyframes pulse` with opacity or background-color transition | Pure CSS, zero JS overhead, already have `@keyframes spin` pattern in codebase |
| SVG icons for pass/fail/unverified | Icon library or font | Inline SVG strings (checkmark, X, question mark) | 3 small SVGs total, no library dependency needed |
| Markdown rendering for talking points | Full markdown parser | Simple regex for `**bold**` and `- bullet` patterns | Gemini output is limited to bold text and bullet lists; 10-15 lines covers it |
| Dropdown component | Custom select with search | Native `<select>` element | Expected 1-5 programs max; native select is sufficient and accessible |

**Key insight:** This is a small-scope vanilla JS project with 1-5 programs and 10-20 listings. Every "library" consideration should be met with "is 10-20 lines of code sufficient?" -- and in every case here, yes.

## Common Pitfalls

### Pitfall 1: Race Condition Between Modal Open and Match Load
**What goes wrong:** User clicks a property card before its match data has loaded. The modal renders without the Matching Programs section, and when match data arrives later, the modal doesn't update.
**Why it happens:** Match calls are async and may take 1-3 seconds. Users click cards immediately.
**How to avoid:** Check `listing.matchLoading` and `listing.matchData` when building modal. If loading, show "Loading program matches..." placeholder. The modal is rebuilt from scratch each time it opens (existing pattern), so re-opening after data loads works automatically.
**Warning signs:** Modal shows stale "loading" state even after match data is available.

### Pitfall 2: Match Call Fires Before Listings Array is Updated
**What goes wrong:** `handleSearch` fires match calls using a stale reference if `currentListings` hasn't been updated yet.
**Why it happens:** Assignment `currentListings = result.listings` must happen BEFORE firing match calls.
**How to avoid:** Ensure the match-firing loop runs after `currentListings` is set and `renderListings()` has completed. The existing code already sets `currentListings = result.listings` before `renderListings()`, so fire matches right after `renderListings()`.
**Warning signs:** Match data appears on wrong cards or cards not found by `data-index`.

### Pitfall 3: Filter Dropdown Shows Programs Before All Matches Complete
**What goes wrong:** Filter dropdown populates mid-stream, showing some programs but not others. User filters, misses results.
**Why it happens:** Populating dropdown as each match response arrives creates a confusing partial state.
**How to avoid:** Track pending match calls with a counter. Only show the filter bar and populate the dropdown when all calls have resolved (or a timeout fires). Use `Promise.allSettled()` or manual counter.
**Warning signs:** Filter dropdown options keep changing as more match results arrive.

### Pitfall 4: Card Index Mismatch After Filtering
**What goes wrong:** `data-index` corresponds to position in `currentListings`, but after filtering, visible card indices don't map 1:1 to DOM position.
**Why it happens:** Filtering hides cards with CSS, not by removing from DOM. The `data-index` attribute still correctly references the original array index.
**How to avoid:** Always use `data-index` attribute to look up listings, never rely on DOM child position. The existing `createPropertyCard` already sets `data-index`, so this just needs to be maintained.
**Warning signs:** Clicking a filtered card opens the wrong property in the modal.

### Pitfall 5: XSS from LLM Explanation Text
**What goes wrong:** Gemini response text is inserted into the DOM, and if it contains HTML-like content, it could execute as markup.
**Why it happens:** Using `innerHTML` to render explanation text without sanitization.
**How to avoid:** Use `textContent` for plain text insertion, or apply basic markdown rendering (bold, bullets) through DOM methods rather than innerHTML. If using innerHTML for formatted text, escape HTML entities first, then apply markdown transformations.
**Warning signs:** Strange formatting or broken layout when explanation text contains angle brackets.

### Pitfall 6: Memory Leak from Event Listeners on Modal Content
**What goes wrong:** Each time the modal opens, new event listeners are attached to "Get Talking Points" buttons and expand/collapse headers. Old listeners aren't cleaned up.
**Why it happens:** Modal content is rebuilt via innerHTML each time, so old DOM nodes are garbage collected -- but only if no external references hold them. The existing pattern uses `content.innerHTML = ...` which replaces all children, so this is actually fine as long as event listeners are attached to elements within `modalContent` (they get GC'd when innerHTML replaces them).
**How to avoid:** Follow the existing pattern: attach listeners inside `openPropertyModal` after setting innerHTML. Since `content.innerHTML = ...` destroys all previous children, no cleanup is needed.
**Warning signs:** None expected if existing pattern is followed.

## Code Examples

### Match API Response Shape (from server.py)
```javascript
// POST /api/match response:
{
    "success": true,
    "programs": [
        {
            "program_name": "Thunder",
            "status": "Eligible",         // "Eligible" | "Potentially Eligible" | "Ineligible"
            "best_tier": "Conforming - Principal Residence - Purchase - 1 Unit",
            "matching_tiers": [
                {
                    "tier_name": "Conforming - Principal Residence - Purchase - 1 Unit",
                    "status": "Eligible",
                    "criteria": [
                        { "criterion": "property_type", "status": "pass",       "detail": "Single Family matches SFR" },
                        { "criterion": "loan_amount",   "status": "pass",       "detail": "Price $500,000 allows loan in range $100,000-$806,500" },
                        { "criterion": "location",      "status": "pass",       "detail": "No location restrictions for this tier" },
                        { "criterion": "unit_count",    "status": "pass",       "detail": "Single Family has 1 unit(s), within limits [1]" }
                    ]
                }
            ]
        }
    ],
    "eligible_count": 1
}
```

### Explain API Response Shape (from server.py)
```javascript
// POST /api/explain response:
{
    "success": true,
    "explanation": "This property qualifies for the Thunder program under the Conforming tier..."
}

// POST /api/explain request body:
{
    "program_name": "Thunder",
    "listing": { /* full RentCast listing object */ },
    "tier_name": "Conforming - Principal Residence - Purchase - 1 Unit"
}
```

### Skeleton Badge CSS
```css
/* Pulse animation for loading skeleton */
@keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
}

.badge-programs-loading {
    background: var(--color-border);
    color: transparent;
    animation: pulse 1.5s ease-in-out infinite;
    min-width: 70px;
}

.badge-programs {
    background: var(--color-success-light);
    color: #065f46;
}
```

### Criteria Status Icons (Inline SVG)
```javascript
// Small, clean inline SVGs for criterion status
const STATUS_ICONS = {
    pass: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M13.3 4.3L6 11.6 2.7 8.3" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12 4L4 12M4 4l8 8" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    unverified: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="#94a3b8" stroke-width="2"/><path d="M6.5 6a1.5 1.5 0 013 0c0 1-1.5 1-1.5 2M8 11h.01" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/></svg>'
};
```

### Basic Markdown Rendering for Talking Points
```javascript
function renderSimpleMarkdown(text) {
    // Escape HTML first to prevent XSS
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    return escaped
        // Bold: **text** -> <strong>text</strong>
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Bullet lists: lines starting with "- " or "* "
        .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        // Line breaks
        .replace(/\n/g, '<br>');
}
```

### Tracking Match Completion
```javascript
// Track when all match calls have completed for filter bar
let matchPending = 0;

function startMatching(listings) {
    matchPending = listings.length;

    listings.forEach((listing, index) => {
        listing.matchLoading = true;
        fetch('/api/match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(listing)
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                listing.matchData = data;
                updateCardBadge(index, data.eligible_count);
            }
        })
        .catch(() => { /* silent failure */ })
        .finally(() => {
            listing.matchLoading = false;
            matchPending--;
            if (matchPending <= 0) {
                onAllMatchesComplete();
            }
        });
    });
}

function onAllMatchesComplete() {
    populateFilterDropdown();
    showFilterBar();
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| jQuery DOM manipulation | Vanilla JS with `querySelector`, `createElement` | 2020+ | No jQuery dependency in this project |
| XMLHttpRequest | Fetch API with async/await | 2017+ | Already used in codebase |
| CSS with preprocessor (SASS/LESS) | CSS Custom Properties (variables) | 2020+ | Native browser support, no build step |

**Deprecated/outdated:**
- None relevant. The vanilla JS approach used in this project is intentionally simple and current.

## Open Questions

1. **How many programs will exist at scale?**
   - What we know: Currently 1 program (Thunder) with ~20+ tiers. CONTEXT says "1-5 programs" expected.
   - What's unclear: Whether more program JSONs will be added before Phase 3 or Phase 4.
   - Recommendation: Design for up to 5 programs. The filter dropdown and modal section will handle 1-5 gracefully. No need for search/pagination within programs.

2. **Match API latency per listing**
   - What we know: Match endpoint is deterministic (no LLM), loads programs from cached JSON. Should be fast (<100ms per call).
   - What's unclear: Actual latency under real conditions, especially with the FCC geocode fallback for county resolution.
   - Recommendation: Set a reasonable timeout (5 seconds per match call). The progressive reveal pattern handles latency gracefully -- fast calls update immediately, slow ones appear when ready.

3. **Explain API latency**
   - What we know: Calls Gemini Flash, expected 2-5 seconds response time.
   - What's unclear: Whether Gemini rate limits could cause failures with multiple rapid "Get Talking Points" clicks.
   - Recommendation: Disable the button while a request is in flight. Show spinner in the talking points area. Cache the response on the program object so repeated expansion doesn't re-fetch.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (backend); no JS test framework |
| Config file | `pyproject.toml` (pytest markers configured) |
| Quick run command | `pytest tests/ -x --ignore=tests/test_ingestion.py -q` |
| Full suite command | `pytest tests/ -q` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UI-01 | Badge shows program count on property cards | manual-only | N/A -- vanilla JS DOM, no JS test framework | N/A |
| UI-02 | Modal shows Matching Programs section with breakdown | manual-only | N/A -- vanilla JS DOM rendering | N/A |
| UI-03 | Program filter hides/shows cards client-side | manual-only | N/A -- client-side JS filtering | N/A |
| UI-04 | Loading states during async matching | manual-only | N/A -- async UI state management | N/A |

**Manual test justification:** This phase is pure frontend (vanilla JS/CSS/HTML). There is no JS test framework (no package.json, no Jest/Vitest). The backend endpoints (`/api/match`, `/api/explain`) are already tested in `tests/test_api_match.py`. The frontend integration is best validated by manual browser testing: run the server, search for properties, observe badges loading, click cards to check modal, test filter dropdown, click "Get Talking Points".

### Sampling Rate
- **Per task commit:** Manual browser test -- search, observe badges, open modal, test filter
- **Per wave merge:** Full manual walkthrough of all 4 requirements
- **Phase gate:** All 4 UI requirements visually confirmed working in browser

### Wave 0 Gaps
None -- this is a frontend-only phase. Backend APIs are already tested and functional. No new test infrastructure is needed since there is no JS test framework and adding one is out of scope for a 3-file vanilla JS project.

## Sources

### Primary (HIGH confidence)
- **Existing codebase** (`static/script.js`, `static/styles.css`, `static/index.html`) -- read and analyzed in full. All patterns, variable names, CSS classes, and function signatures documented above are from the actual source code.
- **Backend API** (`server.py`, `matching/models.py`, `matching/matcher.py`, `matching/explain.py`) -- read in full. Response shapes, endpoint contracts, and data models confirmed from source.
- **Phase 2 test fixtures** (`tests/test_api_match.py`) -- confirmed exact JSON response structure with mock data.

### Secondary (MEDIUM confidence)
- **CSS `@keyframes` pulse animation** -- standard CSS animation pattern, well-supported in all modern browsers.
- **`Promise.allSettled` / manual counter for tracking parallel fetches** -- standard JavaScript pattern for coordinating multiple async operations.

### Tertiary (LOW confidence)
- None. All findings are based on direct source code analysis.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- directly from existing codebase analysis, no assumptions
- Architecture: HIGH -- all patterns extend existing code structure with clear integration points
- Pitfalls: HIGH -- derived from actual code flow analysis (race conditions, DOM update timing)

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable -- no external dependencies changing)
