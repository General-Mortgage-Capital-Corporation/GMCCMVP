"""Core deterministic matching engine for GMCC program eligibility.

No LLM calls -- all matching is pure rule comparison with three-value logic.
"""

import json
import os
from functools import lru_cache

from rag.config import PROGRAMS_DIR
from rag.schemas import EligibilityTier, ProgramRules

from matching.census import get_census_data, is_lmi_tract
from matching.geocode import get_county_from_coordinates
from matching.models import (
    CriterionResult,
    CriterionStatus,
    OverallStatus,
    ProgramResult,
    TierResult,
    ListingInput,
)
from matching.property_types import PROPERTY_TYPE_UNITS, PROPERTY_TYPE_UNIT_RANGES, RENTCAST_TO_PROGRAM

# Programs matched via JSON that appear only in the property modal under
# "Additional Program Matches" — hidden from card badges, chip filters, and
# best-match scoring.  Add new secondary program names here as they are
# formalised into data/programs/ JSON files.
SECONDARY_PROGRAM_NAMES: set[str] = {
    "GMCC Hermes",
    "GMCC Ocean",
    "GMCC Celebrity Jumbo",
    "GMCC Celebrity Forgivable $15K",
    "GMCC Community Opportunity",
    "GMCC Massive",
    "GMCC Universe",
    "GMCC Buy Without Sell First",
    "GMCC Radiant",
    "GMCC Bank Statement Self Employed",
    "GMCC WVOE P&L",
    "GMCC DSCR Rental Flow",
}

# Programs whose eligibility criteria are still pending formalisation.
# Append these as Potentially Eligible placeholders until a JSON file exists.
SECONDARY_PROGRAMS_PENDING: list[dict] = []


@lru_cache(maxsize=1)
def load_programs() -> tuple[ProgramRules, ...]:
    """Load all program rule JSONs from data/programs/. Cached after first call."""
    programs = []
    for filename in sorted(os.listdir(PROGRAMS_DIR)):
        if filename.endswith(".json"):
            with open(os.path.join(PROGRAMS_DIR, filename)) as f:
                data = json.load(f)
            programs.append(ProgramRules.model_validate(data))
    return tuple(programs)


@lru_cache(maxsize=8)
def _load_tract_set(filename: str) -> frozenset[str]:
    """Load a JSON array of 11-digit tract FIPS codes from data/. Cached."""
    # Sanitize: only allow plain filenames, no path traversal
    basename = os.path.basename(filename)
    if basename != filename or '..' in filename:
        raise ValueError(f"Invalid tract file name: {filename}")
    data_dir = os.path.dirname(PROGRAMS_DIR)  # data/ is parent of data/programs/
    path = os.path.join(data_dir, basename)
    with open(path) as f:
        return frozenset(json.load(f))


def check_property_type(
    listing_type: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing property type matches tier's allowed property types."""
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
            detail=f"{listing_type} maps to {mapped}",
        )

    return CriterionResult(
        criterion="property_type",
        status=CriterionStatus.FAIL,
        detail=f"{listing_type} ({mapped}) not in {tier.property_types}",
    )


