<!-- @ts-nocheck -->
<!--
  Floating "AI 法律问答" chat widget for the Just Laws VuePress site.

  - Calls the RAG backend POST /api/chat and streams the answer (SSE).
  - Renders citations as clickable deep-links back into the law text.
  - Backend base URL is configurable (build-time define __JUSTLAWS_RAG_API_BASE__
    or runtime window.__JUSTLAWS_RAG_API_BASE__); empty string = same-origin.
  - Fails gracefully when the backend is absent (the static build never breaks).
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
        @click="open = true"
      >
        <span class="jl-chat__fab-icon">⚖️</span>
        <span class="jl-chat__fab-text">AI 法律问答</span>
      </button>

      <!-- Panel -->
      <section v-if="open" class="jl-chat__panel" aria-label="AI 法律问答">
        <header class="jl-chat__header">
          <div>
            <strong>AI 法律问答</strong>
            <span class="jl-chat__sub">基于现行法律文库的 RAG 检索</span>
          </div>
          <button
            class="jl-chat__close"
            type="button"
            aria-label="关闭"
            @click="open = false"
          >
            ×
          </button>
        </header>

        <div class="jl-chat__disclaimer">
          ⚠️ 本工具基于已收录法条自动整理，仅供参考、不构成法律意见。重大事项请咨询执业律师。
        </div>

        <div ref="bodyEl" class="jl-chat__body">
          <div v-if="!answer && !sources.length && !error" class="jl-chat__examples">
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
          </div>

          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-if="answer"
            class="jl-chat__answer"
            v-html="renderedAnswer"
          ></div>

          <div v-if="error" class="jl-chat__error">{{ error }}</div>

          <div v-if="sources.length" class="jl-chat__sources">
            <h4>参考来源（{{ sources.length }} 条法条，点击核对原文）</h4>
            <a
              v-for="(s, i) in sources"
              :key="i"
              class="jl-chat__src"
              :href="s.source_url"
              target="_blank"
              rel="noopener"
            >
              <span class="jl-chat__src-title"
                >《{{ s.law_name }}》{{ s.article_no }}</span
              >
              <span class="jl-chat__badge">相关度 {{ s.score }}</span>
              <span v-if="s.context" class="jl-chat__src-ctx">{{ s.context }}</span>
            </a>
          </div>
        </div>

        <form class="jl-chat__inputbar" @submit.prevent="ask()">
          <input
            v-model="question"
            class="jl-chat__input"
            type="text"
            :disabled="loading"
            placeholder="用一句话描述你的法律问题…"
          />
          <button class="jl-chat__send" type="submit" :disabled="loading">
            {{ loading ? "…" : "提问" }}
          </button>
        </form>
      </section>
    </div>
  </ClientOnly>
</template>

<script>
import MarkdownIt from "markdown-it";

// html:false escapes any raw HTML in the model output, and markdown-it's
// default link validator strips javascript:/data: URLs, so rendering the
// answer with v-html is safe against injection from the LLM response.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// Abort a streaming request that never responds, so the UI can't hang forever.
const REQUEST_TIMEOUT_MS = 60000;

function resolveApiBase() {
  // Runtime override (set window.__JUSTLAWS_RAG_API_BASE__ before load).
  if (typeof window !== "undefined" && window.__JUSTLAWS_RAG_API_BASE__) {
    return String(window.__JUSTLAWS_RAG_API_BASE__).replace(/\/$/, "");
  }
  // Build-time define injected via docs/.vuepress/config.js.
  if (typeof __JUSTLAWS_RAG_API_BASE__ !== "undefined" && __JUSTLAWS_RAG_API_BASE__) {
    return String(__JUSTLAWS_RAG_API_BASE__).replace(/\/$/, "");
  }
  return ""; // same-origin (production behind an nginx /api reverse proxy)
}

