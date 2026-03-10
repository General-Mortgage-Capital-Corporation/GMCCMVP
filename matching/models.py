"""Pydantic models for the matching engine result types."""

from enum import Enum

from pydantic import BaseModel


class CriterionStatus(str, Enum):
    """Status of a single matching criterion check."""

    PASS = "pass"
    FAIL = "fail"
    UNVERIFIED = "unverified"


class OverallStatus(str, Enum):
    """Overall eligibility status for a tier or program."""

    ELIGIBLE = "Eligible"
    POTENTIALLY_ELIGIBLE = "Potentially Eligible"
    INELIGIBLE = "Ineligible"


class CriterionResult(BaseModel):
    """Result of checking a single eligibility criterion."""

    criterion: str
    status: CriterionStatus
    detail: str


class TierResult(BaseModel):
    """Result of matching a listing against a single program tier."""

    tier_name: str
    status: OverallStatus
    criteria: list[CriterionResult]


class ProgramResult(BaseModel):
    """Result of matching a listing against all tiers of a program."""

    program_name: str
    status: OverallStatus
    matching_tiers: list[TierResult]
    best_tier: str | None


class ListingInput(BaseModel):
    """Normalized input for the matching engine from a RentCast listing."""

    price: float | None = None
    property_type: str | None = None
    state: str | None = None
    county: str | None = None
    county_fips: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    bedrooms: int | None = None
    bathrooms: float | None = None
    square_footage: int | None = None
    # Census / FFIEC data (populated server-side before matching)
    tract_income_level: str | None = None
    census_msa_code: str | None = None
    census_majority_aa_hp: bool | None = None
    census_tract_minority_pct: float | None = None
    census_tract_fips: str | None = None  # 11-digit FIPS: state(2)+county(3)+tract(6)

    @classmethod
    def from_rentcast(cls, listing: dict, census_data: dict | None = None) -> "ListingInput":
        """Create from raw RentCast API response dict with optional FFIEC census data."""
        # RentCast splits FIPS: stateFips="06", countyFips="085"
        # Combine into 5-digit code for program matching (e.g. "06085")
        state_fips = (listing.get("stateFips") or "").strip()
        county_fips_raw = (listing.get("countyFips") or "").strip()
        if state_fips and county_fips_raw:
            combined_fips = state_fips.zfill(2) + county_fips_raw.zfill(3)
        else:
            combined_fips = None

        obj = cls(
            price=listing.get("price"),
            property_type=listing.get("propertyType"),
            state=listing.get("state"),
            county=listing.get("county"),
            county_fips=combined_fips,
            latitude=listing.get("latitude"),
            longitude=listing.get("longitude"),
            bedrooms=listing.get("bedrooms"),
            bathrooms=listing.get("bathrooms"),
            square_footage=listing.get("squareFootage"),
        )
        if census_data:
            obj.tract_income_level = census_data.get("tract_income_level")
            obj.census_msa_code = census_data.get("msa_code")
            obj.census_majority_aa_hp = census_data.get("majority_aa_hp")
            obj.census_tract_minority_pct = census_data.get("tract_minority_pct")
            # Build 11-digit tract FIPS: state(2) + county(3) + tract(6)
            state_c = (census_data.get("state_code") or "").strip()
            county_c = (census_data.get("county_code") or "").strip()
            tract_c = (census_data.get("tract_code") or "").strip()
            if state_c and county_c and tract_c:
                obj.census_tract_fips = state_c.zfill(2) + county_c.zfill(3) + tract_c
            # Use census FIPS if RentCast didn't provide it
            if not obj.county_fips and state_c and county_c:
                obj.county_fips = state_c.zfill(2) + county_c.zfill(3)
        return obj


class MatchResponse(BaseModel):
    """Top-level response from the matching engine."""

    programs: list[ProgramResult]
    eligible_count: int
