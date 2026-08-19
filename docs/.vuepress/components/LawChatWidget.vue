<!-- @ts-nocheck -->
<!--
  Floating "AI 法律问答" chat widget for the Just Laws VuePress site.

  Fully client-side, no backend (BYOK = bring your own key):
  - Lazy-loads /law-corpus.json (article-level law chunks) on first open.
  - Builds the lexical index in a Web Worker (MiniSearch + a CJK bi-gram
    tokenizer) so the ~15 s of CPU never blocks the main thread; the parsed
    corpus is cached in IndexedDB (see law-corpus-cache.js) so repeat opens
    skip the multi-MB re-download that GitHub Pages' 10-minute Cache-Control
    forces. Searches also run inside the worker.
  - If Web Workers are unavailable (very old browsers / restrictive CSP), the
    widget transparently falls back to building the index on the main thread
    with the same chunked yields as before.
  - Sends the retrieved 法条 + question to a user-supplied OpenAI-compatible
    chat endpoint and streams the answer. The API key is stored only in the
    user's browser (localStorage) and sent directly to their chosen provider —
    it never touches our servers.
  - Renders citations as clickable deep-links back into the law text.
-->
<template>
  <ClientOnly>
    <div v-if="enabled" class="jl-chat">
      <!-- Launcher -->
      <button
        v-if="!open"
        class="jl-chat__fab"
        type="button"
        aria-label="打开 AI 法律问答"
        @click="openPanel"
      >
        <span class="jl-chat__fab-icon">⚖️</span>
        <span class="jl-chat__fab-text">AI 法律问答</span>
      </button>

      <!-- Panel -->
      <section v-if="open" class="jl-chat__panel" aria-label="AI 法律问答">
        <header class="jl-chat__header">
          <div>
            <strong>AI 法律问答</strong>
            <span class="jl-chat__sub">本地检索法条 · 自带模型 Key</span>
          </div>
          <div class="jl-chat__actions">
            <button
              class="jl-chat__icon"
              type="button"
              :aria-label="showSettings ? '返回问答' : '设置模型'"
              :title="showSettings ? '返回问答' : '设置模型'"
              @click="showSettings = !showSettings"
            >
              {{ showSettings ? "←" : "⚙" }}
            </button>
            <button
              class="jl-chat__icon"
              type="button"
              aria-label="关闭"
              @click="open = false"
            >
              ×
            </button>
          </div>
        </header>

        <!-- Settings (BYOK) — same shared component as the /settings/ page -->
        <div v-if="showSettings" class="jl-chat__settings">
          <LawModelSettings variant="panel" />
        </div>

        <!-- Chat -->
        <template v-else>
          <div class="jl-chat__disclaimer">
            ⚠️ 本工具基于已收录法条 + 你选择的大模型自动整理，仅供参考、不构成法律意见。重大事项请咨询执业律师。
          </div>

          <div ref="bodyEl" class="jl-chat__body">
            <div v-if="indexState === 'loading'" class="jl-chat__status">
              <span class="jl-chat__status-dot"></span>
              <template v-if="indexFromCache">
                已从本地缓存读取法条，正在后台构建索引 {{ indexProgress }}%…（页面可正常浏览）
              </template>
              <template v-else>
                正在下载法条语料并在后台构建索引 {{ indexProgress }}%…（仅首次较慢，页面可正常浏览）
              </template>
            </div>
            <div v-if="!answer && !sources.length && !error" class="jl-chat__examples">
              <p v-if="!configured" class="jl-chat__hint">
                先在 ⚙ 设置里填入你的模型 API（也可前往
                <a class="jl-chat__hint-link" :href="settingsPageUrl">设置页</a> 配置），即可开始提问。
              </p>
              <template v-else>
                <p class="jl-chat__hint">试着问我：</p>
                <button
                  v-for="ex in examples"
                  :key="ex"
                  type="button"
                  class="jl-chat__chip"
                  @click="ask(ex)"
                >
                  {{ ex }}
                </button>
              </template>
            </div>

            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="answer" class="jl-chat__answer" v-html="renderedAnswer"></div>

            <details v-if="reasoning" class="jl-chat__think">
              <summary>模型思考过程</summary>
              <pre>{{ reasoning }}</pre>
            </details>

            <div v-if="error" class="jl-chat__error">{{ error }}</div>

            <!-- Reasoning models stream long "thinking" deltas before any
                 answer content; without this line the panel looks frozen.
                 Hidden while the corpus index is still building — that step
                 shows its own progress line above. -->
            <div
              v-if="loading && !answer && !error && indexState !== 'loading'"
              class="jl-chat__status"
            >
              <span class="jl-chat__status-dot"></span>
              <template v-if="reasoning"
                >模型思考中…（已输出 {{ reasoning.length }} 字推理，正式回答随后显示）</template
              >
              <template v-else>正在检索法条并等待模型响应…</template>
            </div>

            <details v-if="sources.length" class="jl-chat__sources">
              <summary>参考来源（{{ sources.length }} 条法条，展开核对原文）</summary>
              <a
                v-for="(s, i) in sources"
                :key="i"
                class="jl-chat__src"
                :href="srcUrl(s.u)"
                target="_blank"
                rel="noopener"
              >
                <span class="jl-chat__src-title"
                  >《{{ s.n }}》{{ s.a }}</span
                >
                <span v-if="s.c" class="jl-chat__badge">{{ s.c }}</span>
                <span class="jl-chat__src-ctx">{{ snippet(s.t) }}</span>
              </a>
            </details>
          </div>

          <form class="jl-chat__inputbar" @submit.prevent="ask()">
            <input
              v-model="question"
              class="jl-chat__input"
              type="text"
              maxlength="4000"
              :disabled="loading"
              :placeholder="configured ? '用一句话描述你的法律问题…' : '请先在 ⚙ 设置里填入模型 API'"
            />
            <button
              class="jl-chat__send"
              type="submit"
              :disabled="loading || !configured"
            >
              {{ loading ? "…" : "提问" }}
            </button>
          </form>
        </template>
      </section>
    </div>
  </ClientOnly>
