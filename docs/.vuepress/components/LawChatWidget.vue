<!-- @ts-nocheck -->
<!--
  Floating "AI 法律问答" chat widget for the Just Laws VuePress site.

  Fully client-side, no backend (BYOK = bring your own key):
  - Multi-turn chat: the transcript (user bubble + assistant answer + per-turn
    citations) lives in `turns`; the last few exchanges are folded back into
    the prompt so follow-up questions keep their context.
  - Lazy-loads /law-corpus.json (article-level law chunks) on first open.
  - Builds the lexical index in a Web Worker (MiniSearch + a CJK bi-gram
    tokenizer) so the ~15 s of CPU never blocks the main thread; the parsed
    corpus is cached in IndexedDB (see law-corpus-cache.js) so repeat opens
    skip the multi-MB re-download that GitHub Pages' 10-minute Cache-Control
    forces. Searches also run inside the worker. Retrieval queries are cleaned
    of interrogative filler (怎么办/吗/…) so the bigrams fed to the index are
    the topic terms; short follow-ups inherit the previous question's terms.
  - If Web Workers are unavailable (very old browsers / restrictive CSP), the
    widget transparently falls back to building the index on the main thread
    with the same chunked yields as before.
  - Sends the retrieved 法条 + question to a user-supplied OpenAI-compatible
    chat endpoint and streams the answer. Streamed markdown is re-rendered on
    a ~120 ms throttle (not per token); a 30 s first-byte watchdog and a 60 s
    inter-chunk idle watchdog replace the old flat 90 s cap, so long reasoning
    models are never cut off mid-answer. A 停止 button aborts on demand.
  - Renders citations as clickable deep-links back into the law text — both
    the per-turn source cards and 《法》第X条 mentions inside the answer body.
  - The API key is stored only in the user's browser (localStorage) and sent
    directly to their chosen provider — it never touches our servers.
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
      <section
        v-if="open"
        class="jl-chat__panel"
        role="dialog"
        aria-modal="false"
        aria-label="AI 法律问答"
      >
        <header class="jl-chat__header">
          <div>
            <strong>AI 法律问答</strong>
            <span class="jl-chat__sub">本地检索法条 · 自带模型 Key</span>
          </div>
          <div class="jl-chat__actions">
            <button
              v-if="turns.length && !showSettings"
              class="jl-chat__icon"
              type="button"
              aria-label="开启新对话"
              title="开启新对话"
              @click="newChat"
            >
              ＋
            </button>
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

          <div ref="bodyEl" class="jl-chat__body" role="log">
            <div v-if="indexState === 'loading'" class="jl-chat__status">
              <span class="jl-chat__status-dot"></span>
              <template v-if="indexFromCache">
                已从本地缓存读取法条，正在后台构建索引 {{ indexProgress }}%…（页面可正常浏览）
              </template>
              <template v-else>
                正在下载法条语料并在后台构建索引 {{ indexProgress }}%…（仅首次较慢，页面可正常浏览）
              </template>
            </div>
            <div v-if="indexError" class="jl-chat__error">{{ indexError }}</div>

            <div v-if="!turns.length" class="jl-chat__examples">
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

            <div
              v-for="turn in turns"
              :key="turn.id"
              class="jl-chat__turn"
              :class="turn.role === 'user' ? 'jl-chat__turn--user' : 'jl-chat__turn--bot'"
            >
              <div v-if="turn.role === 'user'" class="jl-chat__bubble">
                {{ turn.text }}
              </div>
              <template v-else>
                <details v-if="turn.reasoning" class="jl-chat__think">
                  <summary>模型思考过程</summary>
                  <pre>{{ turn.reasoning }}</pre>
                </details>

                <!-- eslint-disable-next-line vue/no-v-html -->
                <div
                  v-if="turn.html"
                  class="jl-chat__answer"
                  v-html="turn.html"
                ></div>

                <!-- Reasoning models stream long "thinking" deltas before any
                     answer content; without this line the turn looks frozen.
                     Hidden while the corpus index is still building — that
                     step shows its own progress line above. -->
                <div
                  v-if="turn.streaming && !turn.text && !turn.error && indexState !== 'loading'"
                  class="jl-chat__status"
                >
                  <span class="jl-chat__status-dot"></span>
                  <template v-if="turn.reasoning"
                    >模型思考中…（已输出 {{ turn.reasoning.length }} 字推理，正式回答随后显示）</template
                  >
                  <template v-else>正在检索法条并等待模型响应…</template>
                </div>

                <div v-if="turn.error" class="jl-chat__error">
                  {{ turn.error }}
                </div>

                <!-- Collapsed by default so the streamed answer stays
                     primary; expand to check the original articles. -->
                <details v-if="turn.sources.length" class="jl-chat__sources">
                  <summary>
                    <span class="jl-chat__disclosure" aria-hidden="true">▸</span>
                    参考来源（{{ turn.sources.length }} 条法条，展开核对原文）
                  </summary>
                  <a
                    v-for="(s, i) in turn.sources"
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

                <div v-if="!turn.streaming && turn.text" class="jl-chat__turn-actions">
                  <button
                    class="jl-chat__mini"
                    type="button"
                    @click="copyTurn(turn)"
                  >
                    {{ turn.copied ? "已复制 ✓" : "复制答案" }}
                  </button>
                </div>
              </template>
            </div>
          </div>

          <form class="jl-chat__inputbar" @submit.prevent="ask()">
            <input
              v-model="question"
              class="jl-chat__input"
              type="text"
              maxlength="4000"
              :placeholder="configured ? '用一句话描述你的法律问题…' : '请先在 ⚙ 设置里填入模型 API'"
              enterkeyhint="send"
            />
            <button
              v-if="loading"
              class="jl-chat__send jl-chat__send--stop"
              type="button"
              @click="stop"
            >
              停止
            </button>
            <button
              v-else
              class="jl-chat__send"
              type="submit"
              :disabled="!configured"
            >
              提问
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
import {
  SETTINGS_EVENT,
  loadCfg,
  describeHttpError,
  CORS_HINT,
} from "./chat-settings";
import { cjkTokenize, searchLaws } from "./law-retrieve.js";
import {
  createRequestGeneration,
  applyIfCurrent,
} from "./law-chat-request.js";
import { getCachedCorpus, setCachedCorpus } from "./law-corpus-cache.js";

