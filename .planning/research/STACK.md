# Technology Stack

**Project:** GMCC Listing Agent -- AI Loan Program Matching (Milestone 2)
**Researched:** 2026-03-06
**Scope:** New dependencies for RAG-based loan program matching. Does NOT re-cover Flask, RentCast, or existing stack (see `.planning/codebase/STACK.md`).

## Recommended Stack

### LLM Provider

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Google Gemini (via `google-genai`) | >=1.0.0 | LLM inference for program matching prompts | Project constraint: Gemini/OpenAI preferred, cost-conscious. Gemini 2.0 Flash is the sweet spot -- fast, cheap ($0.10/1M input tokens as of early 2025), and more than capable for structured extraction tasks like "which loan programs match this property." Flash models are purpose-built for high-volume, low-latency use cases. The `google-genai` SDK is the newer unified Python SDK replacing the older `google-generativeai` package. |

**Confidence:** HIGH on Gemini as provider (explicit project constraint). MEDIUM on exact SDK package name -- Google has been consolidating SDKs. Verify `google-genai` vs `google-generativeai` at install time.

**Model selection:**
- **Primary:** `gemini-2.0-flash` -- Best cost/performance ratio for structured matching. Handles the core task: "Given these property attributes and these program guidelines, which programs could apply?"
- **Fallback:** `gemini-2.0-flash-lite` -- Even cheaper for high-volume scenarios, but test quality first.
- **Avoid:** `gemini-2.0-pro` or `gemini-1.5-pro` -- Overkill and expensive for this structured extraction task. The matching prompt is well-defined, not open-ended creative work.

**Why not OpenAI:** Both are viable per project constraints, but Gemini Flash is significantly cheaper than GPT-4o-mini for equivalent quality on structured tasks. If Gemini proves unreliable, OpenAI (`openai` SDK, `gpt-4o-mini` model) is the fallback. The RAG architecture is provider-agnostic -- swapping requires changing one API call, not re-architecting.

### Embedding Model

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Google Text Embedding (via same `google-genai` SDK) | -- | Vectorize loan program guideline chunks | Using the same provider for embeddings and LLM simplifies auth, billing, and SDK management. Google's `text-embedding-004` model produces 768-dimension vectors, handles up to 2048 tokens per chunk, and is effectively free at this scale (5-15 PDFs = a few thousand chunks max). |

**Confidence:** HIGH. Google's embedding models are well-established. The `text-embedding-004` model is their current recommended embedding model.

**Why not OpenAI embeddings:** Adds a second API key, second billing relationship, second SDK. No quality advantage for this use case -- loan program text is structured English, not a domain where one embedding model dramatically outperforms another.

**Why not local embeddings (sentence-transformers):** Adds heavy Python dependencies (PyTorch, transformers), increases deployment complexity, and requires GPU for reasonable speed. Not worth it for 5-15 PDFs that get embedded once and updated occasionally.

### Vector Store

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| ChromaDB | >=0.5.0 | Store and query embedded loan program chunks | Purpose-built for small-to-medium RAG applications. Runs embedded (in-process, no separate server), persists to local disk, has native Python SDK, and supports metadata filtering. For 5-15 PDFs producing a few thousand chunks, ChromaDB is the right tool -- zero operational overhead. |

**Confidence:** HIGH on ChromaDB as choice. MEDIUM on exact version -- ChromaDB had breaking API changes between 0.4.x and 0.5.x. Pin to whatever `pip install chromadb` gives you and lock it.

**Key ChromaDB features that matter here:**
- **Embedded mode:** `chromadb.PersistentClient(path="./chroma_db")` -- no separate process, no Docker, no port management. Flask app just opens the database.
- **Metadata filtering:** Store program name, effective date, program type as metadata on each chunk. Query with `where={"program_type": "DSCR"}` to narrow results before semantic search.
- **Persistence:** Data survives server restarts. Re-embedding only needed when PDFs change.
- **Collection management:** Each program can be a collection, or all programs in one collection with metadata. Single collection with metadata filtering is simpler.

**Alternatives considered:**

