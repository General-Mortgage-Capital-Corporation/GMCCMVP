"""Centralized configuration for the RAG pipeline."""

import os

from dotenv import load_dotenv

load_dotenv()

# Directory paths
GUIDELINES_DIR = "data/guidelines"
PROGRAMS_DIR = "data/programs"
CHROMA_DIR = "data/chroma"

# Gemini configuration
GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Embedding configuration
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768

# ChromaDB configuration
CHROMA_COLLECTION_NAME = "program_guidelines"
