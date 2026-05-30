# Just Laws — RAG 法律问答

在现有 VuePress 法律文库之上的 **RAG 自然语言问答系统**：把 `docs/` 下的法律 Markdown 按"条"切块、向量化检索（稠密向量 + BM25 混合 + 交叉编码器重排），再用 LLM 基于检索到的法条生成**带引用、可深链回原文**的答案。

> 方案文档见 [`../docs-llm-rag-plan.md`](../docs-llm-rag-plan.md)。**仅供参考，不构成法律意见。**

## 特点

- **按法条切块**：约 13,000+ 条法条（来自 161 部法律），每条带 法律名 / 类别 / 章节 / 条号 / 原文深链 元数据。
- **混合检索 + rerank**：稠密向量检索与 BM25 词法检索（jieba 中文分词）经 RRF 融合，再用交叉编码器重排，显著改善长尾问题召回（如"租房押金不退"）。
- **可切换向量库**：`VECTOR_BACKEND=pgvector`（默认，生产）走 PostgreSQL + pgvector；`VECTOR_BACKEND=chroma` 走本地文件型 Chroma（无需数据库，自包含，用于 Docker demo）。
- **provider 无关**：LLM、Embedding、Reranker 都走可切换后端，**自定义 base_url + 自定义 model**，换厂商只改环境变量。
- **Embedding / Reranker 可本地可 API**：默认本地中文模型（`BAAI/bge-small-zh-v1.5` + `BAAI/bge-reranker-base`，免费、无需 key）；设 `EMBEDDING_BACKEND=api` / `RERANK_BACKEND=api` 即切到任意兼容的 API。
- **强护栏**：只依据检索到的法条作答、强制标注条号、检索不足时拒答、附免责声明。
- **可核验**：每个答案附"参考来源"列表，一键跳转 justlaws.cn 对应法条页面。

## 快速开始

```bash
cd rag-poc
pip install -r requirements.txt

# 1) 启动 pgvector 向量库（Docker，本地开发用；如用 chroma 后端可跳过）
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
# 用自包含 Chroma 后端（无需 Postgres）：
# VECTOR_BACKEND=chroma python ingest.py

# 4a) 命令行问答
python rag.py "欠钱不还的诉讼时效是多久？"

# 4b) 检索质量对比（vector-only vs hybrid+rerank，不调用 LLM）
python eval_retrieval.py

# 4c) 后端 API（供 VuePress 站点调用）
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

## 检索流程（hybrid + rerank）

```
query ─┬─► 稠密向量检索 (pgvector / Chroma, bge-small-zh) ─┐
       └─► BM25 词法检索 (rank_bm25 + jieba)               ─┴─► RRF 融合 ─► 交叉编码器重排 ─► top-k
```

- **稠密检索**走 `VECTOR_BACKEND` 选定的向量库（`ingest.py` 写入同一后端）；**BM25** 从 `data/chunks.jsonl` 构建（jieba 分词，缓存于 `.bm25_cache.pkl`）。
- **融合**默认 Reciprocal Rank Fusion（`FUSION_METHOD=rrf`，可选 `weighted`），各检索器权重、候选数、RRF 常数均可通过 env 调整。
- **重排**默认本地交叉编码器 `BAAI/bge-reranker-base`（免费、无需 key），可切换为 API 后端（`RERANK_BACKEND=api`，兼容 Jina / SiliconFlow `/rerank`），亦可通过 `RERANK_ENABLED=false` 关闭。
- 回退：设 `RETRIEVAL_MODE=vector` 即恢复原始单向量检索行为。

详见 `.env.example` 中各项配置（`RETRIEVAL_MODE` / `FUSION_*` / `DENSE_WEIGHT` / `SPARSE_WEIGHT` / `RERANK_*`）。

## pgvector 说明

- `docker-compose.yml` 跑 `pgvector/pgvector:pg16`，库/用户/密码均为 `justlaws`，
  映射到宿主机 **5433** 端口（避开本地已有的 5432）。**compose 里的密码仅用于本地开发**，
  生产请用 `DATABASE_URL` 指向托管 Postgres。
- 表 `law_chunks`：条目元数据列 + `vector(512)` 向量列（维度由 `EMBEDDING_DIM` 决定，
  须与向量模型一致）+ 余弦相似度索引（默认 `ivfflat`，可设 `PG_INDEX_TYPE=hnsw`）。
- 检索用 pgvector 的 `<=>`（余弦距离）算子，相似度 = `1 - 距离`。

## 公开部署（Fly.io，self-contained）

`Dockerfile` 以自包含方式打包：用 **Chroma 后端**（`VECTOR_BACKEND=chroma`）运行，
构建时预下载本地 BGE 向量模型并烤入预构建的 Chroma 索引（`.chroma/`），单容器即可运行、
无需外部数据库。部署前先在本目录构建一次索引：

```bash
pip install -r requirements.txt
VECTOR_BACKEND=chroma python ingest.py      # 解析 docs/ → 切块 → 本地向量化 → 写入 .chroma/

# 本地容器自测
docker build -t justlaws-rag .
docker run -p 8000:8000 -e LLM_API_KEY=sk-... justlaws-rag   # 打开 http://localhost:8000
```

LLM key 以运行时环境变量 / Fly secret 注入（`LLM_API_KEY`，亦可回退到 `SENSENOVA_API_KEY`），
**不写入镜像、不入库**。生产形态请改用 pgvector（`DATABASE_URL` 指向托管 Postgres）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `config.py` | 所有配置（env 驱动，自定义 base_url + model + 向量库 + 检索/重排参数） |
| `chunker.py` | Markdown → 按"条"切块 + 元数据 + 深链 URL |
| `embeddings.py` | 向量化后端（本地 BGE / OpenAI 兼容 API） |
| `db.py` | PostgreSQL + pgvector 层（建表/建索引/余弦检索） |
| `docker-compose.yml` | 本地 pgvector Postgres（端口 5433） |
| `retrieval.py` | 混合检索：稠密向量（pgvector/Chroma） + BM25 词法 + RRF/加权融合 |
| `reranker.py` | 交叉编码器重排后端（本地 CrossEncoder / `/rerank` API） |
| `ingest.py` | 切块 → 向量化 → 写入向量库（pgvector 或 Chroma，同时落 `data/chunks.jsonl`） |
| `rag.py` | 检索（hybrid+rerank）+ 受约束生成（CLI 入口） |
| `eval_retrieval.py` | 检索质量对比脚本（baseline vs hybrid+rerank） |
| `app.py` | FastAPI 后端：`/health` + `/api/chat`（SSE，已开 CORS） |
| `Dockerfile` | 自包含部署镜像（Chroma 后端 + 预置模型/索引） |

## 已知限制

- 检索已升级为混合检索 + rerank；query rewrite / 多跳检索仍未做，可按方案 Phase 2 继续增强。
- 深链到**页面级**（条号在正文为加粗文本、无锚点）；条级锚点需在站点侧给法条加 `id`，属后续工作。
