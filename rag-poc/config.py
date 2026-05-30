"""Configuration for the Just Laws RAG PoC.

Everything is driven by environment variables so that the LLM and embedding
providers can be swapped without code changes (custom base_url + custom model).

LLM (generation) -- any OpenAI-compatible endpoint:
    LLM_BASE_URL   e.g. https://token.sensenova.cn/v1
    LLM_MODEL      e.g. sensenova-6.7-flash-lite
    LLM_API_KEY    your key

Embedding -- two backends:
    EMBEDDING_BACKEND = "local" (default) | "api"
    local:  uses a local sentence-transformers model (no API key needed)
        EMBEDDING_LOCAL_MODEL  default BAAI/bge-small-zh-v1.5
    api:    OpenAI-compatible embeddings endpoint
        EMBEDDING_BASE_URL
        EMBEDDING_MODEL
        EMBEDDING_API_KEY
"""

import os

# --- paths ---
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
DOCS_DIR = os.path.join(REPO_ROOT, "docs")
CHUNKS_JSONL = os.path.join(HERE, "data", "chunks.jsonl")
COLLECTION_NAME = "just-laws"

# Public site base for citation deep-links
SITE_BASE_URL = os.environ.get("SITE_BASE_URL", "https://www.justlaws.cn")

# --- LLM (generation) ---
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://token.sensenova.cn/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "sensenova-6.7-flash-lite")
# Fall back to SENSENOVA_API_KEY for convenience.
LLM_API_KEY = os.environ.get("LLM_API_KEY") or os.environ.get("SENSENOVA_API_KEY", "")

# --- Embedding ---
EMBEDDING_BACKEND = os.environ.get("EMBEDDING_BACKEND", "local").lower()
EMBEDDING_LOCAL_MODEL = os.environ.get("EMBEDDING_LOCAL_MODEL", "BAAI/bge-small-zh-v1.5")
EMBEDDING_BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "")
EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "")
# Vector dimension of the embedding model. Must match the model in use.
# BAAI/bge-small-zh-v1.5 -> 512. Override when switching embedding models.
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "512"))

# --- vector store (PostgreSQL + pgvector) ---
# Connection is fully env-driven. Defaults match rag-poc/docker-compose.yml.
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://justlaws:justlaws@localhost:5433/justlaws"
)
PG_TABLE = os.environ.get("PG_TABLE", "law_chunks")
# Index type for the vector column: "ivfflat" (default) or "hnsw".
PG_INDEX_TYPE = os.environ.get("PG_INDEX_TYPE", "ivfflat").lower()
# Number of lists for the ivfflat index (rule of thumb: rows / 1000).
PG_IVFFLAT_LISTS = int(os.environ.get("PG_IVFFLAT_LISTS", "100"))

# --- retrieval ---
TOP_K = int(os.environ.get("TOP_K", "8"))

# --- backend / CORS ---
# Comma-separated list of allowed origins for the chat API. "*" allows all
# (handy for local dev + the static site calling from any host).
CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "*")