function resolveEnabled() {
  // Runtime override wins (set window.__JUSTLAWS_RAG_ENABLED__ = false to hide).
  if (typeof window !== "undefined" && typeof window.__JUSTLAWS_RAG_ENABLED__ !== "undefined") {
    return window.__JUSTLAWS_RAG_ENABLED__ !== false &&
      !["false", "0", "off", "no"].includes(String(window.__JUSTLAWS_RAG_ENABLED__).toLowerCase());
  }
  // Build-time define injected via docs/.vuepress/config.js (default: enabled).
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
      question: "",
      answer: "",
      sources: [],
      error: "",
      loading: false,
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
      return this.answer ? md.render(this.answer) : "";
    },
  },
  methods: {
    scrollDown() {
      this.$nextTick(() => {
        const el = this.$refs.bodyEl;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
    async ask(preset) {
      const q = (preset || this.question).trim();
      if (!q || this.loading) return;
      this.question = q;
      this.loading = true;
      this.answer = "";
      this.sources = [];
      this.error = "";

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const resp = await fetch(resolveApiBase() + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q }),
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error("HTTP " + resp.status);
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (!line.startsWith("data:")) continue;
            let evt;
            try {
              evt = JSON.parse(line.slice(5).trim());
            } catch (e) {
              continue;
            }
            if (evt.type === "sources") {
              this.sources = evt.sources || [];
            } else if (evt.type === "token") {
              this.answer += evt.text;
              this.scrollDown();
            }
          }
        }
      } catch (e) {
        if (e && e.name === "AbortError") {
          this.error = "回答超时，请稍后重试或换个问法。";
        } else {
          this.error =
            "暂时无法连接问答服务，请稍后再试。（AI 法律问答需要后端服务，静态站点本身不受影响）";
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
.jl-chat__sub {
  display: block;
  font-size: 11px;
  opacity: 0.85;
  font-weight: 400;
}
.jl-chat__close {
  background: transparent;
  border: 0;
  color: #fff;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.jl-chat__disclaimer {
  background: #fff6f5;
  border-bottom: 1px solid #ffd9d4;
  color: #a8261b;
  padding: 8px 14px;
  font-size: 12px;
  line-height: 1.5;
}
.jl-chat__body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}
.jl-chat__hint {
  margin: 0 0 8px;
  font-size: 13px;
  color: #666;
}
.jl-chat__chip {
  display: block;
  width: 100%;
  text-align: left;
  margin-bottom: 8px;
  padding: 8px 12px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 8px;
  font-size: 13px;
  color: #333;
  cursor: pointer;
}
.jl-chat__chip:hover {
  border-color: var(--jl-brand);
  color: var(--jl-brand);
}
.jl-chat__answer {
  line-height: 1.7;
  font-size: 14px;
  color: #1a1a1a;
  word-break: break-word;
}
/* v-html content is not affected by scoped styles, so target it via :deep(). */
.jl-chat__answer :deep(p) {
  margin: 0 0 10px;
}
.jl-chat__answer :deep(p:last-child) {
  margin-bottom: 0;
}
.jl-chat__answer :deep(ul),
.jl-chat__answer :deep(ol) {
  margin: 0 0 10px;
  padding-left: 22px;
}
.jl-chat__answer :deep(li) {
  margin: 2px 0;
}
.jl-chat__answer :deep(li > p) {
  margin: 0;
}
.jl-chat__answer :deep(strong) {
  font-weight: 600;
  color: #000;
}
.jl-chat__answer :deep(a) {
  color: var(--jl-brand);
  text-decoration: underline;
}
.jl-chat__answer :deep(h1),
.jl-chat__answer :deep(h2),
.jl-chat__answer :deep(h3),
.jl-chat__answer :deep(h4) {
  margin: 12px 0 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.jl-chat__answer :deep(code) {
  background: #f3f3f3;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12.5px;
}
.jl-chat__answer :deep(pre) {
  background: #f3f3f3;
  border-radius: 6px;
  padding: 10px 12px;
  overflow-x: auto;
}
.jl-chat__answer :deep(pre code) {
  background: transparent;
  padding: 0;
}
.jl-chat__answer :deep(blockquote) {
  margin: 0 0 10px;
  padding: 4px 12px;
  border-left: 3px solid #eee;
  color: #555;
}
.jl-chat__answer :deep(hr) {
  border: 0;
  border-top: 1px solid #eee;
  margin: 12px 0;
}
.jl-chat__error {
  background: #fff6f5;
  border: 1px solid #ffd9d4;
  color: #a8261b;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 13px;
}
.jl-chat__sources {
  margin-top: 14px;
}
.jl-chat__sources h4 {
  margin: 0 0 8px;
  font-size: 12px;
  color: #666;
}
.jl-chat__src {
  display: block;
  background: #fff;
  border: 1px solid #eee;
  border-left: 3px solid var(--jl-brand);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
  font-size: 13px;
  text-decoration: none;
}
.jl-chat__src-title {
  color: var(--jl-brand);
  font-weight: 600;
}
.jl-chat__badge {
  display: inline-block;
  margin-left: 6px;
  background: #eee;
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  color: #666;
}
.jl-chat__src-ctx {
  display: block;
  margin-top: 2px;
  color: #999;
  font-size: 12px;
}
.jl-chat__inputbar {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #eee;
}
.jl-chat__input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #ccc;
  border-radius: 8px;
  font-size: 14px;
}
.jl-chat__send {
  background: var(--jl-brand);
  color: #fff;
  border: 0;
  border-radius: 8px;
  padding: 0 18px;
  font-size: 14px;
  cursor: pointer;
}
.jl-chat__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