// markdown-it and minisearch are heavy and only needed once the user actually
// opens the chat. They are dynamically imported on demand (see loadMarkdown /
// ensureIndex) so they are split into separate chunks and never block the
// initial page load — important on slow networks (e.g. GitHub Pages in China).
let md = null; // markdown-it instance, lazily created
let MiniSearch = null; // minisearch class, lazily imported (main-thread fallback)

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const TOP_K = 6; // number of 法条 fed to the model
const MAX_CHUNK_CHARS = 600; // cap each 法条's length in the prompt

const MAX_QUESTION_CHARS = 4000;

// Watchdogs for the streamed completion: a first-byte cap (covers DNS/TLS/
// CORS stalls + a server that never starts) and an inter-chunk idle cap. The
// total stream length is NOT capped — reasoning models legitimately run for
// minutes while chunks keep arriving.
const TTFB_TIMEOUT_MS = 30000;
const IDLE_TIMEOUT_MS = 60000;

// Re-render the streamed markdown at most this often. Per-token md.render()
// makes total work quadratic in answer length and janks low-end phones.
const RENDER_INTERVAL_MS = 120;

// Multi-turn: fold the last N exchanges (and at most this many chars) back
// into the prompt so follow-ups keep their context without token bloat.
const HISTORY_MAX_TURNS = 3;
const HISTORY_MAX_CHARS = 4000;

// A follow-up this short ("那诉讼时效呢？") has no retrieval terms of its
// own — its query is merged with the previous user question. Stop-unigram
// dropping and colloquial→legal expansion happen in law-retrieve.js
// (worker-side searchLaws) on the merged string.
const FOLLOWUP_MERGE_MAX_CHARS = 12;

