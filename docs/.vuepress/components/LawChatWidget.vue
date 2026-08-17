<!-- @ts-nocheck -->
<!--
  Floating "AI 法律问答" chat widget for the Just Laws VuePress site.

  Fully client-side, no backend (BYOK = bring your own key):
  - Lazy-loads /law-corpus.json (article-level law chunks) on first open.
  - Builds a lexical index in the browser (MiniSearch + a CJK bi-gram tokenizer)
    and retrieves the top-k 法条 for the question.
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

        <!-- Settings (BYOK) -->
        <div v-if="showSettings" class="jl-chat__settings">
          <p class="jl-chat__settings-intro">
            填入任意 <strong>OpenAI 兼容</strong> 接口（如 DeepSeek、通义千问、智谱 GLM
            等）。Key 仅保存在你本机浏览器、直接发往你选择的服务商，<strong>不会经过本站</strong>。
          </p>
          <label class="jl-chat__field">
            <span>接口地址 Base URL</span>
            <input
              v-model.trim="cfg.baseUrl"
              type="text"
              placeholder="https://api.deepseek.com/v1"
            />
          </label>
          <label class="jl-chat__field">
            <span>API Key</span>
            <input
              v-model.trim="cfg.apiKey"
              type="password"
              autocomplete="off"
              placeholder="sk-..."
            />
          </label>
          <label class="jl-chat__field">
            <span>模型 Model</span>
            <input v-model.trim="cfg.model" type="text" placeholder="deepseek-chat" />
          </label>
          <div class="jl-chat__settings-row">
            <details class="jl-chat__presets">
              <summary>常用预设</summary>
              <button
                v-for="p in presets"
                :key="p.name"
                type="button"
                class="jl-chat__chip"
                @click="applyPreset(p)"
              >
                {{ p.name }}
              </button>
            </details>
            <button class="jl-chat__send" type="button" @click="saveSettings">
              保存
            </button>
          </div>
          <p class="jl-chat__note">
            注：OpenAI 官方端点（api.openai.com）不允许浏览器直连，会被 CORS 拦截；
            请使用国产兼容服务、自建网关或 Azure OpenAI。
          </p>
        </div>

        <!-- Chat -->
        <template v-else>
          <div class="jl-chat__disclaimer">
            ⚠️ 本工具基于已收录法条 + 你选择的大模型自动整理，仅供参考、不构成法律意见。重大事项请咨询执业律师。
          </div>

          <div ref="bodyEl" class="jl-chat__body">
            <div v-if="!answer && !sources.length && !error" class="jl-chat__examples">
              <p v-if="!configured" class="jl-chat__hint">
                先到右上角 ⚙ 设置里填入你的模型 API，即可开始提问。
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

            <div v-if="sources.length" class="jl-chat__sources">
              <h4>参考来源（{{ sources.length }} 条法条，点击核对原文）</h4>
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
            </div>
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

const LS = {
  base: "jl_chat_base_url",
  key: "jl_chat_api_key",
  model: "jl_chat_model",
  wrap: "jl_chat_wrap_jwk",
};

const MAX_QUESTION_CHARS = 4000;

function bytesToB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

async function getWrapKey() {
  const raw = localStorage.getItem(LS.wrap);
  if (raw) {
    try {
      const jwk = JSON.parse(raw);
      return await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "AES-GCM" },
        true,
        ["encrypt", "decrypt"]
      );
    } catch (e) {
      /* regenerate below */
    }
  }
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  localStorage.setItem(LS.wrap, JSON.stringify(jwk));
  return key;
}

async function encryptSecret(plain) {
  if (!plain) return "";
  if (!globalThis.crypto || !crypto.subtle) return plain;
  const key = await getWrapKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  return "enc:v1:" + bytesToB64(iv) + "." + bytesToB64(new Uint8Array(buf));
}

async function decryptSecret(stored) {
  if (!stored) return "";
  if (!stored.startsWith("enc:v1:")) return stored;
  const payload = stored.slice("enc:v1:".length);
  const dot = payload.indexOf(".");
  if (dot < 0) return "";
  const key = await getWrapKey();
  const iv = b64ToBytes(payload.slice(0, dot));
  const data = b64ToBytes(payload.slice(dot + 1));
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(buf);
}

