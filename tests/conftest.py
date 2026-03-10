"""Shared fixtures for the test suite."""

import json
import os

import pytest

from rag.schemas import ProgramRules


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


# --- Matching engine fixtures ---


@pytest.fixture
def sample_listing():
    """RentCast-format listing dict: Single Family, $500K, Los Angeles County, CA."""
    return {
        "price": 500000,
        "propertyType": "Single Family",
        "state": "CA",
        "county": "Los Angeles",
        "countyFips": "06037",
        "latitude": 34.0522,
        "longitude": -118.2437,
        "bedrooms": 3,
        "bathrooms": 2.0,
        "squareFootage": 1500,
        "formattedAddress": "123 Main St, Los Angeles, CA 90001",
    }


@pytest.fixture
def sample_listing_missing_county():
    """RentCast listing with county=None, countyFips=None."""
    return {
        "price": 500000,
        "propertyType": "Single Family",
        "state": "CA",
        "county": None,
        "countyFips": None,
        "latitude": 34.0522,
        "longitude": -118.2437,
        "bedrooms": 3,
        "bathrooms": 2.0,
        "squareFootage": 1500,
        "formattedAddress": "123 Main St, Los Angeles, CA 90001",
    }


@pytest.fixture
def sample_listing_missing_type():
    """RentCast listing with propertyType=None."""
    return {
        "price": 500000,
        "propertyType": None,
        "state": "CA",
        "county": "Los Angeles",
        "countyFips": "06037",
        "latitude": 34.0522,
        "longitude": -118.2437,
        "bedrooms": 3,
        "bathrooms": 2.0,
        "squareFootage": 1500,
        "formattedAddress": "123 Main St, Los Angeles, CA 90001",
    }


@pytest.fixture
def sample_program_rules():
    """ProgramRules loaded from the first available program JSON."""
    programs_dir = "data/programs"
    if not os.path.isdir(programs_dir):
        pytest.skip(f"Programs directory not found: {programs_dir}")
    for fname in sorted(os.listdir(programs_dir)):
        if fname.endswith(".json"):
            path = os.path.join(programs_dir, fname)
            with open(path) as f:
                data = json.load(f)
            return ProgramRules.model_validate(data)
    pytest.skip("No program JSON files found")
