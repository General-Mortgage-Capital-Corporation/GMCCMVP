# Phase 1: Program Knowledge Base - Research

**Researched:** 2026-03-06
**Domain:** PDF extraction, structured data, vector storage (RAG pipeline)
**Confidence:** HIGH

## Summary

Phase 1 builds a PDF-to-structured-data ingestion pipeline that extracts GMCC loan program guidelines into two complementary stores: structured JSON for deterministic matching (Phase 2) and ChromaDB vector chunks for LLM explanation retrieval. The PDFs are table-heavy eligibility matrices (transaction type x unit count x loan amount range x LTV/CLTV x min FICO), making table extraction the critical technical challenge.

The recommended approach is a two-stage pipeline: (1) PyMuPDF4LLM extracts PDF content as Markdown (preserving table structure), then (2) Gemini Flash parses the Markdown into structured JSON via Pydantic-validated structured output. This "extract then structure" approach is more reliable than trying to have the LLM read raw PDF bytes, and the Markdown intermediate step preserves table layout that pure text extraction loses.

ChromaDB stores non-table content (reserves, borrower types, DTI rules, underwriting overlays) as semantically searchable chunks with program metadata for filtered retrieval. A custom embedding function wraps the google-genai SDK's `embed_content` since ChromaDB's built-in Google embedding function still depends on the deprecated `google-generativeai` package.

**Primary recommendation:** Use pymupdf4llm for PDF-to-Markdown, Gemini 2.0 Flash with Pydantic structured output for table-to-JSON extraction, and ChromaDB with a custom google-genai embedding function for vector storage.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- PDFs are available now, one guideline PDF per program
- All programs (~5-15) processed from the start, not incrementally
- Input directory: `data/guidelines/` (gitignored -- proprietary content)
- Folder structure: `data/guidelines/<ProgramName>/guideline.pdf` -- folder name IS the program name
- Example: `data/guidelines/Thunder/TCU Wholesale Mortgage Quick Guide_092025.pdf`
- **Structured JSON** for property-matchable criteria: property type eligibility, loan amount ranges, location restrictions, occupancy types, plus any other matchable criteria discovered in the guidelines
- **Vector chunks** for everything else -- stored in ChromaDB for LLM explanation retrieval
- High accuracy on the explanation side is important -- LOs need trustworthy answers
- Don't artificially limit what's extracted; capture all matchable criteria the guidelines define
- Each program is one entity (e.g., "Thunder") with sub-types as tiers within it (Conforming, Jumbo A, Jumbo with MI, Interest Only)
- Sub-types are stored as tiers in the JSON, NOT as separate top-level programs
- QM vs Non-QM distinction must be visible as program metadata -- LOs need this for realtor conversations
- Rate sheets are pricing-only and irrelevant to Phase 1 (guidelines define eligibility)
- PDFs are very table-heavy -- eligibility matrices are the core content
- Sample PDF available at `sample_guideline/TCU Wholesale Mortgage Quick Guide_092025.pdf`
- Program names come from folder names, not from PDF content
- New `rag/` module directory for ingestion pipeline
- `data/programs/` for output structured JSON (can be committed for version control)
- ChromaDB persistent storage in `data/chroma/` (gitignored)
- No frontend integration in this phase -- backend-only pipeline
- Flask backend pattern; new code as separate Python modules, not added to server.py
- Environment variables via `.env` + `python-dotenv`
- Dependencies in `requirements.txt` with minimum versions

