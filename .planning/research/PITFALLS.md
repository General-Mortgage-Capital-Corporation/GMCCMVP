# Domain Pitfalls

**Domain:** RAG-based AI loan program matching for real estate listings
**Researched:** 2026-03-06
**Confidence:** MEDIUM (based on training data for well-established RAG patterns; no live source verification available)

---

## Critical Pitfalls

Mistakes that cause rewrites, wrong loan program recommendations, or LO trust erosion.

### Pitfall 1: Treating Guideline PDFs as Flat Text (Losing Table/Matrix Structure)

**What goes wrong:** Mortgage guideline PDFs contain eligibility matrices, LTV grids, fee schedules, and conditional logic expressed in tables. Naive PDF-to-text extraction (PyPDF2, basic pdfplumber) flattens tables into garbled text rows, destroying the row/column relationships that define program rules. The RAG system then retrieves chunks where "95% LTV" appears near "SFR" but has no understanding that the 95% applies to owner-occupied SFR and the condo limit is actually 90%.

**Why it happens:** Teams default to the easiest PDF parsing library, test with one simple page, and assume it works. Mortgage guideline PDFs are some of the most table-dense documents in any industry. The complexity isn't visible until you inspect actual extracted text.

**Consequences:** The AI recommends programs with wrong LTV limits, wrong property type eligibility, or wrong loan amount caps. LOs catch incorrect recommendations quickly because they know these programs -- one bad recommendation destroys all trust in the tool.

**Prevention:**
- Use table-aware PDF extraction: `pdfplumber` with explicit table detection, or a vision-based approach (send PDF pages as images to a multimodal LLM for structured extraction).
- For 5-15 programs, consider **manual-assisted extraction**: use AI to draft structured JSON per program, then have a GMCC product specialist validate the output. This is a one-time cost that pays off in accuracy.
- Build a **structured program schema** (JSON) with explicit fields: property types, LTV limits by occupancy, loan amount ranges, location restrictions, etc. Match against the schema, not raw text chunks.
- Test extracted data against at least 3 known scenarios per program where a GMCC LO can confirm correct/incorrect.

**Detection:** Compare AI extraction output against the original PDF visually for any page containing a table or grid. If more than one field is wrong per page, the extraction pipeline is broken.

**Phase:** Must be solved in the RAG knowledge base build phase, before any matching logic is written.

---

### Pitfall 2: Chunking by Token Count Instead of by Logical Rule Boundary

**What goes wrong:** Standard RAG chunking (split every 500 tokens with 50-token overlap) slices guideline documents mid-rule. A program's property eligibility section might start on one chunk and its LTV limits on another. When the LLM retrieves the property eligibility chunk but not the LTV chunk, it confidently states the program works for condos without mentioning the 80% LTV cap that applies specifically to condos.

**Why it happens:** Every RAG tutorial and library defaults to token-based chunking. It works for general Q&A over long documents, but mortgage guidelines have logical units (one rule, one matrix, one program section) that must stay together for correct matching.

**Consequences:** Partial retrieval leads to incomplete or misleading matches. The AI might say "DSCR program applies" without retrieving the minimum DSCR ratio requirement. Worse, the LLM fills in gaps with hallucinated details that sound plausible.

**Prevention:**
- Chunk by **program section**, not by token count. Each program should have chunks like: "Program X - Eligible Property Types", "Program X - LTV Matrix", "Program X - Location Restrictions", "Program X - Loan Amount Limits".
- With only 5-15 programs, the entire knowledge base is small (likely under 100 chunks total). You can afford rich, self-contained chunks that include the program name and section header in every chunk.
- Consider **no chunking at all** -- for 5-15 programs, a structured JSON representation of each program might fit entirely in context without needing RAG retrieval. This eliminates the retrieval failure mode entirely.

**Detection:** Pull 10 random chunks and ask: "Can I fully answer a matching question using only this chunk?" If the answer is frequently "no, I'd need another chunk too," the chunking is wrong.

**Phase:** RAG knowledge base build phase. Must be decided before any embedding or indexing work.

---

### Pitfall 3: Using RAG When Structured Rules Would Be More Reliable

**What goes wrong:** The team builds a full vector-search RAG pipeline for 5-15 programs when the matching logic is fundamentally rule-based: property type in [list]? price within range? location in eligible area? These are deterministic checks, not semantic similarity searches. RAG introduces probabilistic retrieval and LLM interpretation into what should be a yes/no lookup.

**Why it happens:** "RAG" is the current default approach for any AI + document problem. Teams assume they need embeddings and vector search because the input is PDFs. But the end goal isn't "answer questions about guidelines" -- it's "which programs match this property," which is a structured matching problem.

