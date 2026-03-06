"""CLI ingestion pipeline orchestrating PDF extraction, LLM structuring, and ChromaDB storage.

Usage:
    python -m rag.ingest [--review-only] [--program PROGRAM_NAME]

Stages:
    1. PDF -> Markdown (via extract_pdf_to_markdown)
    2. Markdown -> Structured JSON (via structure_with_llm)
    3. Page chunks -> ChromaDB (via store_chunks, unless --review-only)
"""

import json
import os

import click

from rag.config import GUIDELINES_DIR, PROGRAMS_DIR
from rag.extract import extract_pdf_to_markdown
from rag.structure import structure_with_llm
from rag.vectorstore import store_chunks


@click.command()
@click.option(
    "--review-only",
    is_flag=True,
    default=False,
    help="Extract and write JSON but skip ChromaDB indexing.",
)
@click.option(
    "--program",
    type=str,
    default=None,
    help="Process only this program folder name.",
)
def ingest(review_only: bool, program: str | None) -> None:
    """Ingest guideline PDFs into structured JSON and ChromaDB.

    Processes program directories under data/guidelines/, extracting PDFs
    to Markdown, structuring via LLM, writing JSON to data/programs/, and
    optionally indexing page chunks in ChromaDB.
    """
    os.makedirs(PROGRAMS_DIR, exist_ok=True)

    # Determine which program directories to process
    if program:
        program_dirs = [program]
    else:
        if not os.path.isdir(GUIDELINES_DIR):
            click.echo(f"Guidelines directory not found: {GUIDELINES_DIR}")
            return
        program_dirs = sorted(
            d
            for d in os.listdir(GUIDELINES_DIR)
            if os.path.isdir(os.path.join(GUIDELINES_DIR, d))
        )

    if not program_dirs:
        click.echo("No program directories found.")
        return

    for prog_name in program_dirs:
        prog_path = os.path.join(GUIDELINES_DIR, prog_name)

        if not os.path.isdir(prog_path):
            click.echo(f"Warning: Directory not found for '{prog_name}', skipping.")
            continue

        # Find PDF files in the program directory
        pdf_files = [f for f in os.listdir(prog_path) if f.lower().endswith(".pdf")]

        if not pdf_files:
            click.echo(f"Warning: No PDF found in {prog_path}, skipping.")
            continue

        pdf_path = os.path.join(prog_path, pdf_files[0])
        click.echo(f"Processing {prog_name}: {pdf_files[0]}")

        # Stage 1: PDF -> Markdown
        click.echo("  Stage 1: Extracting PDF to Markdown...")
        pages = extract_pdf_to_markdown(pdf_path)

        # Concatenate all pages for LLM structuring
        full_md = "\n\n".join(p["text"] for p in pages)

        # Stage 2: Markdown -> Structured JSON
        click.echo("  Stage 2: Structuring with LLM...")
        rules = structure_with_llm(full_md, prog_name)

        # Write JSON output
        json_filename = f"{prog_name.lower()}.json"
        json_path = os.path.join(PROGRAMS_DIR, json_filename)
        with open(json_path, "w") as f:
            json.dump(rules.model_dump(), f, indent=2)
        click.echo(f"  JSON written: {json_path}")

        # Stage 3: ChromaDB indexing (unless --review-only)
        if not review_only:
            click.echo("  Stage 3: Indexing in ChromaDB...")
            store_chunks(prog_name, pages)
            click.echo("  ChromaDB indexed.")
        else:
            click.echo("  Stage 3: Skipped (--review-only)")

    click.echo("Done.")
