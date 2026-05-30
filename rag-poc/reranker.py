"""Cross-encoder rerank stage. Local sentence-transformers CrossEncoder
(default) or an OpenAI-style ``/rerank`` HTTP endpoint (Jina / SiliconFlow /
Cohere-compatible). Selected via RERANK_BACKEND, mirroring ``embeddings.py``.

A reranker scores each (query, document) pair jointly, which is far more
accurate than the bi-encoder similarity used for first-stage retrieval. We run
it over the fused hybrid candidates and keep the best ``top_k``.
"""

import config

_local_model = None


def is_enabled():
    return config.RERANK_ENABLED


def _get_local():
    global _local_model
    if _local_model is None:
        from sentence_transformers import CrossEncoder

        print(f"[reranker] loading local cross-encoder: {config.RERANK_MODEL}")
        _local_model = CrossEncoder(config.RERANK_MODEL)
    return _local_model


def _rerank_local(question, hits):
    model = _get_local()
    pairs = [(question, h["text"]) for h in hits]
    scores = model.predict(pairs)
    return [float(s) for s in scores]


def _rerank_api(question, hits):
    """Call an OpenAI-style ``/rerank`` endpoint.

    Compatible with the common Jina / SiliconFlow / Cohere request+response
    shape: POST {base_url}/rerank with {model, query, documents, top_n} and a
    response of {results: [{index, relevance_score}, ...]}.
    """
    import httpx

    if not config.RERANK_BASE_URL:
        raise ValueError("RERANK_BACKEND=api requires RERANK_BASE_URL")
    url = config.RERANK_BASE_URL.rstrip("/") + "/rerank"
    headers = {"Content-Type": "application/json"}
    if config.RERANK_API_KEY:
        headers["Authorization"] = f"Bearer {config.RERANK_API_KEY}"
    payload = {
        "model": config.RERANK_MODEL,
        "query": question,
        "documents": [h["text"] for h in hits],
        "top_n": len(hits),
    }
    resp = httpx.post(url, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    scores = [0.0] * len(hits)
    for r in data.get("results", []):
        idx = r.get("index")
        if idx is not None and 0 <= idx < len(scores):
            scores[idx] = float(r.get("relevance_score", r.get("score", 0.0)))
    return scores


def rerank(question, hits, top_k=None):
    """Rerank candidate hits with a cross-encoder; return top_k (or all).

    Falls back to the input order when rerank is disabled or there are no hits.
    Each returned hit gets ``rerank_score`` and its ``score`` set to it.
    """
    if not hits or not config.RERANK_ENABLED:
        return hits[: top_k or len(hits)]
    if config.RERANK_BACKEND == "api":
        scores = _rerank_api(question, hits)
    else:
        scores = _rerank_local(question, hits)
    for h, s in zip(hits, scores):
        h["rerank_score"] = round(s, 6)
        h["score"] = round(s, 6)
    out = sorted(hits, key=lambda h: h["rerank_score"], reverse=True)
    return out[: top_k or len(out)]
