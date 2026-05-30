"""Build the vector index: parse markdown -> chunks -> embed -> Chroma.

Also writes data/chunks.jsonl as an auditable copy of the corpus.
Re-runnable; rebuilds the collection from scratch.
"""

import os
import json
import time

import chromadb

import config
from chunker import iter_chunks
import embeddings

BATCH = 128


def main():
    os.makedirs(os.path.dirname(config.CHUNKS_JSONL), exist_ok=True)
    chunks = list(iter_chunks())
    print(f"[ingest] parsed {len(chunks)} article chunks")

    with open(config.CHUNKS_JSONL, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"[ingest] wrote corpus copy -> {config.CHUNKS_JSONL}")

    client = chromadb.PersistentClient(path=config.CHROMA_DIR)
    try:
        client.delete_collection(config.COLLECTION_NAME)
    except Exception:
        pass
    col = client.create_collection(config.COLLECTION_NAME, metadata={"hnsw:space": "cosine"})

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


if __name__ == "__main__":
    main()
