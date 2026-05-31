#!/usr/bin/env bash
# Build the index and deploy the self-contained RAG backend to Fly.io.
#
# Prereqs (one-time):
#   - flyctl installed + logged in (https://fly.io/docs/flyctl/install/)
#   - app created:           fly apps create just-laws-rag   (or edit fly.toml)
#   - LLM key set as secret:  fly secrets set LLM_API_KEY=sk-...
#   - lock CORS to the site:  fly secrets set CORS_ALLOW_ORIGINS=https://www.justlaws.cn
#
# Each deploy:
#   cd rag-poc && ./scripts/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# 1) (Re)build the baked-in index from the current docs/ corpus.
./scripts/build_index.sh

# 2) Ship it. The Dockerfile bakes .chroma/ + data/chunks.jsonl into the image.
echo "[deploy] fly deploy…"
fly deploy "$@"

echo "[deploy] done. Check: fly status  &&  curl https://<app>.fly.dev/health"
