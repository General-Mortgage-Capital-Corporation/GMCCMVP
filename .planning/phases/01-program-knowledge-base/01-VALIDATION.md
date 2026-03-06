---
phase: 1
slug: program-knowledge-base
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-06
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest >=8.0 |
| **Config file** | none — Wave 0 installs |
| **Quick run command** | `python -m pytest tests/ -x -q` |
| **Full suite command** | `python -m pytest tests/ -v` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `python -m pytest tests/ -x -q`
- **After every plan wave:** Run `python -m pytest tests/ -v`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 0 | KB-01 | unit | `python -m pytest tests/test_schemas.py -x` | No — W0 | ⬜ pending |
| 01-01-02 | 01 | 0 | KB-02 | unit | `python -m pytest tests/test_vectorstore.py -x` | No — W0 | ⬜ pending |
| 01-01-03 | 01 | 0 | KB-03 | integration | `python -m pytest tests/test_ingestion.py -x` | No — W0 | ⬜ pending |
| 01-02-01 | 02 | 1 | KB-01 | integration | `python -m pytest tests/test_extraction.py -x` | No — W0 | ⬜ pending |
| 01-02-02 | 02 | 1 | KB-02 | integration | `python -m pytest tests/test_vectorstore.py -x` | No — W0 | ⬜ pending |
| 01-02-03 | 02 | 1 | KB-03 | integration | `python -m pytest tests/test_ingestion.py::test_reingestion -x` | No — W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `pytest>=8.0` — install test framework
- [ ] `pyproject.toml [tool.pytest.ini_options]` — pytest configuration
- [ ] `tests/__init__.py` — test package init
- [ ] `tests/conftest.py` — shared fixtures (sample PDF path, temp directories, mock Gemini client)
- [ ] `tests/test_schemas.py` — Pydantic model validation tests
- [ ] `tests/test_extraction.py` — PDF-to-Markdown extraction tests
- [ ] `tests/test_vectorstore.py` — ChromaDB storage and query tests
- [ ] `tests/test_ingestion.py` — end-to-end ingestion pipeline tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| LLM extraction accuracy against source PDF | KB-01 | Requires human judgement to verify extracted values match PDF content | Compare data/programs/*.json output against source PDF tables |
| QM/Non-QM classification correctness | KB-01 | May require domain knowledge to verify | Check qm_status field in output JSON against known program classifications |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