### Claude's Discretion
- CLI script vs app-integrated ingestion (recommended: CLI for 5-15 programs)
- Whether to output JSON for manual review before storing, or store directly (recommended: two-step with review for table-heavy PDFs)
- Vector chunk strategy -- how to split non-table content for explanation retrieval
- Exact JSON schema for structured rules (informed by actual PDF content)
- ChromaDB collection design (single collection vs per-program)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| KB-01 | System can parse GMCC loan program guideline PDFs into structured JSON rule sets (property types, location restrictions, loan amount ranges, LTV limits) | PyMuPDF4LLM for PDF-to-Markdown extraction, Gemini Flash structured output with Pydantic models for table-to-JSON parsing, tiered JSON schema design |
| KB-02 | System stores program rules in a vector store (ChromaDB) for explanation retrieval alongside structured JSON for deterministic matching | ChromaDB PersistentClient with custom google-genai embedding function, metadata-filtered queries by program name, dual-store architecture (JSON files + vector DB) |
| KB-03 | Program data can be updated by re-ingesting updated guideline PDFs without code changes | CLI script reads from `data/guidelines/` folder structure, idempotent pipeline that overwrites JSON and re-indexes ChromaDB collection, no hardcoded rules |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pymupdf4llm | >=0.3.4 | PDF-to-Markdown extraction with table preservation | Built on PyMuPDF; specifically designed for LLM/RAG pipelines; handles tables as Markdown tables; actively maintained (Feb 2026 release) |
| PyMuPDF | >=1.27.1 | Underlying PDF engine (auto-installed by pymupdf4llm) | High-performance C library; `find_tables()` for direct table extraction; no external dependencies |
| google-genai | >=1.0.0 | Gemini API client for structured extraction + embeddings | Official unified SDK (replaces deprecated google-generativeai); GA since May 2025; Pydantic structured output support |
| chromadb | >=1.5.0 | Vector store for semantic retrieval of program explanations | Lightweight embedded vector DB; PersistentClient with SQLite backend; metadata filtering; no server needed |
| pydantic | >=2.0.0 | JSON schema definition for structured extraction output | Already a dependency of google-genai; type-safe validation of LLM output |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| python-dotenv | >=1.0.0 | Load API keys from .env | Already in project; load GEMINI_API_KEY |
| click | >=8.0.0 | CLI argument parsing for ingestion script | Already installed; provides clean CLI interface for `python -m rag.ingest` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pymupdf4llm | pdfplumber / camelot | pymupdf4llm produces Markdown tables directly usable by LLM; pdfplumber gives raw coordinates; camelot needs Ghostscript |
| Gemini Flash structured output | Manual regex parsing of tables | LLM handles format variation across programs; regex breaks on different table layouts |
| ChromaDB | FAISS / pgvector | ChromaDB has built-in persistence, metadata filtering, and document storage; FAISS is raw vectors only; pgvector requires PostgreSQL |
| google-genai | openai | User specified Gemini/OpenAI preference; Gemini Flash is cheaper ($0.10/M input tokens vs $0.15/M for GPT-4o-mini) and supports native Pydantic structured output |

**Installation:**
```bash
pip install pymupdf4llm "google-genai>=1.0.0" "chromadb>=1.5.0" click
```

Add to `requirements.txt`:
```
pymupdf4llm>=0.3.4
google-genai>=1.0.0
chromadb>=1.5.0
click>=8.0.0
```

## Architecture Patterns

### Recommended Project Structure
```
rag/
    __init__.py
    ingest.py          # CLI entry point: python -m rag.ingest
    extract.py         # PDF-to-Markdown extraction (pymupdf4llm)
    structure.py       # Markdown-to-JSON via Gemini structured output
    vectorstore.py     # ChromaDB operations (store, query, custom embedding)
    schemas.py         # Pydantic models for program rules JSON
    config.py          # Paths, model names, collection names
data/
    guidelines/        # Input: <ProgramName>/guideline.pdf (gitignored)
    programs/          # Output: <program_name>.json (committable)
    chroma/            # ChromaDB persistent storage (gitignored)
```

