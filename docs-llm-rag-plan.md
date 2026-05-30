# Just Laws → LLM 法律问答助手：架构与落地方案

> 目标：在现有 VuePress 法律文库（约 203 部法律、约 14,757 条法条、6.8MB Markdown）之上，构建一个基于 RAG 的自然语言法律问答助手。模型与向量库走 **API 优先**（OpenAI / DeepSeek / Qwen 等），强调**引用法条、防幻觉、可深链回原文**。

---

## 1. 现状盘点（为什么这套语料天生适合 RAG）

| 维度 | 现状 | 对 RAG 的意义 |
|---|---|---|
| 数据 | 203 部法律，Markdown，统一 `**第X条**　...` 格式 | 可按"条"精确切块，天然带语义边界 |
| 结构 | 8 大类目录 + frontmatter 带颁布/修订日期 | 现成的元数据（类别、法律名、时效） |
| 站点 | VuePress v2 静态站，Algolia 关键词搜索 | 已有可深链的稳定 URL，引用可直接跳原文 |
| 部署 | GitHub Actions 构建 → rsync 到 nginx | 纯静态，**加 LLM 必须引入一个后端/边缘服务** |
| 痛点 | 只能翻页 + 关键词搜，不能回答自然语言问题 | RAG 正好补齐"理解问题 + 找到法条 + 解释"的能力 |

**核心判断**：内容资产质量极高且结构规整，RAG 的主要工作量在"切块/元数据/检索质量/护栏"，而不是清洗脏数据。

---

## 2. 总体架构

```
                            ┌─────────────────────────────────────────┐
用户浏览器                   │            前端（两选一）                  │
  │                         │  A. VuePress 内嵌聊天组件（推荐起步）       │
  │  问："押金不退怎么办"      │  B. 独立 Next.js 应用（功能扩展时）         │
  ▼                         └───────────────┬─────────────────────────┘
┌──────────────┐                            │ HTTPS (SSE 流式)
│  /api/chat   │◄───────────────────────────┘
│  后端服务     │
│ (FastAPI/    │   1. 改写/澄清问题（可选 query rewrite）
│  Next API)   │   2. 向量检索 top-k 法条（+ 元数据过滤）
│              │   3. 重排序 rerank（可选，提升精度）
│              │   4. 拼 Prompt（系统提示 + 检索法条 + 问题）
│              │   5. 调用 LLM API，流式返回答案 + 引用
└──────┬───────┘
       │
   ┌───┴───────────────┐         ┌────────────────────────┐
   │  向量库            │         │  LLM / Embedding API     │
   │ pgvector / Qdrant │         │ OpenAI / DeepSeek / Qwen │
   └───────────────────┘         └────────────────────────┘
       ▲
       │  离线构建（CI 中跑）
┌──────┴──────────────────────────────────────────────────┐
│  Ingestion Pipeline（离线）                                │
│  Markdown → 按"条"切块 → 附元数据 → 向量化 → 写入向量库      │
└──────────────────────────────────────────────────────────┘
```

**关键原则**：Markdown 仓库始终是**唯一真源（source of truth）**。向量库是它的派生产物，可随时从仓库重建。法条更新走原有的 `addlaws` 流程，CI 里增量重建索引。

---

## 3. 数据处理（Ingestion Pipeline）

### 3.1 切块策略：按"法条"切（chunk = 一条）
- 用正则 `\*\*第[一二三四五六七八九十百千零〇\d]+条\*\*` 作为切分锚点；每条作为一个 chunk。
- 章节标题（`## 第X章`/`### 第X节`）作为上下文注入到 chunk 元数据，**不单独成块**，但拼进 chunk 文本头部，保证语义完整（例如"劳动法 / 第三章 劳动合同和集体合同 / 第十六条 ..."）。
- 超长条文（如刑法分则某些条）超过 embedding 上限时，二次按款（自然段）切，保留同一 `article_id`。
- 类型 A（无章节单文件）整体或按段落切；类型 C（民法典/刑法多文件）按文件内的条切。

### 3.2 元数据 schema（每个 chunk 附带）
```json
{
  "chunk_id": "civil-code-1165",
  "law_name": "中华人民共和国民法典",
  "law_slug": "civil-and-commercial/civil-code",
  "category": "民商法",
  "book": "第七编 侵权责任",          // 编/章/节路径
  "chapter": "第一章 一般规定",
  "article_no": "第一千一百六十五条",
  "article_num": 1165,
  "promulgated": "2020-05-28",
  "effective": "2021-01-01",
  "source_url": "https://www.justlaws.cn/civil-and-commercial/civil-code/07-tort-liability.html#第一千一百六十五条",
  "text": "第一千一百六十五条　行为人因过错侵害他人民事权益造成损害的，应当承担侵权责任。..."
}
```
- `source_url` 是**引用深链**的核心：拼接静态站 URL + 锚点。需在 ingestion 时根据 VuePress 的 slug 规则生成锚点（中文标题 → VuePress 默认锚点；建议验证锚点生成规则，必要时给条文加显式 `id`）。

