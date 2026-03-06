"""Tests for Pydantic schemas: EligibilityTier and ProgramRules."""

import pytest
from pydantic import ValidationError

from rag.schemas import EligibilityTier, ProgramRules
from rag.config import GUIDELINES_DIR, PROGRAMS_DIR, CHROMA_DIR


# --- EligibilityTier tests ---


class TestEligibilityTier:
    """Tests for the EligibilityTier Pydantic model."""

    def test_valid_tier_all_fields(self):
        """EligibilityTier validates with all required fields provided."""
        tier = EligibilityTier(
            tier_name="Conforming",
            transaction_types=["Purchase", "Rate/Term Refi"],
            property_types=["SFR", "Condo"],
            occupancy_types=["Primary Residence"],
            max_loan_amount=726200.0,
            min_loan_amount=100000.0,
            max_ltv=95.0,
            max_cltv=95.0,
            min_fico=620,
            min_reserves_months=2,
            max_dti=45.0,
        )
        assert tier.tier_name == "Conforming"
        assert tier.max_loan_amount == 726200.0
        assert tier.min_fico == 620
        assert "Purchase" in tier.transaction_types
        assert "SFR" in tier.property_types

    def test_optional_numeric_fields_accept_none(self):
        """EligibilityTier accepts None for optional numeric fields."""
        tier = EligibilityTier(
            tier_name="Jumbo A",
            transaction_types=["Purchase"],
            property_types=["SFR"],
            occupancy_types=["Primary Residence"],
            max_loan_amount=None,
            min_loan_amount=None,
            max_ltv=None,
            max_cltv=None,
            min_fico=None,
            min_reserves_months=None,
            max_dti=None,
        )
        assert tier.max_loan_amount is None
        assert tier.min_fico is None
        assert tier.max_ltv is None

    def test_rejects_invalid_types(self):
        """EligibilityTier rejects invalid types (string where float expected)."""
        with pytest.raises(ValidationError):
            EligibilityTier(
                tier_name="Bad Tier",
                transaction_types=["Purchase"],
                property_types=["SFR"],
                occupancy_types=["Primary Residence"],
                max_loan_amount="not a number",  # should be float
                min_loan_amount=None,
                max_ltv=None,
                max_cltv=None,
                min_fico=None,
            )

    def test_default_list_fields(self):
        """EligibilityTier default list fields are empty lists."""
        tier = EligibilityTier(
            tier_name="Simple",
            transaction_types=["Purchase"],
            property_types=["SFR"],
            occupancy_types=["Primary Residence"],
        )
        assert tier.location_restrictions == []
        assert tier.unit_count_limits == []
        assert tier.additional_rules == {}


# --- ProgramRules tests ---


class TestProgramRules:
    """Tests for the ProgramRules Pydantic model."""

    def test_requires_program_name_qm_status_tiers(self):
        """ProgramRules requires program_name, qm_status, and tiers list."""
        rules = ProgramRules(
            program_name="Thunder",
            qm_status="QM",
            tiers=[
                EligibilityTier(
                    tier_name="Conforming",
                    transaction_types=["Purchase"],
                    property_types=["SFR"],
                    occupancy_types=["Primary Residence"],
                )
            ],
        )
        assert rules.program_name == "Thunder"
        assert rules.qm_status == "QM"
        assert len(rules.tiers) == 1

    def test_qm_status_values(self):
        """ProgramRules.qm_status accepts QM, Non-QM, and Both."""
        for status in ["QM", "Non-QM", "Both"]:
            rules = ProgramRules(
                program_name="Test",
                qm_status=status,
                tiers=[],
            )
            assert rules.qm_status == status

    def test_empty_tiers_is_valid(self):
        """ProgramRules with empty tiers list is valid."""
        rules = ProgramRules(
            program_name="Empty Program",
            qm_status="QM",
            tiers=[],
        )
        assert rules.tiers == []

    def test_serialization_roundtrip(self):
        """ProgramRules serializes to JSON and deserializes back identically."""
        tier = EligibilityTier(
            tier_name="Conforming",
            transaction_types=["Purchase", "Rate/Term Refi"],
            property_types=["SFR", "Condo", "PUD"],
            occupancy_types=["Primary Residence", "Second Home"],
            max_loan_amount=726200.0,
            min_loan_amount=100000.0,
            max_ltv=95.0,
            max_cltv=95.0,
            min_fico=620,
            min_reserves_months=2,
            max_dti=45.0,
            location_restrictions=["CA", "TX"],
            unit_count_limits=[1, 2, 3, 4],
            additional_rules={"escrow_waiver": False},
        )
        original = ProgramRules(
            program_name="Thunder",
            qm_status="QM",
            tiers=[tier],
            general_notes=["No manufactured homes"],
        )

        # Serialize then deserialize
        dumped = original.model_dump()
        restored = ProgramRules.model_validate(dumped)

        assert restored.program_name == original.program_name
        assert restored.qm_status == original.qm_status
        assert len(restored.tiers) == len(original.tiers)
        assert restored.tiers[0].tier_name == original.tiers[0].tier_name
        assert restored.tiers[0].max_loan_amount == original.tiers[0].max_loan_amount
        assert restored.tiers[0].location_restrictions == original.tiers[0].location_restrictions
        assert restored.general_notes == original.general_notes

    def test_missing_required_fields_rejected(self):
        """ProgramRules rejects missing required fields."""
        with pytest.raises(ValidationError):
            ProgramRules(program_name="Test")  # missing qm_status and tiers

    def test_default_general_notes(self):
        """ProgramRules default general_notes is empty list."""
        rules = ProgramRules(
            program_name="Test",
            qm_status="QM",
            tiers=[],
        )
        assert rules.general_notes == []


# --- Config tests ---


class TestConfig:
    """Tests for rag/config.py path constants."""

    def test_guidelines_dir(self):
        assert GUIDELINES_DIR == "data/guidelines"

    def test_programs_dir(self):
        assert PROGRAMS_DIR == "data/programs"

    def test_chroma_dir(self):
        assert CHROMA_DIR == "data/chroma"