| Alternative | Why Not |
|-------------|---------|
| FAISS | No metadata filtering, no persistence out of the box, lower-level API requires more boilerplate. Good for performance-critical search at scale, overkill here. |
| Qdrant | Excellent database but runs as a separate server (Docker). Operational complexity not justified for 5-15 documents. Would be the right choice if this scaled to hundreds of documents. |
| Pinecone | Managed cloud service = vendor lock-in + network latency + cost. This is a small internal tool, not a product needing cloud vector DB. |
| pgvector | Would need PostgreSQL, which the app doesn't have. Adding a full RDBMS just for vector search is backwards -- add a vector DB for vectors, add PostgreSQL later if you need relational data. |
| SQLite + sqlite-vec | Interesting for keeping everything in SQLite, but immature ecosystem and limited filtering capabilities compared to ChromaDB. |

### PDF Parsing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| PyMuPDF (`pymupdf`) | >=1.24.0 | Extract text from GMCC loan program guideline PDFs | Fast, accurate, handles complex PDF layouts (tables, columns, headers/footers). Loan program guidelines typically have structured tables (LTV limits, property type eligibility, loan amount ranges) -- PyMuPDF preserves table structure better than alternatives. Pure C extension, no Java/Docker dependencies. |

**Confidence:** HIGH. PyMuPDF is the standard choice for Python PDF text extraction when you need layout awareness.

**Why not alternatives:**

| Alternative | Why Not |
|-------------|---------|
| pdfplumber | Good for tables but slower, and PyMuPDF handles the same cases. pdfplumber is built on pdfminer which is pure Python and significantly slower. |
| Unstructured (`unstructured`) | Massive dependency tree (pulls in dozens of packages including ML models). Designed for document intelligence pipelines, not simple text extraction from 5-15 PDFs. |
| PyPDF2 / pypdf | Basic text extraction, poor handling of tables and complex layouts. Loan guidelines with eligibility matrices would extract as garbled text. |
| Amazon Textract / Google Document AI | Cloud OCR services. Overkill -- these PDFs are text-based (not scanned images), so OCR is unnecessary. Adds cost and latency. |

**PDF processing strategy:**
1. Extract text page-by-page with PyMuPDF
2. Chunk by logical sections (program eligibility, LTV tables, property types, location restrictions)
3. Attach metadata to each chunk: program name, section type, effective date
4. Embed and store in ChromaDB
5. Re-process only when PDFs are updated (manual trigger or file-watch)

### Authentication

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Flask-Login | >=0.6.3 | Session-based user authentication | Standard Flask authentication extension. Handles login/logout, session management, `@login_required` decorator, "remember me" cookies. The app needs simple auth (GMCC LOs + branch managers), not OAuth/SAML/SSO. Flask-Login is the right complexity level. |
| Werkzeug (security module) | (bundled with Flask) | Password hashing | `werkzeug.security.generate_password_hash` / `check_password_hash` -- already a Flask dependency, no additional install needed. Uses PBKDF2 by default, which is adequate for an internal tool. |

**Confidence:** HIGH. Flask-Login is the de facto standard for Flask session auth and has been stable for years.

**User storage:** SQLite via Python's built-in `sqlite3` module (no ORM needed for <50 users). A single `users` table with `id, email, password_hash, role, name`. Pre-seed users via a management script -- no self-registration (internal tool).

**Why not alternatives:**

| Alternative | Why Not |
|-------------|---------|
| Flask-Security-Too | Kitchen-sink package (roles, permissions, 2FA, OAuth). Massive for what is needed: login/logout for <50 internal users. |
| Auth0 / Firebase Auth | External dependency for a simple internal tool. Adds network requests to every page load. Appropriate for customer-facing SaaS, not an internal LO tool. |
| Flask-HTTPAuth | Basic/token auth without session management. Works for APIs but poor UX for a web app -- users would need to re-authenticate on every browser session. |
| JWT-based auth | Adds complexity (token refresh, storage, expiration) without benefit over server-side sessions for a single-server Flask app. JWT is for distributed/microservice architectures. |

