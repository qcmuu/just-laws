# Just Laws — RAG 法律问答 PoC

在现有 VuePress 法律文库之上的**最小可用 RAG 问答原型**：把 `docs/` 下的法律 Markdown 按"条"切块、向量化检索，再用 LLM 基于检索到的法条生成**带引用、可深链回原文**的答案。

> 这是方案文档 [`../docs-llm-rag-plan.md`](../docs-llm-rag-plan.md) 的 Phase 0 实现，用于验证检索质量与引用效果。**仅供参考，不构成法律意见。**

## 特点

- **按法条切块**：约 13,000+ 条法条（来自 161 部法律），每条带 法律名 / 类别 / 章节 / 条号 / 原文深链 元数据。
- **provider 无关**：LLM 与 Embedding 都走 OpenAI 兼容接口，**自定义 base_url + 自定义 model**，换厂商只改环境变量。
- **Embedding 可本地可 API**：默认本地中文模型 `BAAI/bge-small-zh-v1.5`（免费、无需 key）；设 `EMBEDDING_BACKEND=api` 即切到任意兼容的向量 API。
- **强护栏**：只依据检索到的法条作答、强制标注条号、检索不足时拒答、附免责声明。
- **可核验**：每个答案附"参考来源"列表，一键跳转 justlaws.cn 对应法条页面。

## 快速开始

```bash
cd rag-poc
pip install -r requirements.txt

# 1) 配置（至少填 LLM_API_KEY）
cp .env.example .env && $EDITOR .env
# 或直接用环境变量：
export LLM_BASE_URL=https://token.sensenova.cn/v1
export LLM_MODEL=sensenova-6.7-flash-lite
export LLM_API_KEY=sk-...

# 2) 构建向量索引（首次会下载本地向量模型，约几分钟）
python ingest.py

# 3a) 命令行问答
python rag.py "欠钱不还的诉讼时效是多久？"

# 3b) 网页问答 UI
uvicorn app:app --host 0.0.0.0 --port 8000
# 浏览器打开 http://localhost:8000
```

## 文件说明

| 文件 | 作用 |
|---|---|
| `config.py` | 所有配置（env 驱动，自定义 base_url + model） |
| `chunker.py` | Markdown → 按"条"切块 + 元数据 + 深链 URL |
| `embeddings.py` | 向量化后端（本地 BGE / OpenAI 兼容 API） |
| `ingest.py` | 切块 → 向量化 → 写入 Chroma（`python ingest.py`） |
| `rag.py` | 检索 + 受约束生成（CLI 入口） |
| `app.py` | FastAPI 流式聊天 UI |

## 已知限制（PoC 范围）

- 检索为单一向量检索，未做混合检索 / rerank / query rewrite——个别长尾问题召回不全（届时会按方案 Phase 2 增强）。
- 深链到**页面级**（条号在正文为加粗文本、无锚点）；条级锚点需在站点侧给法条加 `id`，属后续工作。
- 向量库用本地 Chroma；上线建议换 pgvector（见方案文档）。
