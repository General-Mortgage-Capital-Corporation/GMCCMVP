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

    @classmethod
    def from_rentcast(cls, listing: dict) -> "ListingInput":
        """Create from raw RentCast API response dict."""
        return cls(
            price=listing.get("price"),
            property_type=listing.get("propertyType"),
            state=listing.get("state"),
            county=listing.get("county"),
            county_fips=listing.get("countyFips"),
            latitude=listing.get("latitude"),
            longitude=listing.get("longitude"),
            bedrooms=listing.get("bedrooms"),
            bathrooms=listing.get("bathrooms"),
            square_footage=listing.get("squareFootage"),
        )


class MatchResponse(BaseModel):
    """Top-level response from the matching engine."""

    programs: list[ProgramResult]
    eligible_count: int
