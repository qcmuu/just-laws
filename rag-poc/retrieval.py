"""Hybrid retrieval: dense (Chroma vector search) + sparse (BM25/jieba).

The dense side reuses the Chroma collection built by ``ingest.py``. The sparse
side builds a BM25 index over ``data/chunks.jsonl`` tokenized with jieba. The
two ranked lists are merged with Reciprocal Rank Fusion (default) or a min-max
normalised weighted sum, both configured via environment variables (see
``config.py``).

All public helpers return "hit" dicts with the same shape the PoC has always
used (``text`` / ``law_name`` / ``article_no`` / ``context`` / ``source_url`` /
``score``) plus a ``chunk_id`` used for fusion, so callers and the existing UI
keep working unchanged.
"""

import json
import os
import pickle
import re

import chromadb

import config
import embeddings

_client = None
_col = None
_corpus = None        # list[dict]: chunk records from chunks.jsonl
_id_to_idx = None     # chunk_id -> index into _corpus
_bm25 = None          # rank_bm25.BM25Okapi over the tokenized corpus

# Drop pure-punctuation / whitespace tokens so BM25 keys on content words.
_PUNCT_RE = re.compile(r"^[\s\u3000，。、；：？！（）()《》【】「」“”‘’\-—…·.,:;?!]+$")


def _tokenize(text):
    """jieba tokenization for BM25 (shared by corpus + queries)."""
    import jieba

    return [t for t in jieba.lcut(text) if t.strip() and not _PUNCT_RE.match(t)]


def _collection():
    global _client, _col
    if _col is None:
        _client = chromadb.PersistentClient(path=config.CHROMA_DIR)
        _col = _client.get_collection(config.COLLECTION_NAME)
    return _col


def _load_corpus():
    """Load chunks.jsonl into memory (index-aligned list + id lookup)."""
    global _corpus, _id_to_idx
    if _corpus is not None:
        return _corpus
    if not os.path.exists(config.CHUNKS_JSONL):
        raise FileNotFoundError(
            f"{config.CHUNKS_JSONL} not found — run `python ingest.py` first "
            "to build the corpus and vector index."
        )
    corpus = []
    with open(config.CHUNKS_JSONL, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                corpus.append(json.loads(line))
    _corpus = corpus
    _id_to_idx = {c["chunk_id"]: i for i, c in enumerate(corpus)}
    return _corpus


def _get_bm25():
    """Build (or load from cache) the BM25 index over the tokenized corpus."""
    global _bm25
    if _bm25 is not None:
        return _bm25
    from rank_bm25 import BM25Okapi

    corpus = _load_corpus()
    mtime = os.path.getmtime(config.CHUNKS_JSONL)
    tokenized = None
    if os.path.exists(config.BM25_CACHE):
        try:
            with open(config.BM25_CACHE, "rb") as f:
                cached = pickle.load(f)
            if cached.get("mtime") == mtime and len(cached.get("tokenized", [])) == len(corpus):
                tokenized = cached["tokenized"]
        except Exception:
            tokenized = None
    if tokenized is None:
        print(f"[retrieval] tokenizing {len(corpus)} chunks for BM25 (jieba)…")
        tokenized = [_tokenize(c["text"]) for c in corpus]
        try:
            with open(config.BM25_CACHE, "wb") as f:
                pickle.dump({"mtime": mtime, "tokenized": tokenized}, f)
        except Exception:
            pass
    _bm25 = BM25Okapi(tokenized)
    return _bm25


def _hit_from_chunk(c):
    return {
        "chunk_id": c["chunk_id"],
        "text": c["text"],
        "law_name": c["law_name"],
        "article_no": c["article_no"],
        "context": c.get("context", ""),
        "source_url": c["source_url"],
    }


def dense_search(question, n, category=None):
    """Top-n dense (vector) hits as an ordered list of hit dicts."""
    qvec = embeddings.embed(question, is_query=True)[0]
    where = {"category": category} if category else None
    res = _collection().query(
        query_embeddings=[qvec], n_results=n, where=where,
        include=["documents", "metadatas", "distances"],
    )
    hits = []
    for cid, doc, meta, dist in zip(
        res["ids"][0], res["documents"][0], res["metadatas"][0], res["distances"][0]
    ):
        hits.append({
            "chunk_id": cid,
            "text": doc,
            "law_name": meta["law_name"],
            "article_no": meta["article_no"],
            "context": meta.get("context", ""),
            "source_url": meta["source_url"],
            "score": round(1 - dist, 4),
        })
    return hits


def sparse_search(question, n, category=None):
    """Top-n BM25 (lexical) hits as an ordered list of hit dicts."""
    corpus = _load_corpus()
    bm25 = _get_bm25()
    scores = bm25.get_scores(_tokenize(question))
    order = sorted(range(len(corpus)), key=lambda i: scores[i], reverse=True)
    hits = []
    for i in order:
        if scores[i] <= 0:
            break
        c = corpus[i]
        if category and c.get("category") != category:
            continue
        h = _hit_from_chunk(c)
        h["score"] = round(float(scores[i]), 4)
        hits.append(h)
        if len(hits) >= n:
            break
    return hits


def _min_max(values):
    lo, hi = min(values), max(values)
    if hi - lo < 1e-12:
        return [1.0 for _ in values]
    return [(v - lo) / (hi - lo) for v in values]


def fuse(dense_hits, sparse_hits):
    """Merge two ranked lists into one ordered list of hit dicts.

    Uses Reciprocal Rank Fusion by default; ``FUSION_METHOD=weighted`` switches
    to a min-max normalised weighted sum of the two retrievers' raw scores.
    """
    merged = {}

    def slot(h):
        cid = h["chunk_id"]
        if cid not in merged:
            merged[cid] = {**h}
            merged[cid]["dense_score"] = None
            merged[cid]["sparse_score"] = None
            merged[cid]["fusion_score"] = 0.0
        return merged[cid]

    if config.FUSION_METHOD == "weighted":
        d_norm = _min_max([h["score"] for h in dense_hits]) if dense_hits else []
        s_norm = _min_max([h["score"] for h in sparse_hits]) if sparse_hits else []
        for h, ns in zip(dense_hits, d_norm):
            s = slot(h)
            s["dense_score"] = h["score"]
            s["fusion_score"] += config.DENSE_WEIGHT * ns
        for h, ns in zip(sparse_hits, s_norm):
            s = slot(h)
            s["sparse_score"] = h["score"]
            s["fusion_score"] += config.SPARSE_WEIGHT * ns
    else:  # reciprocal rank fusion
        k = config.RRF_K
        for rank, h in enumerate(dense_hits):
            s = slot(h)
            s["dense_score"] = h["score"]
            s["fusion_score"] += config.DENSE_WEIGHT / (k + rank + 1)
        for rank, h in enumerate(sparse_hits):
            s = slot(h)
            s["sparse_score"] = h["score"]
            s["fusion_score"] += config.SPARSE_WEIGHT / (k + rank + 1)

    out = sorted(merged.values(), key=lambda x: x["fusion_score"], reverse=True)
    for h in out:
        h["score"] = round(h["fusion_score"], 6)
    return out


def hybrid_search(question, category=None, candidates=None):
    """Dense + sparse retrieval fused into a single ranked candidate list."""
    n = candidates or config.FUSION_CANDIDATES
    dense_hits = dense_search(question, n, category=category)
    sparse_hits = sparse_search(question, n, category=category)
    return fuse(dense_hits, sparse_hits)
