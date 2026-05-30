"""Build the vector index: parse markdown -> chunks -> embed -> vector store.

The vector store is selected by ``config.VECTOR_BACKEND``:
    pgvector (default) -> PostgreSQL + pgvector (see db.py)
    chroma             -> local file-based Chroma index under CHROMA_DIR
                          (self-contained; used by the Docker demo)

Also writes data/chunks.jsonl as an auditable copy of the corpus (the markdown
repo stays the single source of truth; the vector store is a derived artifact).
The BM25 sparse retriever reads this same file.

Re-runnable; rebuilds the index from scratch by default.

Usage:
    python ingest.py                 # full corpus (~13k chunks)
    python ingest.py --limit 500     # ingest a subset (fast smoke test)
"""

import os
import json
import time
import argparse

import config
from chunker import iter_chunks
import embeddings

BATCH = 128


def _ingest_pgvector(chunks, recreate):
    import db

    conn = db.connect()
    db.init_schema(conn, recreate=recreate)
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


def _ingest_chroma(chunks, recreate):
    import chromadb

    client = chromadb.PersistentClient(path=config.CHROMA_DIR)
    if recreate:
        try:
            client.delete_collection(config.COLLECTION_NAME)
        except Exception:
            pass
    col = client.get_or_create_collection(
        config.COLLECTION_NAME, metadata={"hnsw:space": "cosine"}
    )

    t0 = time.time()
    for i in range(0, len(chunks), BATCH):
        batch = chunks[i : i + BATCH]
        vecs = embeddings.embed([c["text"] for c in batch])
        col.add(
            ids=[c["chunk_id"] for c in batch],
            embeddings=vecs,
            documents=[c["text"] for c in batch],
            metadatas=[
                {
                    "law_name": c["law_name"],
                    "category": c["category"],
                    "article_no": c["article_no"],
                    "article_num": c["article_num"] if c["article_num"] is not None else -1,
                    "context": c["context"],
                    "source_url": c["source_url"],
                }
                for c in batch
            ],
        )
        done = min(i + BATCH, len(chunks))
        if done % (BATCH * 10) == 0 or done == len(chunks):
            rate = done / (time.time() - t0)
            print(f"[ingest] embedded {done}/{len(chunks)}  ({rate:.0f}/s)")

    print(f"[ingest] done in {time.time() - t0:.1f}s; collection count = {col.count()}")


def main():
    parser = argparse.ArgumentParser(
        description="Ingest law chunks into the configured vector store."
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Only ingest the first N chunks (for a quick smoke test).",
    )
    parser.add_argument(
        "--no-recreate", action="store_true",
        help="Add to the existing index instead of dropping it first.",
    )
    args = parser.parse_args()

    os.makedirs(os.path.dirname(config.CHUNKS_JSONL), exist_ok=True)
    chunks = list(iter_chunks())
    if args.limit:
        chunks = chunks[: args.limit]
    print(f"[ingest] parsed {len(chunks)} article chunks")

    # Always keep an auditable copy of the corpus alongside the vector store
    # (also consumed by the BM25 sparse retriever).
    with open(config.CHUNKS_JSONL, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"[ingest] wrote corpus copy -> {config.CHUNKS_JSONL}")

    recreate = not args.no_recreate
    print(f"[ingest] vector backend = {config.VECTOR_BACKEND}")
    if config.VECTOR_BACKEND == "chroma":
        _ingest_chroma(chunks, recreate)
    else:
        _ingest_pgvector(chunks, recreate)


if __name__ == "__main__":
    main()
