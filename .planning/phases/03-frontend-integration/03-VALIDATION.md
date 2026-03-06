---
phase: 03
slug: frontend-integration
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-06
---

# Phase 03 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 9.0.2 (backend only -- no JS test framework) |
| **Config file** | pyproject.toml |
| **Quick run command** | `pytest tests/test_api_match.py -x -q` |
| **Full suite command** | `pytest tests/ -x -q` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Manual browser test (search, observe badges, open modal, test filter)
- **After every plan wave:** Full manual walkthrough of all 4 requirements + `pytest tests/ -x -q`
- **Before `/gsd:verify-work`:** All 4 UI requirements visually confirmed in browser
- **Max feedback latency:** 30 seconds (manual browser test)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | UI-01 | manual | Browser: search -> check badges on cards | N/A | pending |
| 03-01-02 | 01 | 1 | UI-04 | manual | Browser: observe skeleton badge -> resolved badge | N/A | pending |
| 03-01-03 | 01 | 1 | UI-01 | manual | Browser: verify badge count matches eligible_count | N/A | pending |
| 03-02-01 | 02 | 2 | UI-02 | manual | Browser: click card -> check Matching Programs section | N/A | pending |
| 03-02-02 | 02 | 2 | UI-02 | manual | Browser: expand program -> check criteria grid | N/A | pending |
| 03-02-03 | 02 | 2 | UI-02 | manual | Browser: click Get Talking Points -> verify explanation loads | N/A | pending |
| 03-02-04 | 02 | 2 | UI-03 | manual | Browser: use program filter dropdown -> cards filter correctly | N/A | pending |
| 03-02-05 | 02 | 2 | UI-04 | manual | Browser: open modal before match loads -> shows loading state | N/A | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No new test files needed -- this phase is pure frontend (vanilla JS/CSS/HTML) with no JS test framework. Backend endpoints are already tested in `tests/test_api_match.py`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Badge shows on property cards | UI-01 | Vanilla JS DOM rendering, no JS test framework | Search for "90210", verify green badge "N Programs" appears on cards |
| Modal shows Matching Programs | UI-02 | DOM rendering + expand/collapse interaction | Click any card, verify Matching Programs section with expandable program cards |
| Get Talking Points works | UI-02 | LLM API call + DOM insertion | Expand a program, click "Get Talking Points", verify explanation text appears |
| Program filter works | UI-03 | Client-side DOM filtering | Use dropdown to select a program, verify cards filter and summary updates |
| Loading states render | UI-04 | Async timing observation | Search and immediately observe skeleton badges; open card before match loads |

---

## Validation Sign-Off

- [x] All tasks have manual verify instructions
- [x] Sampling continuity: manual browser test after each task
- [x] Wave 0 covers all requirements (no automated tests needed -- frontend-only)
- [x] No watch-mode flags
- [x] Feedback latency < 30s (manual browser test)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-03-06
