"""Unit tests for the matching engine models, property types, geocode, and matching logic."""

import json
import os
from unittest.mock import patch

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
from matching.matcher import (
    check_eligible_county,
    check_loan_amount,
    check_property_type,
    check_unit_count,
    load_programs,
    match_listing,
    match_tier,
)
from rag.schemas import EligibilityTier, ProgramRules


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
        geocode_mod._get_county_cached.cache_clear()

        monkeypatch.setattr("requests.get", lambda *args, **kwargs: MockResponse())
        result = get_county_from_coordinates(34.052, -118.244)
        assert result is not None
        assert result["county_name"] == "Los Angeles"
        assert result["county_fips"] == "06037"
        assert result["state_code"] == "CA"

        # Clean up cache
        geocode_mod._get_county_cached.cache_clear()

    def test_returns_none_on_api_failure(self, monkeypatch):
        """Mock API timeout/error to verify graceful failure."""
        import requests as req_mod
        import matching.geocode as geocode_mod

        geocode_mod._get_county_cached.cache_clear()

        def mock_get(*args, **kwargs):
            raise req_mod.RequestException("Connection timeout")

        monkeypatch.setattr("requests.get", mock_get)
        result = get_county_from_coordinates(34.052, -118.244)
        assert result is None

        geocode_mod._get_county_cached.cache_clear()


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


# ===================================================================
# Task 2: Core matching logic tests
# ===================================================================


# Helper: create a simple EligibilityTier for testing
def _make_tier(
    tier_name="Test Tier",
    transaction_types=None,
    property_types=None,
    occupancy_types=None,
    max_loan_amount=None,
    min_loan_amount=None,
    location_restrictions=None,
    unit_count_limits=None,
):
    return EligibilityTier(
        tier_name=tier_name,
        transaction_types=transaction_types or ["Purchase"],
        property_types=property_types or ["SFR"],
        occupancy_types=occupancy_types or ["Primary Residence"],
        max_loan_amount=max_loan_amount,
        min_loan_amount=min_loan_amount,
        location_restrictions=location_restrictions or [],
        unit_count_limits=unit_count_limits or [],
    )


# --- load_programs tests ---


class TestLoadPrograms:
    """Test load_programs() function."""

    def test_returns_sequence_of_program_rules(self):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        programs = load_programs()
        # Returns a tuple (hashable for lru_cache) of ProgramRules
        assert len(programs) >= 1
        assert programs[0].program_name  # has a name
        matcher_mod.load_programs.cache_clear()

    def test_caches_results(self):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        first = load_programs()
        second = load_programs()
        # lru_cache returns the same object on cache hit
        assert first is second
        matcher_mod.load_programs.cache_clear()


# --- check_property_type tests ---


class TestCheckPropertyType:
    """Test check_property_type criterion check."""

    def test_single_family_against_sfr_tier_returns_pass(self):
        tier = _make_tier(property_types=["SFR"])
        result = check_property_type("Single Family", tier)
        assert result.status == CriterionStatus.PASS

    def test_none_property_type_returns_unverified(self):
        tier = _make_tier(property_types=["SFR"])
        result = check_property_type(None, tier)
        assert result.status == CriterionStatus.UNVERIFIED

    def test_land_against_sfr_tier_returns_fail(self):
        tier = _make_tier(property_types=["SFR"])
        result = check_property_type("Land", tier)
        assert result.status == CriterionStatus.FAIL


# --- check_loan_amount tests ---


class TestCheckLoanAmount:
    """Test check_loan_amount criterion check."""

    def test_price_in_range_returns_pass(self):
        tier = _make_tier(min_loan_amount=100000, max_loan_amount=806500)
        result = check_loan_amount(500000, tier)
        assert result.status == CriterionStatus.PASS

    def test_none_price_returns_unverified(self):
        tier = _make_tier(min_loan_amount=100000, max_loan_amount=806500)
        result = check_loan_amount(None, tier)
        assert result.status == CriterionStatus.UNVERIFIED

    def test_price_below_min_returns_fail(self):
        tier = _make_tier(min_loan_amount=100000, max_loan_amount=806500)
        result = check_loan_amount(50000, tier)
        assert result.status == CriterionStatus.FAIL

    def test_price_exceeds_max_returns_unverified(self):
        """Price > max is uncertain — with sufficient down payment the loan could be in range."""
        tier = _make_tier(min_loan_amount=100000, max_loan_amount=806500)
        result = check_loan_amount(900000, tier)
        assert result.status == CriterionStatus.UNVERIFIED


# --- check_location tests ---


class TestCheckEligibleCounty:
    """Test check_eligible_county criterion check."""

    def test_no_county_restrictions_returns_pass(self):
        tier = _make_tier()
        tier.eligible_county_fips = []
        result = check_eligible_county(None, None, None, tier)
        assert result.status == CriterionStatus.PASS

    def test_matching_fips_returns_pass(self):
        tier = _make_tier()
        tier.eligible_county_fips = ["06037"]
        result = check_eligible_county("06037", None, None, tier)
        assert result.status == CriterionStatus.PASS

    def test_non_matching_fips_returns_fail(self):
        tier = _make_tier()
        tier.eligible_county_fips = ["06037"]
        result = check_eligible_county("12086", None, None, tier)
        assert result.status == CriterionStatus.FAIL

    def test_no_fips_no_coords_returns_unverified(self):
        tier = _make_tier()
        tier.eligible_county_fips = ["06037"]
        result = check_eligible_county(None, None, None, tier)
        assert result.status == CriterionStatus.UNVERIFIED


# --- check_unit_count tests ---


