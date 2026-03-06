# Phase 2: Deferred Items

## Pre-existing Test Failure

- **File:** `tests/test_vectorstore.py::TestGeminiEmbeddingIntegration::test_real_embedding_returns_floats`
- **Issue:** Test asserts `isinstance(result[0], list)` but Gemini embedding API now returns numpy array instead of list
- **Impact:** Low -- integration test only, not a correctness issue
- **Discovered during:** 02-01 plan execution (full suite run)
- **Out of scope:** Pre-existing issue from Phase 1, not caused by matching engine changes
