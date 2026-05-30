"""Configuration for the Just Laws RAG system.

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

Vector store -- two backends (the dense retriever and ingest both honor this):
    VECTOR_BACKEND = "pgvector" (default, production) | "chroma" (self-contained)
    pgvector:  PostgreSQL + pgvector, connection via DATABASE_URL
    chroma:    local file-based Chroma index under CHROMA_DIR (no DB needed;
               used by the self-contained Docker demo)
"""

import os

# --- paths ---
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
DOCS_DIR = os.path.join(REPO_ROOT, "docs")
CHROMA_DIR = os.path.join(HERE, ".chroma")
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

# --- vector store ---
# Which dense vector backend to use for ingest + retrieval.
VECTOR_BACKEND = os.environ.get("VECTOR_BACKEND", "pgvector").lower()

# pgvector (PostgreSQL). Connection is fully env-driven; defaults match
# rag-poc/docker-compose.yml.
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

# Hybrid retrieval: dense (vector search) + sparse (BM25 over chunks).
# RETRIEVAL_MODE = "hybrid" (default) | "vector" (dense only, legacy PoC behaviour)
RETRIEVAL_MODE = os.environ.get("RETRIEVAL_MODE", "hybrid").lower()

# How many candidates each retriever (dense / sparse) contributes to fusion.
FUSION_CANDIDATES = int(os.environ.get("FUSION_CANDIDATES", "50"))

# Fusion method: "rrf" (Reciprocal Rank Fusion, default) | "weighted" (min-max
# normalised weighted sum of dense + sparse scores).
FUSION_METHOD = os.environ.get("FUSION_METHOD", "rrf").lower()
# RRF constant k. Larger -> ranks matter less, more uniform contribution.
RRF_K = int(os.environ.get("RRF_K", "60"))
# Weights used by both fusion methods (RRF weights each retriever's 1/(k+rank)).
DENSE_WEIGHT = float(os.environ.get("DENSE_WEIGHT", "1.0"))
SPARSE_WEIGHT = float(os.environ.get("SPARSE_WEIGHT", "1.0"))

# Optional on-disk cache of the tokenized BM25 corpus (pickle) for faster startup.
BM25_CACHE = os.path.join(HERE, ".bm25_cache.pkl")

# --- rerank (cross-encoder over fused candidates) ---
# RERANK_ENABLED = "true" (default) | "false" to disable the rerank stage.
RERANK_ENABLED = os.environ.get("RERANK_ENABLED", "true").lower() in ("1", "true", "yes")
# RERANK_BACKEND = "local" (default, sentence-transformers CrossEncoder, no key)
#                | "api" (OpenAI-style /rerank endpoint, e.g. Jina / SiliconFlow)
RERANK_BACKEND = os.environ.get("RERANK_BACKEND", "local").lower()
RERANK_MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-base")
# How many fused candidates are fed into the reranker before truncating to TOP_K.
RERANK_CANDIDATES = int(os.environ.get("RERANK_CANDIDATES", "30"))
# Only used when RERANK_BACKEND=api :
RERANK_BASE_URL = os.environ.get("RERANK_BASE_URL", "")
RERANK_API_KEY = os.environ.get("RERANK_API_KEY", "")

# --- backend / CORS ---
# Comma-separated list of allowed origins for the chat API. "*" allows all
# (handy for local dev + the static site calling from any host).
CORS_ALLOW_ORIGINS = os.environ.get("CORS_ALLOW_ORIGINS", "*")