const PRESETS = [
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  {
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  { name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
];

// Tokenizer for Chinese legal text: emit lowercased ASCII word runs as-is, and
// for CJK runs emit unigrams + bigrams. Used for BOTH indexing and querying so
// lexical recall works without word segmentation or any model download.
function cjkTokenize(str) {
  if (!str) return [];
  const tokens = [];
  const re = /[\u4e00-\u9fff]+|[a-zA-Z0-9]+/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const run = m[0];
    if (/[a-zA-Z0-9]/.test(run[0])) {
      tokens.push(run.toLowerCase());
    } else {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]);
        if (i + 1 < run.length) tokens.push(run[i] + run[i + 1]);
      }
    }
  }
  return tokens;
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
      mdReady: false, // markdown-it loaded (lazy)
      cfg: { baseUrl: "", apiKey: "", model: "" },
      presets: PRESETS,
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
  },
  async created() {
    if (typeof window === "undefined") return;
    try {
      this.cfg.baseUrl = localStorage.getItem(LS.base) || "";
      this.cfg.model = localStorage.getItem(LS.model) || "";
      const stored = localStorage.getItem(LS.key) || "";
      this.cfg.apiKey = stored ? await decryptSecret(stored) : "";
      if (stored && !stored.startsWith("enc:v1:") && this.cfg.apiKey) {
        await this.persistSettings();
      }
    } catch (e) {
      this.cfg.apiKey = "";
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
    async persistSettings() {
      try {
        localStorage.setItem(LS.base, this.cfg.baseUrl);
        localStorage.setItem(LS.model, this.cfg.model);
        const enc = await encryptSecret(this.cfg.apiKey);
        if (enc) localStorage.setItem(LS.key, enc);
        else localStorage.removeItem(LS.key);
      } catch (e) {
        /* ignore */
      }
    },
    async saveSettings() {
      await this.persistSettings();
      if (this.configured) this.showSettings = false;
    },
    applyPreset(p) {
      this.cfg.baseUrl = p.baseUrl;
      if (!this.cfg.model) this.cfg.model = p.model;
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
      this._indexPromise = (async () => {
        try {
          // withBase prepends the site base (e.g. /just-laws/ on a GitHub Pages
          // project site), so the corpus resolves both at root and under a subpath.
          const [{ default: MiniSearchCls }, resp] = await Promise.all([
            MiniSearch ? Promise.resolve({ default: MiniSearch }) : import("minisearch"),
            fetch(withBase("/law-corpus.json")),
          ]);
          MiniSearch = MiniSearchCls;
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const data = await resp.json();
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
          mini.addAll(data.docs);
          this._mini = mini;
          this.indexState = "ready";
        } catch (e) {
          this.indexState = "error";
          this._indexPromise = null;
          this.error = "法条索引加载失败，请刷新页面重试。";
          throw e;
        }
      })();
      return this._indexPromise;
    },
    retrieve(q) {
      if (!this._mini) return [];
      const hits = this._mini.search(q, { combineWith: "OR" });
      return hits.slice(0, TOP_K);
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
        "如果提供的法条不足以回答，请直接说明「现有法条不足以回答」，不要编造法条或条号。" +
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
      const ctx = this.retrieve(q);
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
            "无法连接该接口（可能被 CORS 拦截或网络不可达）。OpenAI 官方端点不支持浏览器直连，" +
            "请改用国产兼容服务、自建网关或 Azure OpenAI；并确认 Base URL 正确。";
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
  --jl-brand: #de2910;
}
.jl-chat__fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
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
  box-shadow: 0 4px 14px rgba(222, 41, 16, 0.4);
}
.jl-chat__fab:hover {
  filter: brightness(1.05);
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
  background: #fff;
  border: 1px solid #eee;
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
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
.jl-chat__settings-intro {
  margin: 0 0 12px;
  color: #555;
  line-height: 1.5;
}
.jl-chat__field {
  display: block;
  margin-bottom: 10px;
}
.jl-chat__field > span {
  display: block;
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}
.jl-chat__field input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 13px;
  background: #fff;
  color: #1a1a1a;
}
.jl-chat__settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
}
.jl-chat__presets summary {
  cursor: pointer;
  color: var(--jl-brand);
  font-size: 12px;
}
.jl-chat__note {
  margin-top: 12px;
  font-size: 11px;
  color: #999;
  line-height: 1.5;
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
.jl-chat__sources {
  margin-top: 14px;
  border-top: 1px dashed #eee;
  padding-top: 10px;
}
.jl-chat__sources h4 {
  font-size: 12px;
  color: #888;
  margin: 0 0 8px;
  font-weight: 600;
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
html.dark .jl-chat__panel {
  background: #161616;
  border-color: #333;
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
html.dark .jl-chat__src-ctx,
html.dark .jl-chat__badge,
html.dark .jl-chat__sources h4,
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
