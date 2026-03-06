"""PDF-to-Markdown extraction via pymupdf4llm with table enhancement.

Stage 1 of the two-stage extraction pipeline: deterministic PDF-to-Markdown
conversion. Uses PyMuPDF's find_tables() for accurate table extraction since
pymupdf4llm's markdown tables garble complex multi-row eligibility matrices.
"""

import os

import pymupdf
import pymupdf4llm


def _format_table_as_markdown(table) -> str:
    """Convert a PyMuPDF table to clean Markdown with proper headers."""
    rows = table.extract()
    if not rows:
        return ""

    # Clean rows: collapse None/empty cells, strip whitespace
    cleaned = []
    for row in rows:
        cleaned_row = []
        for cell in row:
            if cell is None:
                cleaned_row.append("")
            else:
                # Collapse whitespace and strip
                cleaned_row.append(cell.strip().replace("\n", " "))
        cleaned.append(cleaned_row)

    # Remove completely empty columns
    if not cleaned:
        return ""
    col_count = len(cleaned[0])
    non_empty_cols = []
    for col_idx in range(col_count):
        if any(row[col_idx] for row in cleaned if col_idx < len(row)):
            non_empty_cols.append(col_idx)

    filtered = []
    for row in cleaned:
        filtered.append([row[i] for i in non_empty_cols if i < len(row)])

    if not filtered:
        return ""

    # Build markdown table
    lines = []
    # Header row
    lines.append("| " + " | ".join(filtered[0]) + " |")
    lines.append("| " + " | ".join("---" for _ in filtered[0]) + " |")
    # Data rows
    for row in filtered[1:]:
        # Pad row if needed
        while len(row) < len(filtered[0]):
            row.append("")
        lines.append("| " + " | ".join(row) + " |")

    return "\n".join(lines)


def extract_pdf_to_markdown(pdf_path: str) -> list[dict]:
    """Extract PDF content as Markdown with page-level chunks.

    Uses pymupdf4llm for general text and PyMuPDF's find_tables() for
    accurate table extraction. Tables are replaced with properly formatted
    Markdown tables.

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

    # Get base markdown from pymupdf4llm (good for non-table text)
    pages = pymupdf4llm.to_markdown(pdf_path, page_chunks=True)

    # Enhance with accurate table extraction
    doc = pymupdf.open(pdf_path)
    for page_idx, page in enumerate(doc):
        tabs = page.find_tables()
        if not tabs.tables:
            continue

        # Build clean table markdown
        table_sections = []
        for tab in tabs.tables:
            table_md = _format_table_as_markdown(tab)
            if table_md:
                table_sections.append(table_md)

        if table_sections and page_idx < len(pages):
            # Get non-table text from the page
            text_blocks = page.get_text("text")

            # Replace page content with: non-table text + clean tables
            # Use the original markdown for non-table content context,
            # but append the accurately extracted tables
            pages[page_idx]["text"] = (
                pages[page_idx]["text"]
                + "\n\n--- ACCURATELY EXTRACTED TABLES ---\n\n"
                + "\n\n".join(table_sections)
            )

    doc.close()
    return pages
