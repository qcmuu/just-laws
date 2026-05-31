#!/usr/bin/env bash
# Build the self-contained vector index for the Docker image.
#
# Parses docs/ -> chunks -> local BGE embeddings -> a file-based Chroma index
# under rag-poc/.chroma, and writes rag-poc/data/chunks.jsonl (the corpus copy
# used by the BM25 sparse retriever). Both are baked into the Docker image, so
# this MUST be run before `docker build` / `fly deploy`.
#
# Re-run whenever the law corpus (docs/) changes so the index stays in sync.
#
# Usage:
#   cd rag-poc && ./scripts/build_index.sh
set -euo pipefail

cd "$(dirname "$0")/.."

export VECTOR_BACKEND=chroma
export EMBEDDING_BACKEND="${EMBEDDING_BACKEND:-local}"

echo "[build_index] building Chroma index + corpus (VECTOR_BACKEND=chroma)…"
python ingest.py "$@"

test -d .chroma && test -f data/chunks.jsonl \
  && echo "[build_index] OK: .chroma/ and data/chunks.jsonl ready." \
  || { echo "[build_index] ERROR: index/corpus not produced." >&2; exit 1; }
