"""Retrieval + grounded generation with forced citations and guardrails.

Retrieval is hybrid by default: dense vector search (Chroma) fused with BM25
lexical search, then reranked by a cross-encoder. All stages are env-driven
(see config.py); set RETRIEVAL_MODE=vector / RERANK_ENABLED=false to fall back
to the original single-vector PoC behaviour.
"""

from openai import OpenAI

import config
import retrieval
import reranker


def retrieve(question, top_k=None, category=None):
    top_k = top_k or config.TOP_K
    if config.RETRIEVAL_MODE == "vector":
        # Legacy behaviour: dense-only, no fusion/rerank.
        hits = retrieval.dense_search(question, top_k, category=category)
        return hits
    # Hybrid: dense + BM25 fused, then cross-encoder rerank.
    candidates = retrieval.hybrid_search(question, category=category)
    if config.RERANK_ENABLED and candidates:
        candidates = reranker.rerank(
            question, candidates[: config.RERANK_CANDIDATES], top_k=top_k
        )
    else:
        candidates = candidates[:top_k]
    return candidates


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
