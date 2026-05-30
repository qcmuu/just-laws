"""Retrieval quality comparison: baseline (vector-only) vs hybrid + rerank.

Runs a fixed set of representative — and deliberately long-tail — legal queries
through both pipelines and prints the top-k retrieved articles side by side so
the improvement from hybrid retrieval + cross-encoder rerank is visible.

Usage:
    python ingest.py            # build the index first (one-time, ~4-5 min)
    python eval_retrieval.py    # prints baseline vs hybrid+rerank for each query

No LLM call is made — this only exercises the retrieval stage.
"""

import argparse

import config
import retrieval
import reranker

# Representative queries; several are long-tail phrasings the single-vector PoC
# struggled with (deposit refusal, wage arrears, limitation periods, etc.).
QUERIES = [
    "租房押金不退怎么办",
    "公司拖欠工资",
    "欠钱不还诉讼时效",
    "离婚孩子抚养权归谁",
    "试用期被辞退有没有补偿",
    "邻居装修噪音扰民",
    "网购买到假货怎么赔偿",
    "交通事故对方全责不赔钱",
    "未成年人打赏主播能退吗",
    "公司不签劳动合同",
]

TOP_K = config.TOP_K


def fmt(h):
    extra = []
    if h.get("rerank_score") is not None:
        extra.append(f"rr={h['rerank_score']:.4f}")
    if h.get("dense_score") is not None:
        extra.append(f"d={h['dense_score']}")
    if h.get("sparse_score") is not None:
        extra.append(f"s={h['sparse_score']}")
    tag = ("  [" + " ".join(extra) + "]") if extra else f"  [{h.get('score')}]"
    return f"《{h['law_name']}》{h['article_no']}{tag}"


def baseline(question, top_k):
    """Original PoC behaviour: dense vector search only, no fusion/rerank."""
    return retrieval.dense_search(question, top_k, category=None)


def hybrid(question, top_k):
    """Hybrid dense+BM25 fusion, then cross-encoder rerank."""
    candidates = retrieval.hybrid_search(question)
    if reranker.is_enabled() and candidates:
        return reranker.rerank(question, candidates[: config.RERANK_CANDIDATES], top_k=top_k)
    return candidates[:top_k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top-k", type=int, default=TOP_K)
    ap.add_argument("queries", nargs="*", help="override the default query set")
    args = ap.parse_args()
    queries = args.queries or QUERIES
    top_k = args.top_k

    print("=" * 78)
    print(f"Retrieval eval — top_k={top_k}")
    print("  baseline : RETRIEVAL_MODE=vector (dense only)")
    print(f"  hybrid   : dense+BM25 fusion={config.FUSION_METHOD} "
          f"-> rerank={'on('+config.RERANK_BACKEND+':'+config.RERANK_MODEL+')' if reranker.is_enabled() else 'off'}")
    print("=" * 78)

    for q in queries:
        base_hits = baseline(q, top_k)
        hyb_hits = hybrid(q, top_k)
        base_set = {h["chunk_id"] for h in base_hits}
        hyb_set = {h["chunk_id"] for h in hyb_hits}

        print(f"\n### 查询：{q}")
        print("\n  [baseline 向量检索]")
        for i, h in enumerate(base_hits, 1):
            mark = "  " if h["chunk_id"] in hyb_set else " -"
            print(f"  {mark}{i:>2}. {fmt(h)}")
        print("\n  [hybrid 混合检索 + rerank]")
        for i, h in enumerate(hyb_hits, 1):
            mark = " +" if h["chunk_id"] not in base_set else "  "
            print(f"  {mark}{i:>2}. {fmt(h)}")
        n_new = len(hyb_set - base_set)
        print(f"\n  → hybrid 新增 {n_new}/{len(hyb_hits)} 条 baseline 未召回的法条"
              f"（标注 + 者为新召回，- 者为 baseline 中被替换掉的）")
        print("-" * 78)


if __name__ == "__main__":
    main()