**Consequences:** Nondeterministic results (same property gets different programs on different queries), unnecessary latency and cost (embedding search + LLM call per listing), harder to debug when matching is wrong, impossible to explain to LOs why a program was or wasn't recommended.

**Prevention:**
- **Hybrid approach:** Use LLM/RAG to *extract* structured rules from PDFs into a program schema (one-time), then match listings against the schema with deterministic code. Use the LLM only for the explanation layer ("Here's why Program X matches this property").
- Store each program as a structured record: `{ "name": "...", "eligible_property_types": [...], "min_loan": ..., "max_loan": ..., "ltv_limits": {...}, "location_restrictions": [...], "dscr_required": bool, ... }`.
- The matching engine becomes a filter: iterate programs, check each field against listing data, return matches with reasons.
- Reserve RAG/LLM for: initial extraction from PDFs, generating human-readable explanations, and answering edge-case questions that don't map cleanly to structured fields.

**Detection:** If you find yourself writing prompts like "Is the property type eligible for this program?" for data that's a simple list lookup, you've over-relied on RAG.

**Phase:** Architecture decision that must be made before building the RAG pipeline. Getting this wrong means rebuilding the core matching engine.

---

### Pitfall 4: No Ground Truth Dataset for Matching Accuracy

**What goes wrong:** The team builds the matching system, demos it to stakeholders, and gets told "that's wrong for half these properties" with no systematic way to know what "right" looks like. Without a validation dataset of known property-to-program matches, you cannot measure accuracy, detect regressions, or compare approaches.

**Why it happens:** Building a test dataset requires domain expertise (a GMCC LO or product specialist must create it), and teams delay this as "we'll test manually." Manual testing is inconsistent and doesn't catch regressions.

**Consequences:** No way to measure if changes improve or degrade matching. Unable to tell if a prompt change, chunk restructuring, or model switch made things better or worse. Ship broken matching without knowing it's broken.

**Prevention:**
- Before building the matching engine, create a **validation set of 20-30 property + expected programs pairs** with a GMCC LO. Include edge cases: properties near location boundaries, unusual property types, prices near loan limits.
- Format: `{ "listing": { price, type, location, ... }, "expected_programs": ["Program A", "Program C"], "not_eligible": ["Program B"], "reasoning": "..." }`.
- Run this validation set after every change to the matching pipeline. Automate it as a test suite.
- Track precision (of recommended programs, how many are actually eligible) and recall (of eligible programs, how many are recommended).

**Detection:** Ask "how do we know this is correct?" If the answer is "we showed it to someone and they didn't complain," you don't have a ground truth dataset.

**Phase:** Must be created during or before the RAG knowledge base phase. Cannot be deferred -- it gates all quality assessment.

---

### Pitfall 5: Hallucinated Program Details in LLM Responses

**What goes wrong:** The LLM generates plausible-sounding but wrong program details. It might state "Program X allows up to 97% LTV for investment properties" when the actual limit is 75%. Because mortgage terms are standardized (LTV, DTI, DSCR), the LLM's general training on mortgage content fills in "reasonable defaults" that don't match GMCC's specific program terms.

**Why it happens:** LLMs are trained on vast amounts of mortgage content (Fannie Mae guides, FHA manuals, broker training materials). When retrieval provides incomplete context, the model confidently fills gaps with industry-standard values rather than admitting uncertainty. GMCC's programs may have non-standard terms that conflict with general industry knowledge.

**Consequences:** An LO prepares for a listing conversation with wrong program details, presents incorrect terms to a realtor or borrower, and damages GMCC's credibility. This is the single most dangerous failure mode for this product -- wrong information is worse than no information.

**Prevention:**
- **Structured matching first, LLM explanation second.** The matching decision should come from deterministic rules, not LLM inference. The LLM generates the human-readable summary but doesn't decide eligibility.
- If using LLM for matching, always include: "Only use information explicitly stated in the provided context. If a detail is not mentioned, say it is not specified rather than inferring a value."
- Display program details with **source attribution**: "Per GMCC guideline v2.3, page 4" so LOs can verify.
- Implement a **confidence indicator** on each match. If the system isn't sure, say "Possible match -- verify LTV limits" rather than stating a specific number.
- Temperature 0 for all matching calls. No creativity wanted here.

**Detection:** Have an LO review 20 program match explanations. If any contain details not in the source guideline PDF, hallucination is occurring.

