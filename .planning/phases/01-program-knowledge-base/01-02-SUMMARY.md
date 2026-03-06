---
phase: 01-program-knowledge-base
plan: 02
subsystem: api
tags: [chromadb, gemini-embeddings, click-cli, vector-store, ingestion-pipeline]

# Dependency graph
requires:
  - phase: 01-01
    provides: "Pydantic schemas, PDF extraction, LLM structuring functions"
provides:
  - "ChromaDB vector store with Gemini embedding function and program metadata filtering"
  - "CLI ingestion pipeline (python -m rag.ingest) orchestrating extract -> structure -> store"
  - "Validated Thunder program JSON with 44 tiers from sample TCU guideline PDF"
  - "Idempotent re-ingestion with --review-only and --program flags"
affects: [02-matching-engine, 03-api-layer]

# Tech tracking
tech-stack:
  added: [chromadb-persistent-client, gemini-embedding-001]
  patterns: [cli-ingestion-pipeline, embedding-function-wrapper, idempotent-vector-upsert]

key-files:
  created: [rag/vectorstore.py, rag/ingest.py, rag/__main__.py, tests/test_vectorstore.py, tests/test_ingestion.py, data/programs/thunder.json]
  modified: [rag/config.py, rag/extract.py, rag/structure.py]

key-decisions:
  - "Used ChromaDB PersistentClient at data/chroma/ for durable vector storage across runs"
  - "Wrapped Gemini embed_content as ChromaDB EmbeddingFunction for seamless integration"
  - "Idempotent store_chunks deletes existing program chunks before re-adding to avoid duplicates"
  - "Enhanced PDF extraction with PyMuPDF find_tables() for accurate table boundaries"

patterns-established:
  - "CLI ingestion with click: --review-only for JSON-only, --program for single-program processing"
  - "Vector store chunks keyed as {program_name}_page_{i} with program_name metadata for filtering"
  - "Three-stage pipeline: extract (PDF->MD) -> structure (MD->JSON) -> store (JSON->ChromaDB)"

requirements-completed: [KB-02, KB-03]

# Metrics
duration: 15min
completed: 2026-03-06
---

# Phase 1 Plan 02: ChromaDB Vector Store and CLI Ingestion Pipeline Summary

**ChromaDB vector store with Gemini embeddings, click-based CLI ingestion pipeline, and human-verified Thunder program extraction (44 tiers with accurate LTV/FICO/loan amounts)**

## Performance

- **Duration:** 15 min (including human verification checkpoint)
- **Started:** 2026-03-06T20:35:00Z
- **Completed:** 2026-03-06T21:30:00Z
- **Tasks:** 2 (Task 1 TDD with RED+GREEN, Task 2 checkpoint with human verification)
- **Files modified:** 9

## Accomplishments
- ChromaDB vector store module with custom Gemini embedding function, program-scoped storage, and semantic query with metadata filtering
- CLI ingestion pipeline (`python -m rag.ingest`) orchestrating all 3 stages: PDF extraction, LLM structuring, and vector storage
- End-to-end validation against sample TCU Thunder guideline PDF producing 44 accurately structured tiers
- 29 unit tests passing (32 selected, 3 skipped extraction tests needing real PDF), 7 integration tests available
- ChromaDB retrieval confirmed working with program_name filtering (3 relevant chunks returned for semantic queries)

## Task Commits

Each task was committed atomically:

1. **Task 1: ChromaDB vector store, CLI ingestion, and tests (TDD)**
   - `48a258c` (test) - Failing tests for vector store and ingestion pipeline
   - `d93ecab` (feat) - ChromaDB vector store, CLI ingestion pipeline, and entry point

2. **Task 2: End-to-end validation with sample guideline PDF**
   - `09a383e` (fix) - Enhanced PDF table extraction and LLM structuring during checkpoint
   - `2553460` (feat) - Validated Thunder program JSON output

_Note: Task 1 follows TDD RED->GREEN pattern. Task 2 included a checkpoint fix commit._