### Pattern 1: Two-Stage Extraction Pipeline
**What:** Separate PDF reading from structured data extraction. Stage 1 (extract) is deterministic; Stage 2 (structure) uses LLM.
**When to use:** Always -- this gives a reviewable intermediate artifact (Markdown) and isolates LLM usage.
**Example:**
```python
# Stage 1: PDF to Markdown (deterministic, fast)
import pymupdf4llm

def extract_pdf_to_markdown(pdf_path: str) -> list[dict]:
    """Extract PDF content as Markdown with page-level chunks."""
    return pymupdf4llm.to_markdown(pdf_path, page_chunks=True)

# Stage 2: Markdown to Structured JSON (LLM-powered)
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

class EligibilityTier(BaseModel):
    tier_name: str = Field(description="Sub-type name, e.g., 'Conforming', 'Jumbo A'")
    transaction_types: list[str] = Field(description="e.g., ['Purchase', 'Rate/Term Refi', 'Cash-Out Refi']")
    property_types: list[str] = Field(description="e.g., ['SFR', 'Condo', 'PUD', '2-4 Units']")
    occupancy_types: list[str] = Field(description="e.g., ['Primary Residence', 'Second Home', 'Investment']")
    max_loan_amount: float | None = Field(description="Maximum loan amount in dollars")
    min_loan_amount: float | None = Field(description="Minimum loan amount in dollars")
    max_ltv: float | None = Field(description="Maximum LTV as percentage, e.g., 95.0")
    max_cltv: float | None = Field(description="Maximum CLTV as percentage")
    min_fico: int | None = Field(description="Minimum FICO score required")
    min_reserves_months: int | None = Field(description="Minimum months of reserves")
    max_dti: float | None = Field(description="Maximum DTI ratio as percentage")
    location_restrictions: list[str] = Field(default_factory=list, description="Any state/county restrictions")
    unit_count_limits: list[int] = Field(default_factory=list, description="Allowed unit counts, e.g., [1, 2, 3, 4]")
    additional_rules: dict = Field(default_factory=dict, description="Catch-all for other matchable criteria")

class ProgramRules(BaseModel):
    program_name: str = Field(description="Program name from folder name")
    qm_status: str = Field(description="'QM', 'Non-QM', or 'Both'")
    tiers: list[EligibilityTier]
    general_notes: list[str] = Field(default_factory=list, description="Program-wide notes not specific to a tier")

client = genai.Client()

def structure_with_llm(markdown_text: str, program_name: str) -> ProgramRules:
    """Use Gemini to extract structured rules from Markdown."""
    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=f"""Extract ALL eligibility rules from this mortgage program guideline.
The program is called "{program_name}".
Each distinct eligibility matrix/tier should be a separate tier entry.

Guideline content:
{markdown_text}""",
        config={
            "response_mime_type": "application/json",
            "response_json_schema": ProgramRules.model_json_schema(),
        },
    )
    return ProgramRules.model_validate_json(response.text)
```

### Pattern 2: Custom ChromaDB Embedding Function with google-genai
**What:** Wrap `google-genai`'s `embed_content` as a ChromaDB embedding function, since ChromaDB's built-in `GoogleGenerativeAiEmbeddingFunction` still depends on the deprecated `google-generativeai` package.
**When to use:** Always for this project -- avoids installing a deprecated package.
**Example:**
```python
# Source: ChromaDB custom embedding docs + google-genai embedding docs
from chromadb.api.types import Documents, EmbeddingFunction, Embeddings
from google import genai
from google.genai import types

class GeminiEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self, api_key: str | None = None, model: str = "gemini-embedding-001"):
        self._client = genai.Client(api_key=api_key) if api_key else genai.Client()
        self._model = model

    def __call__(self, input: Documents) -> Embeddings:
        result = self._client.models.embed_content(
            model=self._model,
            contents=input,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_DOCUMENT",
                output_dimensionality=768,
            ),
        )
        return [e.values for e in result.embeddings]
```