**Phase:** Prompt engineering and output formatting phase. But the architecture decision (structured matching vs pure RAG) largely determines hallucination risk.

---

## Moderate Pitfalls

### Pitfall 6: Ignoring Location-Based Eligibility Complexity

**What goes wrong:** Some GMCC programs have geographic restrictions (state-specific, county-specific, USDA-eligible areas, high-cost area loan limits). Teams treat location as a simple field ("California: yes/no") when the actual rules involve county-level FHFA conforming loan limits, USDA rural eligibility maps, or state licensing restrictions. A property at $800K in Los Angeles County might be conforming (high-cost limit), while the same price in a rural county is jumbo -- qualifying for completely different programs.

**Why it happens:** Location eligibility looks simple in guideline PDFs ("available in CA, WA, TX") but the loan amount limits that determine program eligibility vary by county. Teams hardcode state lists and miss the county-level nuance.

**Prevention:**
- Map each program's location rules at the **county level**, not just state level.
- For conforming loan limit checks, reference FHFA's published county-level limits (updated annually). Store these as structured data, not in the RAG knowledge base.
- RentCast provides county data in listings -- use it for county-level matching.
- Flag properties near limit boundaries: "This property is near the conforming loan limit for [county]. Verify current limits."

**Detection:** Test with properties in high-cost vs standard-cost counties at prices near the conforming limit boundary. If the system gives the same programs for both, location matching is broken.

**Phase:** Data model design phase. The program schema must include county-level location rules.

---

### Pitfall 7: Stale Program Data Without an Update Workflow

**What goes wrong:** Loan programs change: rates update daily, guidelines update monthly, programs get discontinued or launched. The team builds the RAG knowledge base once from current PDFs and has no process to update it. Six months later, the system recommends a discontinued program or misses a new one.

**Why it happens:** Building the initial knowledge base is the exciting part. Maintaining it is operational work that nobody plans for. The "rate sheet awareness" requirement in PROJECT.md acknowledges this need, but implementation is easy to defer.

**Prevention:**
- Design the program data store for **easy replacement**: structured JSON files or database records, not embedded-in-code constants. Updating a program should be: upload new PDF, run extraction pipeline, validate against test set, deploy.
- Build an **admin interface** (even minimal) for uploading updated guideline PDFs and triggering re-extraction.
- Add a **"last updated" timestamp** visible in the UI so LOs know how current the data is.
- For rate sheets (daily updates), consider a separate data path: rate sheets are highly structured (tables of rates by LTV/credit score), and should be stored as structured data, not in the RAG knowledge base.

**Detection:** If asked "when was this program data last updated?" and there's no answer, the update workflow doesn't exist.

**Phase:** Should be designed in the architecture phase and implemented alongside the initial knowledge base build. Cannot be a "later" feature -- it determines data model choices.

---

### Pitfall 8: Calling the LLM Per Listing in Search Results (Cost and Latency Explosion)

**What goes wrong:** For an area search returning 20 properties, the system makes 20 separate LLM calls to match programs to each listing. At ~1-2 seconds per call, the user waits 20-40 seconds for results. At $0.01-0.03 per call (Gemini/OpenAI), a single search costs $0.20-0.60. Heavy users doing 50+ searches/day make the system expensive and slow.

**Why it happens:** The natural implementation is: for each listing, send listing data + program context to LLM, get matches. This works in a demo with one listing but doesn't scale to batch search results.

**Prevention:**
- **Structured matching eliminates this entirely.** Deterministic rule matching against 5-15 programs for 20 listings takes milliseconds, not minutes. No LLM call needed for the matching step.
- If using LLM for matching, batch all listings into a single call: "Here are 20 properties and 15 programs. For each property, list matching programs." This works within context window limits for this data volume.
- Cache program matches by **property type + price range + location** -- many listings share the same program eligibility profile.
- Generate detailed explanations **on demand** (when user clicks a listing) rather than for all search results upfront.
- Pre-compute matches in the background and cache them, updating only when program data changes.

**Detection:** Measure API cost and latency per search. If either scales linearly with result count, the per-listing LLM call pattern is the cause.

**Phase:** Architecture phase. The batch vs per-listing decision shapes the entire matching pipeline.

---

### Pitfall 9: Embedding Model Mismatch for Mortgage Terminology

**What goes wrong:** General-purpose embedding models (OpenAI `text-embedding-3-small`, Gemini embedding) don't capture mortgage-specific semantic similarity well. "DSCR" (Debt Service Coverage Ratio) and "rental income qualification" are semantically related in mortgage context but may not be close in general embedding space. The retrieval step returns irrelevant chunks because the query "Can this rental property qualify?" doesn't match chunks containing "DSCR program" or "investor cash flow."