### Database (User/Session Storage)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| SQLite | (built-in) | Store user accounts, session data, and optionally program metadata | Zero additional dependencies. Python's `sqlite3` module is in the standard library. For <50 users and a handful of loan programs, SQLite is the right database. No server to manage, data lives in a single file, trivial to back up. |

**Confidence:** HIGH. SQLite is the correct choice for small internal tools with low write concurrency.

**Schema scope:** Users table + optionally a `programs` table tracking which PDFs have been processed, last update time, and chunk counts. NOT for storing listing data (that stays live from RentCast).

**Why not PostgreSQL:** Not enough data or concurrency to justify running a database server. If this tool grows to serve hundreds of concurrent users or needs complex queries, migrate to PostgreSQL then. SQLite handles the current scale perfectly.

### RAG Orchestration

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| **No framework -- direct API calls** | -- | Orchestrate the RAG pipeline (embed query, search ChromaDB, build prompt, call Gemini) | For this focused use case, LangChain/LlamaIndex add complexity without proportional value. The RAG pipeline is simple: embed a query, search ChromaDB, inject results into a prompt template, call Gemini. That is ~50 lines of Python. A framework adds hundreds of abstractions, version churn, and debugging difficulty for a pipeline that does one thing. |

**Confidence:** HIGH. This is an opinionated recommendation backed by widespread community consensus that frameworks are unnecessary for simple, single-purpose RAG pipelines.

**The pipeline in pseudocode:**
```python
# 1. Build query from listing data
query = f"Property: {listing['propertyType']}, Price: ${listing['price']}, Location: {listing['city']}, {listing['state']}"

# 2. Embed the query
query_embedding = genai_client.embed(query, model="text-embedding-004")

# 3. Search ChromaDB for relevant program chunks
results = collection.query(query_embeddings=[query_embedding], n_results=10)

# 4. Build prompt with context
prompt = MATCHING_PROMPT_TEMPLATE.format(
    property_info=query,
    program_context="\n".join(results["documents"][0])
)

# 5. Call Gemini
response = genai_client.generate(prompt, model="gemini-2.0-flash")

# 6. Parse structured response
matches = parse_program_matches(response.text)
```

**Why not LangChain:** LangChain's value is in complex chains (multi-step reasoning, tool use, agents, memory). This app has a single retrieval + generation step. LangChain would add ~20 transitive dependencies, version compatibility issues, and abstraction layers that make debugging harder. The LangChain ecosystem has also been criticized for excessive abstraction and frequent breaking changes.

**Why not LlamaIndex:** Similar reasoning. LlamaIndex is excellent for complex document Q&A with multiple retrieval strategies, re-ranking, and query decomposition. This app retrieves chunks and generates a structured match response. LlamaIndex would be building a cathedral for a task that needs a shed.

## Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `gunicorn` | >=22.0.0 | Production WSGI server | Always in production. Replaces `app.run(debug=True)`. Run with `gunicorn -w 4 server:app`. Addresses existing concern about dev server in production. |
| `python-dotenv` | >=1.0.0 | Environment variable loading | Already in stack. Will now load additional env vars: `GOOGLE_API_KEY`, `SECRET_KEY`. |
| `flask-limiter` | >=3.5.0 | Rate limiting on API endpoints | Apply to `/api/search` and `/api/match` endpoints. Addresses existing security concern about no rate limiting. Uses in-memory storage (adequate for single-server). |

**Confidence:** HIGH on all supporting libraries. These are stable, well-maintained packages.

## Full New Dependencies Summary

```
# AI / RAG
google-genai>=1.0.0          # Gemini LLM + embeddings (unified SDK)
chromadb>=0.5.0               # Vector store for program guidelines

# PDF Processing
pymupdf>=1.24.0               # Extract text from guideline PDFs

# Authentication
flask-login>=0.6.3            # Session-based auth for Flask

# Production
gunicorn>=22.0.0              # Production WSGI server

# Security
flask-limiter>=3.5.0          # Rate limiting
```

**Total new dependencies:** 6 packages (plus their transitive dependencies). This is deliberately minimal. Every package earns its place.