### Pattern 3: Idempotent Re-ingestion
**What:** The ingestion pipeline scans `data/guidelines/`, processes each folder, overwrites JSON output, and rebuilds the ChromaDB collection. Running twice produces the same result.
**When to use:** Always -- this is what makes KB-03 work.
**Example:**
```python
import os
import json

GUIDELINES_DIR = "data/guidelines"
PROGRAMS_DIR = "data/programs"
CHROMA_DIR = "data/chroma"

def ingest_all():
    """Scan guidelines directory, process each program, write outputs."""
    os.makedirs(PROGRAMS_DIR, exist_ok=True)

    for program_name in sorted(os.listdir(GUIDELINES_DIR)):
        program_dir = os.path.join(GUIDELINES_DIR, program_name)
        if not os.path.isdir(program_dir):
            continue

        # Find PDF file in program directory
        pdf_files = [f for f in os.listdir(program_dir) if f.lower().endswith('.pdf')]
        if not pdf_files:
            print(f"Warning: No PDF found in {program_dir}, skipping")
            continue

        pdf_path = os.path.join(program_dir, pdf_files[0])
        print(f"Processing: {program_name} -> {pdf_path}")

        # Stage 1: Extract
        pages = extract_pdf_to_markdown(pdf_path)
        full_markdown = "\n\n".join(p["text"] for p in pages)

        # Stage 2: Structure
        rules = structure_with_llm(full_markdown, program_name)

        # Stage 3: Write JSON (reviewable, committable)
        output_path = os.path.join(PROGRAMS_DIR, f"{program_name.lower()}.json")
        with open(output_path, "w") as f:
            json.dump(rules.model_dump(), f, indent=2)

        # Stage 4: Vector store non-table content
        store_chunks_in_chromadb(program_name, pages)

        print(f"  -> {output_path} written, ChromaDB updated")
```

### Pattern 4: Single ChromaDB Collection with Program Metadata
**What:** Use ONE collection for all programs, with `program_name` as metadata for filtered queries.
**When to use:** With 5-15 programs, a single collection is simpler and enables cross-program queries.
**Example:**
```python
import chromadb

client = chromadb.PersistentClient(path="data/chroma")
collection = client.get_or_create_collection(
    name="program_guidelines",
    embedding_function=GeminiEmbeddingFunction(),
)

def store_chunks_in_chromadb(program_name: str, pages: list[dict]):
    """Store page chunks with program metadata. Idempotent via delete+add."""
    # Delete existing chunks for this program (idempotent re-ingestion)
    existing = collection.get(where={"program_name": program_name})
    if existing["ids"]:
        collection.delete(ids=existing["ids"])

    # Add new chunks
    for i, page in enumerate(pages):
        chunk_id = f"{program_name}_page_{i}"
        collection.add(
            ids=[chunk_id],
            documents=[page["text"]],
            metadatas=[{
                "program_name": program_name,
                "page_number": i + 1,
                "source_file": page.get("file_path", ""),
            }],
        )

def query_program_info(query: str, program_name: str | None = None, n_results: int = 3):
    """Query ChromaDB with optional program filter."""
    kwargs = {
        "query_texts": [query],
        "n_results": n_results,
    }
    if program_name:
        kwargs["where"] = {"program_name": program_name}
    return collection.query(**kwargs)
```

