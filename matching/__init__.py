"""GMCC matching engine package.

Core deterministic matching of property listings against program eligibility rules.
"""

from matching.matcher import load_programs, match_listing
from matching.models import (
    CriterionResult,
    CriterionStatus,
    ListingInput,
    MatchResponse,
    OverallStatus,
    ProgramResult,
    TierResult,
)

__all__ = [
    "load_programs",
    "match_listing",
    "CriterionResult",
    "CriterionStatus",
    "ListingInput",
    "MatchResponse",
    "OverallStatus",
    "ProgramResult",
    "TierResult",
]