## Files Created/Modified
- `rag/vectorstore.py` - GeminiEmbeddingFunction, get_collection, store_chunks, query_program_info
- `rag/ingest.py` - Click CLI orchestrating extract -> structure -> store with --review-only and --program flags
- `rag/__main__.py` - Entry point for `python -m rag` invocation
- `rag/config.py` - Fixed model name from gemini-3.0-flash to gemini-2.5-flash
- `rag/extract.py` - Enhanced with PyMuPDF find_tables() for accurate table extraction
- `rag/structure.py` - Improved LLM prompt for per-row tiers and no QM inference
- `tests/test_vectorstore.py` - 7 tests: embedding function, store chunks (idempotency), query with filters
- `tests/test_ingestion.py` - 6 tests: JSON output, review-only mode, full ingest, idempotency, multi-program
- `data/programs/thunder.json` - Validated Thunder program with 44 tiers (human-verified extraction)

## Decisions Made
- Used ChromaDB `PersistentClient` at `data/chroma/` for durable vector storage that persists across runs, rather than ephemeral in-memory mode
- Wrapped Gemini `embed_content` as a ChromaDB `EmbeddingFunction` subclass for seamless integration with collection operations
- Idempotent `store_chunks` deletes existing program chunks before re-adding, preventing duplicate entries on re-ingestion
- Enhanced PDF extraction with `PyMuPDF find_tables()` to get accurate table cell boundaries rather than relying solely on pymupdf4llm Markdown conversion
- Fixed Gemini model name from `gemini-3.0-flash` to `gemini-2.5-flash` (correct production model name)
- Improved LLM structuring prompt to produce per-row tiers (one tier per eligibility row) and avoid inferring QM status when not explicitly stated

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Gemini model name in config**
- **Found during:** Task 2 (end-to-end validation)
- **Issue:** Config had `gemini-3.0-flash` which does not exist as a valid model name
- **Fix:** Changed to `gemini-2.5-flash` (correct current model)
- **Files modified:** rag/config.py
- **Verification:** Pipeline runs successfully against real API
- **Committed in:** 09a383e

**2. [Rule 1 - Bug] Enhanced PDF table extraction accuracy**
- **Found during:** Task 2 (end-to-end validation)
- **Issue:** pymupdf4llm Markdown conversion alone lost table structure and cell boundaries
- **Fix:** Added PyMuPDF find_tables() to extract accurate table data alongside Markdown text
- **Files modified:** rag/extract.py
- **Verification:** Thunder PDF produces 44 distinct tiers with correct numeric values
- **Committed in:** 09a383e

**3. [Rule 1 - Bug] Improved LLM structuring prompt**
- **Found during:** Task 2 (end-to-end validation)
- **Issue:** LLM was merging table rows into fewer tiers and guessing QM status
- **Fix:** Updated prompt to produce one tier per eligibility row and set QM to "Unknown" when not explicit
- **Files modified:** rag/structure.py
- **Verification:** Human verified tier count and accuracy match source PDF tables
- **Committed in:** 09a383e

---

**Total deviations:** 3 auto-fixed (3 bugs found during end-to-end validation)
**Impact on plan:** All fixes necessary for accurate extraction. No scope creep -- these were quality improvements discovered during the planned validation checkpoint.

## Issues Encountered
None beyond the deviations documented above. The checkpoint flow worked as designed: automated pipeline ran, human reviewed output quality, fixes were applied, and results re-verified.

## User Setup Required
None -- GEMINI_API_KEY in `.env` was already configured during Plan 01. Integration tests require this key to be set.

## Next Phase Readiness
- Complete ingestion pipeline operational: PDF -> Markdown -> JSON -> ChromaDB
- Thunder program fully indexed with 44 tiers and semantic search working
- Ready for Phase 2 (Matching Engine) to query ChromaDB for program eligibility matching
- Additional wholesale program PDFs can be added to `data/guidelines/` and ingested without code changes

---
*Phase: 01-program-knowledge-base*
*Completed: 2026-03-06*