### Anti-Patterns to Avoid
- **Sending raw PDF bytes to LLM:** Gemini can read PDFs directly, but table structure is often lost in multimodal processing. Extract to Markdown first for reliable table parsing.
- **One ChromaDB collection per program:** Creates management overhead and prevents cross-program queries. Use metadata filtering instead.
- **Hardcoding program names or rule values:** Defeats KB-03. Everything flows from the PDF content and folder names.
- **Storing structured rules in ChromaDB:** Vector search is for explanation/context retrieval. Structured rules go in JSON files for deterministic matching in Phase 2.
- **Using `google-generativeai` package:** Deprecated since November 2025. Use `google-genai` exclusively.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF text extraction | Custom PDF parser | pymupdf4llm | PDF format is enormously complex; table detection alone requires layout analysis algorithms |
| Table-to-structured-data | Regex/heuristic table parser | Gemini structured output | Table formats vary across programs; LLM handles variation; Pydantic validates output |
| Vector similarity search | Custom cosine similarity over numpy arrays | ChromaDB | Need persistence, metadata filtering, embedding management, and HNSW indexing |
| Text embeddings | Self-hosted embedding model | Gemini gemini-embedding-001 API | 3072-dim SOTA embeddings via API; no GPU needed; $0.00 for free tier (1500 RPD) |
| JSON schema validation | Manual dict checking | Pydantic BaseModel | Type coercion, validation errors, JSON schema generation for LLM, serialization |

**Key insight:** The core complexity is in PDF layout interpretation and LLM output validation -- both solved by mature libraries. The custom code should only handle pipeline orchestration and domain-specific schema design.

## Common Pitfalls

### Pitfall 1: LLM Hallucinating Rule Values
**What goes wrong:** Gemini invents loan amounts, FICO scores, or LTV limits not in the source PDF.
**Why it happens:** LLM training data includes mortgage industry knowledge; it may "fill in" plausible but incorrect values.
**How to avoid:**
- Use structured output with explicit `None`/`null` for missing fields rather than asking LLM to guess
- Include "Only extract values explicitly stated in the guideline. Use null for values not found." in the prompt
- Two-step with human review: write JSON to `data/programs/` for inspection before relying on it
**Warning signs:** Values that are suspiciously round or match common industry defaults but aren't in the PDF.

### Pitfall 2: Table Spanning Multiple Pages
**What goes wrong:** A single eligibility matrix spans pages 2-3, but page-level chunking splits it, causing incomplete extraction.
**Why it happens:** pymupdf4llm with `page_chunks=True` splits at page boundaries.
**How to avoid:**
- Concatenate all page Markdown before sending to the LLM for structured extraction
- Use `page_chunks=True` only for vector chunking, NOT for structured extraction
- For structured extraction, pass the FULL document Markdown to Gemini
**Warning signs:** Tiers with missing fields that are present in the PDF on the next page.

### Pitfall 3: ChromaDB Embedding Dimension Mismatch
**What goes wrong:** Changing embedding model or dimensionality after initial ingestion causes silent retrieval failures.
**Why it happens:** ChromaDB doesn't validate that new embeddings match the collection's existing dimensionality at query time (it will error at add time).
**How to avoid:**
- Fix `output_dimensionality=768` in the embedding function config
- When changing embedding config, delete and recreate the collection
- The idempotent re-ingestion pattern handles this naturally
**Warning signs:** Query results that seem random or irrelevant after config changes.

### Pitfall 4: Exceeding Gemini Context Window with Large PDFs
**What goes wrong:** Concatenating all pages of a large guideline PDF exceeds the model's practical limit for structured output.
**Why it happens:** While Gemini Flash supports 1M token context, structured output quality degrades with very long inputs.
**How to avoid:**
- Most GMCC guideline PDFs are 5-15 pages (the sample is 5 pages) -- well within limits
- If a PDF exceeds ~50 pages, process in sections and merge results
- Monitor token usage in responses
**Warning signs:** Incomplete tiers, missing fields that are clearly in the PDF.

### Pitfall 5: google-genai API Key Configuration
**What goes wrong:** Using `GOOGLE_API_KEY` env var (which conflicts with other Google services) vs `GEMINI_API_KEY`.
**Why it happens:** The google-genai SDK accepts both `GOOGLE_API_KEY` and `GEMINI_API_KEY` environment variables.
**How to avoid:**
- Use `GEMINI_API_KEY` in `.env` to be explicit and avoid conflicts
- Pass API key explicitly to the client: `genai.Client(api_key=os.getenv("GEMINI_API_KEY"))`
**Warning signs:** Authentication errors or wrong project/billing.