// Truncate a 法条 on a sentence boundary when one exists in the back half,
// so the model never receives half a sentence.
function clampChunk(t, max) {
  const s = String(t || "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  let stop = -1;
  for (const mark of ["。", "；", "！", "？", "："]) {
    const p = cut.lastIndexOf(mark);
    if (p > stop) stop = p;
  }
  return (stop >= Math.floor(max / 2) ? cut.slice(0, stop + 1) : cut) + "…";
}

// ---- Citation matching: 《法名》第X条 in the answer -> deep link ----

const CITE_RE =
  /《([^《》]{2,40})》\s*(第[0-9〇零一二三四五六七八九十百千万]+条(?:之[0-9〇零一二三四五六七八九十百千]+)?)/g;

function cnToArabic(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in digits) current = digits[ch];
    else if (ch in units) {
      const u = units[ch];
      if (u === 10000) {
        section = (section + current) * u;
        total += section;
        section = 0;
      } else {
        section += (current || 1) * u;
      }
      current = 0;
    } else return null;
  }
  return total + section + current;
}

function articleNumber(a) {
  const m = /第([0-9〇零一二三四五六七八九十百千万]+)条/.exec(String(a || ""));
  return m ? cnToArabic(m[1]) : null;
}

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

// Tokenizer for Chinese legal text (imported from law-retrieve.js so the
// widget and the worker share one implementation): lowercased ASCII word
// runs as-is, CJK runs emit unigrams + bigrams. Used for BOTH indexing and
// querying so lexical recall works without word segmentation or any model
// download.

