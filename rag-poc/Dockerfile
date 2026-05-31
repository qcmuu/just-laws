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

# Copy the app code + pyproject + the pre-built Chroma index (.chroma/) and the
# corpus copy (data/chunks.jsonl) baked at build time. Both are produced by
# running `VECTOR_BACKEND=chroma python ingest.py` in this directory first
# (see scripts/build_index.sh). The image is fully self-contained: no DB, no
# corpus download at runtime.
COPY . .

# Install the app and its dependencies.
RUN pip install .

# Fail fast at build time if the index/corpus were not pre-built. The repo's
# docs/ corpus is NOT part of this build context, so the image cannot build the
# index itself — it must be baked in. A missing index would otherwise only
# surface as a runtime error on the first query.
#   - .chroma/            : dense vector index (Chroma)
#   - data/chunks.jsonl   : corpus copy used by the BM25 sparse retriever
RUN test -d /app/.chroma && test -f /app/data/chunks.jsonl || ( \
      echo "ERROR: prebuilt index missing. Run 'VECTOR_BACKEND=chroma python ingest.py'" \
           "(or scripts/build_index.sh) in rag-poc/ before 'docker build'." >&2; \
      exit 1 )

# Pre-download the local embedding + reranker models at build time so the first
# request is fast (no cold-start download).
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${EMBEDDING_LOCAL_MODEL}')"
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('${RERANK_MODEL}')"

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os,urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/health',timeout=4); sys.exit(0)" || exit 1
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
