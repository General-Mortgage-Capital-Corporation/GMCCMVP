"""Tests for ChromaDB vector store operations.

Tests cover:
- GeminiEmbeddingFunction with mocked genai client
- store_chunks with in-memory ChromaDB (idempotent)
- query_program_info with program_name filtering
"""

from unittest.mock import MagicMock, patch

import chromadb
import pytest

from rag.vectorstore import (
    GeminiEmbeddingFunction,
    get_collection,
    query_program_info,
    store_chunks,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class FakeEmbeddingFunction(chromadb.EmbeddingFunction):
    """Deterministic embedding function for unit tests."""

    def __call__(self, input):
        """Return fixed-dimension vectors based on string hash."""
        dim = 10
        embeddings = []
        for doc in input:
            h = hash(doc) % 10000
            embeddings.append([(h + i) / 10000.0 for i in range(dim)])
        return embeddings


def _make_in_memory_collection():
    """Create an in-memory ChromaDB collection for testing."""
    client = chromadb.Client()
    return client.get_or_create_collection(
        name="test_collection",
        embedding_function=FakeEmbeddingFunction(),
    )


# ---------------------------------------------------------------------------
# GeminiEmbeddingFunction
# ---------------------------------------------------------------------------


class TestGeminiEmbeddingFunction:
    """Tests for the Gemini embedding wrapper."""

    @patch("rag.vectorstore.genai")
    def test_returns_list_of_float_lists(self, mock_genai):
        """__call__ should return a list of float lists (embeddings)."""
        # Set up mock embedding response
        mock_embedding_1 = MagicMock()
        mock_embedding_1.values = [0.1, 0.2, 0.3]
        mock_embedding_2 = MagicMock()
        mock_embedding_2.values = [0.4, 0.5, 0.6]

        mock_result = MagicMock()
        mock_result.embeddings = [mock_embedding_1, mock_embedding_2]

        mock_client = MagicMock()
        mock_client.models.embed_content.return_value = mock_result
        mock_genai.Client.return_value = mock_client

        fn = GeminiEmbeddingFunction(api_key="test-key")
        result = fn(["hello world", "foo bar"])

        assert len(result) == 2
        assert list(result[0]) == [0.1, 0.2, 0.3]
        assert list(result[1]) == [0.4, 0.5, 0.6]

    @patch("rag.vectorstore.genai")
    def test_uses_configured_model(self, mock_genai):
        """Should pass the configured model name to embed_content."""
        mock_embedding = MagicMock()
        mock_embedding.values = [0.1, 0.2, 0.3]
        mock_result = MagicMock()
        mock_result.embeddings = [mock_embedding]
        mock_client = MagicMock()
        mock_client.models.embed_content.return_value = mock_result
        mock_genai.Client.return_value = mock_client

        fn = GeminiEmbeddingFunction(api_key="test-key", model="custom-model")
        fn(["test doc"])

        call_kwargs = mock_client.models.embed_content.call_args
        assert call_kwargs.kwargs["model"] == "custom-model"


# ---------------------------------------------------------------------------
# store_chunks
# ---------------------------------------------------------------------------


class TestStoreChunks:
    """Tests for storing page chunks in ChromaDB."""

    def test_stores_pages_with_correct_ids(self):
        """Chunks should have IDs like '{program_name}_page_{i}'."""
        collection = _make_in_memory_collection()
        pages = [
            {"text": "Page 1 content about loan programs"},
            {"text": "Page 2 content about eligibility"},
        ]

        store_chunks("Thunder", pages, collection=collection)

        result = collection.get(ids=["Thunder_page_0", "Thunder_page_1"])
        assert len(result["ids"]) == 2

    def test_stores_program_name_metadata(self):
        """Each chunk should have program_name in metadata."""
        collection = _make_in_memory_collection()
        pages = [{"text": "Content about loan amounts"}]

        store_chunks("Thunder", pages, collection=collection)

        result = collection.get(ids=["Thunder_page_0"], include=["metadatas"])
        assert result["metadatas"][0]["program_name"] == "Thunder"

    def test_stores_page_number_metadata(self):
        """Each chunk should have page_number metadata (1-indexed)."""
        collection = _make_in_memory_collection()
        pages = [
            {"text": "First page"},
            {"text": "Second page"},
        ]

        store_chunks("Thunder", pages, collection=collection)

        result = collection.get(ids=["Thunder_page_1"], include=["metadatas"])
        assert result["metadatas"][0]["page_number"] == 2

    def test_idempotent_re_add(self):
        """Calling store_chunks twice with the same data should not duplicate."""
        collection = _make_in_memory_collection()
        pages = [
            {"text": "Page 1"},
            {"text": "Page 2"},
            {"text": "Page 3"},
        ]

        store_chunks("Thunder", pages, collection=collection)
        count_after_first = collection.count()

        store_chunks("Thunder", pages, collection=collection)
        count_after_second = collection.count()

        assert count_after_first == count_after_second == 3


# ---------------------------------------------------------------------------
# query_program_info
# ---------------------------------------------------------------------------


class TestQueryProgramInfo:
    """Tests for querying the vector store."""

    def test_returns_results(self):
        """Should return non-empty results when chunks exist."""
        collection = _make_in_memory_collection()
        pages = [
            {"text": "Thunder allows SFR, Condo, and PUD property types"},
            {"text": "Maximum LTV is 95% for conforming loans"},
        ]
        store_chunks("Thunder", pages, collection=collection)

        result = query_program_info(
            "property types", collection=collection
        )

        assert "documents" in result
        assert len(result["documents"][0]) > 0

    def test_filter_by_program_name(self):
        """With program_name filter, only that program's chunks are returned."""
        collection = _make_in_memory_collection()

        store_chunks(
            "Thunder",
            [{"text": "Thunder conforming loan rules"}],
            collection=collection,
        )
        store_chunks(
            "Bolt",
            [{"text": "Bolt non-QM loan rules"}],
            collection=collection,
        )

        result = query_program_info(
            "loan rules",
            program_name="Thunder",
            n_results=5,
            collection=collection,
        )

        # All returned chunks should belong to Thunder
        for meta in result["metadatas"][0]:
            assert meta["program_name"] == "Thunder"

    def test_n_results_respected(self):
        """Should return at most n_results chunks."""
        collection = _make_in_memory_collection()
        pages = [{"text": f"Page {i} content"} for i in range(10)]
        store_chunks("Thunder", pages, collection=collection)

        result = query_program_info(
            "content", n_results=3, collection=collection
        )

        assert len(result["documents"][0]) <= 3


# ---------------------------------------------------------------------------
# Integration tests (require GEMINI_API_KEY)
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestGeminiEmbeddingIntegration:
    """Integration tests that call the real Gemini API."""

    def test_real_embedding_returns_floats(self):
        """Real API call should return float embeddings."""
        fn = GeminiEmbeddingFunction()
        result = fn(["test document"])

        assert len(result) == 1
        assert isinstance(result[0], list)
        assert all(isinstance(v, float) for v in result[0])
