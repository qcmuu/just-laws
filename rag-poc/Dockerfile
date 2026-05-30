FROM python:3.12-slim

# HF cache lives inside the image so the embedding model is baked in (fast cold start).
ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/.hf_cache \
    VECTOR_BACKEND=chroma \
    EMBEDDING_BACKEND=local \
    EMBEDDING_LOCAL_MODEL=BAAI/bge-small-zh-v1.5 \
    RERANK_BACKEND=local \
    RERANK_MODEL=BAAI/bge-reranker-base

WORKDIR /app

# Copy the app code + pyproject + the pre-built Chroma index (.chroma/) baked at build time.
COPY . .

# Install the app and its dependencies.
RUN pip install .

# Pre-download the local embedding + reranker models at build time so the first
# request is fast (no cold-start download).
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${EMBEDDING_LOCAL_MODEL}')"
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('${RERANK_MODEL}')"

# Build the vector index at image build time if it was not baked in (fallback).
# The repo's docs/ corpus is not present in this build context, so this only runs
# when a .chroma index is missing AND a docs/ dir happens to be available.
RUN test -d /app/.chroma || (test -d /app/docs && python ingest.py) || true

EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
