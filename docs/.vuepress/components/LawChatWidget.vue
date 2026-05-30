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
    <div class="jl-chat">
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

          <div v-if="answer" class="jl-chat__answer">{{ answer }}</div>

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

export default {
  name: "LawChatWidget",
  data() {
    return {
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

      try {
        const resp = await fetch(resolveApiBase() + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q }),
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
        this.error =
          "暂时无法连接问答服务，请稍后再试。（AI 法律问答需要后端服务，静态站点本身不受影响）";
      } finally {
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
  white-space: pre-wrap;
  line-height: 1.7;
  font-size: 14px;
  color: #1a1a1a;
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