</template>

<script>
import { withBase } from "@vuepress/client";

import LawModelSettings from "./LawModelSettings.vue";
import { SETTINGS_EVENT, loadCfg } from "./chat-settings";
import { getCachedCorpus, setCachedCorpus } from "./law-corpus-cache.js";
import { cjkTokenize, searchLaws } from "./law-retrieve.js";

// markdown-it and minisearch are heavy and only needed once the user actually
// opens the chat. They are dynamically imported on demand (see loadMarkdown /
// ensureIndex) so they are split into separate chunks and never block the
// initial page load — important on slow networks (e.g. GitHub Pages in China).
let md = null; // markdown-it instance, lazily created
let MiniSearch = null; // minisearch class, lazily imported

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const REQUEST_TIMEOUT_MS = 90000; // streamed completions can run a while
const TOP_K = 6; // number of 法条 fed to the model
const MAX_CHUNK_CHARS = 600; // cap each 法条's length in the prompt

const MAX_QUESTION_CHARS = 4000;

// Indexing 24k+ 法条 with the bigram tokenizer takes ~15s of CPU on a fast
// machine — long enough for browsers to pop the "page unresponsive" dialog if
// done in one synchronous addAll() burst. Build in small chunks and hand the
// main thread back to the browser between chunks (MessageChannel yields
// without setTimeout's 4ms clamp, falling back to setTimeout elsewhere).
const INDEX_CHUNK_DOCS = 300;
function yieldToUI() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== "undefined") {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function resolveEnabled() {
  if (
    typeof window !== "undefined" &&
    typeof window.__JUSTLAWS_RAG_ENABLED__ !== "undefined"
  ) {
    return (
      window.__JUSTLAWS_RAG_ENABLED__ !== false &&
      !["false", "0", "off", "no"].includes(
        String(window.__JUSTLAWS_RAG_ENABLED__).toLowerCase()
      )
    );
  }
  if (typeof __JUSTLAWS_RAG_ENABLED__ !== "undefined") {
    return __JUSTLAWS_RAG_ENABLED__ !== false;
  }
  return true;
}

export default {
  name: "LawChatWidget",
  components: { LawModelSettings },
  data() {
    return {
      enabled: resolveEnabled(),
      open: false,
      showSettings: false,
      question: "",
      answer: "",
      reasoning: "",
      sources: [],
      error: "",
      loading: false,
      indexState: "idle", // idle | loading | ready | error
      indexProgress: 0, // % while indexState === "loading"
      indexFromCache: false, // true when corpus came from IndexedDB (no network)
      mdReady: false, // markdown-it loaded (lazy)
      cfg: { baseUrl: "", apiKey: "", model: "" },
      examples: [
        "租房到期房东不退押金怎么办？",
        "公司拖欠工资可以怎么维权？",
        "欠钱不还的诉讼时效是多久？",
        "离婚时夫妻共同财产怎么分割？",
      ],
    };
  },
  computed: {
    renderedAnswer() {
      if (!this.answer) return "";
      // mdReady is referenced so the computed re-runs once markdown-it loads.
      if (this.mdReady && md) return md.render(this.answer);
      return escapeHtml(this.answer).replace(/\n/g, "<br>");
    },
    configured() {
      return !!(this.cfg.baseUrl && this.cfg.apiKey && this.cfg.model);
    },
    settingsPageUrl() {
      return withBase("/settings/");
    },
  },
  async created() {
    if (typeof window === "undefined") return;
    // Non-reactive worker plumbing (kept off Vue's reactive proxy — a proxied
    // Worker breaks postMessage's `this` binding).
    this._worker = null;
    this._searchSeq = 0;
    this._searchWaiters = new Map();
    this.cfg = { ...this.cfg, ...(await loadCfg()) };
    // Stay in sync when settings are saved elsewhere (the /settings/ page or
    // this panel — both dispatch SETTINGS_EVENT after persisting).
    this._onSettingsSaved = async () => {
      try {
        this.cfg = { ...this.cfg, ...(await loadCfg()) };
      } catch (e) {
        /* keep previous cfg */
      }
      if (this.configured && this.showSettings) this.showSettings = false;
    };
    window.addEventListener(SETTINGS_EVENT, this._onSettingsSaved);
  },
  beforeUnmount() {
    if (typeof window !== "undefined" && this._onSettingsSaved) {
      window.removeEventListener(SETTINGS_EVENT, this._onSettingsSaved);
    }
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  },
  methods: {
    openPanel() {
      this.open = true;
      if (!this.configured) this.showSettings = true;
      // Warm up the heavy chunks (corpus index + markdown renderer) as soon as
      // the panel opens, in parallel, so the first question feels responsive.
      this.ensureIndex();
      this.loadMarkdown();
    },
    async loadMarkdown() {
      if (md) {
        this.mdReady = true;
        return;
      }
      try {
        const mod = await import("markdown-it");
        const MarkdownIt = mod.default || mod;
        // html:false escapes any raw HTML in the model output, and markdown-it's
        // default link validator strips javascript:/data: URLs, so rendering the
        // answer with v-html is safe against injection from the LLM response.
        md = new MarkdownIt({ html: false, linkify: true, breaks: true });
        this.mdReady = true;
      } catch (e) {
        /* fall back to escaped plain text in renderedAnswer */
      }
    },
    snippet(t) {
      const s = String(t || "").replace(/\s+/g, " ");
      return s.length > 80 ? s.slice(0, 80) + "…" : s;
    },
    srcUrl(u) {
      // Corpus stores site-relative URLs, optionally with a 第X条 fragment.
      // Split the hash so withBase does not mangle it; VuePress base lives on the path.
      const raw = u || "/";
      const hashAt = raw.indexOf("#");
      const path = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
      let hash = hashAt >= 0 ? raw.slice(hashAt + 1) : "";
      if (hash) {
        try {
          hash = decodeURIComponent(hash);
        } catch (e) {
          /* keep raw */
        }
        hash = encodeURIComponent(hash);
      }
      const resolved = withBase(path);
      return hash ? resolved + "#" + hash : resolved;
    },
    scrollDown() {
      this.$nextTick(() => {
        const el = this.$refs.bodyEl;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    async ensureIndex() {
      if (this._indexPromise) return this._indexPromise;
      this.indexState = "loading";
      this.indexProgress = 0;
      // Prefer the Web Worker: the ~15 s CPU index build (and every search)
      // runs off the main thread, so the page never janks while the corpus
      // loads. If workers are unavailable (very old browsers / strict CSP) or
      // the worker errors out, fall back to the in-page path below.
      this._indexPromise = (async () => {
        try {
          if (typeof Worker !== "undefined" && (await this._tryIndexViaWorker())) {
            this.indexState = "ready";
            this.indexProgress = 100;
            return;
          }
          await this._indexOnMainThread();
        } catch (e) {
          this._teardownWorker();
          throw e;
        }
      })()
        .catch((e) => {
          this.indexState = "error";
          this._indexPromise = null;
          this.error = "法条索引加载失败，请刷新页面重试。";
          throw e;
        });
      return this._indexPromise;
    },
    // Worker path. Returns true once the worker reports `ready`. Any failure
    // (constructor throw, error message, crash) tears the worker down and
    // returns false so the caller falls back to the main-thread path.
    // The worker is imported with Vite's `?worker` suffix (instead of
    // `new Worker(new URL(...))`), which VuePress' SSR build rejects; `?worker`
    // yields a constructor and the code is still split into its own chunk.
    async _tryIndexViaWorker() {
      let worker;
      try {
        const workerMod = await import("./law-index.worker.js?worker");
        const LawIndexWorker = workerMod.default || workerMod;
        worker = new LawIndexWorker();
      } catch (e) {
        return false;
      }
      this._worker = worker;
      // Persistent listener for search results (retrieve() waits on these).
      worker.addEventListener("message", this._onWorkerMessage);
      // One-shot listener for the init sequence, removed on settle.
      const initOk = new Promise((resolve, reject) => {
        const onMsg = (e) => {
          const msg = e.data || {};
          if (msg.type === "progress") {
            this.indexProgress = msg.percent || 0;
            // fromCache arrives with the first progress message, so the status
            // line shows the right variant during the whole build, not just
            // after `ready`.
            if (typeof msg.fromCache === "boolean") {
              this.indexFromCache = msg.fromCache;
            }
          } else if (msg.type === "ready") {
            // Persist the version pointer the worker discovered, so future
            // visits can hit the IndexedDB cache without a network fetch.
            if (msg.version != null) this._writeCachedVersion(msg.version);
            this.indexFromCache = !!msg.fromCache;
            cleanup();
            resolve();
          } else if (msg.type === "error") {
            cleanup();
            reject(new Error(msg.message || "worker error"));
          }
        };
        const onErr = () => {
          cleanup();
          reject(new Error("worker error"));
        };
        const cleanup = () => {
          worker.removeEventListener("message", onMsg);
          worker.removeEventListener("error", onErr);
        };
        worker.addEventListener("message", onMsg);
        worker.addEventListener("error", onErr);
        worker.postMessage({
          type: "init",
          corpusUrl: withBase("/law-corpus.json"),
          cachedVersion: this._readCachedVersion(),
        });
      });
      try {
        await initOk;
        return true;
      } catch (e) {
        this._teardownWorker();
        return false;
      }
    },
    // Routes worker replies for pending searches (see retrieve()).
    _onWorkerMessage(e) {
      const msg = e.data || {};
      if (msg.type === "results" && msg.requestId != null) {
        const resolve = this._searchWaiters.get(msg.requestId);
        if (resolve) {
          this._searchWaiters.delete(msg.requestId);
          resolve(msg.hits || []);
        }
      } else if (msg.type === "error" && msg.requestId != null) {
        const resolve = this._searchWaiters.get(msg.requestId);
        if (resolve) {
          this._searchWaiters.delete(msg.requestId);
          resolve([]);
        }
      }
    },
    _teardownWorker() {
      if (this._worker) {
        this._worker.removeEventListener("message", this._onWorkerMessage);
        try {
          this._worker.terminate();
        } catch (e) {
          /* ignore */
        }
        this._worker = null;
      }
    },
    // Main-thread fallback: the pre-worker path (IndexedDB cache -> fetch ->
    // chunked MiniSearch build with yields). Kept so the widget works even
    // where Web Workers are unavailable.
    async _indexOnMainThread() {
      const MiniSearchCls = MiniSearch || (await import("minisearch")).default;
      MiniSearch = MiniSearchCls;

      // Resolve the corpus: try the IndexedDB cache first (keyed by the
      // corpus `version`), then fall back to a network fetch and persist
      // the result. On a cache hit the 2.6MB gzip download is skipped
      // entirely — the biggest win on a slow link. The cache is best-effort
      // and versioned, so a stale corpus never loads after a rebuild.
      let data = null;
      try {
        const lastVer = this._readCachedVersion();
        if (lastVer != null) {
          const cached = await getCachedCorpus(lastVer);
          if (cached) {
            data = cached;
            this.indexFromCache = true;
          }
        }
      } catch (e) {
        /* cache miss -> fall through to network */
      }

      if (!data) {
        const resp = await fetch(withBase("/law-corpus.json"));
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        data = await resp.json();
        // Persist for next time (best-effort). The version field gates the
        // cache key, so an updated corpus with a new version replaces the
        // old entry automatically (see setCachedCorpus pruning).
        if (data && data.version != null) {
          this._writeCachedVersion(data.version);
          setCachedCorpus(data.version, data).catch(() => {});
        }
      }

      const mini = new MiniSearch({
        fields: ["t", "n", "c"],
        storeFields: ["n", "a", "c", "u", "t"],
        tokenize: cjkTokenize,
        searchOptions: {
          tokenize: cjkTokenize,
          boost: { n: 3, c: 1.5 },
          combineWith: "OR",
        },
      });
      // Chunked build with yields: the page stays interactive (no
      // "unresponsive" dialog) and indexProgress ticks up as feedback.
      const total = data.docs.length;
      for (let i = 0; i < total; i += INDEX_CHUNK_DOCS) {
        mini.addAll(data.docs.slice(i, i + INDEX_CHUNK_DOCS));
        this.indexProgress = Math.min(
          100,
          Math.round(((i + INDEX_CHUNK_DOCS) / total) * 100)
        );
        await yieldToUI();
      }
      this._mini = mini;
      this.indexState = "ready";
    },
    // localStorage pointer to the last cached corpus version. Cheaper than
    // scanning IndexedDB keys on every open; the authoritative check is still
    // the version field inside the cached entry.
    _readCachedVersion() {
      try {
        const v = localStorage.getItem("jl_corpus_version");
        return v == null ? null : Number(v);
      } catch (e) {
        return null;
      }
    },
    _writeCachedVersion(v) {
      try {
        localStorage.setItem("jl_corpus_version", String(v));
      } catch (e) {
        /* ignore */
      }
    },
    // Search the index. With a worker present the query is posted there and
    // the hits arrive back via _onWorkerMessage; otherwise we fall back to the
    // in-page MiniSearch built by _indexOnMainThread.
    retrieve(q) {
      if (this._worker) {
        const requestId = ++this._searchSeq;
        return new Promise((resolve) => {
          this._searchWaiters.set(requestId, resolve);
          try {
            this._worker.postMessage({
              type: "search",
              query: q,
              topK: TOP_K,
              requestId,
            });
          } catch (e) {
            this._searchWaiters.delete(requestId);
            resolve([]);
          }
        });
      }
      if (!this._mini) return Promise.resolve([]);
      return Promise.resolve(searchLaws(this._mini, q, TOP_K));
    },
    buildMessages(q, ctx) {
      const blocks = ctx
        .map((c) => {
          const t = c.t.length > MAX_CHUNK_CHARS ? c.t.slice(0, MAX_CHUNK_CHARS) + "…" : c.t;
          return `《${c.n}》${c.c ? "（" + c.c + "）" : ""}\n${t}`;
        })
        .join("\n\n");
      const system =
        "你是严谨的中国法律检索助手。只依据【可参考法条】中的内容回答用户问题，" +
        "并在回答中明确引用法律名称与条号（如《中华人民共和国民法典》第X条）。" +
        "如果检索到的法条与问题明显不是同一程序或领域，不要硬套，直接说明未能检索到对应条文，" +
        "可以点出通常应查找哪一类程序法，但不要编造条号或法条内容。" +
        "回答用简体中文，条理清晰，必要时分点。最后提示重大事项应咨询执业律师。";
      const user =
        `用户问题：${q}\n\n【可参考法条】\n${blocks || "（未检索到相关法条）"}`;
      return [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
    },
    async ask(preset) {
      const q = (preset || this.question).trim().slice(0, MAX_QUESTION_CHARS);
      if (!q || this.loading) return;
      if (!this.configured) {
        this.showSettings = true;
        return;
      }
      this.question = q;
      this.loading = true;
      this.answer = "";
      this.reasoning = "";
      this.sources = [];
      this.error = "";

      this.loadMarkdown();
      try {
        await this.ensureIndex();
      } catch (e) {
        this.loading = false;
        return;
      }
      const ctx = await this.retrieve(q);
      this.sources = ctx;
      this.scrollDown();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const url = this.cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + this.cfg.apiKey,
          },
          body: JSON.stringify({
            model: this.cfg.model,
            messages: this.buildMessages(q, ctx),
            temperature: 0.2,
            stream: true,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          let detail = "";
          try {
            detail = (await resp.text()).slice(0, 300);
          } catch (e) {
            /* ignore */
          }
          throw new Error("HTTP " + resp.status + (detail ? "：" + detail : ""));
        }
        if (!resp.body) throw new Error("无响应流");
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let streamFinished = false;
        try {
          // eslint-disable-next-line no-constant-condition
          while (!streamFinished) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") {
                streamFinished = true;
                buf = "";
                try {
                  await reader.cancel();
                } catch (_) {}
                break;
              }
              let evt;
              try {
                evt = JSON.parse(payload);
              } catch (e) {
                continue;
              }
              const deltaObj =
                evt.choices && evt.choices[0] ? evt.choices[0].delta : null;
              if (deltaObj) {
                const thinking =
                  deltaObj.reasoning_content || deltaObj.reasoning || "";
                const delta = deltaObj.content || deltaObj.text || "";
                if (thinking) this.reasoning += thinking;
                if (delta) {
                  this.answer += delta;
                  this.scrollDown();
                } else if (thinking) {
                  this.scrollDown();
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!this.answer) {
          if (this.reasoning) {
            this.answer = this.reasoning;
            this.reasoning = "";
          } else {
            this.error = "模型未返回内容，请检查模型名称或额度。";
          }
        }
      } catch (e) {
        if (e && e.name === "AbortError") {
          this.error = "回答超时，请稍后重试或换个问法。";
        } else if (e && e.name === "TypeError") {
          // fetch threw before any HTTP response -> almost always CORS/network.
          this.error =
            "无法连接该接口（可能被 CORS 拦截或网络不可达）。注意：OpenAI 官方端点和商汤 SenseNova（token.sensenova.cn）都不允许浏览器直连，" +
            "请改用 DeepSeek、通义千问、智谱等支持跨域的兼容服务或自建网关；并确认 Base URL 正确。";
        } else {
          this.error = "调用失败：" + (e && e.message ? e.message : String(e));
        }
      } finally {
        clearTimeout(timer);
        this.loading = false;
        this.scrollDown();
      }
    },
  },
};
</script>

<style scoped>
.jl-chat {
  --jl-brand: #b13a2e;
}
.jl-chat__fab {
  position: fixed;
  right: 20px;
  /* 抬高到「上一页/下一页」分页行之上，避免遮挡正文页脚导航 */
  bottom: 76px;
  z-index: 1000;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border: 0;
  border-radius: 999px;
  background: var(--jl-brand);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(177, 58, 46, 0.35);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.jl-chat__fab:hover {
  filter: brightness(1.05);
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(177, 58, 46, 0.42);
}
.jl-chat__fab-icon {
  font-size: 18px;
}
.jl-chat__panel {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  width: 380px;
  max-width: calc(100vw - 32px);
  height: 560px;
  max-height: calc(100vh - 40px);
  background: #fdfbf6;
  border: 1px solid #e6dfcf;
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(59, 44, 24, 0.18);
  overflow: hidden;
}
.jl-chat__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--jl-brand);
  color: #fff;
}
.jl-chat__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.jl-chat__sub {
  display: block;
  font-size: 11px;
  opacity: 0.85;
  font-weight: 400;
}
.jl-chat__icon {
  background: transparent;
  border: 0;
  color: #fff;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.jl-chat__icon:hover {
  background: rgba(255, 255, 255, 0.18);
}
.jl-chat__settings {
  padding: 14px 16px;
  overflow-y: auto;
  font-size: 13px;
  color: #333;
}
.jl-chat__disclaimer {
  background: #fff6f5;
  border-bottom: 1px solid #ffd9d4;
  padding: 8px 14px;
  font-size: 12px;
  color: #a8331f;
  line-height: 1.5;
}
.jl-chat__body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}
.jl-chat__hint {
  font-size: 13px;
  color: #666;
  margin: 0 0 8px;
  line-height: 1.6;
}
.jl-chat__hint-link {
  color: var(--jl-brand);
}
.jl-chat__chip {
  display: inline-block;
  margin: 0 6px 6px 0;
  padding: 6px 10px;
  border: 1px solid #eadbd9;
  border-radius: 999px;
  background: #fff;
  color: #444;
  font-size: 12px;
  cursor: pointer;
}
.jl-chat__chip:hover {
  border-color: var(--jl-brand);
  color: var(--jl-brand);
}
.jl-chat__answer {
  font-size: 14px;
  line-height: 1.7;
  color: #222;
  word-break: break-word;
}
.jl-chat__answer :deep(p) {
  margin: 0 0 10px;
}
.jl-chat__error {
  font-size: 13px;
  color: #a8331f;
  background: #fff6f5;
  border: 1px solid #ffd9d4;
  border-radius: 8px;
  padding: 10px 12px;
  line-height: 1.5;
}
.jl-chat__status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #666;
  line-height: 1.6;
}
.jl-chat__status-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--jl-brand);
  animation: jl-chat-pulse 1.2s ease-in-out infinite;
}
@keyframes jl-chat-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
.jl-chat__sources {
  margin-top: 14px;
  border-top: 1px dashed #eee;
  padding-top: 10px;
}
.jl-chat__sources > summary {
  font-size: 12px;
  color: #888;
  margin: 0;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.jl-chat__sources > summary::-webkit-details-marker {
  display: none;
}
.jl-chat__sources > summary::before {
  content: "▸ ";
  color: var(--jl-brand);
}
.jl-chat__sources[open] > summary {
  margin-bottom: 8px;
}
.jl-chat__sources[open] > summary::before {
  content: "▾ ";
}
.jl-chat__src {
  display: block;
  padding: 8px 10px;
  margin-bottom: 8px;
  border: 1px solid #eee;
  border-radius: 8px;
  text-decoration: none;
  color: #333;
}
.jl-chat__src:hover {
  border-color: var(--jl-brand);
  background: #fffafa;
}
.jl-chat__src-title {
  display: inline;
  font-weight: 600;
  color: var(--jl-brand);
  font-size: 13px;
}
.jl-chat__badge {
  display: inline-block;
  margin-left: 8px;
  font-size: 11px;
  color: #999;
}
.jl-chat__src-ctx {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #666;
  line-height: 1.5;
}
.jl-chat__inputbar {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #eee;
}
.jl-chat__input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid #ddd;
  border-radius: 999px;
  font-size: 13px;
  outline: none;
  background: #fff;
  color: #1a1a1a;
}
.jl-chat__input:focus {
  border-color: var(--jl-brand);
}
.jl-chat__send {
  padding: 9px 16px;
  border: 0;
  border-radius: 999px;
  background: var(--jl-brand);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.jl-chat__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.jl-chat__think {
  margin: 10px 0 12px;
  font-size: 12px;
  color: #666;
}
.jl-chat__think summary {
  cursor: pointer;
  color: #888;
}
.jl-chat__think pre {
  margin: 8px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: #555;
}
</style>

<style>
html.dark .jl-chat {
  --jl-brand: #d4614c;
}
html.dark .jl-chat__panel {
  background: #1e1a15;
  border-color: #342d23;
}
html.dark .jl-chat__settings,
html.dark .jl-chat__settings-intro,
html.dark .jl-chat__answer,
html.dark .jl-chat__src {
  color: #e8e8e8;
}
html.dark .jl-chat__field input,
html.dark .jl-chat__input {
  background: #1f1f1f;
  border-color: #444;
  color: #f2f2f2;
}
html.dark .jl-chat__body,
html.dark .jl-chat__hint,
html.dark .jl-chat__status,
html.dark .jl-chat__src-ctx,
html.dark .jl-chat__badge,
html.dark .jl-chat__sources > summary,
html.dark .jl-chat__note {
  color: #b5b5b5;
}
html.dark .jl-chat__disclaimer,
html.dark .jl-chat__error {
  background: #2a1614;
  border-color: #5a2a24;
  color: #f0b4aa;
}
html.dark .jl-chat__chip {
  background: #1f1f1f;
  border-color: #444;
  color: #ddd;
}
html.dark .jl-chat__src {
  border-color: #333;
  background: #1a1a1a;
}
html.dark .jl-chat__src:hover {
  background: #241818;
}
html.dark .jl-chat__inputbar,
html.dark .jl-chat__sources {
  border-color: #333;
}
html.dark .jl-chat__think,
html.dark .jl-chat__think pre {
  color: #aaa;
}
</style>
