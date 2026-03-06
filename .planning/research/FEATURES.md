# Feature Landscape

**Domain:** AI-powered loan program matching for LO-facing property listing tool
**Researched:** 2026-03-06
**Confidence:** MEDIUM (based on domain knowledge of mortgage tech tools and RAG systems; web search unavailable for verification)

## Context

This analysis examines features for an internal GMCC tool where loan officers search active property listings and see which GMCC loan programs could apply to each property. This is NOT a full product & pricing engine (PPE) like Optimal Blue or Polly -- those require borrower data (credit score, DTI, LTV, employment). This is a property-side pre-qualification tool: given a listing's price, location, property type, and estimated rent, which GMCC programs are even in the conversation?

The competitive frame is not "vs Optimal Blue" but rather "vs the LO looking at a listing and mentally running through programs from memory." The bar is: faster and more reliable than an experienced LO's mental recall.

---

## Table Stakes

Features users expect. Missing any of these and the tool feels broken or useless.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Program badges on property cards | LOs need at-a-glance indication of which programs apply without clicking into each listing | Medium | Core value prop. Each card should show 1-3 top matching program names as colored badges. If no programs match, show "No Matching Programs" in gray. |
| Program match detail on click | Clicking a property must show WHY each program matches or does not match, with specific criteria cited | Medium | This is the "credibility" feature. LOs need to trust the matching. Show each program with pass/fail per criterion (property type, location, loan amount range, etc.). |
| Match confidence indicator | Each program match needs a confidence signal -- "Strong Match" vs "Possible Match" vs "Needs Verification" | Low | Based on how many criteria could be verified from listing data vs how many are unknown. A property with full data gets "Strong Match"; one missing rent estimate gets "Possible Match." |
| Property type eligibility filtering | Programs must correctly filter by property type (SFR, Condo, 2-4 Unit, Townhouse, etc.) | Low | Direct mapping from RentCast `propertyType` to program guidelines. This is the most straightforward matching criterion and must be correct. |
| Loan amount range matching | Programs have min/max loan amounts; listing price should be checked against these ranges | Low | Use listing price as proxy for loan amount (conservative: assume 80% LTV for conventional, 96.5% for FHA, etc.). Flag when price is outside program range. |
| Location-based eligibility | Some programs are state-specific, county-specific, or have geographic restrictions (e.g., USDA rural, state bond programs) | Medium | Requires mapping listing address/county/zip to program geographic eligibility. RentCast provides city, state, zipCode, county -- sufficient for most rules. |
| Program data from guideline PDFs | The RAG knowledge base must be built from actual GMCC guideline PDFs, not hardcoded rules | High | Core technical challenge. PDFs must be parsed, chunked, and indexed. Program rules must be extractable as structured criteria, not just free-text retrieval. |
| Search functionality (existing) | Property search by address or zip with radius -- already built | Done | Existing MVP covers this. Maintain current UX. |
| Property detail view (existing) | Full listing details with contact info -- already built | Done | Existing MVP covers this. Add program matching section to the modal. |
| User authentication | Multiple LOs and branch managers need separate access; internal tool should not be public | Medium | Simple login. Does not need SSO or complex RBAC for MVP. Username/password or invite-code based access. |

## Differentiators

