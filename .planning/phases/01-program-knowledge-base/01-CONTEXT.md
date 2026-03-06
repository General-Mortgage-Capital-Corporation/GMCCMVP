# Phase 1: Program Knowledge Base - Context

**Gathered:** 2026-03-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract GMCC loan program guideline PDFs into structured, queryable data: structured JSON rule sets for deterministic matching and ChromaDB vector store for LLM explanation retrieval. The ingestion pipeline must handle all ~5-15 programs and be re-runnable when programs update.

</domain>

<decisions>
## Implementation Decisions

### PDF Source & Input Structure
- PDFs are available now, one guideline PDF per program
- All programs (~5-15) processed from the start, not incrementally
- Input directory: `data/guidelines/` (gitignored — proprietary content)
- Folder structure: `data/guidelines/<ProgramName>/guideline.pdf` — folder name IS the program name
- Example: `data/guidelines/Thunder/TCU Wholesale Mortgage Quick Guide_092025.pdf`

### Rule Coverage (Layered Approach)
- **Structured JSON** for property-matchable criteria: property type eligibility, loan amount ranges, location restrictions, occupancy types, plus any other matchable criteria discovered in the guidelines
- **Vector chunks** for everything else — stored in ChromaDB for LLM explanation retrieval
- High accuracy on the explanation side is important — LOs need trustworthy answers
- Don't artificially limit what's extracted; capture all matchable criteria the guidelines define

### Program Organization
- Each program is one entity (e.g., "Thunder") with sub-types as tiers within it (Conforming, Jumbo A, Jumbo with MI, Interest Only)
- Sub-types are stored as tiers in the JSON, NOT as separate top-level programs
- QM vs Non-QM distinction must be visible as program metadata — LOs need this for realtor conversations
- Rate sheets are pricing-only and irrelevant to Phase 1 (guidelines define eligibility)

### Extraction Approach
- PDFs are very table-heavy — eligibility matrices are the core content
- Sample PDF (TCU Quick Guide) shows good text extraction quality with layout-preserving extraction
- Table formats: transaction type x unit count x loan amount range x LTV/CLTV x min FICO
- Sample PDF available at `sample_guideline/TCU Wholesale Mortgage Quick Guide_092025.pdf` for extraction strategy validation

### Claude's Discretion
- CLI script vs app-integrated ingestion (recommended: CLI for 5-15 programs)
- Whether to output JSON for manual review before storing, or store directly (recommended: two-step with review for table-heavy PDFs)
- Vector chunk strategy — how to split non-table content for explanation retrieval
- Exact JSON schema for structured rules (informed by actual PDF content)
- ChromaDB collection design (single collection vs per-program)

</decisions>

<specifics>
## Specific Ideas

- Program names come from folder names, not from PDF content — this is how GMCC internally refers to programs (e.g., "Thunder" not "TCU Wholesale Mortgage")
- The TCU Quick Guide is 5 pages with 4 distinct eligibility matrices (Conforming, Jumbo A Principal Residence, Jumbo A Second Home, Jumbo A Interest Only, Jumbo with MI) plus sections on reserves, borrower types, DTI rules, and underwriting overlays
- Most program PDFs follow a similar Quick Guide format with eligibility matrices, though some may be more detailed or differently formatted
- Programs span QM and Non-QM categories

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- None directly reusable — this is a new capability (RAG pipeline) being added to the project

### Established Patterns
- Flask backend (`server.py`): New ingestion code should follow Python module pattern, not be added to server.py
- Environment variables via `.env` + `python-dotenv`: API keys for Gemini/OpenAI should follow this pattern
- `requirements.txt` with minimum versions: New dependencies (PyMuPDF, ChromaDB, google-genai) added here

### Integration Points
- New `rag/` module directory for ingestion pipeline, matching engine (Phase 2), and provider abstraction
- `data/guidelines/` as input directory for PDF files (gitignored)
- `data/programs/` or similar for output structured JSON (can be committed for version control)
- ChromaDB persistent storage in `data/chroma/` or similar (gitignored)
- No frontend integration in this phase — Phase 1 is backend-only pipeline

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-program-knowledge-base*
*Context gathered: 2026-03-06*
