"""Unit tests for the matching engine models, property types, and geocode fallback."""

import json
import os

import pytest

from matching.models import (
    CriterionResult,
    CriterionStatus,
    ListingInput,
    MatchResponse,
    OverallStatus,
    ProgramResult,
    TierResult,
)
from matching.property_types import PROPERTY_TYPE_UNITS, RENTCAST_TO_PROGRAM
from matching.geocode import get_county_from_coordinates


# --- ListingInput tests ---


class TestListingInputFromRentcast:
    """Test ListingInput.from_rentcast() classmethod."""

    def test_creates_valid_model_from_full_rentcast_dict(self, sample_listing):
        listing = ListingInput.from_rentcast(sample_listing)
        assert listing.price == 500000
        assert listing.property_type == "Single Family"
        assert listing.state == "CA"
        assert listing.county == "Los Angeles"
        assert listing.latitude == 34.0522
        assert listing.longitude == -118.2437

    def test_handles_missing_fields_gracefully(self):
        listing = ListingInput.from_rentcast({})
        assert listing.price is None
        assert listing.property_type is None
        assert listing.state is None
        assert listing.county is None
        assert listing.latitude is None
        assert listing.longitude is None
        assert listing.bedrooms is None
        assert listing.bathrooms is None
        assert listing.square_footage is None


# --- Property type mapping tests ---


class TestPropertyTypeMappings:
    """Test RENTCAST_TO_PROGRAM and PROPERTY_TYPE_UNITS lookup tables."""

    def test_single_family_maps_to_sfr(self):
        assert RENTCAST_TO_PROGRAM["Single Family"] == "SFR"

    def test_condo_maps_to_condo(self):
        assert RENTCAST_TO_PROGRAM["Condo"] == "Condo"

    def test_multi_family_maps_to_2_4_units(self):
        assert RENTCAST_TO_PROGRAM["Multi-Family"] == "2-4 Units"

    def test_townhouse_maps_to_sfr(self):
        assert RENTCAST_TO_PROGRAM["Townhouse"] == "SFR"

    def test_single_family_units_is_1(self):
        assert PROPERTY_TYPE_UNITS["Single Family"] == 1

    def test_condo_units_is_1(self):
        assert PROPERTY_TYPE_UNITS["Condo"] == 1

    def test_multi_family_units_is_none(self):
        assert PROPERTY_TYPE_UNITS["Multi-Family"] is None

    def test_all_7_rentcast_types_in_rentcast_to_program(self):
        expected = {
            "Single Family",
            "Condo",
            "Townhouse",
            "Multi-Family",
            "Manufactured",
            "Apartment",
            "Land",
        }
        assert set(RENTCAST_TO_PROGRAM.keys()) == expected

    def test_all_7_rentcast_types_in_property_type_units(self):
        expected = {
            "Single Family",
            "Condo",
            "Townhouse",
            "Multi-Family",
            "Manufactured",
            "Apartment",
            "Land",
        }
        assert set(PROPERTY_TYPE_UNITS.keys()) == expected


# --- Geocode fallback tests ---


class TestGetCountyFromCoordinates:
    """Test FCC Area API county fallback."""

    def test_returns_county_dict_on_success(self, monkeypatch):
        """Mock FCC API response to verify parsing."""

        class MockResponse:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "results": [
                        {
                            "county_name": "Los Angeles",
                            "county_fips": "06037",
                            "state_code": "CA",
                            "state_name": "California",
                        }
                    ]
                }

        import matching.geocode as geocode_mod

        # Clear lru_cache before mocking
        geocode_mod.get_county_from_coordinates.cache_clear()

        monkeypatch.setattr("requests.get", lambda *args, **kwargs: MockResponse())
        result = get_county_from_coordinates(34.052, -118.244)
        assert result is not None
        assert result["county_name"] == "Los Angeles"
        assert result["county_fips"] == "06037"
        assert result["state_code"] == "CA"

        # Clean up cache
        geocode_mod.get_county_from_coordinates.cache_clear()

    def test_returns_none_on_api_failure(self, monkeypatch):
        """Mock API timeout/error to verify graceful failure."""
        import requests as req_mod
        import matching.geocode as geocode_mod

        geocode_mod.get_county_from_coordinates.cache_clear()

        def mock_get(*args, **kwargs):
            raise req_mod.RequestException("Connection timeout")

        monkeypatch.setattr("requests.get", mock_get)
        result = get_county_from_coordinates(34.052, -118.244)
        assert result is None

        geocode_mod.get_county_from_coordinates.cache_clear()


# --- Enum and model structure tests ---


class TestCriterionStatus:
    """Test CriterionStatus enum values."""

    def test_has_pass_value(self):
        assert CriterionStatus.PASS == "pass"

    def test_has_fail_value(self):
        assert CriterionStatus.FAIL == "fail"

    def test_has_unverified_value(self):
        assert CriterionStatus.UNVERIFIED == "unverified"


class TestOverallStatus:
    """Test OverallStatus enum values."""

    def test_has_eligible_value(self):
        assert OverallStatus.ELIGIBLE == "Eligible"

    def test_has_potentially_eligible_value(self):
        assert OverallStatus.POTENTIALLY_ELIGIBLE == "Potentially Eligible"

    def test_has_ineligible_value(self):
        assert OverallStatus.INELIGIBLE == "Ineligible"


class TestCriterionResult:
    """Test CriterionResult model."""

    def test_accepts_criterion_name_status_detail(self):
        result = CriterionResult(
            criterion="property_type",
            status=CriterionStatus.PASS,
            detail="Single Family matches SFR",
        )
        assert result.criterion == "property_type"
        assert result.status == CriterionStatus.PASS
        assert result.detail == "Single Family matches SFR"


class TestTierResult:
    """Test TierResult model."""

    def test_aggregates_criteria_list(self):
        criteria = [
            CriterionResult(
                criterion="property_type",
                status=CriterionStatus.PASS,
                detail="Matches",
            ),
            CriterionResult(
                criterion="loan_amount",
                status=CriterionStatus.PASS,
                detail="In range",
            ),
        ]
        tier = TierResult(
            tier_name="Conforming - Purchase - 1 Unit",
            status=OverallStatus.ELIGIBLE,
            criteria=criteria,
        )
        assert tier.tier_name == "Conforming - Purchase - 1 Unit"
        assert tier.status == OverallStatus.ELIGIBLE
        assert len(tier.criteria) == 2


class TestProgramResult:
    """Test ProgramResult model."""

    def test_has_program_name_status_tiers_best_tier(self):
        result = ProgramResult(
            program_name="Thunder",
            status=OverallStatus.ELIGIBLE,
            matching_tiers=[],
            best_tier="Conforming - Purchase - 1 Unit",
        )
        assert result.program_name == "Thunder"
        assert result.status == OverallStatus.ELIGIBLE
        assert result.best_tier == "Conforming - Purchase - 1 Unit"
        assert result.matching_tiers == []


class TestMatchResponse:
    """Test MatchResponse model."""

    def test_has_programs_list_and_eligible_count(self):
        resp = MatchResponse(
            programs=[
                ProgramResult(
                    program_name="Thunder",
                    status=OverallStatus.ELIGIBLE,
                    matching_tiers=[],
                    best_tier=None,
                )
            ],
            eligible_count=1,
        )
        assert len(resp.programs) == 1
        assert resp.eligible_count == 1