Features that set the tool apart. Not expected by users on day one, but create significant value once delivered.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| DSCR/rental program matching with rent estimation | For investment properties, estimate potential rent and check DSCR program eligibility. Most LOs cannot do this math in their head during a listing conversation. | High | RentCast may offer rent estimates via a separate API call, or use comparable rent data. DSCR = (Monthly Rent / Monthly PITIA). If estimated DSCR > program minimum (typically 0.75-1.25), flag DSCR programs as viable. This is the single most differentiating feature -- DSCR programs are GMCC's specialty lending play. |
| Program comparison view | Side-by-side comparison of 2-3 matching programs for a specific property showing rate ranges, LTV limits, and key differences | Medium | LOs frequently need to explain "why Program A vs Program B" to realtors. A comparison view makes this conversation easy. |
| Rate sheet awareness | Incorporate daily rate sheet data so program matches include approximate rate ranges, not just eligibility | High | Requires periodic ingestion of rate sheet data (PDF or structured). Transforms tool from "is it eligible?" to "is it eligible and roughly what rate?" Massive value but significant data pipeline work. |
| Talking points generation | For each matched program, generate a 2-3 sentence plain-English summary the LO can use when talking to the listing agent | Low | Leverages the LLM already in the stack. Template: "This [property type] at [price] could qualify for GMCC's [Program Name], which offers [key benefit]. [One differentiator vs conventional]." |
| Listing agent contact integration | One-click to copy formatted talking points + property details for outreach to the listing agent whose contact info is already displayed | Low | Not email sending -- just clipboard copy of a formatted message. Listing agent name, phone, and email already come from RentCast. Combine with program matches for a prepared outreach snippet. |
| Search result filtering by program eligibility | Filter the property search results to show only listings eligible for a specific program (e.g., "Show me only DSCR-eligible properties") | Medium | Inverts the flow: instead of "find listings, then check programs," it becomes "I want to pitch this program, show me eligible listings." Powerful for LOs who specialize in specific programs. |
| Multi-property program summary | After searching an area, show a summary: "12 of 20 properties qualify for FHA, 8 for DSCR, 15 for Conventional" -- giving the LO an area-level view | Low | Aggregation of individual property matches. Useful for LOs prospecting an entire neighborhood or zip code. |
| Saved searches with alerts | Save a search (zip code + radius + program filter) and get notified when new matching listings appear | High | Requires a database, background jobs, and notification system. Future feature but high value for active prospecting LOs. |
| Branch manager dashboard | Aggregate view for managers: which LOs are using the tool, which programs are matching most, which areas are being searched | Medium | Analytics layer. Valuable for management but not for individual LOs. Requires auth with roles. |

## Anti-Features

Features to explicitly NOT build. Each would add complexity without sufficient value for this use case.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full borrower qualification | No buyer data available from listings. Building borrower intake (credit score, income, DTI) makes this a completely different product -- a full LOS/POS, not a listing tool. | Match on property-side criteria only. Label results as "potentially eligible based on property data" not "qualified." |
| Automated email/SMS outreach to listing agents | Sending automated messages to listing agents creates compliance risk, spam risk, and reputation risk. LOs need control over their outreach voice. | Provide copy-ready talking points and contact info. Let the LO decide when and how to reach out. |
| Direct MLS integration / IDX feed | MLS data licensing is expensive, complex, and regionally fragmented. RentCast already aggregates this data. Building direct MLS integration is a multi-month project with legal overhead. | Continue using RentCast API. If data gaps emerge, evaluate MLS integration as a later phase. |
| Real-time rate lock / pricing | Rate locking requires integration with GMCC's LOS (Encompass, etc.), compliance workflows, and real-time investor pricing feeds. This is a full PPE, not a listing tool. | Show approximate rate ranges from rate sheets as informational only. Include disclaimers. |
| Open house scheduling / calendar integration | The PROJECT.md explicitly defers this. Open house data is not reliably available from RentCast and scraping it from other sources is fragile. | If RentCast adds open house data in the future, surface it. Do not build scraping infrastructure. |
| Buyer-facing portal / consumer access | This is an internal LO tool. Exposing it to consumers changes compliance requirements (TILA, RESPA advertising rules), requires different UX, and dilutes the LO-specific value. | Keep strictly internal. If consumer-facing is ever needed, build as a separate product. |
| Custom LLM fine-tuning | Fine-tuning a model on GMCC guidelines is expensive, hard to update when programs change, and unnecessary. RAG with structured extraction handles this use case better. | Use RAG with well-structured document parsing. Update the knowledge base by re-ingesting PDFs when programs change. |
| Map-based visualization | While maps are visually appealing, they add significant frontend complexity (map library, tiles, markers, clustering) without improving the core matching workflow. LOs care about the program match, not the pin on a map. | Keep the card-based list view. Add distance info (already present). Consider maps as a late-stage polish feature only. |
| Multi-lender comparison | Comparing GMCC programs against competitors' programs requires competitor rate data (which GMCC does not have) and creates a tool that might recommend against GMCC. | Only show GMCC programs. The tool's job is to find which GMCC programs work, not to compare GMCC vs other lenders. |