### 3.3 向量化
- Embedding 模型（API）：`text-embedding-3-large`（OpenAI）/ `text-embedding-v3`（Qwen/DashScope）/ BGE 系列（如需自托管再议）。
- 批量调用，带重试与限流；约 1.5 万条 chunk，一次全量构建成本很低（embedding 通常每百万 token 几美分~几角，全量一次性 < 数美元量级，具体以所选 API 价目为准）。
- 产物写入向量库；同时把 chunk 元数据落一份到仓库（如 `data/chunks.jsonl`），便于审计与重建。

### 3.4 增量更新
- CI 中比对 `git diff`，只对变更的法律文件重新切块 + 嵌入 + upsert，按 `chunk_id` 覆盖。
- 与现有 `addlaws` 技能衔接：收录新法律后自动触发索引更新。

---

## 4. 检索与生成（RAG Core）

### 4.1 检索
1. （可选）**Query rewrite**：把口语问题改写为更利于检索的表述 / 抽取法律关键词。
2. **向量检索** top-k（k≈8~20），可按元数据过滤（如限定"劳动法/民法典"或某类别）。
3. **混合检索**（推荐）：向量 + BM25/关键词，召回更全（法律里精确术语、条号很重要）。
4. （可选）**Rerank**：用 reranker API（如 Cohere rerank / Qwen rerank）对候选重排，取 top-n（n≈5~8）喂给 LLM，显著提升引用精度。

### 4.2 生成（强护栏 Prompt）
系统提示要点：
- 角色：中国法律信息检索助手，**仅依据下方检索到的法条作答**。
- **强制引用**：每个结论后标注来源法律名 + 条号，并给出深链。
- **防幻觉**：检索内容不足以回答时，明确说"现有收录法条无法确定"，不要编造条号/内容。
- **免责声明**：提供法律信息而非法律意见，重大事项建议咨询执业律师。
- 输出结构：先直接回答 → 关键适用法条（带引用）→ 通俗解释 → 免责声明。

```
你是「Just Laws」法律信息助手。严格遵守：
1. 只能依据【参考法条】中的内容回答，禁止使用其中没有的法条或编造条号。
2. 每条结论必须标注来源，格式：（《法律名》第X条）。
3. 若【参考法条】不足以回答，直接说明"根据现有收录法条无法确定，建议咨询专业律师"。
4. 结尾附免责声明：本回答为法律信息整理，不构成法律意见。

【参考法条】
{retrieved_chunks_with_metadata}

【用户问题】
{question}
```

### 4.3 引用与可信度
- 答案里的每个引用渲染为可点击链接 → 跳转静态站对应法条锚点。
- 前端展示"参考来源"列表（法律名 + 条号 + 跳转），让用户一键核对原文——这是法律产品建立信任的关键。

---

## 5. API 方案对比（模型层，API 优先）

| 选项 | 生成模型 | Embedding | 优点 | 注意 |
|---|---|---|---|---|
| **DeepSeek** | deepseek-chat / reasoner | 需配 BGE 或 Qwen embedding | 中文强、价格低、国内访问好 | 自身无 embedding，需混搭 |
| **Qwen（阿里 DashScope）** | qwen-max/plus | text-embedding-v3 + rerank | 中文法律语料友好、一站式（含 rerank） | 需 DashScope key |
| **OpenAI** | gpt-4o / 4o-mini | text-embedding-3 | 工具链成熟、质量稳 | 国内访问/合规需评估 |

**建议起步组合**：生成用 DeepSeek 或 Qwen（中文 + 成本），Embedding + Rerank 用 Qwen DashScope（一站式）。代码层做**模型适配层**，便于随时切换 provider（统一 OpenAI 兼容接口最省事）。

### 5.1 自定义 base_url + 自定义 model（必须支持）
所有 LLM / Embedding 调用统一走 **OpenAI 兼容接口**，并通过环境变量完全可配置，不写死任何 provider：