function resolveEnabled() {
  if (
    typeof window !== "undefined" &&
    typeof window.__JUSTLAWS_RAG_ENABLED__ !== "undefined"
  ) {
    return (
      window.__JUSTLAWS_RAG_ENABLED__ !== false &&
      !["false", "0", "off", "no"].includes(
        String(window.__JUSTLAWS_RAG_ENABLED__).toLowerCase(),
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
      turns: [], // transcript: {id, role, text} | {id, role, text, html, reasoning, sources, error, streaming, copied}
      loading: false,
      indexState: "idle", // idle | loading | ready | error
      indexProgress: 0, // % while indexState === "loading"
      indexFromCache: false, // true when corpus came from IndexedDB (no network)
      indexError: "",
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
    configured() {
      return !!(this.cfg.baseUrl && this.cfg.apiKey && this.cfg.model);
    },
    settingsPageUrl() {
      return withBase("/settings/");
    },
  },
  watch: {
    // Esc closes the panel (removed again on close / unmount).
    open(v) {
      if (typeof window === "undefined" || !this._onKeydown) return;
      if (v) window.addEventListener("keydown", this._onKeydown);
      else window.removeEventListener("keydown", this._onKeydown);
    },
  },
  async created() {
    this._requestGate = createRequestGeneration();
    if (typeof window === "undefined") return;
    // Non-reactive plumbing (kept off Vue's reactive proxy — a proxied
    // Worker breaks postMessage's `this` binding).
    this._worker = null;
    this._searchSeq = 0;
    this._searchWaiters = new Map();
    this._turnSeq = 0;
    this._renderTimer = null;
    this._activeController = null;
    this._stopReason = ""; // "" | "user" | "ttfb" | "idle"
    this._onKeydown = (e) => {
      if (e.key === "Escape") this.open = false;
    };
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
    if (this._requestGate) this._requestGate.next();
    if (this._activeController) {
      try {
        this._activeController.abort();
      } catch (e) {
        /* ignore */
      }
      this._activeController = null;
    }
    if (typeof window !== "undefined") {
      if (this._onSettingsSaved) {
        window.removeEventListener(SETTINGS_EVENT, this._onSettingsSaved);
      }
      if (this._onKeydown) {
        window.removeEventListener("keydown", this._onKeydown);
      }
    }
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  },
  methods: {
    // 开启新对话：invalidate the in-flight generation so its finally/timer
    // cannot clear loading or null the next request's AbortController.
    newChat() {
      this._requestGate.next();
      this._stopReason = "user";
      if (this._activeController) {
        try {
          this._activeController.abort();
        } catch (e) {
          /* ignore */
        }
        this._activeController = null;
      }
      this.turns = [];
      this.question = "";
      this.loading = false;
      this.showSettings = false;
    },
    openPanel() {
      this.open = true;
      // Opening from the FAB always lands on chat for configured users —
      // showSettings may be left over from a previous panel session.
      this.showSettings = !this.configured;
      // Warm up the heavy chunks (corpus index + markdown renderer) as soon as
      // the panel opens, in parallel, so the first question feels responsive.
      this.ensureIndex();
      this.loadMarkdown();
    },
    async loadMarkdown() {
      if (md) return;
      try {
        const mod = await import("markdown-it");
        const MarkdownIt = mod.default || mod;
        // html:false escapes any raw HTML in the model output, and markdown-it's
        // default link validator strips javascript:/data: URLs, so rendering the
        // answer with v-html is safe against injection from the LLM response.
        md = new MarkdownIt({ html: false, linkify: true, breaks: true });
        // Open rendered links in a new tab so a click never navigates the
        // whole SPA away from the law page the reader is on.
        const orig = md.renderer.rules.link_open;
        md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
          const token = tokens[idx];
          let i = token.attrIndex("target");
          if (i < 0) token.attrPush(["target", "_blank"]);
          else token.attrs[i][1] = "_blank";
          i = token.attrIndex("rel");
          if (i < 0) token.attrPush(["rel", "noopener noreferrer"]);
          else token.attrs[i][1] = "noopener noreferrer";
          return orig
            ? orig(tokens, idx, options, env, self)
            : self.renderToken(tokens, idx, options);
        };
      } catch (e) {
        /* fall back to escaped plain text in renderTurn */
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
    // Stick to the bottom while streaming — but only when the reader is
    // already near the bottom, so scrolling up to re-read is never yanked.
    scrollDown(force) {
      this.$nextTick(() => {
        const el = this.$refs.bodyEl;
        if (!el) return;
        const nearBottom =
          force || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (nearBottom) el.scrollTop = el.scrollHeight;
      });
    },
    async ensureIndex() {
      if (this._indexPromise) return this._indexPromise;
      this.indexState = "loading";
      this.indexProgress = 0;
      this.indexError = "";
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
          this.indexError = "法条索引加载失败，请刷新页面重试。";
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

      const mini = new MiniSearchCls({
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
          Math.round(((i + INDEX_CHUNK_DOCS) / total) * 100),
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
    // Retrieval terms for a question: a short follow-up inherits the previous
    // question's terms; stop-unigram filtering and colloquial→legal expansion
    // are applied by law-retrieve.js inside searchLaws (worker or fallback).
    buildRetrievalQuery(q, currentUserTurn) {
      if (q.length > FOLLOWUP_MERGE_MAX_CHARS) return q;
      const prev = this.turns.filter(
        (t) => t.role === "user" && t !== currentUserTurn,
      );
      const last = prev[prev.length - 1];
      return last && last.text ? last.text + "，" + q : q;
    },
    buildMessages(q, ctx, history) {
      const blocks = ctx
        .map((c) => {
          const t = clampChunk(c.t, MAX_CHUNK_CHARS);
          return `《${c.n}》${c.c ? "（" + c.c + "）" : ""}\n${t}`;
        })
        .join("\n\n");
      const system =
        "你是严谨的中国法律检索助手。这是一段多轮对话，请结合此前问答的上下文理解用户当前的问题。" +
        "只依据【可参考法条】中的内容回答，并在回答中明确引用法律名称与条号（如《中华人民共和国民法典》第X条）。" +
        "如果提供的法条不足以回答，请直接说明「现有法条不足以回答」，不要编造法条或条号。" +
        "回答用简体中文，条理清晰，必要时分点。最后提示重大事项应咨询执业律师。";
      const user =
        `用户问题：${q}\n\n【可参考法条】\n${blocks || "（未检索到相关法条）"}`;

      const msgs = [{ role: "system", content: system }];
      // Fold recent exchanges back in, newest-first under the char budget.
      let budget = HISTORY_MAX_CHARS;
      const prior = [];
      for (
        let i = history.length - 1;
        i >= 0 && prior.length < HISTORY_MAX_TURNS * 2;
        i--
      ) {
        const t = history[i];
        if (!t.text || t.error) continue;
        if (t.text.length > budget) break;
        budget -= t.text.length;
        prior.unshift({
          role: t.role === "user" ? "user" : "assistant",
          content: t.text,
        });
      }
      msgs.push(...prior);
      msgs.push({ role: "user", content: user });
      return msgs;
    },
    // ---- Streamed-answer rendering (throttled) ----

    applyDelta(turn, thinking, content) {
      if (thinking) turn.reasoning += thinking;
      if (content) turn.text += content;
      if (this._renderTimer) return; // a render is already scheduled
      if (!turn.html && turn.text) {
        // First visible token — paint at once, throttle everything after.
        this.renderTurn(turn);
        this.scrollDown();
        return;
      }
      this._renderTimer = setTimeout(() => {
        this._renderTimer = null;
        this.renderTurn(turn);
        this.scrollDown();
      }, RENDER_INTERVAL_MS);
    },
    renderTurn(turn) {
      if (!turn || !turn.text) {
        if (turn) turn.html = "";
        return;
      }
      const html = md
        ? md.render(turn.text)
        : escapeHtml(turn.text).replace(/\n/g, "<br>");
      turn.html = this.linkifyCitations(html, turn.sources);
    },
    // Wrap 《法名》第X条 mentions that match one of this turn's retrieved
    // sources in deep links to the law page. DOM-based (text nodes only), so
    // it can never corrupt the markdown-generated markup.
    linkifyCitations(html, sources) {
      if (!sources || !sources.length || !html.includes("《")) return html;
      if (typeof DOMParser === "undefined") return html;
      let doc;
      try {
        doc = new DOMParser().parseFromString(html, "text/html");
      } catch (e) {
        return html;
      }
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      const jobs = [];
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (parent && parent.closest("a, pre, code")) continue;
        const text = node.nodeValue || "";
        if (!text.includes("《")) continue;
        CITE_RE.lastIndex = 0;
        let m;
        while ((m = CITE_RE.exec(text)) !== null) {
          const hit = this.matchSource(sources, m[1], m[2]);
          if (hit) {
            jobs.push({
              node,
              start: m.index,
              end: m.index + m[0].length,
              url: this.srcUrl(hit.u),
              label: m[0].replace(/\s+/g, ""),
            });
          }
        }
      }
      if (!jobs.length) return html;
      // Replace per node from the end so earlier offsets stay valid.
      const byNode = new Map();
      for (const j of jobs) {
        if (!byNode.has(j.node)) byNode.set(j.node, []);
        byNode.get(j.node).push(j);
      }
      for (const list of byNode.values()) {
        list.sort((a, b) => b.start - a.start);
        for (const j of list) {
          const a = doc.createElement("a");
          a.href = j.url;
          a.target = "_blank";
          a.rel = "noopener";
          a.className = "jl-chat__cite";
          a.textContent = j.label;
          const range = doc.createRange();
          range.setStart(j.node, j.start);
          range.setEnd(j.node, j.end);
          range.deleteContents();
          range.insertNode(a);
        }
      }
      return doc.body.innerHTML;
    },
    // Cited "民法典" matches source "中华人民共和国民法典"; article numbers
    // are normalized across 中文/阿拉伯 numerals.
    matchSource(sources, citedName, citedArticle) {
      const bare = String(citedName || "").trim().replace(/^中华人民共和国/, "");
      if (!bare) return null;
      const want = articleNumber(citedArticle);
      return (
        sources.find((s) => {
          const sBare = String(s.n || "").replace(/^中华人民共和国/, "");
          if (!sBare) return false;
          if (!(sBare.includes(bare) || bare.includes(sBare))) return false;
          const got = articleNumber(s.a);
          return want == null || got == null || got === want;
        }) || null
      );
    },
    async copyTurn(turn) {
      let text = turn.text || "";
      if (turn.sources && turn.sources.length) {
        text +=
          "\n\n参考来源：\n" +
          turn.sources
            .map(
              (s) =>
                "· 《" + s.n + "》" + s.a + (s.c ? "（" + s.c + "）" : ""),
            )
            .join("\n");
      }
      if (!text.trim()) return;
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (e) {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand("copy");
          document.body.removeChild(ta);
        } catch (e2) {
          ok = false;
        }
      }
      if (ok) {
        turn.copied = true;
        setTimeout(() => {
          turn.copied = false;
        }, 1500);
      }
    },
    stop() {
      if (!this.loading) return;
      this._stopReason = "user";
      if (this._activeController) {
        try {
          this._activeController.abort();
        } catch (e) {
          /* ignore */
        }
      }
      // No controller yet (index still building / retrieving) — ask() checks
      // _stopReason between phases and bails out.
    },
    async ask(preset) {
      const q = (preset || this.question).trim().slice(0, MAX_QUESTION_CHARS);
      if (!q || this.loading) return;
      if (!this.configured) {
        this.showSettings = true;
        return;
      }
      const reqId = this._requestGate.next();
      this.question = "";
      this.loading = true;
      this._stopReason = "";

      let userTurn = { id: ++this._turnSeq, role: "user", text: q };
      let turn = {
        id: ++this._turnSeq,
        role: "assistant",
        text: "",
        html: "",
        reasoning: "",
        sources: [],
        error: "",
        streaming: true,
        copied: false,
      };
      this.turns.push(userTurn, turn);
      // Vue stores the raw objects; re-read through the reactive array so the
      // streaming mutations below (text/html/reasoning/copied) re-render.
      userTurn = this.turns[this.turns.length - 2];
      turn = this.turns[this.turns.length - 1];
      this.scrollDown(true);

      const isLive = () => this._requestGate.isLive(reqId);
      const releaseUi = () =>
        applyIfCurrent(this._requestGate, reqId, () => {
          this.loading = false;
          this._activeController = null;
        });
      const finishTurn = (stoppedMsg) => {
        turn.streaming = false;
        if (stoppedMsg && !turn.text && !turn.error) turn.error = stoppedMsg;
        this.renderTurn(turn);
      };

      const bailIfStopped = () => {
        if (!isLive()) {
          finishTurn("已停止生成。");
          return true;
        }
        if (this._stopReason !== "user") return false;
        finishTurn("已停止生成。");
        this.loading = false;
        return true;
      };

      this.loadMarkdown();
      try {
        await this.ensureIndex();
      } catch (e) {
        finishTurn();
        releaseUi();
        return; // indexError already shown at panel level
      }
      if (bailIfStopped()) return;

      const ctx = await this.retrieve(this.buildRetrievalQuery(q, userTurn));
      if (bailIfStopped()) return;
      turn.sources = ctx;
      this.scrollDown();

      const controller = new AbortController();
      if (!isLive()) {
        controller.abort();
        finishTurn("已停止生成。");
        return;
      }
      this._activeController = controller;
      let timer = null;
      const arm = (ms, reason) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!isLive()) return;
          this._stopReason = reason;
          controller.abort();
        }, ms);
      };

      try {
        const url = this.cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
        arm(TTFB_TIMEOUT_MS, "ttfb");
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + this.cfg.apiKey,
          },
          body: JSON.stringify({
            model: this.cfg.model,
            messages: this.buildMessages(q, ctx, this.turns.slice(0, -2)),
            temperature: 0.2,
            stream: true,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          let detail = "";
          try {
            detail = (await resp.text()).slice(0, 160);
          } catch (e) {
            /* ignore */
          }
          throw new Error(describeHttpError(resp.status, detail));
        }
        if (!resp.body) throw new Error("无响应流");
        arm(IDLE_TIMEOUT_MS, "idle");
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let streamFinished = false;
        try {
          // eslint-disable-next-line no-constant-condition
          while (!streamFinished) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!isLive()) {
              try {
                await reader.cancel();
              } catch (_) {}
              break;
            }
            arm(IDLE_TIMEOUT_MS, "idle"); // data flowing — only guard gaps
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
                if ((thinking || delta) && isLive()) {
                  this.applyDelta(turn, thinking, delta);
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!turn.text) {
          if (turn.reasoning) {
            turn.text = turn.reasoning;
            turn.reasoning = "";
          } else if (!turn.error) {
            turn.error = "模型未返回内容，请检查模型名称或额度。";
          }
        }
      } catch (e) {
        if (!isLive()) {
          finishTurn("已停止生成。");
        } else if (e && e.name === "AbortError") {
          if (this._stopReason === "user") {
            // User pressed 停止 — keep whatever already arrived.
            if (!turn.text) turn.error = "已停止生成。";
          } else if (this._stopReason === "ttfb") {
            turn.error =
              "等待模型响应超时（" +
              Math.round(TTFB_TIMEOUT_MS / 1000) +
              " 秒内没有任何数据），请稍后重试或换一个模型。";
          } else {
            turn.error =
              "回答中断（" +
              Math.round(IDLE_TIMEOUT_MS / 1000) +
              " 秒没有新内容），已生成的部分已保留，可重新提问。";
          }
        } else if (e && e.name === "TypeError") {
          // fetch threw before any HTTP response -> almost always CORS/network.
          turn.error = CORS_HINT;
        } else {
          turn.error = "调用失败：" + (e && e.message ? e.message : String(e));
        }
      } finally {
        clearTimeout(timer);
        applyIfCurrent(this._requestGate, reqId, () => {
          if (this._renderTimer) {
            clearTimeout(this._renderTimer);
            this._renderTimer = null;
          }
        });
        this.renderTurn(turn);
        turn.streaming = false;
        if (releaseUi()) this.scrollDown();
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
/* Phones: near-fullscreen sheet instead of the small corner panel. */
@media (max-width: 479.98px) {
  .jl-chat__panel {
    top: 8px;
    left: 8px;
    right: 8px;
    bottom: 8px;
    width: auto;
    max-width: none;
    height: auto;
    max-height: none;
  }
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
.jl-chat__turn {
  margin-bottom: 14px;
}
.jl-chat__turn--user {
  display: flex;
  justify-content: flex-end;
}
.jl-chat__bubble {
  max-width: 85%;
  padding: 8px 12px;
  background: rgba(177, 58, 46, 0.08);
  border: 1px solid rgba(177, 58, 46, 0.22);
  border-radius: 12px 12px 2px 12px;
  color: #7a2d23;
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
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
.jl-chat__turn-actions {
  margin-top: 8px;
}
.jl-chat__mini {
  border: 1px solid #e2dac9;
  background: transparent;
  color: #8a8273;
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 999px;
  cursor: pointer;
}
.jl-chat__mini:hover {
  border-color: var(--jl-brand);
  color: var(--jl-brand);
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
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #888;
  margin: 0 0 8px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.jl-chat__sources > summary::-webkit-details-marker {
  display: none;
}
.jl-chat__disclosure {
  flex-shrink: 0;
  color: #666;
  font-size: 14px;
  line-height: 1;
  transition: transform 0.15s ease;
}
.jl-chat__sources[open] .jl-chat__disclosure {
  transform: rotate(90deg);
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
  white-space: nowrap;
}
.jl-chat__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.jl-chat__send--stop {
  background: #6f6a5e;
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
html.dark .jl-chat__bubble {
  background: rgba(212, 97, 76, 0.14);
  border-color: rgba(212, 97, 76, 0.32);
  color: #eac4bc;
}
html.dark .jl-chat__mini {
  border-color: #4a443a;
  color: #b0a898;
}
html.dark .jl-chat__send--stop {
  background: #5a544a;
}

/* v-html content is not covered by scoped styles, so the in-answer citation
   link lives here (global). */
.jl-chat__cite {
  color: var(--jl-brand, #b13a2e);
  font-weight: 600;
  text-decoration: none;
  border-bottom: 1px dashed var(--jl-brand, #b13a2e);
}
.jl-chat__cite:hover {
  border-bottom-style: solid;
}
</style>
