"""Static ACS demographics lookup (data/tract_minority.json).

The live Census ACS API rejects keyless calls (mid-2026), so demographics
now come from a bundled extract. These tests pin the lookup contract and
the fast path's newly-populated MMCT fields.
"""

from matching.census import _static_demographics, get_census_data_fast


def test_static_demographics_known_tract():
    # East San Jose tract, verified against ACS 2019-2023 B03002.
    demo = _static_demographics("06085503601")
    assert demo is not None
    assert demo["total_population"] == 3609
    assert demo["white_nh_population"] == 656
    assert demo["black_population"] == 66
    assert demo["asian_population"] == 735
    assert demo["hispanic_population"] == 2130


def test_static_demographics_unknown_tract():
    assert _static_demographics("99999999999") is None


def test_fast_path_populates_mmct_fields():
    result = get_census_data_fast("CA", "Santa Clara", "503601")
    assert result is not None
    assert result["tract_minority_pct"] == 81.8
    assert result["majority_aa_hp"] is True
    assert result["tract_population"] == 3609
    assert result["minority_population"] == 2953
    # FFIEC income data still rides along
    assert result["tract_income_level"] == "Low"


def test_fast_path_unknown_tract_leaves_minority_none():
    result = get_census_data_fast("CA", "Santa Clara", "999999")
    assert result is not None
    assert result["tract_minority_pct"] is None
    assert "majority_aa_hp" not in result