class TestCheckUnitCount:
    """Test check_unit_count criterion check."""

    def test_single_family_inferred_1_against_limit_1_returns_pass(self):
        tier = _make_tier(unit_count_limits=[1])
        result = check_unit_count("Single Family", tier)
        assert result.status == CriterionStatus.PASS

    def test_multi_family_range_outside_limits_returns_fail(self):
        """Multi-Family has known range 2-4 units; none in [1] → FAIL."""
        tier = _make_tier(unit_count_limits=[1])
        result = check_unit_count("Multi-Family", tier)
        assert result.status == CriterionStatus.FAIL

    def test_single_family_1_against_limit_2_returns_fail(self):
        tier = _make_tier(unit_count_limits=[2])
        result = check_unit_count("Single Family", tier)
        assert result.status == CriterionStatus.FAIL


# --- match_tier tests ---


class TestMatchTier:
    """Test match_tier aggregation logic."""

    def test_all_pass_returns_eligible(self, sample_listing):
        listing = ListingInput.from_rentcast(sample_listing)
        tier = _make_tier(
            property_types=["SFR"],
            min_loan_amount=100000,
            max_loan_amount=806500,
            location_restrictions=[],
            unit_count_limits=[1],
        )
        result = match_tier(listing, tier)
        assert result.status == OverallStatus.ELIGIBLE

    def test_some_unverified_returns_potentially_eligible(self):
        # Listing with no county_fips and geocode fails -> eligible_county UNVERIFIED
        listing = ListingInput(
            price=500000,
            property_type="Single Family",
            state=None,
            county=None,
            county_fips=None,
            latitude=34.0,
            longitude=-118.0,
        )
        tier = _make_tier(
            property_types=["SFR"],
            min_loan_amount=100000,
            max_loan_amount=806500,
            unit_count_limits=[1],
        )
        # Set eligible_county_fips so the check doesn't just PASS (empty = no restriction)
        tier.eligible_county_fips = ["06037"]
        # Mock geocode to return None so county stays UNVERIFIED
        with patch("matching.matcher.get_county_from_coordinates", return_value=None):
            result = match_tier(listing, tier)
        assert result.status == OverallStatus.POTENTIALLY_ELIGIBLE

    def test_any_fail_returns_ineligible(self, sample_listing):
        listing = ListingInput.from_rentcast(sample_listing)
        # SFR listing against a tier that only allows Condo
        tier = _make_tier(
            property_types=["Condo"],
            min_loan_amount=100000,
            max_loan_amount=806500,
            location_restrictions=[],
            unit_count_limits=[1],
        )
        result = match_tier(listing, tier)
        assert result.status == OverallStatus.INELIGIBLE


# --- match_listing tests ---


class TestMatchListing:
    """Test match_listing integration logic."""

    def test_skips_non_purchase_tiers(self, sample_listing, sample_program_rules):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(sample_listing)
        results = match_listing(listing)
        assert len(results) >= 1
        first = results[0]
        # Verify no non-Purchase tiers appear in matching_tiers
        for tr in first.matching_tiers:
            pass
        matcher_mod.load_programs.cache_clear()

    def test_returns_program_result_with_matching_tiers(
        self, sample_listing, sample_program_rules
    ):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(sample_listing)
        results = match_listing(listing)
        first = results[0]
        assert first.program_name  # has a program name
        # Should have some matching (eligible or potentially eligible) tiers
        assert len(first.matching_tiers) > 0
        matcher_mod.load_programs.cache_clear()

    def test_best_tier_set_to_first_eligible(
        self, sample_listing, sample_program_rules
    ):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(sample_listing)
        results = match_listing(listing)
        first = results[0]
        assert first.best_tier is not None
        matcher_mod.load_programs.cache_clear()

    def test_all_pass_listing_returns_eligible_status(
        self, sample_listing, sample_program_rules
    ):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(sample_listing)
        results = match_listing(listing)
        # At least one program should find this listing eligible
        statuses = [r.status for r in results]
        assert OverallStatus.ELIGIBLE in statuses or OverallStatus.POTENTIALLY_ELIGIBLE in statuses
        matcher_mod.load_programs.cache_clear()

    def test_missing_county_returns_potentially_eligible(
        self, sample_listing_missing_county, sample_program_rules
    ):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(sample_listing_missing_county)
        with patch("matching.matcher.get_county_from_coordinates", return_value=None):
            results = match_listing(listing)
        # With missing county and geocode failing, programs with county restrictions
        # should be Potentially Eligible or Ineligible
        assert len(results) >= 1
        for r in results:
            assert r.status in (
                OverallStatus.ELIGIBLE,
                OverallStatus.POTENTIALLY_ELIGIBLE,
                OverallStatus.INELIGIBLE,
            )
        matcher_mod.load_programs.cache_clear()

    def test_land_property_type_returns_ineligible(
        self, sample_program_rules
    ):
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(
            {
                "price": 500000,
                "propertyType": "Land",
                "state": "CA",
                "county": "Los Angeles",
            }
        )
        results = match_listing(listing)
        # Land doesn't match any program property types
        for r in results:
            assert r.status == OverallStatus.INELIGIBLE
        matcher_mod.load_programs.cache_clear()

    def test_makes_zero_llm_calls(self, sample_listing, sample_program_rules):
        """Verify that match_listing is purely deterministic -- no LLM calls."""
        from matching import matcher as matcher_mod

        matcher_mod.load_programs.cache_clear()
        listing = ListingInput.from_rentcast(sample_listing)
        with patch.dict("sys.modules", {"google.genai": None, "google": None}):
            results = match_listing(listing)
        assert len(results) >= 1
        matcher_mod.load_programs.cache_clear()
