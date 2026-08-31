"""Build data/tract_minority.json from a Census ACS table-based summary file.

The site used to fetch tract demographics from the live ACS API, but the
Census Bureau began rejecting keyless API calls in mid-2026 (every request
302s to a "Missing Key" page), which silently blanked MMCT everywhere. This
extract removes the runtime dependency entirely.

Usage:
    1. Download table B03002 (Hispanic or Latino Origin by Race) from the
       ACS 5-year table-based summary file release, e.g.:
       https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b03002.dat
    2. python scripts/build_tract_minority.py /path/to/acsdt5y2024-b03002.dat

Output: data/tract_minority.json — {11-digit tract FIPS: [total, white_nh,
black_nh, asian_nh, hispanic]}. Consumed by matching/census.py.

When a new ACS vintage lands, re-run against the new .dat and commit the
regenerated JSON alongside the matching FFIEC tract_lookup.json refresh.
"""

import json
import os
import sys

COLUMNS = ("B03002_E001", "B03002_E003", "B03002_E004", "B03002_E006", "B03002_E012")
TRACT_PREFIX = "1400000US"  # summary level 140 = census tract


def main(src: str) -> None:
    out: dict[str, list[int]] = {}
    with open(src) as f:
        header = f.readline().rstrip("\n").split("|")
        idx = {name: i for i, name in enumerate(header)}
        cols = [idx[c] for c in COLUMNS]
        for line in f:
            if not line.startswith(TRACT_PREFIX):
                continue
            parts = line.rstrip("\n").split("|")
            try:
                vals = [int(parts[i]) for i in cols]
            except (ValueError, IndexError):
                continue
            if vals[0] <= 0:  # zero-population tracts carry no signal
                continue
            out[parts[0][len(TRACT_PREFIX):]] = vals

    dest = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "tract_minority.json")
    with open(dest, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {len(out)} tracts -> {dest} ({os.path.getsize(dest)} bytes)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
