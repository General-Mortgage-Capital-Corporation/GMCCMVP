# Architecture Patterns

**Domain:** RAG-based loan program matching integrated into existing Flask property search app
**Researched:** 2026-03-06
**Confidence:** MEDIUM (based on training data; WebSearch/WebFetch unavailable for verification of latest versions)

## Recommended Architecture

### High-Level View

```
                          GMCC Listing Agent - Target Architecture

  +------------------+         +------------------------------------------+
  |                  |  HTTP   |              Flask Server                |
  |    Browser       +-------->|                                          |
  |  (Vanilla JS)    |         |  +------------+   +-------------------+  |
  |                  |<--------+  | Existing    |   | New RAG           |  |
  +------------------+         |  | Search API  |   | Matching API      |  |
                               |  | /api/search |   | /api/match        |  |
                               |  +------+-----+   | /api/programs     |  |
                               |         |         +--------+----------+  |
                               +---------|------------------|-------------+
                                         |                  |
                          +--------------+     +------------+----------+
                          |                    |                       |
                   +------v-------+   +--------v--------+   +---------v-------+
                   |  RentCast    |   |  Vector Store   |   |  LLM API        |
                   |  API         |   |  (ChromaDB)     |   |  (Gemini/OpenAI)|
                   |  (listings)  |   |  (embeddings)   |   |  (generation)   |
                   +--------------+   +---------+-------+   +-----------------+
                                                |
                                      +---------v---------+
                                      |  PDF Knowledge    |
                                      |  Base             |
                                      |  (GMCC program    |
                                      |   guideline PDFs) |
                                      +-------------------+
```

The architecture adds three new components alongside the existing search flow: a PDF ingestion pipeline, a vector store for program embeddings, and an LLM-powered matching endpoint. The existing search flow remains untouched -- matching is a parallel enrichment step.

### Component Boundaries