## Feature Dependencies

```
Property Search (existing) --> Program Matching Engine (core)
                                    |
                                    +--> Program Badges on Cards
                                    +--> Program Detail in Modal
                                    +--> Match Confidence Indicator
                                    +--> Talking Points Generation

Guideline PDF Parsing --> RAG Knowledge Base --> Program Matching Engine

User Authentication --> All Features (gate access)

Program Matching Engine --> Search Filtering by Program (requires matching to run first)
                       --> Multi-Property Summary (aggregation of matches)
                       --> Program Comparison View

Rate Sheet Ingestion --> Rate Sheet Awareness --> Enhanced Talking Points

RentCast Rent Estimate API --> DSCR/Rental Program Matching

Database (new) --> Saved Searches
              --> Branch Manager Dashboard
              --> User Authentication (user storage)
```

### Critical Path

The critical dependency chain for the core value prop is:

```
Guideline PDF Parsing --> Structured Program Rules --> Matching Engine --> UI Integration
```

Everything else builds on top of the matching engine. If the matching engine is unreliable or slow, no downstream feature matters.

## MVP Recommendation

**Prioritize (Phase 1 -- Core Matching):**

1. **Guideline PDF parsing and structured rule extraction** -- This is the hardest problem and the foundation. If program rules cannot be reliably extracted from PDFs, nothing else works. Approach: parse PDFs into structured JSON rule sets (property type eligibility, location restrictions, loan amount limits, LTV requirements, occupancy rules). Store these as structured data, not just vector embeddings.

2. **Program matching engine** -- Given a property's attributes (price, type, location, county), check against structured program rules. Return matches with confidence levels. Start with deterministic rule matching, use LLM only for ambiguous cases or natural language explanations.

3. **Program badges on property cards** -- Visual integration into existing card UI. Color-coded badges showing matching program names. This is the "wow moment" that demonstrates value.

4. **Program match detail in modal** -- Expand existing property detail modal with a "Matching Programs" section showing per-program eligibility breakdown (which criteria passed, which are unknown, which failed).

5. **User authentication** -- Simple login to gate access. Does not need to be fancy. Session-based auth with Flask-Login is sufficient.

**Prioritize (Phase 2 -- Enhanced Value):**

6. **Match confidence indicators** -- Strong/Possible/Needs Verification based on data completeness.
7. **Talking points generation** -- LLM-generated plain-English summaries for each match.
8. **DSCR/rental program matching** -- Rent estimation + DSCR calculation. High value, high complexity.

**Defer:**

- **Rate sheet awareness**: High value but requires a separate data pipeline for daily PDF ingestion. Build after core matching is proven reliable.
- **Search filtering by program**: Requires core matching to be fast enough to run across all results. Optimize matching performance first.
- **Saved searches / alerts**: Requires database, background jobs, notifications. Build after core loop is validated.
- **Branch manager dashboard**: Analytics layer. Build only after there are enough users to generate meaningful data.
- **Program comparison view**: Nice-to-have after individual matching works well.
- **Listing agent contact integration (copy-ready outreach)**: Low complexity but should wait until talking points are polished.

## Matching Engine Design Considerations

This section is included because the matching engine is the centerpiece feature, and its design fundamentally shapes every other feature.

### Hybrid Approach: Structured Rules + LLM

**Do NOT rely purely on RAG for matching.** RAG (retrieve relevant chunks, ask LLM to answer) works well for open-ended questions but is unreliable for systematic eligibility checking where every criterion matters. A missed paragraph about county restrictions means a wrong match.

