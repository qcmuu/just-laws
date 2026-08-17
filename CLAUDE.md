# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 及 AI 编程助手在此仓库中工作时提供指导。

## 项目概述

**JustLaws AI** 是一个基于 VuePress 的中华人民共和国现行法律与案例知识库站点，集成了**纯静态客户端 AI 法律问答 (BYOK RAG)** 与 **279 篇典型司法判例与法学研究文献库**。
- 上游项目：[ImCa0/just-laws](https://github.com/ImCa0/just-laws) (部署于 [justlaws.cn](https://www.justlaws.cn))
- 本项目仓库：[qcmuu/just-laws](https://github.com/qcmuu/just-laws) (`just-laws-ai`)
- **技术栈**：VuePress v2 (beta) 静态站点生成，Client-side MiniSearch 检索，GitHub Pages 自动化部署，Python Exa API Harvester，Python FastAPI/pgvector/Chroma (后端 RAG PoC)。

## 目录结构

```
just-laws/
├── docs/                           # VuePress 文档根目录
│   ├── .vuepress/                  # VuePress 配置与组件
│   │   ├── components/             # LawChatWidget.vue (纯前端 AI 问答浮窗)
│   │   ├── scripts/                # build-law-corpus.mjs (构建法条检索 JSON)
│   │   ├── public/                 # 静态资源 (images/logo.png, law-corpus.json)
│   │   ├── config.js               # 主配置（导航、侧边栏、搜索、环境变量开关）
│   │   ├── client.js               # 客户端配置（异步挂载浮窗、统计脚本）
│   │   └── styles/index.scss       # 全局样式（品牌色、布局）
│   │
│   ├── references/                 # 典型案例与法学文献文档索引页
│   ├── category/                   # 分类索引页（宪法相关法、民商法、行政法等）
│   ├── constitution/               # 宪法及修正案
│   ├── constitutional-relevance/   # 宪法相关法（54部）
│   ├── civil-and-commercial/       # 民商法（25部，含民法典）
│   ├── administrative/             # 行政法（52部）
│   ├── economic/                   # 经济法（16部）
│   ├── social/                     # 社会法（5部）
│   ├── criminal-law/               # 刑法及修正案（4部）
│   └── procedural/                 # 诉讼与非诉讼程序法（10部）
│
├── references/                     # 279 篇落地保存的真实司法判例与学术文献（三件套）
│   ├── 01_民商法_民法典与公司法/
│   ├── 02_刑法与刑事诉讼法/
│   ├── 03_经济法与财税金融/
│   ├── 04_行政法与国家赔偿/
│   ├── 05_社会法与劳动保障/
│   ├── 06_数据与人工智能法/
│   ├── 07_涉外法治与国际司法/
│   ├── 08_宪法与国家机构/
│   ├── manifest.json               # 结构化索引
│   └── README.md                   # 分类导航表
│
├── rag-poc/                        # 后端 RAG 混合检索 PoC 服务 (FastAPI + pgvector/chroma)
├── harvest_legal_references.py     # Exa API 多 Key 并发文献与判例抓取脚本
├── LAWS_PROGRESS.md                # 308 部法律收录进度跟踪
├── CLAUDE.md                       # 本文件
├── README.md                       # 项目主文档与 Fork 说明
└── package.json                    # 项目依赖与 npm scripts
```

## 常用开发命令

```bash
# 1. 单独构建法条检索语料库 (docs/.vuepress/public/law-corpus.json)
npm run build:corpus

# 2. 本地开发服务器 (先自动构建语料库，再启动 VuePress 开发服务器)
npm run docs:dev

# 3. 生产静态站点构建
npm run docs:build
```

## 核心功能与实现规范

### 1. 客户端 AI 法律问答 (LawChatWidget.vue)
- 位于 `docs/.vuepress/components/LawChatWidget.vue`。
- **语料格式**：由 `docs/.vuepress/scripts/build-law-corpus.mjs` 从全量法律 Markdown 中解析出约 13,000+ 条以“条”为单位的法条 JSON（字段：`n` 法律名、`a` 条号、`c` 章节、`u` 相对 URL、`t` 正文）。
- **客户端检索**：动态导入 `minisearch`，使用 CJK 双字切分（bi-gram）索引进行本地 BM25 检索。
- **BYOK 调用**：直连用户配置的 OpenAI 兼容接口（如 DeepSeek、通义千问等），支持 SSE 流式接收与 Markdown 渲染，附带原文跳转深链接。

### 2. 法律目录组织规则

法律按结构分为三种类型：

**类型 A - 无章节**（如国旗法）：单文件，无需 frontmatter
```
constitutional-relevance/national-flag-law/
└── README.md
```

**类型 B - 有章节**（如种子法）：单文件，需要 `sidebar: auto`
```
economic/seed-law/
└── README.md              # 包含 frontmatter
```

**类型 C - 有编结构**（如民法典、刑法）：多文件拆分
```
civil-and-commercial/civil-code/
├── README.md              # 封面页（有 next frontmatter）
├── 01-general-principles.md   # 第一编（有 prev frontmatter）
├── 02-property-rights.md      # 第二编（无 frontmatter）
└── ...
```

## 内容来源

- **法律原文**: [国家法律法规数据库](https://flk.npc.gov.cn/)（时效性为有效、公布日期为最新）
- **全量法律列表**: [全国人大网现行有效法律目录](http://www.npc.gov.cn/npc/c2/c30834/202512/t20251231_450944.html)（308 部法律完整列表和分类）

## 可用技能

- **addlaws**: 自动化法律收录（[文档](.claude/skills/addlaws/SKILL.md)）
- **markitdown**: 文件格式转换（[文档](.claude/skills/markitdown/SKILL.md)）
