"""Embedding backends. Local sentence-transformers (default) or any
OpenAI-compatible embeddings API. Selected via EMBEDDING_BACKEND."""

import config

_local_model = None


def _get_local():
    global _local_model
    if _local_model is None:
        from sentence_transformers import SentenceTransformer

        print(f"[embeddings] loading local model: {config.EMBEDDING_LOCAL_MODEL}")
        _local_model = SentenceTransformer(config.EMBEDDING_LOCAL_MODEL)
    return _local_model


def _embed_local(texts, is_query=False):
    model = _get_local()
    # bge models recommend a query instruction prefix for retrieval.
    if is_query and "bge" in config.EMBEDDING_LOCAL_MODEL.lower():
        texts = ["为这个句子生成表示以用于检索相关文章：" + t for t in texts]
    vecs = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    return [v.tolist() for v in vecs]


_api_client = None


def _get_api():
    global _api_client
    if _api_client is None:
        from openai import OpenAI

        _api_client = OpenAI(
            base_url=config.EMBEDDING_BASE_URL, api_key=config.EMBEDDING_API_KEY
        )
    return _api_client


def _embed_api(texts, is_query=False):
    client = _get_api()
    resp = client.embeddings.create(model=config.EMBEDDING_MODEL, input=texts)
    return [d.embedding for d in resp.data]


def embed(texts, is_query=False):
    if isinstance(texts, str):
        texts = [texts]
    if config.EMBEDDING_BACKEND == "api":
        return _embed_api(texts, is_query=is_query)
    return _embed_local(texts, is_query=is_query)
