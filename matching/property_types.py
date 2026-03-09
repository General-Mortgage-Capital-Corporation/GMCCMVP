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
    "Multi-Family": None,  # Range: 2-4, checked via PROPERTY_TYPE_UNIT_RANGES
    "Manufactured": 1,
    "Apartment": None,  # Unknown
    "Land": None,  # N/A
}

# For types where exact unit count is unknown but the range is bounded
PROPERTY_TYPE_UNIT_RANGES: dict[str, list[int]] = {
    "Multi-Family": [2, 3, 4],
}
