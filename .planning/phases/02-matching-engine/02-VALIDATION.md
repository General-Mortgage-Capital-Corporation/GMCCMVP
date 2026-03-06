---
phase: 02
slug: matching-engine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 02 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 9.0.2 |
| **Config file** | pyproject.toml (markers section exists) |
| **Quick run command** | `pytest tests/test_matching.py -x -q` |
| **Full suite command** | `pytest tests/ -x -q` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pytest tests/test_matching.py -x -q`
- **After every plan wave:** Run `pytest tests/ -x -q`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | MATCH-01 | unit | `pytest tests/test_matching.py::test_match_returns_all_programs -x` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | MATCH-01 | unit | `pytest tests/test_matching.py::test_property_type_mapping -x` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | MATCH-02 | unit | `pytest tests/test_matching.py::test_per_criterion_breakdown -x` | ❌ W0 | ⬜ pending |
| 02-01-04 | 01 | 1 | MATCH-02 | unit | `pytest tests/test_matching.py::test_criterion_status_values -x` | ❌ W0 | ⬜ pending |
| 02-01-05 | 01 | 1 | MATCH-03 | unit | `pytest tests/test_matching.py::test_missing_county_unverified -x` | ❌ W0 | ⬜ pending |
| 02-01-06 | 01 | 1 | MATCH-03 | unit | `pytest tests/test_matching.py::test_missing_property_type_unverified -x` | ❌ W0 | ⬜ pending |
| 02-01-07 | 01 | 1 | MATCH-03 | unit | `pytest tests/test_matching.py::test_potentially_eligible_status -x` | ❌ W0 | ⬜ pending |
| 02-01-08 | 01 | 1 | MATCH-04 | unit | `pytest tests/test_matching.py::test_no_llm_calls_in_matching -x` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 2 | MATCH-04 | unit | `pytest tests/test_matching.py::test_explain_calls_gemini -x` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 2 | MATCH-01 | integration | `pytest tests/test_api_match.py::test_match_endpoint -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/test_matching.py` — stubs for MATCH-01 through MATCH-04 unit tests
- [ ] `tests/test_api_match.py` — stubs for /api/match and /api/explain endpoint integration tests
- [ ] `tests/conftest.py` — add fixtures for sample listing data and program rules (extend existing)

*Framework install: Already installed (pytest 9.0.2)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| LLM explanation quality | MATCH-04 | Subjective text quality | Review 3 generated explanations for accuracy and usefulness |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
