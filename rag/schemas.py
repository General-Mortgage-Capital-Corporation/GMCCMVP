"""Pydantic models for structured program rules extracted from guideline PDFs."""

from pydantic import BaseModel, Field


class EligibilityTier(BaseModel):
    """A single eligibility tier/matrix within a loan program.

    Each tier represents a distinct sub-type (e.g., Conforming, Jumbo A)
    with its own set of eligibility criteria.
    """

    tier_name: str = Field(
        description="Sub-type name, e.g., 'Conforming', 'Jumbo A'"
    )
    transaction_types: list[str] = Field(
        description="Eligible transaction types, e.g., ['Purchase', 'Rate/Term Refi', 'Cash-Out Refi']"
    )
    property_types: list[str] = Field(
        description="Eligible property types, e.g., ['SFR', 'Condo', 'PUD', '2-4 Units']"
    )
    occupancy_types: list[str] = Field(
        description="Eligible occupancy types, e.g., ['Primary Residence', 'Second Home', 'Investment']"
    )
    max_loan_amount: float | None = Field(
        default=None,
        description="Maximum loan amount in dollars",
    )
    min_loan_amount: float | None = Field(
        default=None,
        description="Minimum loan amount in dollars",
    )
    max_ltv: float | None = Field(
        default=None,
        description="Maximum LTV as percentage, e.g., 95.0",
    )
    max_cltv: float | None = Field(
        default=None,
        description="Maximum CLTV as percentage",
    )
    min_fico: int | None = Field(
        default=None,
        description="Minimum FICO score required",
    )
    min_reserves_months: int | None = Field(
        default=None,
        description="Minimum months of reserves required",
    )
    max_dti: float | None = Field(
        default=None,
        description="Maximum DTI ratio as percentage",
    )
    location_restrictions: list[str] = Field(
        default_factory=list,
        description="Any state or county restrictions",
    )
    unit_count_limits: list[int] = Field(
        default_factory=list,
        description="Allowed unit counts, e.g., [1, 2, 3, 4]",
    )
    additional_rules: dict = Field(
        default_factory=dict,
        description="Catch-all for other matchable criteria not covered by explicit fields",
    )


class ProgramRules(BaseModel):
    """Structured rules for a single GMCC loan program.

    Each program has a name (from folder name), QM status, and a list of
    eligibility tiers extracted from the guideline PDF.
    """

    program_name: str = Field(
        description="Program name from folder name, e.g., 'Thunder'"
    )
    qm_status: str = Field(
        description="QM classification: 'QM', 'Non-QM', or 'Both'"
    )
    tiers: list[EligibilityTier] = Field(
        description="List of eligibility tiers/matrices extracted from the guideline"
    )
    general_notes: list[str] = Field(
        default_factory=list,
        description="Program-wide notes not specific to any single tier",
    )
