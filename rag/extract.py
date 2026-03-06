"""PDF-to-Markdown extraction via pymupdf4llm.

Stage 1 of the two-stage extraction pipeline: deterministic PDF-to-Markdown
conversion that preserves table structure for downstream LLM processing.
"""

import os

import pymupdf4llm


def extract_pdf_to_markdown(pdf_path: str) -> list[dict]:
    """Extract PDF content as Markdown with page-level chunks.

    Uses pymupdf4llm to convert each page of the PDF into Markdown format,
    preserving table structure as Markdown tables.

    Args:
        pdf_path: Path to the PDF file to extract.

    Returns:
        List of dicts, each with at least a "text" key containing
        the Markdown content for one page.

    Raises:
        FileNotFoundError: If pdf_path does not exist.
    """
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF file not found: {pdf_path}")

    return pymupdf4llm.to_markdown(pdf_path, page_chunks=True)