**Why it happens:** Embedding models are trained on general text. Mortgage is a specialized domain with its own vocabulary, abbreviations (LTV, DTI, DSCR, NOO, ITIN), and semantic relationships.

**Prevention:**
- With only 5-15 programs, consider **bypassing embeddings entirely**: use keyword/metadata-based retrieval (filter by property type, then retrieve all chunks for matching programs) instead of semantic search.
- If using embeddings, test retrieval quality with mortgage-specific queries: "investment property rental income" should retrieve DSCR program chunks. "Foreign national no SSN" should retrieve ITIN/foreign national program chunks.
- Add **metadata filters** to chunks (program name, section type, property type tags) so retrieval uses both semantic similarity and structured filters.
- Consider a **retrieval-then-rerank** approach: retrieve top-20 by embedding similarity, rerank with a cross-encoder or LLM prompt that understands mortgage terminology.

**Detection:** Run 10 mortgage-specific queries against the vector store and manually check if the top-3 retrieved chunks are the right ones. If recall is below 80%, the embedding approach needs help.

**Phase:** RAG pipeline build phase. Test retrieval quality before building the matching logic on top of it.

---

### Pitfall 10: Showing Matches Without Explainability (LO Trust Failure)

**What goes wrong:** The system shows "Program A, Program B" as badges on a listing card with no explanation. The LO doesn't know why those programs were recommended, can't verify correctness, and doesn't trust the output. The tool becomes a curiosity rather than a preparation tool.

**Why it happens:** Teams focus on getting the matching working and treat the explanation as a nice-to-have. But for LOs, the "why" is the entire value -- they need to walk into a conversation saying "This property qualifies for our DSCR program because the estimated rent covers the payment at current rates," not just "our AI said it matches."

**Prevention:**
- Every program match must include a **one-sentence reason**: "Eligible: SFR in CA, price within conforming limits, meets minimum property value."
- Every match should flag **key data points the LO should verify**: "Verify: estimated rent not available from listing data; DSCR calculation requires rent estimate."
- On the detail view, show the **matching criteria checklist**: property type (check), location (check), loan amount (check), occupancy type (unknown -- no buyer data).
- Clearly distinguish between "definitely eligible based on property data" and "potentially eligible but needs buyer qualification info."

**Detection:** Ask an LO: "Based on this output, would you feel confident mentioning this program to a realtor?" If the answer is "I'd need to look it up myself first," explainability is insufficient.

**Phase:** UI/UX design phase, but must be planned in the architecture phase so matching results carry structured reasons, not just program names.

---

## Minor Pitfalls

### Pitfall 11: Not Handling Missing Listing Data Gracefully

**What goes wrong:** RentCast doesn't provide estimated rent for all properties, and some listings lack square footage, exact property type, or other fields. The matching system either crashes on missing fields, silently skips the property, or matches as if the missing field meets all criteria.

**Prevention:**
- Define behavior for each field when missing: property type missing = match against all types with a "verify property type" flag. Rent estimate missing = skip DSCR calculation with "rent estimate needed for DSCR programs" note.
- Never silently skip or silently assume. Every missing-data decision should be visible to the LO.
- Track which fields are most commonly missing from RentCast data so you can prioritize alternative data sources or manual entry.

**Phase:** Matching engine implementation. Define the missing-data policy in the data model design.

---

### Pitfall 12: Over-Engineering the RAG Pipeline for 5-15 Documents

**What goes wrong:** The team sets up a full vector database (Pinecone, Weaviate, ChromaDB persistent cluster), a document processing pipeline with LangChain/LlamaIndex, embedding jobs, and a retrieval chain -- for a knowledge base that would fit in a single LLM context window. The infrastructure complexity dwarfs the actual problem.

**Prevention:**
- For 5-15 program guideline PDFs, the total content is likely 50-200 pages. Structured extraction into JSON/YAML creates a dataset under 50KB.
- Start with the simplest approach: structured JSON program records, no vector database, deterministic matching, LLM only for explanation generation.
- If RAG is needed, use an in-process solution (ChromaDB in-memory, or simple SQLite with full-text search) rather than a hosted vector database service.
- Graduate to a more complex setup only if the number of programs exceeds what fits in context (unlikely for this use case).

**Phase:** Architecture decision. Choosing simplicity here saves weeks of unnecessary infrastructure work.

---

### Pitfall 13: Not Separating "Could Match" from "Will Match"