## Alternatives Considered (Summary)

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| LLM Provider | Gemini 2.0 Flash | OpenAI GPT-4o-mini | Higher cost, second billing relationship. Viable fallback. |
| Embeddings | Google text-embedding-004 | OpenAI text-embedding-3-small | Second provider adds complexity for no quality gain. |
| Vector Store | ChromaDB (embedded) | Qdrant (server) | Operational overhead not justified for 5-15 docs. |
| Vector Store | ChromaDB (embedded) | FAISS | No metadata filtering, no built-in persistence. |
| PDF Parsing | PyMuPDF | Unstructured | Massive dependency tree for simple text extraction. |
| PDF Parsing | PyMuPDF | pdfplumber | Slower, and PyMuPDF handles tables adequately. |
| Auth | Flask-Login + SQLite | Auth0 | External dependency for a simple internal tool. |
| Auth | Flask-Login + SQLite | Flask-Security-Too | Kitchen-sink: too many features for this use case. |
| RAG Framework | Direct API calls | LangChain | Adds abstraction without value for a single-step pipeline. |
| RAG Framework | Direct API calls | LlamaIndex | Designed for complex doc Q&A, overkill for focused matching. |
| Database | SQLite (built-in) | PostgreSQL | No server to justify. Migrate later if needed. |

## Installation

```bash
# New dependencies for Milestone 2 (AI matching + auth)
pip install google-genai chromadb pymupdf flask-login gunicorn flask-limiter

# Full requirements.txt after milestone (existing + new)
# flask>=3.0.0
# flask-cors>=4.0.0
# requests>=2.31.0
# python-dotenv>=1.0.0
# google-genai>=1.0.0
# chromadb>=0.5.0
# pymupdf>=1.24.0
# flask-login>=0.6.3
# gunicorn>=22.0.0
# flask-limiter>=3.5.0
```

## Environment Variables (New)

```bash
# .env additions
GOOGLE_API_KEY=your-gemini-api-key     # Google AI Studio API key
SECRET_KEY=your-flask-secret-key       # Flask session signing (use: python -c "import secrets; print(secrets.token_hex(32))")
```

## Version Verification Notes

Version numbers are based on training data through May 2025. All packages listed are mature and stable, but exact latest versions should be verified at install time:

- **google-genai:** Google has been actively consolidating Python SDKs. The package may be `google-genai` or `google-generativeai`. Check `pip install google-genai` -- if it fails, use `google-generativeai>=0.8.0`. **Verify at install time.**
- **chromadb:** Had breaking changes between 0.4.x and 0.5.x (client API changed). The `>=0.5.0` floor avoids the old API. Pin exact version after install.
- **pymupdf:** Install via `pip install pymupdf` (the package name on PyPI). The import is `import pymupdf` (or `import fitz` for older versions). **Verify import name at install time.**
- **flask-login, gunicorn, flask-limiter:** Stable, long-lived packages. Versions listed are conservative minimums.

## Cost Projections

**Gemini 2.0 Flash pricing (as of early 2025):**
- Input: ~$0.10 per 1M tokens
- Output: ~$0.40 per 1M tokens

**Per-match estimate:**
- Property description: ~100 tokens
- Retrieved program context (10 chunks): ~2,000 tokens
- System prompt + template: ~500 tokens
- Output (matching analysis): ~500 tokens
- **Cost per match: ~$0.0005 (less than a tenth of a cent)**

**Monthly estimate (20 LOs, 50 searches/day each):**
- 1,000 matches/day x 30 days = 30,000 matches/month
- ~$15/month in API costs
- Embeddings for initial PDF processing: negligible (one-time, a few thousand chunks)

**This is effectively free at the projected scale.**

## Sources

- Project constraints from `.planning/PROJECT.md` (Gemini/OpenAI preference, cost-conscious, 5-15 PDFs)
- Existing stack from `.planning/codebase/STACK.md` (Flask 3.x, Python 3.12+)
- Architecture constraints from `.planning/codebase/ARCHITECTURE.md` (monolithic Flask, no database)
- Security concerns from `.planning/codebase/CONCERNS.md` (no auth, no rate limiting, dev server in prod)
- Package knowledge from training data (through May 2025) -- version numbers flagged as MEDIUM confidence where noted

---

*Stack research: 2026-03-06*
