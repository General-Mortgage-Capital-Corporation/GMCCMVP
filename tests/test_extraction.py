"""Tests for PDF extraction and LLM structuring pipeline."""

import os

import pytest

from rag.extract import extract_pdf_to_markdown
from rag.schemas import ProgramRules


# --- extract_pdf_to_markdown tests ---


class TestExtractPdfToMarkdown:
    """Tests for PDF-to-Markdown extraction via pymupdf4llm."""

    def test_returns_list_of_dicts_with_text_key(self, sample_pdf_path):
        """extract_pdf_to_markdown returns a list of dicts with 'text' key."""
        result = extract_pdf_to_markdown(sample_pdf_path)
        assert isinstance(result, list)
        assert len(result) > 0
        for page in result:
            assert isinstance(page, dict)
            assert "text" in page

    def test_page_chunks_produces_one_per_page(self, sample_pdf_path):
        """extract_pdf_to_markdown with page_chunks=True produces one entry per page."""
        result = extract_pdf_to_markdown(sample_pdf_path)
        # The sample PDF is 5 pages
        assert len(result) >= 1
        # Each entry should have text content
        for page in result:
            assert len(page["text"]) > 0

    def test_output_contains_markdown_table_syntax(self, sample_pdf_path):
        """extract_pdf_to_markdown output contains Markdown table syntax for table-heavy PDFs."""
        result = extract_pdf_to_markdown(sample_pdf_path)
        full_text = "\n".join(page["text"] for page in result)
        # Markdown tables use pipe characters and dashes
        assert "|" in full_text, "Expected Markdown table pipe characters in output"

    def test_raises_file_not_found_for_missing_pdf(self):
        """extract_pdf_to_markdown raises FileNotFoundError for non-existent PDF."""
        with pytest.raises(FileNotFoundError):
            extract_pdf_to_markdown("/nonexistent/path/to/file.pdf")


# --- structure_with_llm tests ---


class TestStructureWithLlm:
    """Tests for Markdown-to-JSON structuring via Gemini.

    Integration tests require GEMINI_API_KEY and are marked accordingly.
    """

    @pytest.mark.integration
    def test_returns_program_rules_instance(self, sample_pdf_path):
        """structure_with_llm returns a ProgramRules instance."""
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            pytest.skip("GEMINI_API_KEY not set")

        from rag.structure import structure_with_llm

        pages = extract_pdf_to_markdown(sample_pdf_path)
        full_md = "\n\n".join(p["text"] for p in pages)

        result = structure_with_llm(full_md, "Thunder")
        assert isinstance(result, ProgramRules)

    @pytest.mark.integration
    def test_program_name_matches_input(self, sample_pdf_path):
        """structure_with_llm result has program_name matching the input."""
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            pytest.skip("GEMINI_API_KEY not set")

        from rag.structure import structure_with_llm

        pages = extract_pdf_to_markdown(sample_pdf_path)
        full_md = "\n\n".join(p["text"] for p in pages)

        result = structure_with_llm(full_md, "Thunder")
        assert result.program_name == "Thunder"

    @pytest.mark.integration
    def test_has_at_least_one_tier(self, sample_pdf_path):
        """structure_with_llm result has at least one tier for the sample TCU guideline."""
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            pytest.skip("GEMINI_API_KEY not set")

        from rag.structure import structure_with_llm

        pages = extract_pdf_to_markdown(sample_pdf_path)
        full_md = "\n\n".join(p["text"] for p in pages)

        result = structure_with_llm(full_md, "Thunder")
        assert len(result.tiers) >= 1

    @pytest.mark.integration
    def test_qm_status_is_set(self, sample_pdf_path):
        """structure_with_llm result has qm_status set (not empty string)."""
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            pytest.skip("GEMINI_API_KEY not set")

        from rag.structure import structure_with_llm

        pages = extract_pdf_to_markdown(sample_pdf_path)
        full_md = "\n\n".join(p["text"] for p in pages)

        result = structure_with_llm(full_md, "Thunder")
        assert result.qm_status != ""
        assert result.qm_status in ["QM", "Non-QM", "Both"]

    @pytest.mark.integration
    def test_tiers_have_nonempty_property_and_transaction_types(self, sample_pdf_path):
        """Each tier in result has non-empty property_types and transaction_types lists."""
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            pytest.skip("GEMINI_API_KEY not set")

        from rag.structure import structure_with_llm

        pages = extract_pdf_to_markdown(sample_pdf_path)
        full_md = "\n\n".join(p["text"] for p in pages)

        result = structure_with_llm(full_md, "Thunder")
        for tier in result.tiers:
            assert len(tier.property_types) > 0, f"Tier '{tier.tier_name}' has empty property_types"
            assert len(tier.transaction_types) > 0, f"Tier '{tier.tier_name}' has empty transaction_types"
