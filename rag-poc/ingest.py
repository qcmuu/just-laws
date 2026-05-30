"""Build the vector index: parse markdown -> chunks -> embed -> pgvector.

Also writes data/chunks.jsonl as an auditable copy of the corpus (the markdown
repo stays the single source of truth; the vector store is a derived artifact).

Re-runnable; rebuilds the table from scratch by default.

Usage:
    python ingest.py                 # full corpus (~13k chunks)
    python ingest.py --limit 500     # ingest a subset (fast smoke test)
"""

import os
import json
import time
import argparse

import config
import db
from chunker import iter_chunks
import embeddings

BATCH = 128


def main():
    parser = argparse.ArgumentParser(description="Ingest law chunks into pgvector.")
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Only ingest the first N chunks (for a quick smoke test).",
    )
    parser.add_argument(
        "--no-recreate", action="store_true",
        help="Upsert into the existing table instead of dropping it first.",
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(config.CHUNKS_JSONL), exist_ok=True)
    chunks = list(iter_chunks())
    if args.limit:
        chunks = chunks[: args.limit]
    print(f"[ingest] parsed {len(chunks)} article chunks")

    # Always keep an auditable copy of the corpus alongside the vector store.
    with open(config.CHUNKS_JSONL, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"[ingest] wrote corpus copy -> {config.CHUNKS_JSONL}")

    conn = db.connect()
    db.init_schema(conn, recreate=not args.no_recreate)
    print(f"[ingest] schema ready (table={config.PG_TABLE}, dim={config.EMBEDDING_DIM})")

    t0 = time.time()
    for i in range(0, len(chunks), BATCH):
        batch = chunks[i : i + BATCH]
        vecs = embeddings.embed([c["text"] for c in batch])
        db.upsert_chunks(conn, batch, vecs)
        done = min(i + BATCH, len(chunks))
        if done % (BATCH * 10) == 0 or done == len(chunks):
            rate = done / (time.time() - t0)
            print(f"[ingest] embedded {done}/{len(chunks)}  ({rate:.0f}/s)")

    total = db.count(conn)
    conn.close()
    print(f"[ingest] done in {time.time() - t0:.1f}s; row count = {total}")


if __name__ == "__main__":
    main()
