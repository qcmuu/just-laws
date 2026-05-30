"""Retrieval + grounded generation with forced citations and guardrails."""

import chromadb
from openai import OpenAI

import config
import embeddings

_client = None
_col = None


def _collection():
    global _client, _col
    if _col is None:
        _client = chromadb.PersistentClient(path=config.CHROMA_DIR)
        _col = _client.get_collection(config.COLLECTION_NAME)
    return _col


def retrieve(question, top_k=None, category=None):
    top_k = top_k or config.TOP_K
    qvec = embeddings.embed(question, is_query=True)[0]
    where = {"category": category} if category else None
    res = _collection().query(
        query_embeddings=[qvec], n_results=top_k, where=where,
        include=["documents", "metadatas", "distances"],
    )
    hits = []
    for doc, meta, dist in zip(
        res["documents"][0], res["metadatas"][0], res["distances"][0]
    ):
        hits.append({
            "text": doc,
            "law_name": meta["law_name"],
            "article_no": meta["article_no"],
            "context": meta.get("context", ""),
            "source_url": meta["source_url"],
            "score": round(1 - dist, 4),
        })
    return hits


SYSTEM_PROMPT = """你是「Just Laws」法律信息助手，基于中华人民共和国现行法律文库回答问题。请严格遵守：
1. 只能依据下方【参考法条】中的内容作答，禁止使用其中没有出现的法条，禁止编造条号或法律名称。
2. 每一个结论后必须标注来源，格式为：（《法律名》第X条）。
3. 如果【参考法条】不足以回答问题，必须直接说明"根据现有收录的法条无法确定，建议咨询专业律师"，不要强行作答。
4. 回答结构：先用通俗语言给出结论，再列出关键适用法条及其要点，最后附一句免责声明。
5. 本回答仅为法律信息整理，不构成法律意见。"""


def build_context(hits):
    blocks = []
    for i, h in enumerate(hits, 1):
        blocks.append(
            f"[{i}] 《{h['law_name']}》{h['article_no']}\n"
            f"（位置：{h['context']}）\n{h['text']}"
        )
    return "\n\n".join(blocks)


def answer(question, top_k=None, category=None, stream=False):
    hits = retrieve(question, top_k=top_k, category=category)
    context = build_context(hits)
    user_msg = f"【参考法条】\n{context}\n\n【用户问题】\n{question}"
    client = OpenAI(base_url=config.LLM_BASE_URL, api_key=config.LLM_API_KEY)
    if stream:
        return hits, client.chat.completions.create(
            model=config.LLM_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.2,
            stream=True,
        )
    resp = client.chat.completions.create(
        model=config.LLM_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.2,
    )
    return hits, resp.choices[0].message.content


if __name__ == "__main__":
    import sys

    q = " ".join(sys.argv[1:]) or "租房到期房东不退押金怎么办？"
    print(f"问题：{q}\n")
    hits, text = answer(q)
    print("=" * 60)
    print("检索到的法条：")
    for i, h in enumerate(hits, 1):
        print(f"  [{i}] ({h['score']}) 《{h['law_name']}》{h['article_no']}  {h['source_url']}")
    print("=" * 60)
    print("回答：\n")
    print(text)
