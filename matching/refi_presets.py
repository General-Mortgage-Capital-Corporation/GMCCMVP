"""Refi Finder preset registry.

Each preset is a curated starting filter set for a real refi outreach
scenario. The UI shows these as cards on the Refi Finder landing screen;
picking one pre-fills the filter form with the preset's `base_filters`,
which the LO can then tweak inline before previewing/fetching.

A preset is intentionally NOT a hard-coded query. It's a starting point.
Every value in `base_filters` is editable from the UI. The UI also lets
the LO toggle off any filter the preset includes (e.g. drop the rate
threshold if the preset's 6.5% is too narrow for the local market).

Geography is always LO-supplied and lives outside the preset — every
preset requires the LO to enter at least one zip / city / county before
preview is allowed.

Field names in `base_filters` map to the canonical filter keys defined in
refi_search.FilterSpec (which the normalizer translates to PropertyRadar's
Criteria array shape).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any


# How far back to look for "high-rate vintage" loans (rate-and-term preset).
# Bounds the 2023-2024 rate-peak window most LOs are targeting today.
HIGH_RATE_VINTAGE_FROM = "2023-01-01"
HIGH_RATE_VINTAGE_TO = "2024-06-30"

# Rate threshold below which a refi is rarely worthwhile in the current
# environment. Adjust as market rates move.
HIGH_RATE_THRESHOLD = 6.5
FHA_HIGH_RATE_THRESHOLD = 5.5
VA_HIGH_RATE_THRESHOLD = 6.0
RECENT_PURCHASE_RATE_THRESHOLD = 6.75


def _months_ago_iso(n: int) -> str:
    return (date.today() - timedelta(days=n * 30)).isoformat()


def _years_ago_iso(n: int) -> str:
    return (date.today() - timedelta(days=n * 365)).isoformat()


@dataclass(frozen=True)
class Preset:
    id: str
    name: str
    tagline: str            # 1-line shown on the card
    why: str                # tooltip / detail card — explains targeting logic
    base_filters: dict[str, Any]
    # Filter keys the UI should surface as the headline tweakable controls
    # for this preset (rest live under an "all filters" toggle).
    primary_filter_keys: list[str] = field(default_factory=list)


PRESETS: list[Preset] = [
    Preset(
        id="rate_term_refi",
        name="Rate-and-term refi",
        tagline="High-rate vintage loans with refinanceable equity",
        why=(
            "Borrowers who closed during the 2023–mid-2024 rate peak at an "
            "estimated fixed rate of 6.5%+ on an owner-occupied home with "
            "at least $50k of equity. The highest-volume refi opportunity "
            "right now — these borrowers can typically save 50–100 bps by "
            "refinancing today."
        ),
        base_filters={
            "first_date_range": {"from": HIGH_RATE_VINTAGE_FROM, "to": HIGH_RATE_VINTAGE_TO},
            "first_rate_min": HIGH_RATE_THRESHOLD,
            "first_rate_type": ["F"],
            "first_purpose": ["PMoney", "R&TRefi", "CashOut"],
            "available_equity_min": 50_000,
            "owner_occupied": True,
            "property_types": ["SFR", "CND"],
        },
        primary_filter_keys=[
            "first_date_range", "first_rate_min", "available_equity_min",
            "property_types", "owner_occupied",
        ],
    ),
    Preset(
        id="cash_out",
        name="Cash-out candidates",
        tagline="Seasoned loans with high equity",
        why=(
            "Owner-occupied homes with 40%+ equity and a current loan that's "
            "at least 5 years old. These borrowers can tap accumulated "
            "equity for renovations, debt consolidation, or major purchases "
            "without losing their primary residence rate dramatically."
        ),
        base_filters={
            "equity_percent_min": 40,
            "first_date_to": _years_ago_iso(5),
            "available_equity_min": 100_000,
            "is_free_and_clear": False,
            "owner_occupied": True,
            "property_types": ["SFR", "CND"],
        },
        primary_filter_keys=[
            "equity_percent_min", "available_equity_min", "first_date_to",
            "property_types",
        ],
    ),
    Preset(
        id="fha_to_conv",
        name="FHA → Conventional",
        tagline="Drop MIP — borrowers with 22%+ equity on an FHA loan",
        why=(
            "FHA borrowers carry MIP for the life of the loan. Once equity "
            "reaches 22%, they can refi into a Conventional loan and "
            "eliminate MIP entirely — often a $150–$400/mo savings even "
            "if the rate drop is modest."
        ),
        base_filters={
            "first_loan_type": ["F"],  # FHA
            "equity_percent_min": 22,
            "first_rate_min": FHA_HIGH_RATE_THRESHOLD,
            "owner_occupied": True,
            "property_types": ["SFR", "CND"],
        },
        primary_filter_keys=[
            "equity_percent_min", "first_rate_min", "property_types",
        ],
    ),
    Preset(
        id="va_irrrl",
        name="VA IRRRL",
        tagline="VA loans from 2022+ at high rates",
        why=(
            "Veterans with a VA loan originated 2022 or later at 6%+ are "
            "prime IRRRL (Interest Rate Reduction Refi) candidates. IRRRL "
            "is a streamline product — no appraisal or income verification "
            "required, lowest-friction refi path on the market."
        ),
        base_filters={
            "first_loan_type": ["V"],  # VA
            "first_date_range": {"from": "2022-01-01", "to": date.today().isoformat()},
            "first_rate_min": VA_HIGH_RATE_THRESHOLD,
            "owner_occupied": True,
            "property_types": ["SFR", "CND"],
        },
        primary_filter_keys=[
            "first_date_range", "first_rate_min", "property_types",
        ],
    ),
    Preset(
        id="arm_reset",
        name="ARM about to reset",
        tagline="Adjustable rate loans nearing first reset",
        why=(
            "ARM borrowers whose first reset is within 12 months. After "
            "reset, their rate floats to index + margin — usually 6–8% in "
            "today's environment. Refi to a fixed-rate product locks in "
            "their savings before the shock hits."
        ),
        base_filters={
            "first_rate_type": ["A"],
            "first_arm_reset_within_months": 12,
            "available_equity_min": 25_000,
            "owner_occupied": True,
            "property_types": ["SFR", "CND"],
        },
        primary_filter_keys=[
            "first_arm_reset_within_months", "available_equity_min",
            "property_types",
        ],
    ),
    Preset(
        id="recent_purchase_remorse",
        name="Recent-purchase buyer's remorse",
        tagline="Bought 6–18 months ago at peak rates",
        why=(
            "Borrowers who purchased within the last 6–18 months at 6.75%+. "
            "Most are 'date the rate, marry the house' buyers waiting for "
            "the right moment to refi. Even a 50 bps drop is meaningful "
            "monthly savings on a fresh loan."
        ),
        base_filters={
            "last_transfer_date_from": _months_ago_iso(18),
            "last_transfer_date_to": _months_ago_iso(6),
            "first_purpose": ["PMoney"],
            "first_rate_min": RECENT_PURCHASE_RATE_THRESHOLD,
            "owner_occupied": True,
            "property_types": ["SFR", "CND"],
        },
        primary_filter_keys=[
            "last_transfer_date_from", "last_transfer_date_to",
            "first_rate_min", "property_types",
        ],
    ),
]


PRESET_BY_ID: dict[str, Preset] = {p.id: p for p in PRESETS}


def get_preset(preset_id: str) -> Preset | None:
    return PRESET_BY_ID.get(preset_id)


def list_presets_dict() -> list[dict]:
    """JSON-serialisable preset list for the UI."""
    return [
        {
            "id": p.id,
            "name": p.name,
            "tagline": p.tagline,
            "why": p.why,
            "base_filters": p.base_filters,
            "primary_filter_keys": p.primary_filter_keys,
        }
        for p in PRESETS
    ]
