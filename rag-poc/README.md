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

# 1) 启动 pgvector 向量库（Docker，本地开发用）
docker compose up -d
export DATABASE_URL=postgresql://justlaws:justlaws@localhost:5433/justlaws

# 2) 配置（至少填 LLM_API_KEY）
cp .env.example .env && $EDITOR .env
# 或直接用环境变量：
export LLM_BASE_URL=https://token.sensenova.cn/v1
export LLM_MODEL=sensenova-6.7-flash-lite
export LLM_API_KEY=sk-...

# 3) 构建向量索引（首次会下载本地向量模型，约几分钟）
python ingest.py                 # 全量 ~13k 条
python ingest.py --limit 600     # 仅前 600 条，快速冒烟

# 4a) 命令行问答
python rag.py "欠钱不还的诉讼时效是多久？"

# 4b) 后端 API（供 VuePress 站点调用）
uvicorn app:app --host 0.0.0.0 --port 8000
# GET /health 健康检查；POST /api/chat SSE 流式问答；已开启 CORS
```

## 站点集成（VuePress 浮窗）

站点通过 `docs/.vuepress/client.js` 注册了一个浮动的「AI 法律问答」组件
（`docs/.vuepress/components/LawChatWidget.vue`），调用上面的后端 `/api/chat`、
流式渲染答案并把引用渲染成可点击的深链。

后端地址通过构建期环境变量 `JUSTLAWS_RAG_API_BASE` 配置（见 `config.js` 的
`define`）。为空时按**同源** `/api/chat` 请求（生产建议用 nginx 把 `/api` 反代到后端）。
本地联调：

```bash
# 后端跑在 8000；让站点指向它
export JUSTLAWS_RAG_API_BASE=http://localhost:8000
npm run docs:dev        # 仓库根目录
```

> 静态构建（`npm run docs:build`）不依赖后端；后端缺失时浮窗会友好降级提示，站点本身不受影响。

## pgvector 说明

- `docker-compose.yml` 跑 `pgvector/pgvector:pg16`，库/用户/密码均为 `justlaws`，
  映射到宿主机 **5433** 端口（避开本地已有的 5432）。**compose 里的密码仅用于本地开发**，
  生产请用 `DATABASE_URL` 指向托管 Postgres。
- 表 `law_chunks`：条目元数据列 + `vector(512)` 向量列（维度由 `EMBEDDING_DIM` 决定，
  须与向量模型一致）+ 余弦相似度索引（默认 `ivfflat`，可设 `PG_INDEX_TYPE=hnsw`）。
- 检索用 pgvector 的 `<=>`（余弦距离）算子，相似度 = `1 - 距离`。

## 文件说明

| 文件 | 作用 |
|---|---|
| `config.py` | 所有配置（env 驱动，自定义 base_url + model + `DATABASE_URL`） |
| `chunker.py` | Markdown → 按"条"切块 + 元数据 + 深链 URL |
| `embeddings.py` | 向量化后端（本地 BGE / OpenAI 兼容 API） |
| `db.py` | PostgreSQL + pgvector 层（建表/建索引/余弦检索） |
| `docker-compose.yml` | 本地 pgvector Postgres（端口 5433） |
| `ingest.py` | 切块 → 向量化 → 写入 pgvector（同时落 `data/chunks.jsonl`） |
| `rag.py` | 检索 + 受约束生成（CLI 入口） |
| `app.py` | FastAPI 后端：`/health` + `/api/chat`（SSE，已开 CORS） |

## 已知限制（PoC 范围）

- 检索为单一向量检索，未做混合检索 / rerank / query rewrite——个别长尾问题召回不全（届时会按方案 Phase 2 增强）。
- 深链到**页面级**（条号在正文为加粗文本、无锚点）；条级锚点需在站点侧给法条加 `id`，属后续工作。
- 向量库已迁移到 pgvector（本 Phase 1）；后续混合检索 / rerank 见方案文档 Phase 2。
