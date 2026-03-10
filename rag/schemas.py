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
    eligible_county_fips: list[str] = Field(
        default_factory=list,
        description="Allowed 5-digit county FIPS codes, e.g., ['06085', '06001']. Empty = no restriction.",
    )
    requires_lmi_tract: bool = Field(
        default=False,
        description="If True, property must be in a FFIEC-designated low-to-moderate income census tract.",
    )
    eligible_msa_codes: list[str] = Field(
        default_factory=list,
        description="Allowed MSA/MD codes, e.g., ['31084', '36084']. Empty = no restriction.",
    )
    requires_dmmct: bool = Field(
        default=False,
        description="If True, property must be in a Designated Majority-Minority Census Tract (Black+Hispanic > 50% of tract population).",
    )
    requires_mmct_or_lmi: bool = Field(
        default=False,
        description="If True, property must be in a Majority-Minority Census Tract (total minority > 50%) OR an LMI tract.",
    )
    eligible_tract_fips_file: str | None = Field(
        default=None,
        description="Filename (in data/) of a JSON array of eligible 11-digit census tract FIPS codes. Used for tract-level eligibility programs like Diamond CLP.",
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
