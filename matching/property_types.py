"""Static lookup tables for mapping RentCast property types to program terms."""

# Source: RentCast API docs (developers.rentcast.io/reference/property-types)
# mapped to program terms from thunder.json tier data
RENTCAST_TO_PROGRAM: dict[str, str] = {
    "Single Family": "SFR",
    "Condo": "Condo",
    "Townhouse": "SFR",  # Townhouses treated as SFR in most programs
    "Multi-Family": "2-4 Units",
    "Manufactured": "Manufactured",  # May not match any current program
    "Apartment": "2-4 Units",  # 5+ units typically not eligible
    "Land": "Land",  # Likely no matching programs
}

# Unit count inference from RentCast property type
PROPERTY_TYPE_UNITS: dict[str, int | None] = {
    "Single Family": 1,
    "Condo": 1,
    "Townhouse": 1,
    "Multi-Family": None,  # Unknown — RentCast covers duplex through 50+ units
    "Manufactured": 1,
    "Apartment": None,  # Unknown
    "Land": None,  # N/A
}

# For types where exact unit count is unknown but the range is bounded.
#
# NOTE: Multi-Family was previously listed here as [2, 3, 4]. That was wrong —
# RentCast's "Multi-Family" classification covers everything from a duplex up
# to 50+ unit apartment buildings. The old range made check_unit_count pass
# (2, 3, and 4 are all within typical CRA 1-4 unit limits), which silently
# marked 5+ unit buildings as "Eligible" for programs they legally cannot
# qualify for. We now fall through to the UNVERIFIED branch, which the
# matcher surfaces as "Potentially Eligible" with a note instructing the
# caller (UI or agent) to verify the actual unit count via another source
# (Redfin, Zillow, the listing itself) before acting on the result.
PROPERTY_TYPE_UNIT_RANGES: dict[str, list[int]] = {}
