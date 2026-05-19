"""Day-1 PropertyRadar spike: validate API and measure field coverage.

Runs the "rate-and-term refi candidates" preset against several test zips.
By default this is PREVIEW ONLY (free) -- pass --fetch to actually charge
records, with --limit controlling how many rows per zip you pull.

Usage:
    # Free: just show how many properties match in each test zip.
    python3 scripts/pr_spike.py

    # Paid: also pull 3 sample rows per zip (~9 records, ~0.1% of monthly quota).
    python3 scripts/pr_spike.py --fetch --limit 3

    # Paid: change which fieldset comes back.
    python3 scripts/pr_spike.py --fetch --limit 3 --fields LimitedREI

Test zips (one per market type):
    95014  Cupertino, CA           -- standard disclosure state, tech metro
    77002  Houston, TX             -- non-disclosure state, urban
    33139  Miami Beach, FL         -- standard, condo-heavy
"""

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

# Make repo root importable when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv

load_dotenv()

from matching.propertyradar import (  # noqa: E402
    FIELDSET_LIMITED_REI,
    PropertyRadarError,
    QuotaCapExceeded,
    fetch_search,
    preview_search,
)

TEST_ZIPS = [
    (95014, "Cupertino, CA"),
    (77002, "Houston, TX"),
    (33139, "Miami Beach, FL"),
]

# "Rate-and-term refi candidates" preset.
# Targets the 2023-01 to 2024-06 high-rate vintage on owner-occupied SFR/CND
# with estimated fixed rate >= 6.5% and at least $50k available equity.
def refi_criteria_for_zip(zip5: int) -> list[dict]:
    return [
        {"name": "ZipFive", "value": [zip5]},
        {"name": "PropertyType", "value": [{"name": "PType", "value": ["SFR", "CND"]}]},
        {"name": "isSameMailingOrExempt", "value": [1]},
        {"name": "FirstPurpose", "value": ["PMoney", "R&TRefi", "CashOut"]},
        {"name": "FirstRateType", "value": ["F"]},      # Fixed only
        {"name": "FirstDate", "value": ["from: 1/1/2023 to: 6/30/2024"]},
        {"name": "FirstRate", "value": [[6.5, None]]},
        {"name": "AvailableEquity", "value": [[50000, None]]},
    ]


# Columns the v1 UI needs to populate. We'll score how often each is present.
TARGET_COLUMNS = [
    "RadarID", "Address", "City", "State", "ZipFive",
    "Owner", "OwnerFirstName", "OwnerLastName", "isSameMailingOrExempt",
    "PType", "Beds", "Baths", "SqFt", "YearBuilt",
    "AVM", "AvailableEquity", "EquityPercent", "CLTV", "TotalLoanBalance", "NumberLoans",
    "FirstDate", "FirstAmount", "FirstAmountLTV", "FirstPurpose", "FirstLoanType",
    "FirstRateType", "FirstRate", "FirstTermInYears", "FirstLenderOriginal",
    "SecondAmount", "SecondLenderOriginal",
    "LastTransferRecDate", "LastTransferValue",
    "CensusTract", "FIPS", "Latitude", "Longitude",
]


def banner(s: str) -> None:
    line = "=" * 72
    print(f"\n{line}\n{s}\n{line}")


def summarise_preview(zip5: int, label: str) -> dict:
    print(f"\n[preview] {zip5} {label} ...")
    try:
        data = preview_search(refi_criteria_for_zip(zip5))
    except PropertyRadarError as exc:
        print(f"  ERROR: {exc}")
        return {"zip": zip5, "label": label, "error": str(exc)}
    total = data.get("totalResultCount")
    remaining = data.get("quantityFreeRemaining")
    print(f"  totalResultCount      : {total}")
    print(f"  quantityFreeRemaining : {remaining}")
    print(f"  totalCost             : {data.get('totalCost')}")
    return {"zip": zip5, "label": label, "totalResultCount": total,
            "quantityFreeRemaining": remaining}


def fetch_and_score(zip5: int, label: str, limit: int, fields: str) -> dict:
    print(f"\n[fetch ] {zip5} {label} -- limit={limit} fields={fields}")
    try:
        data = fetch_search(refi_criteria_for_zip(zip5), fields=fields, limit=limit)
    except QuotaCapExceeded as exc:
        print(f"  CAPPED: {exc}")
        return {"zip": zip5, "label": label, "error": "daily_cap"}
    except PropertyRadarError as exc:
        print(f"  ERROR: {exc}")
        return {"zip": zip5, "label": label, "error": str(exc)}

    rows = data.get("results", [])
    total = data.get("totalResultCount")
    print(f"  returned {len(rows)} rows (of {total} matching)")

    # Per-row field presence
    coverage: Counter = Counter()
    for row in rows:
        for col in TARGET_COLUMNS:
            v = row.get(col)
            if v is None or v == "" or v == [] or v == {}:
                continue
            coverage[col] += 1

    return {
        "zip": zip5,
        "label": label,
        "rows_returned": len(rows),
        "rows_available": total,
        "coverage": dict(coverage),
        "sample_row": rows[0] if rows else None,
    }


def print_coverage_table(per_zip: list[dict], limit: int) -> None:
    banner("FIELD COVERAGE REPORT")
    print(f"Counts are rows-with-value / total rows fetched ({limit}/zip)\n")
    header = f"{'field':<24} " + " ".join(f"{r['zip']:>6}" for r in per_zip if "coverage" in r)
    print(header)
    print("-" * len(header))
    aggregate: Counter = Counter()
    total_rows = 0
    for r in per_zip:
        if "coverage" in r:
            total_rows += r.get("rows_returned", 0)
            for k, v in r["coverage"].items():
                aggregate[k] += v
    for col in TARGET_COLUMNS:
        row = f"{col:<24} "
        for r in per_zip:
            if "coverage" not in r:
                continue
            n = r["coverage"].get(col, 0)
            row += f"{n:>2}/{r['rows_returned']:<3} "
        row += f"  agg {aggregate[col]:>2}/{total_rows}"
        print(row)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fetch", action="store_true",
                    help="actually charge records (default: preview-only, free)")
    ap.add_argument("--limit", type=int, default=3,
                    help="rows per zip when --fetch (default 3)")
    ap.add_argument("--fields", default=FIELDSET_LIMITED_REI,
                    help=f"fieldset name (default {FIELDSET_LIMITED_REI})")
    ap.add_argument("--out", default="data/pr_spike_results.json",
                    help="write per-zip + sample-row JSON here")
    args = ap.parse_args()

    if not os.getenv("PROPERTY_RADAR_API_ACCESS_TOKEN"):
        print("PROPERTY_RADAR_API_ACCESS_TOKEN not set in env", file=sys.stderr)
        return 2

    banner("STEP 1 -- PREVIEW (free) across test zips")
    previews = [summarise_preview(z, l) for z, l in TEST_ZIPS]

    out_payload: dict = {"previews": previews}

    if args.fetch:
        if args.limit <= 0:
            print("--limit must be > 0 when --fetch", file=sys.stderr)
            return 2
        total_records = args.limit * len(TEST_ZIPS)
        banner(f"STEP 2 -- FETCH (paid) -- {total_records} records total")
        fetched = [fetch_and_score(z, l, args.limit, args.fields) for z, l in TEST_ZIPS]
        out_payload["fetched"] = fetched
        print_coverage_table(fetched, args.limit)
    else:
        print("\n(skipping fetch -- pass --fetch --limit N to pull sample rows)")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out_payload, indent=2, default=str))
    print(f"\nwrote {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
