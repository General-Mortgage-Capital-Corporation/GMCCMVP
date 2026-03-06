"""Core deterministic matching engine for GMCC program eligibility.

No LLM calls -- all matching is pure rule comparison with three-value logic.
"""

import json
import os
from functools import lru_cache

from rag.config import PROGRAMS_DIR
from rag.schemas import EligibilityTier, ProgramRules

from matching.geocode import get_county_from_coordinates
from matching.models import (
    CriterionResult,
    CriterionStatus,
    OverallStatus,
    ProgramResult,
    TierResult,
    ListingInput,
)
from matching.property_types import PROPERTY_TYPE_UNITS, RENTCAST_TO_PROGRAM


@lru_cache(maxsize=1)
def load_programs() -> tuple[ProgramRules, ...]:
    """Load all program rule JSONs from data/programs/. Cached after first call.

    Returns a tuple (hashable for lru_cache) of ProgramRules.
    """
    programs = []
    for filename in sorted(os.listdir(PROGRAMS_DIR)):
        if filename.endswith(".json"):
            with open(os.path.join(PROGRAMS_DIR, filename)) as f:
                data = json.load(f)
            programs.append(ProgramRules.model_validate(data))
    return tuple(programs)


def check_property_type(
    listing_type: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing property type matches tier's allowed property types.

    None or unmapped type -> UNVERIFIED. Mapped value in tier.property_types -> PASS.
    Otherwise FAIL.
    """
    if listing_type is None:
        return CriterionResult(
            criterion="property_type",
            status=CriterionStatus.UNVERIFIED,
            detail="Property type not available in listing data",
        )

    mapped = RENTCAST_TO_PROGRAM.get(listing_type)
    if mapped is None:
        return CriterionResult(
            criterion="property_type",
            status=CriterionStatus.UNVERIFIED,
            detail=f"Property type '{listing_type}' has no mapping to program terms",
        )

    if mapped in tier.property_types:
        return CriterionResult(
            criterion="property_type",
            status=CriterionStatus.PASS,
            detail=f"{listing_type} matches {mapped}",
        )

    return CriterionResult(
        criterion="property_type",
        status=CriterionStatus.FAIL,
        detail=f"{listing_type} ({mapped}) not in {tier.property_types}",
    )


def check_loan_amount(
    price: float | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing price is compatible with tier's loan amount range.

    Price is the upper bound for loan amount (buyer makes a down payment).
    - None price -> UNVERIFIED
    - price < min_loan_amount -> FAIL (impossible to reach min loan with this price)
    - Otherwise -> PASS (with down payment, loan could be within tier range)
    """
    if price is None:
        return CriterionResult(
            criterion="loan_amount",
            status=CriterionStatus.UNVERIFIED,
            detail="Listing price not available",
        )

    # If price is below the tier's minimum loan amount, it's impossible
    # for the loan to reach that minimum (price is the ceiling for loan amount)
    if tier.min_loan_amount is not None and price < tier.min_loan_amount:
        return CriterionResult(
            criterion="loan_amount",
            status=CriterionStatus.FAIL,
            detail=(
                f"Price ${price:,.0f} is below minimum loan amount "
                f"${tier.min_loan_amount:,.0f}"
            ),
        )

    # Price >= min means a loan in range is possible.
    # Price > max is OK because with down payment the loan can be <= max.
    if tier.max_loan_amount is not None and tier.min_loan_amount is not None:
        detail = (
            f"Price ${price:,.0f} allows loan in range "
            f"${tier.min_loan_amount:,.0f}-${tier.max_loan_amount:,.0f}"
        )
    elif tier.max_loan_amount is not None:
        detail = (
            f"Price ${price:,.0f} allows loan up to "
            f"${tier.max_loan_amount:,.0f}"
        )
    else:
        detail = f"Price ${price:,.0f} -- no loan amount constraints on this tier"

    return CriterionResult(
        criterion="loan_amount",
        status=CriterionStatus.PASS,
        detail=detail,
    )


def check_location(
    county: str | None,
    state: str | None,
    lat: float | None,
    lon: float | None,
    tier: EligibilityTier,
) -> CriterionResult:
    """Check if listing location satisfies tier's location restrictions.

    Empty location_restrictions -> PASS (no restrictions = any location).
    If county/state available, check against restrictions.
    If no location data and no lat/lon -> UNVERIFIED.
    If lat/lon available but no county, use FCC geocode fallback.
    """
    # No restrictions means any location is fine
    if not tier.location_restrictions:
        return CriterionResult(
            criterion="location",
            status=CriterionStatus.PASS,
            detail="No location restrictions for this tier",
        )

    # Try to resolve county if missing but lat/lon available
    resolved_county = county
    resolved_state = state
    if not county and lat is not None and lon is not None:
        geo_result = get_county_from_coordinates(lat, lon)
        if geo_result:
            resolved_county = geo_result.get("county_name")
            resolved_state = resolved_state or geo_result.get("state_code")

    # If still no location data -> UNVERIFIED
    if not resolved_county and not resolved_state:
        return CriterionResult(
            criterion="location",
            status=CriterionStatus.UNVERIFIED,
            detail="No location data available to check restrictions",
        )

    # Check against restrictions (substring match for county, exact for state)
    for restriction in tier.location_restrictions:
        restriction_lower = restriction.lower().strip()
        # Check state code match
        if resolved_state and resolved_state.lower().strip() == restriction_lower:
            return CriterionResult(
                criterion="location",
                status=CriterionStatus.PASS,
                detail=f"State {resolved_state} matches restriction '{restriction}'",
            )
        # Check county name substring match
        if resolved_county and restriction_lower in resolved_county.lower():
            return CriterionResult(
                criterion="location",
                status=CriterionStatus.PASS,
                detail=(
                    f"County '{resolved_county}' matches "
                    f"restriction '{restriction}'"
                ),
            )
        # Check if county name is in the restriction text
        if resolved_county and resolved_county.lower() in restriction_lower:
            return CriterionResult(
                criterion="location",
                status=CriterionStatus.PASS,
                detail=(
                    f"County '{resolved_county}' matches "
                    f"restriction '{restriction}'"
                ),
            )

    # Location data available but doesn't match any restriction
    location_desc = f"{resolved_county or ''}, {resolved_state or ''}".strip(", ")
    return CriterionResult(
        criterion="location",
        status=CriterionStatus.FAIL,
        detail=(
            f"Location '{location_desc}' does not match "
            f"restrictions {tier.location_restrictions}"
        ),
    )


def check_unit_count(
    listing_type: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing's inferred unit count matches tier's unit_count_limits.

    Empty unit_count_limits -> PASS (no restriction).
    Infer units from PROPERTY_TYPE_UNITS. None inference -> UNVERIFIED.
    Inferred units in limits -> PASS. Otherwise FAIL.
    """
    if not tier.unit_count_limits:
        return CriterionResult(
            criterion="unit_count",
            status=CriterionStatus.PASS,
            detail="No unit count restrictions for this tier",
        )

    if listing_type is None:
        return CriterionResult(
            criterion="unit_count",
            status=CriterionStatus.UNVERIFIED,
            detail="Property type not available to infer unit count",
        )

    inferred_units = PROPERTY_TYPE_UNITS.get(listing_type)
    if inferred_units is None:
        return CriterionResult(
            criterion="unit_count",
            status=CriterionStatus.UNVERIFIED,
            detail=(
                f"Cannot determine unit count from property type '{listing_type}'"
            ),
        )

    if inferred_units in tier.unit_count_limits:
        return CriterionResult(
            criterion="unit_count",
            status=CriterionStatus.PASS,
            detail=(
                f"{listing_type} has {inferred_units} unit(s), "
                f"within limits {tier.unit_count_limits}"
            ),
        )

    return CriterionResult(
        criterion="unit_count",
        status=CriterionStatus.FAIL,
        detail=(
            f"{listing_type} has {inferred_units} unit(s), "
            f"not in limits {tier.unit_count_limits}"
        ),
    )


def match_tier(listing: ListingInput, tier: EligibilityTier) -> TierResult:
    """Match a listing against a single tier, checking all criteria.

    Returns TierResult with: any FAIL -> INELIGIBLE, any UNVERIFIED (no FAIL) ->
    POTENTIALLY_ELIGIBLE, all PASS -> ELIGIBLE.
    """
    criteria = [
        check_property_type(listing.property_type, tier),
        check_loan_amount(listing.price, tier),
        check_location(listing.county, listing.state, listing.latitude, listing.longitude, tier),
        check_unit_count(listing.property_type, tier),
    ]

    statuses = [c.status for c in criteria]
    if CriterionStatus.FAIL in statuses:
        status = OverallStatus.INELIGIBLE
    elif CriterionStatus.UNVERIFIED in statuses:
        status = OverallStatus.POTENTIALLY_ELIGIBLE
    else:
        status = OverallStatus.ELIGIBLE

    return TierResult(tier_name=tier.tier_name, status=status, criteria=criteria)


def match_listing(listing: ListingInput) -> list[ProgramResult]:
    """Match a listing against all loaded GMCC programs.

    - Loads all programs via load_programs()
    - Filters tiers to Purchase-only (locked decision: all active listings are purchases)
    - Skips occupancy filtering (locked decision: show all occupancy tiers)
    - Returns one ProgramResult per program
    """
    programs = load_programs()
    results = []

    for program in programs:
        # Filter to Purchase tiers only
        purchase_tiers = [
            tier
            for tier in program.tiers
            if "Purchase" in tier.transaction_types
        ]

        # Match listing against each purchase tier
        tier_results = [match_tier(listing, tier) for tier in purchase_tiers]

        # Collect non-ineligible tiers
        matching_tiers = [
            tr for tr in tier_results if tr.status != OverallStatus.INELIGIBLE
        ]

        # Determine program-level status
        if not matching_tiers:
            program_status = OverallStatus.INELIGIBLE
            best_tier = None
        else:
            # Check if any tier is fully eligible
            eligible_tiers = [
                tr for tr in matching_tiers if tr.status == OverallStatus.ELIGIBLE
            ]
            if eligible_tiers:
                program_status = OverallStatus.ELIGIBLE
                best_tier = eligible_tiers[0].tier_name
            else:
                program_status = OverallStatus.POTENTIALLY_ELIGIBLE
                best_tier = matching_tiers[0].tier_name

        results.append(
            ProgramResult(
                program_name=program.program_name,
                status=program_status,
                matching_tiers=matching_tiers,
                best_tier=best_tier,
            )
        )

    return results