**Recommended approach:**

1. **Parse guideline PDFs once** into structured rule sets (JSON/database records):
   - Property types allowed: ["SFR", "Condo", "2-4 Unit", "Townhouse"]
   - States/counties allowed or excluded
   - Loan amount min/max
   - LTV limits (by property type, occupancy)
   - Occupancy types: ["Primary", "Investment", "Second Home"]
   - Special requirements (e.g., DSCR minimum, minimum credit score ranges)

2. **Match deterministically** against structured rules. This is fast, reliable, and explainable.

3. **Use LLM (via RAG) for:**
   - Generating natural-language explanations of why a program matches
   - Answering follow-up questions about a program ("What are the reserve requirements?")
   - Handling edge cases where structured rules are ambiguous
   - Generating talking points

This hybrid approach gives reliability for matching (deterministic) and flexibility for explanations (LLM).

### Data Completeness Problem

Not all listing data needed for matching is available from RentCast. Handle missing data explicitly:

| Data Point | Available from RentCast? | Matching Impact |
|-----------|--------------------------|-----------------|
| Price | Yes | Loan amount range check |
| Property Type | Yes | Direct eligibility filter |
| City/State/County/Zip | Yes | Location eligibility |
| Bedrooms/Bathrooms | Yes | Relevant for some programs (unit count) |
| Estimated Rent | No (separate API call or estimation needed) | DSCR program eligibility |
| Occupancy Intent | No (depends on buyer, not property) | Cannot determine -- show all occupancy options |
| HOA info | Partially (fee only) | Condo eligibility (warrantable vs non-warrantable unknown) |
| Year Built | Yes | Some programs restrict property age |

**Rule: When data is missing, do not exclude the program.** Instead, mark the criterion as "unverified" and let the LO make the judgment call. The tool should over-include with caveats rather than under-include and miss opportunities.

## Competitive Landscape Context

The tools in this space fall into distinct categories. GMCC's tool sits in a unique niche:

| Category | Examples | What They Do | Why GMCC Is Different |
|----------|----------|--------------|----------------------|
| Product & Pricing Engines (PPE) | Optimal Blue, Polly, Mortech, LoanTek, Lender Price | Full borrower+property eligibility with real-time pricing across multiple investors/channels | GMCC only needs its own programs, no borrower data, no real-time pricing |
| LO CRM / Outreach | Total Expert, BNTouch, Aidium, Homebot | Contact management, email campaigns, lead nurture | GMCC is not building a CRM, just a listing lookup with matching |
| Listing Search Tools | Zillow Pro, Realtor.com Pro, MLS systems | Property search and details for real estate professionals | GMCC has this via RentCast; adding program matching is the differentiator |
| AI Mortgage Assistants | Various chatbots, Capacity, Kasisto | Conversational AI for borrower questions | GMCC has an existing chatbot; this tool is structured matching, not chat |

**The gap this tool fills:** No existing tool combines "search active listings" with "automatically show which of MY lender's programs apply." LOs currently do this manually -- look at a listing, mentally recall programs, check a rate sheet. This tool automates that mental process.

## Sources

- Domain knowledge of mortgage technology products (Optimal Blue, Polly, LoanTek, Mortech/Zillow, Lender Price PPE platforms)
- Domain knowledge of LO-facing tools (Total Expert, BNTouch, Aidium CRM/outreach platforms)
- Domain knowledge of RAG system design patterns for document QA
- GMCC project context from PROJECT.md
- Existing codebase analysis from .planning/codebase/ files
- Confidence: MEDIUM -- web search was unavailable for verification of current product features and pricing. Recommendations are based on training data knowledge of the mortgage tech ecosystem through early 2025. Core patterns in this space (PPE, eligibility matching, guideline management) are stable and unlikely to have changed significantly.

---

*Feature research: 2026-03-06*