```bash
# 生成模型（LLM）
LLM_BASE_URL=https://api.deepseek.com/v1     # 任意 OpenAI 兼容端点
LLM_MODEL=deepseek-chat                       # 自定义模型名
LLM_API_KEY=sk-xxx

# 向量模型（Embedding）—— 可与 LLM 用不同 provider
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=text-embedding-v3
EMBEDDING_API_KEY=sk-xxx
```
- 用官方 `openai` SDK 的 `base_url` 覆盖即可对接 DeepSeek / Qwen(DashScope 兼容模式) / OpenAI / 本地 vLLM/Ollama 等任意兼容端点。
- LLM 与 Embedding 各自独立配置（base_url / model / key），允许混搭不同厂商。
- 切换 provider 只改环境变量，无需改代码。

> 需要你提供对应 base_url、model 名与 API Key（Key 我用安全的 secret 流程请求，不写进代码/仓库）。

---

## 6. 向量库选型

| 选项 | 形态 | 适配本项目 |
|---|---|---|
| **pgvector**（Postgres 插件） | 自托管/托管 PG | 推荐：一个 PG 同时存元数据 + 向量，运维简单，1.5 万条规模绰绰有余 |
| **Qdrant** | 自托管/云 | 检索功能丰富、过滤强，云有免费档 |
| **本地文件（FAISS/Chroma）** | 进程内 | 适合 PoC，量小，无需独立服务 |

**建议**：PoC 用 Chroma/本地；上线用 pgvector（与后端同库，省事）。

---

## 7. 前端集成（两选一）

- **方案 A（推荐起步）**：在 VuePress 里嵌一个浮动聊天组件（自定义 Vue 组件 / 客户端增强），调用后端 `/api/chat`（SSE 流式）。保留现有静态站不动，最快上线，引用直接跳本站。
- **方案 B（扩展期）**：独立 Next.js 应用（如 `chat.justlaws.cn`），承载更复杂交互（多轮、历史、对比、文书）。静态文库与 AI 站点并存、互相深链。

---

## 8. 部署架构

现状是纯静态 nginx，RAG 必须引入一个**后端服务**：

```
nginx
 ├── /            → 现有 VuePress 静态站（不变）
 └── /api/*       → 反代到后端服务（FastAPI / Next API，跑在同机或容器）
                     后端 → 向量库(pgvector) + LLM/Embedding API
```
- 后端可用 systemd / Docker 跑在现有服务器；或上 Serverless（Vercel/边缘函数）。
- CI 扩展：构建静态站之外，新增"重建/增量更新向量索引"步骤。
- 密钥：API Key、DB 连接串走环境变量 / secret，不入仓库。

---

## 9. 护栏、合规与风险（法律产品必须重视）

- **不构成法律意见**：全站 + 每条回答显著免责声明。
- **引用可核验**：所有结论可一键跳原文，降低幻觉危害。
- **时效性**：标注法条颁布/修订/施行日期；提示"以官方最新文本为准"。
- **拒答边界**：检索不足、超出收录范围、涉及个案定性时引导咨询律师。
- **滥用防护**：限流、敏感问题处理策略、日志与审计。
- **数据合规**：用户问题是否留存、是否脱敏，需明确隐私政策。

---

## 10. 分阶段落地路线（建议）

**Phase 0 — PoC（1 个脚本即可验证价值）**
- 离线切块 + 嵌入（本地 Chroma）→ 命令行/简单网页问答，验证检索质量与引用效果。

**Phase 1 — MVP 上线**
- pgvector + FastAPI `/api/chat`（流式）+ VuePress 内嵌聊天组件 + 引用深链 + 免责声明。
- CI 增量索引更新。

**Phase 2 — 质量增强**
- 混合检索 + rerank、query rewrite、多轮对话、按法律/类别过滤、评测集（QA 回归）。

**Phase 3 — 功能扩展**
- 语义搜索替换 Algolia、法条释义、修正案对比、场景→适用法、文书辅助等。

---

## 11. 我需要你确认/提供的

1. **API Key**：生成模型 + Embedding（建议 DeepSeek/Qwen 或 OpenAI）。我用安全 secret 流程请求。
2. **前端**：先走方案 A（VuePress 内嵌）还是直接方案 B（独立应用）？
3. **向量库**：PoC 本地 Chroma → 上线 pgvector，是否认可？
4. **部署目标**：复用现有 nginx 服务器加后端，还是上 Serverless？
5. **下一步动作**：要我先做 **Phase 0 PoC**（最快看到效果），还是先把这份方案细化成带代码骨架的工程文档？

---

*本文件为方案讨论稿，未改动任何现有站点代码。*
