# Phase 2: Matching Engine - Research

**Researched:** 2026-03-06
**Domain:** Deterministic rule matching, reverse geocoding, LLM explanation generation
**Confidence:** HIGH

## Summary

The Matching Engine takes RentCast property listing data and checks it against structured program JSON rules (from Phase 1) to determine eligibility. The core matching logic is straightforward deterministic comparison: map listing fields to program tier criteria, check each criterion, and produce a per-criterion pass/fail/unverified breakdown. The system currently has one program (Thunder, 44 tiers) with the schema supporting multiple programs.

A critical discovery: RentCast sale listing responses already include `county`, `countyFips`, `state`, and `stateFips` fields directly in the response. This means reverse geocoding from coordinates is only needed as a **fallback** when RentCast's county field is missing, not as the primary path. The FCC Area API (`geo.fcc.gov`) is the best fallback -- free, no API key, fast, returns county name and FIPS code.

The LLM explanation feature (Gemini Flash) is on-demand only, triggered when the LO clicks into program details. The project already has a working pattern for Gemini calls (`rag/structure.py`) and ChromaDB queries (`rag/vectorstore.py`) that can be reused directly.

**Primary recommendation:** Build a pure-Python matching module (`matching/`) with a `match_listing()` function that loads all program JSONs, checks listing data against every tier, and returns structured results with per-criterion status. Use the FCC Area API as county fallback. Add a `/api/match` endpoint to Flask and a `/api/explain` endpoint for on-demand LLM explanations.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Static lookup table for RentCast property types to program rule terms (e.g., "Single Family" -> "SFR", "Condo" -> "Condo")
- Assume transaction type is "Purchase" for all active listings (this is a listing search tool for active sales)
- Skip occupancy type filtering -- show all occupancy tiers as potential matches since occupancy is unknown without buyer data
- Use listing price as proxy for loan amount when checking against min/max_loan_amount tier ranges
- Reverse geocode coordinates to get county for location restriction matching (external geocoding API needed)
- Parse state from RentCast address string for state-level restrictions
- Two-tier status: "Eligible" (all checkable criteria pass, none unverified) and "Potentially Eligible" (some pass, some unverified, none fail). Any criterion fail = excluded
- Property card badge counts both Eligible and Potentially Eligible together; detail modal distinguishes the two
- Program-level rollup: show "Thunder: Eligible" with best-matching tier highlighted; detail view lists which tiers matched
- Per-criterion breakdown always shows all criteria (property type, loan amount, location, unit count) with pass/fail/unverified -- consistent view so LO always knows what was checked
- On-demand LLM explanations only -- generate when LO clicks into program detail (not eagerly)
- Explanation content: 2-3 sentence program summary + bullet-point talking points for LO
- Use ChromaDB vector context (original guideline chunks) alongside structured JSON for richer explanations
- Use Gemini Flash (gemini-2.5-flash) -- already configured, consistent with Phase 1