**What goes wrong:** The system shows program matches as definitive ("This property qualifies for Program X") when it can only assess property-side criteria. Without buyer data (credit score, DTI, down payment, citizenship status), the match is "this property is eligible for Program X if the buyer also qualifies." LOs or their managers interpret matches as guaranteed, leading to embarrassment when the buyer doesn't qualify.

**Prevention:**
- Use language that reflects certainty level: "Property eligible" not "Qualifies." "Potential match" not "Recommended program."
- Explicitly list what the system checked vs. what it couldn't check: "Checked: property type, location, price range. Not checked: borrower credit, DTI, down payment, occupancy intent."
- Consider two tiers: "Strong match (property meets all property-side criteria)" and "Conditional match (property meets some criteria, verify X and Y)."

**Phase:** UI copy and matching output design. Establish the language conventions early in the design phase.

---

### Pitfall 14: Rate Sheet Data Mixed with Program Guidelines

**What goes wrong:** Rate sheets (daily pricing) and program guidelines (eligibility rules) are treated as the same type of document. Rate sheets are highly volatile (daily updates) with specific numeric data (rates by LTV/FICO matrix). Guidelines are stable (monthly/quarterly updates) with categorical rules. Mixing them in one RAG knowledge base means either rate data is stale or the entire knowledge base churns daily.

**Prevention:**
- Maintain two separate data stores: **program guidelines** (structured rules, updated monthly) and **rate sheets** (pricing tables, updated daily or on-demand).
- For the MVP, focus on program matching (guidelines) and defer rate sheet integration. Adding "current rates" is a distinct feature with different data pipeline requirements.
- When rate sheets are added, store them as structured numerical data (database table), not as RAG document chunks.

**Phase:** Architecture phase. The data model must separate these two concerns from the start even if rate sheets are deferred.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| PDF Extraction / Knowledge Base Build | Table structure destruction (Pitfall 1), wrong chunking (Pitfall 2) | Use table-aware extraction, chunk by program section, validate output against source PDFs |
| Architecture / System Design | Over-using RAG for a rule-based problem (Pitfall 3), over-engineering infrastructure (Pitfall 12), per-listing LLM calls (Pitfall 8) | Design structured matching first, reserve LLM for extraction and explanation |
| Matching Engine Implementation | No ground truth for validation (Pitfall 4), hallucinated details (Pitfall 5), missing data handling (Pitfall 11) | Create validation dataset before building, use deterministic matching, define missing-data policy |
| Data Model Design | Location complexity underestimated (Pitfall 6), rate sheets mixed with guidelines (Pitfall 14) | County-level location modeling, separate data stores for guidelines vs. rates |
| UI/UX and Output Design | No explainability (Pitfall 10), ambiguous match language (Pitfall 13) | Every match needs a reason, distinguish "property eligible" from "fully qualifies" |
| Operations / Maintenance | Stale program data (Pitfall 7) | Build update workflow alongside initial knowledge base, show last-updated timestamps |
| Embedding / Retrieval (if RAG used) | Mortgage terminology mismatch (Pitfall 9) | Test retrieval with domain-specific queries, use metadata filters, consider bypassing embeddings for small corpus |

## Confidence Notes

| Area | Confidence | Rationale |
|------|------------|-----------|
| PDF table extraction issues | HIGH | Well-documented problem across all RAG implementations with structured PDFs |
| Chunking strategy | HIGH | Universal RAG pitfall, especially well-understood for domain-specific documents |
| Structured vs RAG matching | HIGH | Fundamental architecture pattern; strong consensus that deterministic matching beats LLM inference for rule-based decisions |
| Hallucination risks | HIGH | Extensively documented LLM behavior, especially in domains where training data creates false confidence |
| Location/county complexity | MEDIUM | Based on general mortgage industry knowledge; specific GMCC program location rules not verified |
| Cost/latency patterns | MEDIUM | Based on published API pricing and typical response times; exact costs depend on model choice and prompt length |
| Embedding model fit for mortgage | MEDIUM | Based on general domain-specific embedding challenges; not tested against GMCC-specific terminology |

## Sources

- Training data on RAG system design patterns, failure modes, and production deployment experiences through early 2025
- General mortgage industry knowledge: conforming loan limits, DSCR programs, guideline PDF structures
- PDF parsing library capabilities: pdfplumber, PyPDF2, vision-based extraction approaches
- LLM API patterns: batching, caching, cost optimization for OpenAI and Google Gemini

*Note: WebSearch and WebFetch were unavailable during this research session. All findings are from training data. Confidence levels reflect this limitation -- findings align with well-established patterns but could not be verified against the latest sources.*