| Component | Responsibility | Communicates With | New/Existing |
|-----------|---------------|-------------------|--------------|
| **Browser (Vanilla JS)** | Renders search results + program match badges. Requests matching after search completes. | Flask API endpoints | Existing (modified) |
| **Flask Server** | Routes requests, orchestrates matching pipeline, serves static files | All components | Existing (extended) |
| **Search API** (`/api/search`) | Proxies property search to RentCast, returns listings | RentCast API | Existing (unchanged) |
| **Match API** (`/api/match`) | Takes listing data, retrieves relevant program chunks, calls LLM for matching | Vector Store, LLM API | **New** |
| **Programs API** (`/api/programs`) | Lists available programs, triggers re-ingestion | Vector Store, PDF Pipeline | **New** |
| **PDF Ingestion Pipeline** | Extracts text from PDFs, chunks it, creates embeddings, stores in vector DB | Vector Store, Embedding API | **New** |
| **Vector Store (ChromaDB)** | Stores and retrieves program document embeddings | Embedding API (at query time if using ChromaDB's built-in) | **New** |
| **LLM API (Gemini/OpenAI)** | Generates structured matching assessments from retrieved context + listing data | Called by Match API | **New** |
| **Auth Layer** | Protects all API endpoints, manages LO sessions | Flask session/JWT | **New** |

### Why These Boundaries

1. **Match API is separate from Search API** -- Matching is an enrichment step, not part of search. Search must stay fast (RentCast latency only). Matching can be async or on-demand (when user clicks a listing).

2. **ChromaDB runs in-process** -- At 5-15 PDFs, there is no need for a separate vector database service. ChromaDB's persistent client mode stores data to disk and runs inside the Flask process. This avoids infrastructure complexity.

3. **PDF Ingestion is a separate pipeline** -- Ingestion runs at admin time (when programs change), not at query time. It writes to ChromaDB. The match endpoint only reads from ChromaDB.

4. **LLM call is at query time** -- Embeddings retrieve candidate program chunks, but the actual matching logic (does this program fit this property?) requires LLM reasoning over structured property data + unstructured program rules.

## Data Flow

### Flow 1: PDF Ingestion (Admin Time -- Runs When Programs Change)

```
Admin uploads PDF
       |
       v
  1. PyMuPDF (fitz) extracts text from PDF
       |
       v
  2. Text splitter chunks text into ~500-token segments
     with ~50-token overlap, preserving section boundaries
       |
       v
  3. Each chunk gets metadata: {program_name, source_pdf,
     section_type, page_number}
       |
       v
  4. Embedding API (OpenAI text-embedding-3-small or
     Gemini text-embedding-004) converts chunks to vectors
       |
       v
  5. ChromaDB stores vectors + text + metadata in a
     "loan_programs" collection on disk
```

**Key design decisions:**
- Chunk size of ~500 tokens balances context richness against retrieval precision. Loan program guidelines have dense, rule-heavy sections -- too small and you lose context (e.g., an LTV rule separated from its property type condition); too large and irrelevant content dilutes retrieval.
- Section-aware chunking is critical. Program PDFs have structured sections (Eligibility, LTV, Property Types, Location Restrictions). The chunker should detect headers and avoid splitting mid-section when possible.
- Metadata enables filtered retrieval: query only DSCR programs, or only programs that mention a specific property type.

### Flow 2: Property Search (Unchanged)

```
User searches -> /api/search -> RentCast API -> listings returned -> cards rendered
```

No changes to existing flow.

### Flow 3: Program Matching (New -- Triggered Per Listing)

```
User clicks listing card (or search completes for batch matching)
       |
       v
  1. Frontend sends POST /api/match with listing data:
     {price, propertyType, zipCode, state, county,
      estimatedRent (if available), sqft}
       |
       v
  2. Match API constructs a retrieval query from listing data:
     "property type: SFR, price: $450,000, location: CA 91234,
      rental property, loan amount needed"
       |
       v
  3. ChromaDB similarity search returns top-K chunks
     (K=10-15) from across all programs
       |
       v
  4. Retrieved chunks are assembled into a context block,
     grouped by program name
       |
       v
  5. LLM prompt combines:
     - System: "You are a loan program matching assistant..."
     - Context: Retrieved program chunks
     - Query: Structured listing data
     - Instructions: "For each program, assess eligibility
       based on available data. Return JSON."
       |
       v
  6. LLM returns structured JSON:
     [
       {
         "program_name": "DSCR Investor Program",
         "match_level": "strong",  // strong | possible | unlikely
         "reasons": ["Property type eligible", "Price within limits"],
         "caveats": ["Requires rent verification"],
         "key_terms": {"max_ltv": "80%", "min_dscr": "1.0"}
       },
       ...
     ]
       |
       v
  7. Match API returns program matches to frontend
       |
       v
  8. Frontend renders match badges on property card
     and detailed breakdown in property modal
```

**Key design decisions:**
- **Per-listing matching, not batch** -- Each listing gets its own match request. This keeps latency predictable and avoids LLM context window issues with batch processing. Matching can be triggered on card click (lazy) or in parallel after search (eager).
- **Retrieval query is constructed, not raw** -- Instead of passing the raw listing JSON to ChromaDB, the match API constructs a natural language query that emphasizes matchable dimensions (property type, price range, location). This produces better embedding similarity than raw structured data.
- **LLM returns structured JSON** -- The prompt requests JSON output with a defined schema. Both Gemini and OpenAI support JSON mode / structured outputs. This makes frontend rendering deterministic.
- **Match levels, not binary** -- "strong / possible / unlikely" gives LOs nuance. A program might be possible but require buyer info the listing doesn't have.

### Flow 4: Rate Sheet Updates (Periodic)

```
  1. Admin uploads new rate sheet PDF or triggers refresh
       |
       v
  2. Ingestion pipeline processes rate sheet
     (same as Flow 1 but tagged with date metadata)
       |
       v
  3. Old rate sheet chunks for that program are replaced
     in ChromaDB (delete by metadata filter + re-insert)
       |
       v
  4. Next matching query automatically uses current rates
```

Rate sheets change daily but the system does not need real-time updates -- a manual or scheduled daily refresh is sufficient for MVP.

## Component Deep Dives

### PDF Ingestion Pipeline

**Location:** New module, e.g., `rag/ingest.py`

```python
# Conceptual structure
class ProgramIngester:
    def __init__(self, collection, embedding_fn):
        self.collection = collection      # ChromaDB collection
        self.embedding_fn = embedding_fn  # Embedding function

    def ingest_pdf(self, pdf_path, program_name):
        """Extract, chunk, embed, store."""
        text = extract_text(pdf_path)           # PyMuPDF
        chunks = chunk_text(text, program_name) # Section-aware chunking
        self.collection.add(
            documents=[c.text for c in chunks],
            metadatas=[c.metadata for c in chunks],
            ids=[c.id for c in chunks]
        )

    def replace_program(self, program_name, pdf_path):
        """Delete old chunks, ingest new."""
        self.collection.delete(
            where={"program_name": program_name}
        )
        self.ingest_pdf(pdf_path, program_name)
```

**PDF text extraction:** Use PyMuPDF (`fitz`). It handles complex PDF layouts better than PyPDF2, extracts text with positional information (useful for detecting headers), and is fast. For PDFs with scanned images, add Tesseract OCR as a fallback, but GMCC program PDFs are likely native text PDFs (generated from Word/InDesign), so OCR should not be needed for MVP.

**Chunking strategy:** Use a hybrid approach:
1. First, split by detected section headers (lines that match patterns like all-caps, bold, or numbered headings)
2. Then, split oversized sections by token count (~500 tokens) with ~50-token overlap
3. Tag each chunk with: `program_name`, `section_type` (eligibility, ltv, property_types, location, rates, general), `page_number`, `source_pdf`

### Vector Store (ChromaDB)

**Why ChromaDB over alternatives:**

| Consideration | ChromaDB | Pinecone | pgvector |
|--------------|----------|----------|----------|
| Scale needed | 5-15 PDFs, ~500-2000 chunks | Millions+ | Medium-large |
| Infrastructure | None (runs in-process) | Managed cloud service | Requires PostgreSQL |
| Cost | Free | Paid after free tier | Free (but needs Postgres) |
| Complexity | `pip install chromadb` | API keys, cloud config | DB setup, migrations |
| Persistence | Local disk | Cloud | Database |
| Good fit for this project? | **Yes -- right-sized** | Overkill | Overkill |

ChromaDB is the right choice because this is a small, focused knowledge base. Running in-process with persistent storage to disk eliminates an entire infrastructure dependency. If the system ever needs to scale to thousands of programs (unlikely for a single mortgage company), migration to pgvector or Pinecone is straightforward -- the retrieval interface is the same.

**Collection structure:**

```python
import chromadb

client = chromadb.PersistentClient(path="./chroma_data")
collection = client.get_or_create_collection(
    name="loan_programs",
    metadata={"hnsw:space": "cosine"}  # cosine similarity
)
```

Single collection with metadata-based filtering. No need for multiple collections at this scale.

### LLM Matching Engine

**Location:** New module, e.g., `rag/matcher.py`

```python
class ProgramMatcher:
    def __init__(self, collection, llm_client):
        self.collection = collection
        self.llm_client = llm_client

    def match(self, listing_data: dict) -> list[dict]:
        """Match a listing against all loan programs."""
        # 1. Build retrieval query
        query = self._build_query(listing_data)

        # 2. Retrieve relevant chunks
        results = self.collection.query(
            query_texts=[query],
            n_results=15,
            include=["documents", "metadatas"]
        )

        # 3. Group chunks by program
        context = self._group_by_program(results)

        # 4. Call LLM with structured prompt
        response = self._call_llm(listing_data, context)

        # 5. Parse and return structured matches
        return self._parse_response(response)
```

**LLM provider choice:** Use OpenAI `gpt-4o-mini` for matching. Rationale:
- Cost: ~$0.15/1M input tokens, ~$0.60/1M output tokens -- a single match costs fractions of a cent
- JSON mode is reliable and well-documented
- Gemini `gemini-2.0-flash` is a viable alternative at similar cost; the interface is interchangeable
- The matching task is structured reasoning over rules, not creative generation -- a smaller model handles it well
- Build with an abstraction layer so the LLM provider can be swapped without code changes

**Prompt engineering is critical.** The matching prompt must:
1. Clearly state what data is available vs. unknown (no buyer data)
2. Instruct the model to reason about property-side eligibility only
3. Define the output JSON schema explicitly
4. Include examples of each match level
5. Handle edge cases: "insufficient data to determine" is a valid outcome

### Authentication Layer

**Location:** Flask middleware / decorators

Use Flask-Login with session-based auth for MVP. The user base is small (GMCC LOs and branch managers -- likely under 50 users), so a simple username/password with Flask sessions stored server-side is appropriate.

```python
from flask_login import LoginManager, login_required

login_manager = LoginManager()
login_manager.init_app(app)

@app.route('/api/match', methods=['POST'])
@login_required
def match_programs():
    ...
```

User data can be stored in SQLite (via Flask-SQLAlchemy) -- adding a full database is warranted now that the app has state (user accounts, potentially saved matches).

### Frontend Integration

The existing vanilla JS frontend needs these additions:

1. **Match badges on property cards** -- After search results load, fire match requests for visible listings. Display colored badges: green (strong match), yellow (possible), gray (unlikely).

2. **Match details in property modal** -- When modal opens, show program matches with reasons and caveats below the existing property details.

3. **Loading states** -- Matching is async (LLM call takes 1-3 seconds). Show skeleton/spinner on badges while matching loads.

4. **Login page** -- Simple form that posts credentials, stores session cookie.

No framework change needed. The existing DOM manipulation pattern can handle these additions with new render functions.

## Patterns to Follow

### Pattern 1: Retrieval-Then-Generate (Standard RAG)

**What:** Separate retrieval (vector search) from generation (LLM). Never ask the LLM to "know" program details -- always provide them as context.

**When:** Every matching request.

**Why:** The LLM's training data does not contain GMCC's proprietary loan programs. RAG ensures the model reasons over actual program rules, not hallucinated ones. This is the core architectural invariant.

### Pattern 2: Structured Query Construction

**What:** Transform structured listing data into a natural language query optimized for embedding similarity, rather than passing raw JSON.

**When:** Building the retrieval query from listing data.

**Example:**
```python
def _build_query(self, listing: dict) -> str:
    parts = []
    if listing.get("propertyType"):
        parts.append(f"property type: {listing['propertyType']}")
    if listing.get("price"):
        parts.append(f"loan amount approximately ${listing['price']:,}")
    if listing.get("state"):
        parts.append(f"located in {listing.get('city', '')} {listing['state']}")
    if listing.get("estimatedRent"):
        parts.append(f"estimated rent ${listing['estimatedRent']}/month")
        parts.append("investment property DSCR rental")
    parts.append("eligible loan programs requirements guidelines")
    return ", ".join(parts)
```

### Pattern 3: Provider Abstraction

**What:** Wrap LLM and embedding calls behind an interface so providers can be swapped.

**When:** All LLM and embedding interactions.

**Example:**
```python
class LLMProvider:
    def complete(self, messages: list, json_mode: bool = False) -> str:
        raise NotImplementedError

class OpenAIProvider(LLMProvider):
    def complete(self, messages, json_mode=False):
        response = self.client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            response_format={"type": "json_object"} if json_mode else None,
        )
        return response.choices[0].message.content

class GeminiProvider(LLMProvider):
    def complete(self, messages, json_mode=False):
        # Gemini equivalent
        ...
```

### Pattern 4: Lazy Matching with Caching

**What:** Match programs on-demand (when user views a listing) and cache results for the session. Do not pre-match all search results.

**When:** User clicks a property card or explicitly requests matching.

**Why:** A search might return 20 listings but the user only inspects 3-5. Pre-matching all 20 wastes 15+ LLM calls. Cache results in memory (or session) keyed by listing address so repeat views are instant.

```python
# Simple in-memory cache (per-server-process)
match_cache = {}  # key: listing_address, value: {matches, timestamp}
CACHE_TTL = 3600  # 1 hour

def get_cached_match(address):
    cached = match_cache.get(address)
    if cached and time.time() - cached["timestamp"] < CACHE_TTL:
        return cached["matches"]
    return None
```

### Pattern 5: Metadata-Filtered Retrieval

**What:** Use ChromaDB's `where` filter to narrow retrieval before vector search.

**When:** When listing data clearly maps to a program category (e.g., investment property -> filter to DSCR-tagged chunks).

**Example:**
```python
# If property appears to be investment/rental, boost DSCR program chunks
results = collection.query(
    query_texts=[query],
    n_results=15,
    where={"section_type": {"$in": ["eligibility", "property_types", "ltv"]}}
)
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Stuffing All Program Text into LLM Context

**What:** Skipping vector retrieval and just concatenating all program PDFs into the LLM prompt.

**Why bad:** At 5-15 programs with multi-page guidelines each, total text could be 50,000-150,000 tokens. This exceeds context windows of smaller models, costs significantly more per call, and the LLM performs worse with excessive irrelevant context. More context does not mean better reasoning.

**Instead:** Use RAG. Retrieve only the 10-15 most relevant chunks (~5,000-7,500 tokens of context) per query.

### Anti-Pattern 2: Embedding Raw Listing JSON for Retrieval

**What:** Passing `{"propertyType": "Single Family", "price": 450000, ...}` directly as the query text to ChromaDB.

**Why bad:** JSON structure is not semantically similar to natural language program descriptions. The embedding model was trained on natural language, not JSON. Retrieval quality will be poor.

**Instead:** Construct a natural language query (Pattern 2 above).

### Anti-Pattern 3: Real-Time PDF Processing

**What:** Parsing and embedding PDFs at query time instead of pre-ingesting them.

**Why bad:** PDF extraction + chunking + embedding takes 10-60 seconds per document. This would make matching impossibly slow and waste compute on every request.

**Instead:** Ingest PDFs at admin time. Query time only does vector search + LLM generation.

### Anti-Pattern 4: Using a Full LangChain Stack

**What:** Importing LangChain for the entire RAG pipeline (document loaders, text splitters, chains, retrievers, output parsers).

**Why bad:** LangChain adds massive dependency weight (~50+ transitive packages), complex abstraction layers that obscure what's happening, and frequent breaking changes between versions. For a focused 5-15 document RAG system, the overhead is not justified.

**Instead:** Use ChromaDB directly + PyMuPDF for extraction + a simple text splitter function (~20 lines of code) + direct OpenAI/Gemini API calls. The total custom code is ~200-300 lines -- far simpler to understand, debug, and maintain than LangChain's abstraction layers.

### Anti-Pattern 5: Separate Microservice for RAG

**What:** Deploying the RAG pipeline as a separate service with its own API.

**Why bad:** At this scale (5-15 programs, small user base), a microservice adds network latency, deployment complexity, and operational burden for zero scalability benefit. The Flask server can handle everything in-process.

**Instead:** Add RAG modules to the existing Flask app. ChromaDB runs in-process. If scale demands change (unlikely), extract later.

## Suggested File Structure

```
GMCCMVP/
  server.py                    # Existing -- add new route imports
  rag/
    __init__.py
    ingest.py                  # PDF extraction + chunking + embedding
    matcher.py                 # Retrieval + LLM matching logic
    prompts.py                 # Prompt templates for matching
    providers.py               # LLM/embedding provider abstraction
    schemas.py                 # Match result data classes
  auth/
    __init__.py
    models.py                  # User model (SQLAlchemy)
    routes.py                  # Login/logout/register endpoints
  data/
    programs/                  # Uploaded program PDFs (gitignored)
    rate_sheets/               # Uploaded rate sheets (gitignored)
  chroma_data/                 # ChromaDB persistent storage (gitignored)
  static/
    index.html                 # Existing (modified for auth + match UI)
    script.js                  # Existing (modified for match display)
    styles.css                 # Existing (modified for badges/match UI)
    login.html                 # New login page
  requirements.txt             # Updated with new dependencies
  .env                         # Add OPENAI_API_KEY or GEMINI_API_KEY
```

## Suggested Build Order

Build order is driven by dependencies between components. Each phase produces a testable increment.

```
Phase 1: PDF Ingestion Pipeline + Vector Store
   |  No external dependencies beyond ChromaDB + PyMuPDF
   |  Can be tested independently with sample PDFs
   |  Output: ChromaDB populated with program chunks
   |
   v
Phase 2: Matching Engine (Retrieval + LLM)
   |  Depends on: Phase 1 (populated vector store)
   |  Can be tested via CLI/script before wiring to API
   |  Output: Given listing data, returns program matches
   |
   v
Phase 3: API Endpoints + Frontend Integration
   |  Depends on: Phase 2 (matching engine to call)
   |  Wires matching into Flask routes + renders in UI
   |  Output: End-to-end flow visible in browser
   |
   v
Phase 4: Authentication
   |  Depends on: Phase 3 (endpoints to protect)
   |  Can be added as middleware without changing matching logic
   |  Output: Login required, sessions managed
   |
   v
Phase 5: Admin Tools + Rate Sheet Updates
      Depends on: Phase 1 (ingestion pipeline to trigger)
      Adds admin UI for PDF upload, re-ingestion, program management
      Output: Non-technical admin can update programs
```

**Why this order:**
- Phase 1 first because everything downstream depends on having program data in a vector store. It is also the most uncertain component (PDF quality, chunking strategy) and benefits from early validation.
- Phase 2 before API integration because the matching logic needs prompt iteration and tuning. Easier to iterate via scripts than through the full UI.
- Phase 3 before auth because you need to see matching working end-to-end before adding access control. Auth can block testing if added too early.
- Phase 4 before admin tools because admin tools need auth (admin role), and auth is simpler to implement in isolation.
- Phase 5 last because manual CLI-based ingestion works fine for MVP. Admin UI is quality-of-life, not core functionality.

## Scalability Considerations

| Concern | Current (5-15 programs) | 50+ programs | Notes |
|---------|------------------------|--------------|-------|
| Vector store | ChromaDB in-process | ChromaDB still fine up to ~100K docs | Migrate to pgvector only if > 100K chunks |
| LLM latency | 1-3 sec per match | Same (per-listing) | Latency is per-call, not per-corpus-size |
| LLM cost | ~$0.001 per match | Same | Cost scales with queries, not corpus |
| Embedding cost | One-time ~$0.01 for all programs | ~$0.10 | Negligible at any realistic scale |
| Concurrent users | Flask dev server, 1-5 users | Gunicorn with workers | Add WSGI server at ~10+ concurrent users |
| PDF ingestion | Manual CLI, takes seconds | Need queuing | Not a concern until 50+ programs |

The architecture intentionally avoids premature optimization. Every component can be upgraded independently if scale demands change, but none of these upgrades are likely needed for GMCC's use case.

## Technology Confidence Notes

| Technology | Confidence | Notes |
|------------|-----------|-------|
| ChromaDB | MEDIUM | Training data confirms it's the leading lightweight vector DB for Python. Unable to verify latest API surface against current docs. Core patterns (PersistentClient, collection.add/query) are stable. |
| OpenAI API (gpt-4o-mini) | MEDIUM | Training data confirms model availability and JSON mode. Unable to verify current pricing or latest model variants. |
| Gemini API | MEDIUM | Training data confirms text-embedding-004 and gemini-2.0-flash exist. API surface may have changed. |
| PyMuPDF (fitz) | HIGH | Stable, mature library. PDF extraction API has been consistent for years. |
| Flask-Login | HIGH | Stable, widely used. API is well-established. |
| RAG patterns | HIGH | Architecture patterns are well-established and technology-agnostic. The retrieval-then-generate pattern is the standard approach. |

## Sources

- Training data knowledge of RAG architecture patterns (verified against widespread adoption across the industry -- HIGH confidence in patterns, MEDIUM on specific library versions)
- Existing codebase analysis (`.planning/codebase/ARCHITECTURE.md`, `server.py`)
- Project requirements (`.planning/PROJECT.md`)

**Verification gaps:** Unable to access WebSearch or WebFetch to verify latest ChromaDB API, current OpenAI/Gemini pricing, or newest embedding model recommendations. Recommend verifying these during implementation phase.

---

*Architecture research: 2026-03-06*