## Code Examples

Verified patterns from official sources:

### Complete Ingestion CLI Entry Point
```python
# rag/ingest.py
# Usage: python -m rag.ingest [--review-only] [--program NAME]
import os
import json
import click

from rag.extract import extract_pdf_to_markdown
from rag.structure import structure_with_llm
from rag.vectorstore import get_collection, store_chunks, rebuild_collection
from rag.config import GUIDELINES_DIR, PROGRAMS_DIR

@click.command()
@click.option("--review-only", is_flag=True, help="Extract and write JSON but skip ChromaDB indexing")
@click.option("--program", default=None, help="Process only this program (folder name)")
def ingest(review_only: bool, program: str | None):
    """Ingest GMCC guideline PDFs into structured JSON and ChromaDB."""
    os.makedirs(PROGRAMS_DIR, exist_ok=True)

    programs = [program] if program else sorted(
        d for d in os.listdir(GUIDELINES_DIR)
        if os.path.isdir(os.path.join(GUIDELINES_DIR, d))
    )

    if not programs:
        click.echo(f"No program directories found in {GUIDELINES_DIR}")
        return

    for prog_name in programs:
        prog_dir = os.path.join(GUIDELINES_DIR, prog_name)
        pdf_files = [f for f in os.listdir(prog_dir) if f.lower().endswith(".pdf")]
        if not pdf_files:
            click.echo(f"  SKIP: No PDF in {prog_dir}")
            continue

        pdf_path = os.path.join(prog_dir, pdf_files[0])
        click.echo(f"  Processing: {prog_name} ({pdf_files[0]})")

        # Stage 1: Extract PDF to Markdown
        pages = extract_pdf_to_markdown(pdf_path)
        full_md = "\n\n".join(p["text"] for p in pages)

        # Stage 2: LLM structured extraction
        rules = structure_with_llm(full_md, prog_name)
        out_path = os.path.join(PROGRAMS_DIR, f"{prog_name.lower()}.json")
        with open(out_path, "w") as f:
            json.dump(rules.model_dump(), f, indent=2)
        click.echo(f"    JSON -> {out_path} ({len(rules.tiers)} tiers)")

        # Stage 3: Vector store (unless review-only)
        if not review_only:
            store_chunks(prog_name, pages)
            click.echo(f"    ChromaDB -> {len(pages)} chunks indexed")

    click.echo("Done.")

if __name__ == "__main__":
    ingest()
```

### ChromaDB Query for Explanation Retrieval (Phase 2 Preview)
```python
# Source: ChromaDB official docs - metadata filtering
results = collection.query(
    query_texts=["what property types does Thunder allow"],
    n_results=3,
    where={"program_name": "Thunder"},
)

# results["documents"][0] -> list of matching text chunks
# results["metadatas"][0] -> list of metadata dicts with page_number, source_file
# results["distances"][0] -> list of similarity distances
```

