"""Tests for the CLI ingestion pipeline.

Tests cover:
- Ingest produces JSON output file from a mock program directory
- --review-only flag skips ChromaDB storage
- Idempotent re-ingestion produces identical JSON
"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from rag.ingest import ingest
from rag.schemas import EligibilityTier, ProgramRules


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_guidelines(tmp_path, program_name="TestProgram"):
    """Create a fake guidelines directory with a dummy PDF file."""
    program_dir = tmp_path / "guidelines" / program_name
    program_dir.mkdir(parents=True)
    pdf_path = program_dir / "guide.pdf"
    pdf_path.write_bytes(b"%PDF-1.4 fake pdf content")
    return tmp_path / "guidelines", tmp_path / "programs"


def _make_sample_rules(program_name="TestProgram"):
    """Create a sample ProgramRules instance for mocking."""
    return ProgramRules(
        program_name=program_name,
        qm_status="QM",
        tiers=[
            EligibilityTier(
                tier_name="Conforming",
                transaction_types=["Purchase", "Rate/Term Refi"],
                property_types=["SFR", "Condo"],
                occupancy_types=["Primary Residence"],
                max_loan_amount=766550.0,
                min_fico=620,
                max_ltv=97.0,
            )
        ],
        general_notes=["Standard underwriting applies"],
    )


# ---------------------------------------------------------------------------
# Ingest command tests
# ---------------------------------------------------------------------------


class TestIngestCommand:
    """Tests for the CLI ingest command."""

    @patch("rag.ingest.store_chunks")
    @patch("rag.ingest.structure_with_llm")
    @patch("rag.ingest.extract_pdf_to_markdown")
    def test_produces_json_output(
        self, mock_extract, mock_structure, mock_store, tmp_path
    ):
        """Ingest should create a JSON file in the programs output directory."""
        guidelines_dir, programs_dir = _make_mock_guidelines(tmp_path)

        # Mock the pipeline stages
        mock_extract.return_value = [{"text": "Page 1 markdown content"}]
        mock_structure.return_value = _make_sample_rules("TestProgram")

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(guidelines_dir)), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            result = runner.invoke(ingest, ["--program", "TestProgram"])

        assert result.exit_code == 0, f"CLI error: {result.output}"
        json_path = programs_dir / "testprogram.json"
        assert json_path.exists(), f"Expected JSON at {json_path}"

        data = json.loads(json_path.read_text())
        assert data["program_name"] == "TestProgram"
        assert data["qm_status"] == "QM"
        assert len(data["tiers"]) == 1

    @patch("rag.ingest.store_chunks")
    @patch("rag.ingest.structure_with_llm")
    @patch("rag.ingest.extract_pdf_to_markdown")
    def test_review_only_skips_chromadb(
        self, mock_extract, mock_structure, mock_store, tmp_path
    ):
        """--review-only flag should write JSON but NOT call store_chunks."""
        guidelines_dir, programs_dir = _make_mock_guidelines(tmp_path)

        mock_extract.return_value = [{"text": "Page 1"}]
        mock_structure.return_value = _make_sample_rules("TestProgram")

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(guidelines_dir)), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            result = runner.invoke(ingest, ["--review-only", "--program", "TestProgram"])

        assert result.exit_code == 0, f"CLI error: {result.output}"
        mock_store.assert_not_called()

    @patch("rag.ingest.store_chunks")
    @patch("rag.ingest.structure_with_llm")
    @patch("rag.ingest.extract_pdf_to_markdown")
    def test_full_ingest_calls_store_chunks(
        self, mock_extract, mock_structure, mock_store, tmp_path
    ):
        """Without --review-only, store_chunks should be called."""
        guidelines_dir, programs_dir = _make_mock_guidelines(tmp_path)

        mock_extract.return_value = [{"text": "Page 1"}]
        mock_structure.return_value = _make_sample_rules("TestProgram")

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(guidelines_dir)), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            result = runner.invoke(ingest, ["--program", "TestProgram"])

        assert result.exit_code == 0, f"CLI error: {result.output}"
        mock_store.assert_called_once()

    @patch("rag.ingest.store_chunks")
    @patch("rag.ingest.structure_with_llm")
    @patch("rag.ingest.extract_pdf_to_markdown")
    def test_idempotent_json_output(
        self, mock_extract, mock_structure, mock_store, tmp_path
    ):
        """Running ingest twice should produce identical JSON output."""
        guidelines_dir, programs_dir = _make_mock_guidelines(tmp_path)

        mock_extract.return_value = [{"text": "Page 1"}]
        mock_structure.return_value = _make_sample_rules("TestProgram")

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(guidelines_dir)), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            runner.invoke(ingest, ["--review-only", "--program", "TestProgram"])
            json_path = programs_dir / "testprogram.json"
            first_output = json_path.read_text()

            runner.invoke(ingest, ["--review-only", "--program", "TestProgram"])
            second_output = json_path.read_text()

        assert first_output == second_output

    @patch("rag.ingest.store_chunks")
    @patch("rag.ingest.structure_with_llm")
    @patch("rag.ingest.extract_pdf_to_markdown")
    def test_skips_directory_without_pdf(
        self, mock_extract, mock_structure, mock_store, tmp_path
    ):
        """Should skip a program directory that has no PDF files."""
        guidelines_dir = tmp_path / "guidelines"
        programs_dir = tmp_path / "programs"
        # Create a program dir with no PDF
        (guidelines_dir / "EmptyProgram").mkdir(parents=True)

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(guidelines_dir)), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            result = runner.invoke(ingest, ["--program", "EmptyProgram"])

        assert result.exit_code == 0
        mock_extract.assert_not_called()

    @patch("rag.ingest.store_chunks")
    @patch("rag.ingest.structure_with_llm")
    @patch("rag.ingest.extract_pdf_to_markdown")
    def test_processes_multiple_programs(
        self, mock_extract, mock_structure, mock_store, tmp_path
    ):
        """Without --program flag, should process all subdirectories."""
        guidelines_dir = tmp_path / "guidelines"
        programs_dir = tmp_path / "programs"

        # Create two program directories with PDFs
        for name in ["Alpha", "Beta"]:
            d = guidelines_dir / name
            d.mkdir(parents=True)
            (d / "guide.pdf").write_bytes(b"%PDF-1.4 fake")

        mock_extract.return_value = [{"text": "Page 1"}]
        mock_structure.side_effect = [
            _make_sample_rules("Alpha"),
            _make_sample_rules("Beta"),
        ]

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(guidelines_dir)), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            result = runner.invoke(ingest, [])

        assert result.exit_code == 0
        assert mock_extract.call_count == 2
        assert (programs_dir / "alpha.json").exists()
        assert (programs_dir / "beta.json").exists()


# ---------------------------------------------------------------------------
# Integration tests (require GEMINI_API_KEY and sample PDF)
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestIngestIntegration:
    """Integration tests that run the real pipeline."""

    def test_ingest_sample_pdf(self, tmp_path):
        """Full pipeline against the sample TCU guideline PDF."""
        from rag.ingest import ingest

        guidelines_dir = tmp_path / "guidelines" / "Thunder"
        guidelines_dir.mkdir(parents=True)

        import shutil
        sample_pdf = "sample_guideline/TCU Wholesale Mortgage Quick Guide_092025.pdf"
        if not os.path.exists(sample_pdf):
            pytest.skip("Sample PDF not available")
        shutil.copy(sample_pdf, guidelines_dir / "guide.pdf")

        programs_dir = tmp_path / "programs"

        runner = CliRunner()
        with patch("rag.ingest.GUIDELINES_DIR", str(tmp_path / "guidelines")), \
             patch("rag.ingest.PROGRAMS_DIR", str(programs_dir)):
            result = runner.invoke(ingest, ["--review-only", "--program", "Thunder"])

        assert result.exit_code == 0
        json_path = programs_dir / "thunder.json"
        assert json_path.exists()
        data = json.loads(json_path.read_text())
        assert data["program_name"] == "Thunder"
        assert len(data["tiers"]) > 0
