"""Shared fixtures for the test suite."""

import os
import pytest


@pytest.fixture
def sample_pdf_path():
    """Return path to the sample guideline PDF, skip if not present."""
    path = "sample_guideline/TCU Wholesale Mortgage Quick Guide_092025.pdf"
    if not os.path.exists(path):
        pytest.skip(f"Sample PDF not found: {path}")
    return path


@pytest.fixture
def tmp_output_dir(tmp_path):
    """Return a temporary directory for test output."""
    return tmp_path