### Gemini Embedding with Task Type for Queries vs Documents
```python
# Source: Google AI embeddings documentation
# Use RETRIEVAL_DOCUMENT when storing, RETRIEVAL_QUERY when searching
class GeminiEmbeddingFunction(EmbeddingFunction[Documents]):
    def __init__(self, task_type: str = "RETRIEVAL_DOCUMENT", **kwargs):
        # ... init ...
        self._task_type = task_type

    def __call__(self, input: Documents) -> Embeddings:
        result = self._client.models.embed_content(
            model=self._model,
            contents=input,
            config=types.EmbedContentConfig(
                task_type=self._task_type,
                output_dimensionality=768,
            ),
        )
        return [e.values for e in result.embeddings]

# Note: ChromaDB uses the same embedding function for both add and query.
# The task_type distinction (RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY) is
# recommended by Google but ChromaDB doesn't support using different
# functions for add vs query. Use RETRIEVAL_DOCUMENT as default --
# the quality difference is minimal for this use case.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `google-generativeai` package | `google-genai` unified SDK | Nov 2025 (deprecated) | Must use new SDK; import is `from google import genai` not `import google.generativeai` |
| `text-embedding-004` | `gemini-embedding-001` | Jan 2026 (deprecated) | New model is 3072-dim default, supports MRL for dimension reduction |
| ChromaDB `Settings(persist_directory=...)` | `chromadb.PersistentClient(path=...)` | ChromaDB 0.4+ | Old Settings-based persistence is removed; use PersistentClient directly |
| PyMuPDF `page.get_text()` for tables | `pymupdf4llm.to_markdown()` | PyMuPDF4LLM 0.2+ | Markdown output preserves table structure; much better for LLM consumption |
| Manual JSON schema for Gemini | Pydantic `model_json_schema()` | google-genai GA (May 2025) | SDK natively accepts Pydantic schemas via `response_json_schema` |

**Deprecated/outdated:**
- `google-generativeai` package: Permanently end-of-life since Nov 30, 2025. Use `google-genai`.
- `embedding-001` model: Deprecated Aug 2025. Use `gemini-embedding-001`.
- `text-embedding-004` model: Deprecated Jan 2026. Use `gemini-embedding-001`.
- ChromaDB `Settings(chroma_db_impl=..., persist_directory=...)`: Removed. Use `PersistentClient(path=...)`.

## Open Questions

1. **Exact JSON schema for eligibility tiers**
   - What we know: The sample PDF has matrices with transaction type x unit count x loan amount x LTV/CLTV x FICO. The Pydantic schema in this research is a good starting point.
   - What's unclear: Whether all programs follow the same matrix format, or if some have additional/different criteria. Some tiers may have nested conditions (e.g., different LTV limits per unit count per transaction type).
   - Recommendation: Run extraction on the sample PDF first, review output, then refine the schema. The `additional_rules` dict field serves as a catch-all for program-specific criteria. Consider a more granular matrix representation if needed (list of eligibility rows rather than flat maximums).

2. **Chunk granularity for vector store**
   - What we know: Page-level chunks work well for 5-page PDFs. The non-table sections (reserves, borrower types, DTI rules) are what goes into ChromaDB.
   - What's unclear: Whether page-level is too coarse for longer PDFs. Whether table content should also be chunked for explanation retrieval.
   - Recommendation: Start with page-level chunks. If retrieval quality is poor, switch to section-based splitting using Markdown headers as boundaries. Include table content in vector chunks too -- LOs may ask "what are the LTV limits for Thunder Jumbo A" and the answer should come from the original table text.

3. **QM vs Non-QM classification**
   - What we know: This distinction must be visible as program metadata. Some programs may explicitly state QM/Non-QM status, others may require inference from product features (e.g., interest-only = Non-QM).
   - What's unclear: Whether all PDFs explicitly label their QM status.
   - Recommendation: Include `qm_status` in the LLM extraction prompt. If the PDF doesn't state it explicitly, the LLM can often infer from product features. Flag any uncertain classifications for manual review.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest >=8.0 |
| Config file | none -- see Wave 0 |
| Quick run command | `python -m pytest tests/ -x -q` |
| Full suite command | `python -m pytest tests/ -v` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| KB-01 | PDF parsed into structured JSON with property types, location, amounts, LTV | integration | `python -m pytest tests/test_extraction.py -x` | No -- Wave 0 |
| KB-01 | Pydantic schema validates extracted data | unit | `python -m pytest tests/test_schemas.py -x` | No -- Wave 0 |
| KB-02 | Chunks stored in ChromaDB and retrievable by semantic query | integration | `python -m pytest tests/test_vectorstore.py -x` | No -- Wave 0 |
| KB-02 | Metadata filtering by program name returns correct results | unit | `python -m pytest tests/test_vectorstore.py::test_metadata_filter -x` | No -- Wave 0 |
| KB-03 | Re-running ingestion updates stored rules (idempotent) | integration | `python -m pytest tests/test_ingestion.py::test_reingestion -x` | No -- Wave 0 |
| KB-03 | New PDF in input directory is picked up without code changes | integration | `python -m pytest tests/test_ingestion.py::test_new_program -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `python -m pytest tests/ -x -q`
- **Per wave merge:** `python -m pytest tests/ -v`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `pytest.ini` or `pyproject.toml [tool.pytest.ini_options]` -- pytest configuration
- [ ] `tests/__init__.py` -- test package init
- [ ] `tests/conftest.py` -- shared fixtures (sample PDF path, temp directories, mock Gemini client)
- [ ] `tests/test_schemas.py` -- Pydantic model validation tests
- [ ] `tests/test_extraction.py` -- PDF-to-Markdown extraction tests (requires sample PDF)
- [ ] `tests/test_vectorstore.py` -- ChromaDB storage and query tests
- [ ] `tests/test_ingestion.py` -- End-to-end ingestion pipeline tests
- [ ] Framework install: `pip install pytest>=8.0`
- [ ] Consider: mock Gemini API calls in tests to avoid API costs and flakiness