def check_loan_amount(
    price: float | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing price is compatible with tier's loan amount range."""
    if price is None:
        return CriterionResult(
            criterion="loan_amount",
            status=CriterionStatus.UNVERIFIED,
            detail="Listing price not available",
        )

    if tier.min_loan_amount is not None and price < tier.min_loan_amount:
        return CriterionResult(
            criterion="loan_amount",
            status=CriterionStatus.FAIL,
            detail=(
                f"Price ${price:,.0f} is below minimum loan amount "
                f"${tier.min_loan_amount:,.0f}"
            ),
        )

    # For conforming-only programs: price above max could still work with
    # a larger down payment, so mark as UNVERIFIED rather than FAIL.
    if tier.max_loan_amount is not None and price > tier.max_loan_amount:
        return CriterionResult(
            criterion="loan_amount",
            status=CriterionStatus.UNVERIFIED,
            detail=(
                f"Price ${price:,.0f} exceeds conforming limit "
                f"${tier.max_loan_amount:,.0f} — may still qualify with sufficient down payment"
            ),
        )

    # For jumbo programs: price >= min doesn't guarantee loan >= min.
    # With 20% down, loan = price * 0.80. Only PASS if that still exceeds min.
    if tier.min_loan_amount is not None and price * 0.80 < tier.min_loan_amount:
        return CriterionResult(
            criterion="loan_amount",
            status=CriterionStatus.UNVERIFIED,
            detail=(
                f"Price ${price:,.0f} could be conforming or jumbo depending on down payment "
                f"(20% down = ${price * 0.80:,.0f} loan vs ${tier.min_loan_amount:,.0f} jumbo floor)"
            ),
        )

    if tier.min_loan_amount is not None:
        detail = f"Price ${price:,.0f} supports jumbo loan (even at 80% LTV, loan ${price * 0.80:,.0f} exceeds ${tier.min_loan_amount:,.0f} floor)"
    elif tier.max_loan_amount is not None:
        detail = f"Price ${price:,.0f} within conforming limit ${tier.max_loan_amount:,.0f}"
    else:
        detail = f"Price ${price:,.0f} — no loan amount constraints"

    return CriterionResult(
        criterion="loan_amount",
        status=CriterionStatus.PASS,
        detail=detail,
    )


def check_eligible_county(
    county_fips: str | None,
    lat: float | None,
    lon: float | None,
    tier: EligibilityTier,
) -> CriterionResult:
    """Check if listing county FIPS is in the tier's eligible county list."""
    if not tier.eligible_county_fips:
        return CriterionResult(
            criterion="eligible_county",
            status=CriterionStatus.PASS,
            detail="No county restrictions for this tier",
        )

    resolved_fips = county_fips
    if not resolved_fips and lat is not None and lon is not None:
        geo = get_county_from_coordinates(lat, lon)
        if geo:
            resolved_fips = geo.get("county_fips")

    if not resolved_fips:
        return CriterionResult(
            criterion="eligible_county",
            status=CriterionStatus.UNVERIFIED,
            detail="County FIPS not available to check eligibility",
        )

    resolved_fips = resolved_fips.strip().zfill(5)

    if resolved_fips in tier.eligible_county_fips:
        return CriterionResult(
            criterion="eligible_county",
            status=CriterionStatus.PASS,
            detail=f"County FIPS {resolved_fips} is in Cronus Assessment Area",
        )

    return CriterionResult(
        criterion="eligible_county",
        status=CriterionStatus.FAIL,
        detail=f"County FIPS {resolved_fips} is not in the eligible county list",
    )


def check_eligible_tract(
    tract_fips: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if the property's census tract is in the tier's eligible tract list."""
    if not tier.eligible_tract_fips_file:
        return CriterionResult(
            criterion="eligible_tract",
            status=CriterionStatus.PASS,
            detail="No census tract restrictions for this tier",
        )

    if not tract_fips:
        return CriterionResult(
            criterion="eligible_tract",
            status=CriterionStatus.UNVERIFIED,
            detail="Census tract FIPS not available to check eligibility",
        )

    tract_set = _load_tract_set(tier.eligible_tract_fips_file)
    if tract_fips in tract_set:
        return CriterionResult(
            criterion="eligible_tract",
            status=CriterionStatus.PASS,
            detail=f"Census tract {tract_fips} is in the eligible tract list",
        )

    return CriterionResult(
        criterion="eligible_tract",
        status=CriterionStatus.FAIL,
        detail=f"Census tract {tract_fips} is not in the eligible tract list",
    )


def check_lmi_tract(
    tract_income_level: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if census tract is LMI per FFIEC designation."""
    if not tier.requires_lmi_tract:
        return CriterionResult(
            criterion="lmi_census_tract",
            status=CriterionStatus.PASS,
            detail="LMI census tract not required for this tier",
        )

    if not tract_income_level:
        return CriterionResult(
            criterion="lmi_census_tract",
            status=CriterionStatus.UNVERIFIED,
            detail="Census tract income level unavailable — verify at geomap.ffiec.gov",
        )

    if is_lmi_tract(tract_income_level):
        return CriterionResult(
            criterion="lmi_census_tract",
            status=CriterionStatus.PASS,
            detail=f"Tract income level is '{tract_income_level}' (LMI) — CRA eligible",
        )

    return CriterionResult(
        criterion="lmi_census_tract",
        status=CriterionStatus.FAIL,
        detail=f"Tract income level is '{tract_income_level}' — not LMI (must be Low or Moderate)",
    )


def check_eligible_msa(
    msa_code: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing's MSA code is in the tier's eligible MSA list."""
    if not tier.eligible_msa_codes:
        return CriterionResult(
            criterion="eligible_msa",
            status=CriterionStatus.PASS,
            detail="No MSA restrictions for this tier",
        )

    if not msa_code:
        return CriterionResult(
            criterion="eligible_msa",
            status=CriterionStatus.UNVERIFIED,
            detail="MSA code not available to check eligibility",
        )

    if msa_code.strip() in tier.eligible_msa_codes:
        return CriterionResult(
            criterion="eligible_msa",
            status=CriterionStatus.PASS,
            detail=f"MSA {msa_code} is in the eligible MSA list",
        )

    return CriterionResult(
        criterion="eligible_msa",
        status=CriterionStatus.FAIL,
        detail=f"MSA {msa_code} is not in the eligible MSA list",
    )


def check_eligible_state(
    state: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing's state is in the tier's eligible state list."""
    if not tier.eligible_states:
        return CriterionResult(
            criterion="eligible_state",
            status=CriterionStatus.PASS,
            detail="No state restrictions for this tier",
        )

    if not state:
        return CriterionResult(
            criterion="eligible_state",
            status=CriterionStatus.UNVERIFIED,
            detail="State not available to check eligibility",
        )

    if state.upper().strip() in tier.eligible_states:
        return CriterionResult(
            criterion="eligible_state",
            status=CriterionStatus.PASS,
            detail=f"State {state} is in the eligible state list",
        )

    return CriterionResult(
        criterion="eligible_state",
        status=CriterionStatus.FAIL,
        detail=f"State {state} is not in the eligible state list ({', '.join(tier.eligible_states)})",
    )


def check_dmmct(
    majority_aa_hp: bool | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if census tract is a Designated Majority-Minority Census Tract.

    DMMCT = Black+Hispanic population > 50% of total tract population.
    """
    if not tier.requires_dmmct:
        return CriterionResult(
            criterion="dmmct",
            status=CriterionStatus.PASS,
            detail="DMMCT not required for this tier",
        )

    if majority_aa_hp is None:
        return CriterionResult(
            criterion="dmmct",
            status=CriterionStatus.UNVERIFIED,
            detail="Census demographics unavailable — cannot verify DMMCT status",
        )

    if majority_aa_hp:
        return CriterionResult(
            criterion="dmmct",
            status=CriterionStatus.PASS,
            detail="Tract is a Designated Majority-Minority Census Tract (Black+Hispanic > 50%)",
        )

    return CriterionResult(
        criterion="dmmct",
        status=CriterionStatus.FAIL,
        detail="Tract is not a DMMCT (Black+Hispanic ≤ 50% of tract population)",
    )


def check_mmct_or_lmi(
    tract_minority_pct: float | None,
    tract_income_level: str | None,
    tier: EligibilityTier,
) -> CriterionResult:
    """Check if tract is a Majority-Minority Census Tract OR LMI tract.

    MMCT = total minority population > 50% of tract (broader than DMMCT).
    LMI = Low or Moderate income tract per FFIEC.
    """
    if not tier.requires_mmct_or_lmi:
        return CriterionResult(
            criterion="mmct_or_lmi",
            status=CriterionStatus.PASS,
            detail="MMCT/LMI tract not required for this tier",
        )

    # Check LMI first
    if tract_income_level and is_lmi_tract(tract_income_level):
        return CriterionResult(
            criterion="mmct_or_lmi",
            status=CriterionStatus.PASS,
            detail=f"Tract is LMI (income level: {tract_income_level})",
        )

    # Check MMCT (minority % > 50)
    if tract_minority_pct is not None and tract_minority_pct > 50.0:
        return CriterionResult(
            criterion="mmct_or_lmi",
            status=CriterionStatus.PASS,
            detail=f"Tract is MMCT (minority {tract_minority_pct:.1f}% > 50%)",
        )

    if tract_minority_pct is not None and tract_income_level:
        return CriterionResult(
            criterion="mmct_or_lmi",
            status=CriterionStatus.FAIL,
            detail=f"Tract is not MMCT (minority {tract_minority_pct:.1f}%) and not LMI ({tract_income_level})",
        )

    return CriterionResult(
        criterion="mmct_or_lmi",
        status=CriterionStatus.UNVERIFIED,
        detail="Census demographics unavailable — cannot verify MMCT/LMI status",
    )


def check_unit_count(
    listing_type: str | None, tier: EligibilityTier
) -> CriterionResult:
    """Check if listing's inferred unit count matches tier's unit_count_limits."""
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
        # Check if a known range exists (e.g. Multi-Family = 2-4 units)
        unit_range = PROPERTY_TYPE_UNIT_RANGES.get(listing_type)
        if unit_range:
            if all(u in tier.unit_count_limits for u in unit_range):
                return CriterionResult(
                    criterion="unit_count",
                    status=CriterionStatus.PASS,
                    detail=f"{listing_type} ({unit_range[0]}-{unit_range[-1]} units), all within limits {tier.unit_count_limits}",
                )
            if any(u in tier.unit_count_limits for u in unit_range):
                return CriterionResult(
                    criterion="unit_count",
                    status=CriterionStatus.UNVERIFIED,
                    detail=f"{listing_type} ({unit_range[0]}-{unit_range[-1]} units), some within limits {tier.unit_count_limits}",
                )
            return CriterionResult(
                criterion="unit_count",
                status=CriterionStatus.FAIL,
                detail=f"{listing_type} ({unit_range[0]}-{unit_range[-1]} units), none within limits {tier.unit_count_limits}",
            )
        return CriterionResult(
            criterion="unit_count",
            status=CriterionStatus.UNVERIFIED,
            detail=f"Cannot determine unit count from property type '{listing_type}'",
        )

    if inferred_units in tier.unit_count_limits:
        return CriterionResult(
            criterion="unit_count",
            status=CriterionStatus.PASS,
            detail=f"{listing_type} has {inferred_units} unit(s), within limits {tier.unit_count_limits}",
        )

    return CriterionResult(
        criterion="unit_count",
        status=CriterionStatus.FAIL,
        detail=f"{listing_type} has {inferred_units} unit(s), not in limits {tier.unit_count_limits}",
    )


def match_tier(listing: ListingInput, tier: EligibilityTier) -> TierResult:
    """Match a listing against a single tier, checking all criteria."""
    criteria = [
        check_property_type(listing.property_type, tier),
        check_loan_amount(listing.price, tier),
        check_eligible_state(listing.state, tier),
        check_eligible_county(listing.county_fips, listing.latitude, listing.longitude, tier),
        check_eligible_msa(listing.census_msa_code, tier),
        check_eligible_tract(listing.census_tract_fips, tier),
        check_lmi_tract(listing.tract_income_level, tier),
        check_dmmct(listing.census_majority_aa_hp, tier),
        check_mmct_or_lmi(listing.census_tract_minority_pct, listing.tract_income_level, tier),
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


def quick_prescreen(listing_data: dict, program_names: list[str]) -> bool:
    """Quick pre-screen using only RentCast data. No Census API calls.

    Returns True if the listing could potentially match at least one tier
    of at least one selected program. Only checks property_type, price,
    county FIPS, and unit count — all available from RentCast directly.
    """
    programs = load_programs()
    selected = [p for p in programs if p.program_name in program_names]
    if not selected:
        return True

    property_type = listing_data.get("propertyType")
    price = listing_data.get("price")

    # Build county FIPS from RentCast data
    state_fips = (listing_data.get("stateFips") or "").strip()
    county_fips_raw = (listing_data.get("countyFips") or "").strip()
    if state_fips and county_fips_raw:
        county_fips = state_fips.zfill(2) + county_fips_raw.zfill(3)
    else:
        county_fips = None
        lat = listing_data.get("latitude")
        lng = listing_data.get("longitude")
        if lat and lng:
            geo = get_county_from_coordinates(lat, lng)
            if geo:
                county_fips = geo.get("county_fips")

    mapped_type = RENTCAST_TO_PROGRAM.get(property_type) if property_type else None
    inferred_units = PROPERTY_TYPE_UNITS.get(property_type) if property_type else None
    unit_range = PROPERTY_TYPE_UNIT_RANGES.get(property_type) if property_type else None

    for program in selected:
        purchase_tiers = [t for t in program.tiers if "Purchase" in t.transaction_types]
        for tier in purchase_tiers:
            if _tier_quick_passes(tier, mapped_type, price, county_fips, inferred_units, unit_range):
                return True

    return False


def _tier_quick_passes(tier, mapped_type, price, county_fips, inferred_units, unit_range) -> bool:
    """Return True if the listing doesn't definitively FAIL this tier."""
    # Property type
    if mapped_type is not None and tier.property_types:
        if mapped_type not in tier.property_types:
            return False

    # Price — only FAIL if below min (above max is UNVERIFIED, not FAIL)
    if price is not None and tier.min_loan_amount is not None:
        if price < tier.min_loan_amount:
            return False

    # County
    if county_fips and tier.eligible_county_fips:
        if county_fips.strip().zfill(5) not in tier.eligible_county_fips:
            return False

    # Unit count
    if tier.unit_count_limits:
        if inferred_units is not None:
            if inferred_units not in tier.unit_count_limits:
                return False
        elif unit_range is not None:
            if not any(u in tier.unit_count_limits for u in unit_range):
                return False

    return True


def match_listing(listing: ListingInput) -> list[ProgramResult]:
    """Match a listing against all loaded GMCC programs."""
    programs = load_programs()
    results = []

    for program in programs:
        purchase_tiers = [
            tier
            for tier in program.tiers
            if "Purchase" in tier.transaction_types
        ]

        tier_results = [match_tier(listing, tier) for tier in purchase_tiers]

        eligible_tiers = [
            tr for tr in tier_results if tr.status == OverallStatus.ELIGIBLE
        ]
        potential_tiers = [
            tr for tr in tier_results if tr.status == OverallStatus.POTENTIALLY_ELIGIBLE
        ]

        if eligible_tiers:
            program_status = OverallStatus.ELIGIBLE
            best_tier = eligible_tiers[0].tier_name
        elif potential_tiers:
            program_status = OverallStatus.POTENTIALLY_ELIGIBLE
            best_tier = potential_tiers[0].tier_name
        else:
            program_status = OverallStatus.INELIGIBLE
            best_tier = tier_results[0].tier_name if tier_results else None

        results.append(
            ProgramResult(
                program_name=program.program_name,
                status=program_status,
                matching_tiers=tier_results,  # include all tiers for UI detail
                best_tier=best_tier,
                is_secondary=program.program_name in SECONDARY_PROGRAM_NAMES,
            )
        )

    # Append secondary programs whose criteria haven't been formalised yet.
    pending_criterion = CriterionResult(
        criterion="eligibility_criteria",
        status=CriterionStatus.UNVERIFIED,
        detail="Eligibility criteria under review — contact GMCC for details",
    )
    pending_tier = TierResult(
        tier_name="Pending Criteria",
        status=OverallStatus.POTENTIALLY_ELIGIBLE,
        criteria=[pending_criterion],
    )
    for prog in SECONDARY_PROGRAMS_PENDING:
        results.append(
            ProgramResult(
                program_name=prog["name"],
                status=OverallStatus.POTENTIALLY_ELIGIBLE,
                matching_tiers=[pending_tier],
                best_tier="Pending Criteria",
                is_secondary=True,
            )
        )

    return results