### Claude's Discretion
- Specific reverse geocoding provider (Census Bureau, Google, etc.)
- Exact matching function API signature and return types
- Caching strategy for match results and explanations
- Error handling for geocoding failures

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MATCH-01 | System matches each property listing against all GMCC programs based on available listing data (price, property type, location, county) | RentCast provides price, propertyType, county, state, latitude/longitude directly. Property type mapping table handles RentCast->program term conversion. Matching function iterates all program JSONs and all tiers. |
| MATCH-02 | Each program match includes per-criterion pass/fail/unknown status (property type eligible, loan amount in range, location allowed) | CriterionResult model with status enum (PASS/FAIL/UNVERIFIED) for each checkable criterion. TierResult aggregates criteria into tier-level status. ProgramResult aggregates tiers into program-level status. |
| MATCH-03 | When listing data is insufficient to determine eligibility, system marks criterion as "unverified" rather than excluding the program | Three-value logic: PASS/FAIL/UNVERIFIED. Missing county = location UNVERIFIED. Missing bedrooms (can't determine unit count) = unit_count UNVERIFIED. Overall status becomes "Potentially Eligible" when any criterion is UNVERIFIED and none FAIL. |
| MATCH-04 | Matching uses deterministic rule checking for eligibility decisions and LLM only for generating natural-language explanations | Core match_listing() is pure Python with no LLM calls. Separate explain_match() function calls Gemini Flash on-demand, using ChromaDB context + structured tier data. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pydantic | 2.10.5 | Match result models (CriterionResult, TierResult, ProgramResult, ListingInput) | Already used for ProgramRules/EligibilityTier; consistent pattern |
| flask | 3.1.3 | `/api/match` and `/api/explain` endpoints | Already used in server.py |
| google-genai | 1.66.0 | Gemini Flash calls for on-demand explanations | Already used in rag/structure.py |
| chromadb | 1.5.2 | Query guideline chunks for explanation context | Already used in rag/vectorstore.py |
| requests | 2.32.5 | FCC Area API calls for county fallback | Already installed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| functools.lru_cache | stdlib | Cache loaded program JSONs and geocoding results | Always -- avoid re-reading JSON files on every request |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| FCC Area API (geocoding fallback) | Census Bureau Geocoder | Census API is more complex, requires benchmark/vintage params; FCC is simpler single endpoint |
| FCC Area API (geocoding fallback) | Google Geocoding API | Requires API key and billing; FCC is free and keyless |
| In-memory JSON loading | Database | Overkill for <10 programs with <100 tiers each; JSON files from Phase 1 are the source of truth |

**Installation:**
```bash
# No new packages needed -- all dependencies already installed from Phase 1
```

## Architecture Patterns

### Recommended Project Structure
```
matching/
    __init__.py          # Package init
    models.py            # Pydantic models: ListingInput, CriterionResult, TierResult, ProgramResult, MatchResponse
    matcher.py           # Core matching logic: load_programs(), match_listing(), match_tier()
    property_types.py    # RENTCAST_TO_PROGRAM property type lookup table
    geocode.py           # FCC Area API county fallback
    explain.py           # Gemini Flash on-demand explanation generation
```

### Pattern 1: Three-Value Criterion Matching
**What:** Each criterion check returns PASS, FAIL, or UNVERIFIED (not just True/False)
**When to use:** Every criterion check in the matching logic
**Example:**
```python
from enum import Enum
from pydantic import BaseModel

class CriterionStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    UNVERIFIED = "unverified"

class CriterionResult(BaseModel):
    criterion: str          # e.g., "property_type", "loan_amount", "location", "unit_count"
    status: CriterionStatus
    detail: str             # Human-readable explanation, e.g., "Single Family matches SFR"

def check_property_type(listing_type: str | None, tier_types: list[str]) -> CriterionResult:
    if listing_type is None:
        return CriterionResult(
            criterion="property_type",
            status=CriterionStatus.UNVERIFIED,
            detail="Property type not available in listing data"
        )

    mapped = RENTCAST_TO_PROGRAM.get(listing_type)
    if mapped is None:
        return CriterionResult(
            criterion="property_type",
            status=CriterionStatus.UNVERIFIED,
            detail=f"Property type '{listing_type}' has no mapping to program terms"
        )

    if mapped in tier_types:
        return CriterionResult(
            criterion="property_type",
            status=CriterionStatus.PASS,
            detail=f"{listing_type} matches {mapped}"
        )

    return CriterionResult(
        criterion="property_type",
        status=CriterionStatus.FAIL,
        detail=f"{listing_type} ({mapped}) not in {tier_types}"
    )
```

### Pattern 2: Tier-Level Aggregation with Two-Tier Overall Status
**What:** Aggregate per-criterion results into tier status, then aggregate tiers into program status
**When to use:** After all criteria checked for a tier
**Example:**
```python
class OverallStatus(str, Enum):
    ELIGIBLE = "Eligible"
    POTENTIALLY_ELIGIBLE = "Potentially Eligible"
    INELIGIBLE = "Ineligible"

class TierResult(BaseModel):
    tier_name: str
    status: OverallStatus
    criteria: list[CriterionResult]

def compute_tier_status(criteria: list[CriterionResult]) -> OverallStatus:
    statuses = [c.status for c in criteria]
    if CriterionStatus.FAIL in statuses:
        return OverallStatus.INELIGIBLE
    if CriterionStatus.UNVERIFIED in statuses:
        return OverallStatus.POTENTIALLY_ELIGIBLE
    return OverallStatus.ELIGIBLE

class ProgramResult(BaseModel):
    program_name: str
    status: OverallStatus           # Best status across eligible tiers
    matching_tiers: list[TierResult]  # Only tiers that are Eligible or Potentially Eligible
    best_tier: str | None           # Name of the best-matching tier
```

### Pattern 3: Program JSON Loading with Caching
**What:** Load all program JSON files once and cache in memory
**When to use:** At startup / first request
**Example:**
```python
import json
import os
from functools import lru_cache
from rag.config import PROGRAMS_DIR
from rag.schemas import ProgramRules

@lru_cache(maxsize=1)
def load_programs() -> list[ProgramRules]:
    """Load all program rule JSONs from data/programs/. Cached after first call."""
    programs = []
    for filename in os.listdir(PROGRAMS_DIR):
        if filename.endswith(".json"):
            with open(os.path.join(PROGRAMS_DIR, filename)) as f:
                data = json.load(f)
            programs.append(ProgramRules.model_validate(data))
    return programs
```

### Pattern 4: On-Demand Explanation with ChromaDB Context
**What:** Generate LLM explanation only when requested, using vector store context
**When to use:** `/api/explain` endpoint, triggered by user click
**Example:**
```python
from google import genai
from google.genai import types
from rag.config import GEMINI_API_KEY, GEMINI_MODEL
from rag.vectorstore import query_program_info

def explain_match(program_name: str, listing: dict, tier_name: str) -> str:
    """Generate LO-facing explanation using Gemini Flash + ChromaDB context."""
    # Retrieve relevant guideline chunks
    context = query_program_info(
        query=f"{program_name} {tier_name} eligibility requirements",
        program_name=program_name,
        n_results=3,
    )
    chunks = "\n---\n".join(context["documents"][0]) if context["documents"][0] else ""

    client = genai.Client(api_key=GEMINI_API_KEY)
    prompt = f"""You are helping a loan officer understand why a property matches a GMCC loan program.

Program: {program_name}
Matching Tier: {tier_name}
Property: {json.dumps(listing, indent=2)}

Guideline context:
{chunks}

Write:
1. A 2-3 sentence summary of this program and why this property qualifies.
2. 3-4 bullet-point talking points the LO could use when speaking with a listing agent about this property.

Keep it professional and concise. Focus on what makes this a good fit."""

    response = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
    )
    return response.text
```

### Anti-Patterns to Avoid
- **Calling LLM for eligibility decisions:** The LLM must NEVER make match/no-match decisions. All eligibility is deterministic rule checking. LLM is only for natural-language explanations.
- **Failing on missing data:** Never mark a criterion as FAIL when the listing simply doesn't have the data. Use UNVERIFIED instead.
- **Matching against all 44 tiers naively without filtering:** Filter by transaction_type="Purchase" first (locked decision), which eliminates ~60% of tiers immediately.
- **Loading program JSONs on every request:** Cache them. They only change when guidelines are re-ingested.
- **Eager LLM calls:** Do not call Gemini for every listing match. Only call when LO explicitly requests an explanation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Property type mapping | Complex regex/NLP parsing of property descriptions | Static dict lookup table | RentCast returns standardized enum values; mapping is 1:1 |
| County geocoding fallback | Custom lat/lon-to-county math or shapefile processing | FCC Area API (`geo.fcc.gov/api/census/area`) | Free, no API key, returns county_name + county_fips directly |
| JSON schema validation | Manual dict key checking | Pydantic model_validate | Already used for ProgramRules; consistent pattern |
| Natural language explanations | Template strings with hardcoded text | Gemini Flash + ChromaDB context | Richer, more natural output; leverages existing RAG infrastructure |

**Key insight:** The matching logic itself is simple comparisons. The complexity is in handling missing data (three-value logic) and structuring the results for the UI. Don't over-engineer the matching; spend effort on clean result models.

## Common Pitfalls

### Pitfall 1: Treating Missing Data as Failure
**What goes wrong:** A listing without county data gets excluded from all programs with location restrictions, even though it might be eligible.
**Why it happens:** Boolean logic (True/False) doesn't capture "unknown." Developers default to `if not county: return False`.
**How to avoid:** Use three-value logic (PASS/FAIL/UNVERIFIED). Every criterion check function must handle None input by returning UNVERIFIED.
**Warning signs:** Zero "Potentially Eligible" results in testing -- means the UNVERIFIED path isn't working.

### Pitfall 2: Property Type String Mismatch
**What goes wrong:** RentCast returns "Single Family" but program rules say "SFR". Direct string comparison fails.
**Why it happens:** Different systems use different terminology for the same property types.
**How to avoid:** Use the static RENTCAST_TO_PROGRAM lookup table. Map RentCast types at the boundary, not deep in matching logic.
**Warning signs:** All property type checks return FAIL despite matching property types.

### Pitfall 3: Unit Count Inference from Property Type
**What goes wrong:** A "Multi-Family" listing matches against tiers requiring unit_count_limits=[1], or a "Single Family" doesn't match unit_count_limits=[1] because no explicit bedrooms/units mapping exists.
**Why it happens:** RentCast's "Multi-Family" means 2-4 units, but the exact unit count isn't always in the listing. "Single Family" is always 1 unit but that's implicit.
**How to avoid:** Map "Single Family" -> unit count 1, "Condo" -> unit count 1, "Townhouse" -> unit count 1. For "Multi-Family", mark unit_count as UNVERIFIED unless bedrooms field provides clarity.
**Warning signs:** Multi-Family properties showing as FAIL for all tiers instead of UNVERIFIED.

### Pitfall 4: Loan Amount vs. Listing Price Confusion
**What goes wrong:** Using listing price directly as loan amount, but listing price != loan amount (there's a down payment).
**Why it happens:** We don't have down payment or LTV info from listings.
**How to avoid:** This is an accepted approximation (locked decision). The listing price is an upper bound for loan amount. Check if price falls within the tier's min/max loan amount range. If price > max_loan_amount, that's a real FAIL (loan can't be larger than price). If price < min_loan_amount, mark UNVERIFIED (borrower might have a smaller down payment than assumed).
**Warning signs:** Low-price properties excluded from high-LTV tiers that they should match.

### Pitfall 5: FCC API Rate Limiting or Downtime
**What goes wrong:** FCC geocoding API is slow, rate-limited, or down during production use.
**Why it happens:** It's a free government API with no SLA.
**How to avoid:** Cache geocoding results (county lookup by lat/lon rounded to 2 decimals is stable). RentCast already provides county in most responses, so FCC is only the fallback. On FCC failure, mark location as UNVERIFIED rather than crashing.
**Warning signs:** Slow response times on `/api/match` when many listings lack county data.

### Pitfall 6: Occupancy Type Confusion
**What goes wrong:** Filtering by occupancy type when we don't know if the buyer intends primary residence, second home, or investment.
**Why it happens:** Occupancy is buyer-specific, not property-specific.
**How to avoid:** Locked decision: skip occupancy type filtering. Show all occupancy tiers as potential matches. This is correct behavior -- the LO knows their buyer's intent.
**Warning signs:** If occupancy filtering is accidentally applied, many tiers that should match will be excluded.

## Code Examples

### Property Type Mapping Table
```python
# Source: RentCast API docs (developers.rentcast.io/reference/property-types)
# mapped to program terms from thunder.json tier data
RENTCAST_TO_PROGRAM: dict[str, str] = {
    "Single Family": "SFR",
    "Condo": "Condo",
    "Townhouse": "SFR",        # Townhouses treated as SFR in most programs
    "Multi-Family": "2-4 Units",
    "Manufactured": "Manufactured",  # May not match any current program
    "Apartment": "2-4 Units",   # 5+ units typically not eligible
    "Land": "Land",             # Likely no matching programs
}

# Unit count inference from RentCast property type
PROPERTY_TYPE_UNITS: dict[str, int | None] = {
    "Single Family": 1,
    "Condo": 1,
    "Townhouse": 1,
    "Multi-Family": None,   # Unknown: could be 2, 3, or 4
    "Manufactured": 1,
    "Apartment": None,       # Unknown
    "Land": None,            # N/A
}
```

### FCC Area API County Fallback
```python
import requests
from functools import lru_cache

@lru_cache(maxsize=1024)
def get_county_from_coordinates(lat: float, lon: float) -> dict | None:
    """Reverse geocode coordinates to county using FCC Area API.

    Returns dict with county_name, county_fips, state_code, state_name,
    or None on failure. Results are cached by (lat, lon) rounded to 3 decimals.
    """
    lat_r = round(lat, 3)
    lon_r = round(lon, 3)
    try:
        resp = requests.get(
            "https://geo.fcc.gov/api/census/area",
            params={"lat": lat_r, "lon": lon_r, "format": "json"},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("results"):
            r = data["results"][0]
            return {
                "county_name": r.get("county_name"),
                "county_fips": r.get("county_fips"),
                "state_code": r.get("state_code"),
                "state_name": r.get("state_name"),
            }
    except (requests.RequestException, KeyError, IndexError):
        pass
    return None
```

### Listing Input Model
```python
class ListingInput(BaseModel):
    """Normalized input for the matching engine from a RentCast listing."""
    price: float | None = None
    property_type: str | None = None   # RentCast enum value
    state: str | None = None           # 2-char abbreviation
    county: str | None = None          # County name
    county_fips: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    bedrooms: int | None = None
    bathrooms: float | None = None
    square_footage: int | None = None

    @classmethod
    def from_rentcast(cls, listing: dict) -> "ListingInput":
        """Create from raw RentCast API response dict."""
        return cls(
            price=listing.get("price"),
            property_type=listing.get("propertyType"),
            state=listing.get("state"),
            county=listing.get("county"),
            county_fips=listing.get("countyFips"),
            latitude=listing.get("latitude"),
            longitude=listing.get("longitude"),
            bedrooms=listing.get("bedrooms"),
            bathrooms=listing.get("bathrooms"),
            square_footage=listing.get("squareFootage"),
        )
```

### Flask Endpoint Pattern
```python
@app.route('/api/match', methods=['POST'])
def match_listing_endpoint():
    """Match a listing against all GMCC programs.

    Request body: RentCast listing object (JSON)
    Response: { programs: [...ProgramResult], listing_summary: {...} }
    """
    listing_data = request.get_json()
    if not listing_data:
        return jsonify({"success": False, "error": "No listing data provided"}), 400

    listing = ListingInput.from_rentcast(listing_data)
    results = match_listing(listing)

    return jsonify({
        "success": True,
        "programs": [r.model_dump() for r in results],
        "eligible_count": sum(1 for r in results if r.status != OverallStatus.INELIGIBLE),
    })
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| google.generativeai SDK | google-genai SDK (google.genai) | 2024-2025 | Project already uses new SDK; consistent |
| Manual geocoding lookups | FCC Area API (free, no key) | Always available | No API key management needed |
| Binary match/no-match | Three-value logic (pass/fail/unverified) | Domain best practice | Prevents false negatives from missing data |

**Deprecated/outdated:**
- `google.generativeai` package: Replaced by `google-genai`. Project already uses the new one.
- FCC Census Block Conversions API v1.0: Replaced by FCC Area API at `geo.fcc.gov/api/census/area`.

## Open Questions

1. **Location restriction format in future programs**
   - What we know: Thunder has zero location restrictions. The schema supports `location_restrictions: list[str]` but we have no examples of populated values yet.
   - What's unclear: Will restrictions be state codes ("CA"), county names ("San Francisco County"), county FIPS codes ("06075"), or free-text descriptions?
   - Recommendation: Implement location matching to handle both state codes and county name substring matching. When new programs are ingested, validate that the restriction format is handled. Add a note in the matching code for extensibility.

2. **Townhouse -> SFR mapping correctness**
   - What we know: Most GMCC programs treat townhouses as SFR for eligibility purposes.
   - What's unclear: Some programs may have separate townhouse eligibility rules.
   - Recommendation: Map Townhouse -> SFR for now. If a program ever distinguishes townhouses, the mapping table is easy to update.

3. **Price as loan amount: edge cases for low prices**
   - What we know: Listing price is the upper bound for loan amount. Decision is locked.
   - What's unclear: If a $200K property checks against a tier with min_loan_amount=$806,501, should it FAIL or UNVERIFIED? The borrower won't get a $806K loan on a $200K property.
   - Recommendation: FAIL when price < min_loan_amount. The price IS the ceiling for loan amount, so it's impossible to reach the min. PASS when min_loan_amount <= price <= max_loan_amount. FAIL when price > max_loan_amount (the loan can't exceed the price).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest 9.0.2 |
| Config file | pyproject.toml (markers section exists) |
| Quick run command | `pytest tests/test_matching.py -x -q` |
| Full suite command | `pytest tests/ -x -q` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MATCH-01 | match_listing returns results for all programs given a listing | unit | `pytest tests/test_matching.py::test_match_returns_all_programs -x` | No -- Wave 0 |
| MATCH-01 | Property type mapping covers all RentCast types | unit | `pytest tests/test_matching.py::test_property_type_mapping -x` | No -- Wave 0 |
| MATCH-02 | Each program result contains per-criterion breakdown | unit | `pytest tests/test_matching.py::test_per_criterion_breakdown -x` | No -- Wave 0 |
| MATCH-02 | Criterion results include pass/fail/unverified status | unit | `pytest tests/test_matching.py::test_criterion_status_values -x` | No -- Wave 0 |
| MATCH-03 | Missing county marks location as unverified, not fail | unit | `pytest tests/test_matching.py::test_missing_county_unverified -x` | No -- Wave 0 |
| MATCH-03 | Missing property type marks as unverified | unit | `pytest tests/test_matching.py::test_missing_property_type_unverified -x` | No -- Wave 0 |
| MATCH-03 | Overall status is "Potentially Eligible" when unverified criteria exist | unit | `pytest tests/test_matching.py::test_potentially_eligible_status -x` | No -- Wave 0 |
| MATCH-04 | match_listing makes zero LLM calls | unit | `pytest tests/test_matching.py::test_no_llm_calls_in_matching -x` | No -- Wave 0 |
| MATCH-04 | explain_match calls Gemini and returns text | unit | `pytest tests/test_matching.py::test_explain_calls_gemini -x` | No -- Wave 0 |
| MATCH-01 | /api/match endpoint returns valid JSON | integration | `pytest tests/test_api_match.py::test_match_endpoint -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pytest tests/test_matching.py -x -q`
- **Per wave merge:** `pytest tests/ -x -q`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/test_matching.py` -- covers MATCH-01 through MATCH-04 unit tests
- [ ] `tests/test_api_match.py` -- covers /api/match and /api/explain endpoint integration tests
- [ ] `tests/conftest.py` -- add fixtures for sample listing data and program rules (extend existing conftest)
- [ ] Framework install: Already installed (pytest 9.0.2)

## Sources

### Primary (HIGH confidence)
- [RentCast Property Listings Schema](https://developers.rentcast.io/reference/property-listings-schema) - Confirmed county, countyFips, state, stateFips, price, propertyType fields in sale listing response
- [RentCast Property Types](https://developers.rentcast.io/reference/property-types) - Confirmed enum values: Single Family, Condo, Townhouse, Manufactured, Multi-Family, Apartment, Land
- [FCC Area API](https://geo.fcc.gov/api/census/) - Verified working: returns county_name, county_fips, state_code from lat/lon; free, no API key (tested live: San Francisco County returned correctly)
- `data/programs/thunder.json` - Analyzed 44 tiers: property_types are SFR/Condo/2-4 Units; all location_restrictions are empty; loan amounts range $100K-$8M
- `rag/schemas.py` - Existing ProgramRules and EligibilityTier models
- `rag/structure.py` - Existing Gemini Flash call pattern with google-genai SDK
- `rag/vectorstore.py` - Existing query_program_info() for ChromaDB retrieval

### Secondary (MEDIUM confidence)
- [Gemini Structured Output docs](https://ai.google.dev/gemini-api/docs/structured-output) - Gemini 2.5 Flash supports structured output via response_schema
- [Census Bureau Geocoder API](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html) - Alternative to FCC; more complex but also free

### Tertiary (LOW confidence)
- Townhouse -> SFR mapping: Based on general mortgage industry convention; needs validation with actual GMCC program guidelines if/when non-Thunder programs are ingested

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already installed and used in Phase 1; no new dependencies
- Architecture: HIGH - matching logic is straightforward comparisons; models follow existing Pydantic patterns
- Pitfalls: HIGH - identified from direct analysis of data structures and API field availability
- Geocoding: HIGH - FCC API tested live and working; RentCast confirmed to provide county data natively

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (stable domain; no rapidly evolving dependencies)