## Sources

### Primary (HIGH confidence)
- [PyPI: google-genai 1.66.0](https://pypi.org/project/google-genai/) - Latest version, features, Python >=3.10 requirement
- [PyPI: chromadb 1.5.2](https://pypi.org/project/chromadb/) - Latest version, Python >=3.9
- [PyPI: pymupdf4llm 0.3.4](https://pypi.org/project/pymupdf4llm/) - Latest version, dependencies
- [Google AI: Structured Output](https://ai.google.dev/gemini-api/docs/structured-output) - Pydantic response_schema with Gemini
- [Google AI: Embeddings](https://ai.google.dev/gemini-api/docs/embeddings) - embed_content API, gemini-embedding-001, task types
- [ChromaDB: Metadata Filtering](https://docs.trychroma.com/docs/querying-collections/metadata-filtering) - where clauses, operators, combining filters
- [ChromaDB: Custom Embedding Functions](https://cookbook.chromadb.dev/embeddings/bring-your-own-embeddings/) - EmbeddingFunction interface
- [PyMuPDF4LLM: API Reference](https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/api.html) - to_markdown parameters
- [google-generativeai deprecated](https://github.com/google-gemini/deprecated-generative-ai-python) - Official deprecation notice

### Secondary (MEDIUM confidence)
- [Artifex: Table Extraction with PyMuPDF](https://artifex.com/blog/table-recognition-extraction-from-pdfs-pymupdf-python) - Table extraction strategies and find_tables()
- [ChromaDB PR #4278](https://github.com/chroma-core/chroma/pull/4278) - GoogleGenAiEmbeddingFunction (NOT yet merged, confirms need for custom function)
- [Google AI Developers Forum](https://discuss.ai.google.dev/t/google-generativeai-vs-python-genai/53873) - SDK migration guidance

### Tertiary (LOW confidence)
- [Gemini Flash pricing](https://pricepertoken.com/pricing-page/model/google-gemini-2.0-flash-001) - $0.10/M input, $0.40/M output (verify on official pricing page)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries verified via PyPI with current versions and official documentation
- Architecture: HIGH - Patterns verified against official docs for all three libraries; two-stage extraction is industry-standard for PDF-to-structured-data pipelines
- Pitfalls: HIGH - Table extraction, LLM hallucination, and embedding dimension issues are well-documented in official sources and community discussions
- ChromaDB + google-genai integration: MEDIUM - Custom embedding function needed because built-in integration PR is still open; pattern is straightforward but not yet in official ChromaDB docs

**Research date:** 2026-03-06
**Valid until:** 2026-04-06 (30 days -- stack is stable; google-genai updates frequently but API is GA)
