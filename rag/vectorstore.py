"""ChromaDB vector store operations for program guideline chunks.

Provides embedding, storage, and semantic query capabilities for
program guideline page chunks using ChromaDB with Gemini embeddings.
"""

import chromadb
from chromadb import Documents, EmbeddingFunction, Embeddings
from google import genai
from google.genai import types

from rag.config import (
    CHROMA_COLLECTION_NAME,
    CHROMA_DIR,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
)


class GeminiEmbeddingFunction(EmbeddingFunction[Documents]):
    """Custom ChromaDB embedding function wrapping Gemini embed_content."""

    def __init__(self, api_key: str | None = None, model: str = EMBEDDING_MODEL):
        """Initialize with optional API key and model name.

        Args:
            api_key: Gemini API key. If None, uses default credentials.
            model: Embedding model name. Defaults to EMBEDDING_MODEL from config.
        """
        if api_key:
            self._client = genai.Client(api_key=api_key)
        else:
            self._client = genai.Client()
        self._model = model

    def __call__(self, input: Documents) -> Embeddings:
        """Generate embeddings for a list of documents.

        Args:
            input: List of document strings to embed.

        Returns:
            List of float lists (one embedding per document).
        """
        result = self._client.models.embed_content(
            model=self._model,
            contents=input,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_DOCUMENT",
                output_dimensionality=EMBEDDING_DIMENSIONS,
            ),
        )
        return [e.values for e in result.embeddings]


def get_collection(chroma_dir: str = CHROMA_DIR) -> chromadb.Collection:
    """Get or create the program guidelines ChromaDB collection.

    Args:
        chroma_dir: Path to ChromaDB persistent storage directory.

    Returns:
        ChromaDB Collection configured with Gemini embeddings.
    """
    client = chromadb.PersistentClient(path=chroma_dir)
    return client.get_or_create_collection(
        name=CHROMA_COLLECTION_NAME,
        embedding_function=GeminiEmbeddingFunction(),
    )


def store_chunks(
    program_name: str,
    pages: list[dict],
    collection: chromadb.Collection | None = None,
) -> None:
    """Store page chunks in ChromaDB with program metadata.

    Idempotent: deletes any existing chunks for the program before adding.

    Args:
        program_name: Name of the program (used for metadata and ID prefix).
        pages: List of page dicts, each with a "text" key.
        collection: Optional ChromaDB collection. If None, uses get_collection().
    """
    if collection is None:
        collection = get_collection()

    # Delete existing chunks for this program (idempotent)
    existing = collection.get(where={"program_name": program_name})
    if existing["ids"]:
        collection.delete(ids=existing["ids"])

    # Add new chunks
    ids = [f"{program_name}_page_{i}" for i in range(len(pages))]
    documents = [p["text"] for p in pages]
    metadatas = [
        {"program_name": program_name, "page_number": i + 1}
        for i in range(len(pages))
    ]

    collection.add(ids=ids, documents=documents, metadatas=metadatas)


def query_program_info(
    query: str,
    program_name: str | None = None,
    n_results: int = 3,
    collection: chromadb.Collection | None = None,
) -> dict:
    """Query ChromaDB for relevant program guideline chunks.

    Args:
        query: Natural language query string.
        program_name: Optional filter to return only this program's chunks.
        n_results: Maximum number of results to return.
        collection: Optional ChromaDB collection. If None, uses get_collection().

    Returns:
        ChromaDB query result dict with documents, metadatas, distances, etc.
    """
    if collection is None:
        collection = get_collection()

    kwargs = {
        "query_texts": [query],
        "n_results": n_results,
    }

    if program_name:
        kwargs["where"] = {"program_name": program_name}

    return collection.query(**kwargs)
