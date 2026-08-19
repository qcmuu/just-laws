<!-- @ts-nocheck -->
<!--
  Shared BYOK settings form, used in two places:
  - inside the floating chat widget (variant="panel", compact)
  - on the /settings/ page (variant="page", with status and preset details)

  Saving persists to localStorage (AES-GCM obfuscated key, see chat-settings.js)
  and dispatches the jl-chat-settings-saved event so every open UI re-reads it.

  A "测试连接" button fires a 1-token chat request at the configured endpoint
  so users can verify Key / model / CORS *before* asking a real question.
-->
<template>
  <div class="jl-model-settings" :class="{ 'jl-model-settings--page': variant === 'page' }">
    <p v-if="variant === 'page'" class="jl-chat__settings-intro">
      配置你的大模型接口后，全站任意页面的「AI 法律问答」浮窗即可使用。API Key 仅保存在
      <strong>你本机浏览器</strong>（AES-GCM 加密存储）、提问时直连你选择的服务商，<strong>不会经过本站</strong>。
    </p>
    <p v-else class="jl-chat__settings-intro">
      填入任意 <strong>OpenAI 兼容</strong> 接口（如 DeepSeek、通义千问、智谱
      GLM 等）。Key 仅保存在你本机浏览器、直接发往你选择的服务商，<strong>不会经过本站</strong>。
    </p>

    <p v-if="variant === 'page' && configured" class="jl-model-settings__status jl-model-settings__status--ok">
      ✓ 已配置：{{ cfg.model }} @ {{ cfg.baseUrl.replace(/^https?:\/\//, "") }}
    </p>
    <p v-else-if="variant === 'page'" class="jl-model-settings__status">
      尚未完成配置（默认已预填 DeepSeek，粘贴 Key 即可用）。
    </p>

    <!-- SenseNova's API host fails the browser CORS preflight — surface that
         BEFORE the user burns time getting a key and wondering why chat hangs. -->
    <p v-if="blockedPreset" class="jl-model-settings__error" role="alert">
      ⚠️ {{ blockedPreset.name }} 的接口（{{ blockedPreset.baseUrl.replace(/^https?:\/\//, "") }}）不允许浏览器跨域直连（CORS），在本站网页端提问会失败。请改用
      DeepSeek / 通义千问 / 智谱 GLM；确需使用商汤模型，请通过自建网关（one-api 等）转发后再填入网关地址。
    </p>

    <label class="jl-chat__field">
      <span>接口地址 Base URL</span>
      <input v-model.trim="form.baseUrl" type="text" placeholder="https://api.deepseek.com/v1" />
    </label>
    <label class="jl-chat__field">
      <span>API Key</span>
      <div class="jl-model-settings__keyrow">
        <input
          v-model.trim="form.apiKey"
          :type="showKey ? 'text' : 'password'"
          autocomplete="off"
          placeholder="sk-...（仅存本机浏览器）"
        />
        <button
          class="jl-model-settings__eye"
          type="button"
          :aria-label="showKey ? '隐藏 API Key' : '显示 API Key'"
          :title="showKey ? '隐藏' : '显示'"
          @click="showKey = !showKey"
        >
          {{ showKey ? "🙈" : "👁" }}
        </button>
      </div>
    </label>
    <label class="jl-chat__field">
      <span>模型 Model</span>
      <input v-model.trim="form.model" type="text" placeholder="deepseek-chat" />
    </label>

    <div v-if="variant === 'page'" class="jl-chat__settings-row">
      <div class="jl-model-settings__presets">
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          class="jl-chat__chip"
          :class="{ 'jl-chat__chip--active': form.baseUrl === p.baseUrl }"
          @click="applyPreset(p)"
        >
          {{ p.name }}{{ p.corsBlocked ? " ⚠️" : "" }}
        </button>
      </div>
      <div class="jl-model-settings__btns">
        <button
          class="jl-chat__send jl-chat__send--ghost"
          type="button"
          :disabled="testing"
          @click="test"
        >
          {{ testing ? "测试中…" : "测试连接" }}
        </button>
        <button class="jl-chat__send" type="button" :disabled="saving" @click="save">
          {{ savedFlash ? "已保存 ✓" : "保存" }}
        </button>
      </div>
    </div>
    <div v-else class="jl-chat__settings-row">
      <details class="jl-chat__presets">
        <summary>常用预设</summary>
        <div class="jl-model-settings__presets">
          <button
            v-for="p in presets"
            :key="p.id"
            type="button"
            class="jl-chat__chip"
            @click="applyPreset(p)"
          >
            {{ p.name }}
          </button>
        </div>
      </details>
      <div class="jl-model-settings__btns">
        <button
          class="jl-chat__send jl-chat__send--ghost"
          type="button"
          :disabled="testing"
          @click="test"
        >
          {{ testing ? "测试中…" : "测试连接" }}
        </button>
        <button class="jl-chat__send" type="button" :disabled="saving" @click="save">
          {{ savedFlash ? "已保存 ✓" : "保存" }}
        </button>
      </div>
    </div>

    <p
      v-if="testResult"
      class="jl-model-settings__test"
      :class="{
        'jl-model-settings__test--ok': testOk,
        'jl-model-settings__test--pending': testing,
      }"
    >
      {{ testResult }}
    </p>
    <p v-if="saveError" class="jl-model-settings__error">{{ saveError }}</p>
    <p class="jl-chat__note">
      注：OpenAI 官方端点（api.openai.com）和商汤 SenseNova 官方接口不允许浏览器直连，会被 CORS 拦截；请使用其他预设、兼容服务或自建网关。
      使用本地 Ollama 需先以 <code>OLLAMA_ORIGINS=*</code> 启动服务。
    </p>
  </div>
</template>

<script>
import {
  PRESETS,
  initialPreset,
  loadCfg,
  notifySettingsSaved,
  saveCfg,
  describeHttpError,
  CORS_HINT,
} from "./chat-settings";

export default {
  name: "LawModelSettings",
  props: {
    variant: { type: String, default: "panel" }, // "panel" (widget) | "page"
  },
  data() {
    return {
      form: { baseUrl: "", apiKey: "", model: "" },
      presets: PRESETS,
      saving: false,
      savedFlash: false,
      saveError: "",
      showKey: false,
      testing: false,
      testResult: "",
      testOk: false,
      cfg: { baseUrl: "", apiKey: "", model: "" },
    };
  },
  computed: {
    configured() {
      return !!(this.cfg.baseUrl && this.cfg.apiKey && this.cfg.model);
    },
    // The preset matching the Base URL currently in the form, when that
    // preset is known not to work from a browser (CORS). null otherwise.
    blockedPreset() {
      return (
        PRESETS.find(
          (p) => p.corsBlocked && this.form.baseUrl === p.baseUrl
        ) || null
      );
    },
  },
  async mounted() {
    this.cfg = await loadCfg();
    this.form = { ...this.form, ...this.cfg };
    // First-run pre-fill: ?provider=deepseek URL param, else the default
    // preset (DeepSeek). Never overwrites an existing configuration.
    const pre = initialPreset();
    if (pre && !this.form.baseUrl) {
      this.form.baseUrl = pre.baseUrl;
      this.form.model = pre.model;
    }
  },
  methods: {
    // A preset switches both endpoint and model — the fields ship pre-filled
    // with the default, so filling only the empty model would mix providers.
    applyPreset(p) {
      this.form.baseUrl = p.baseUrl;
      this.form.model = p.model;
    },
    async save() {
      this.saving = true;
      this.saveError = "";
      try {
        await saveCfg(this.form);
        this.cfg = { ...this.form };
        notifySettingsSaved();
        this.savedFlash = true;
        setTimeout(() => {
          this.savedFlash = false;
        }, 1500);
      } catch (e) {
        this.saveError = "保存失败：浏览器可能处于隐私模式，无法写入本地存储。";
      } finally {
        this.saving = false;
      }
    },
    // Fire a minimal (1-token) chat request at the form's endpoint so users
    // can verify Key / model / CORS without asking a real question. Uses the
    // unsaved form values — test first, save after it works.
    async test() {
      const base = (this.form.baseUrl || "").trim();
      const key = (this.form.apiKey || "").trim();
      const model = (this.form.model || "").trim();
      if (!base || !key || !model) {
        this.testOk = false;
        this.testing = false;
        this.testResult = "请先填写 Base URL、API Key 和模型名，再测试连接。";
        return;
      }
      this.testing = true;
      this.testOk = false;
      this.testResult = "正在测试连接…";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const resp = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + key,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "你好" }],
            max_tokens: 1,
            stream: false,
          }),
          signal: controller.signal,
        });
        if (resp.ok) {
          this.testOk = true;
          this.testResult =
            "✓ 连接成功：" + model + " @ " + base.replace(/^https?:\/\//, "");
        } else {
          let detail = "";
          try {
            detail = (await resp.text()).slice(0, 160);
          } catch (e) {
            /* ignore */
          }
          this.testResult = "✗ " + describeHttpError(resp.status, detail);
        }
      } catch (e) {
        if (e && e.name === "AbortError") {
          this.testResult = "✗ 连接超时（15 秒无响应），请检查地址或网络。";
        } else {
          this.testResult = "✗ " + CORS_HINT;
        }
      } finally {
        clearTimeout(timer);
        this.testing = false;
      }
    },
  },
};
</script>

<style scoped>
.jl-model-settings {
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
.jl-model-settings__keyrow {
  display: flex;
  gap: 6px;
}
.jl-model-settings__keyrow input {
  flex: 1;
}
.jl-model-settings__eye {
  flex-shrink: 0;
  border: 1px solid #ddd;
  background: #fff;
  border-radius: 8px;
  padding: 0 10px;
  cursor: pointer;
  font-size: 13px;
  color: #666;
}
.jl-chat__settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.jl-chat__presets summary {
  cursor: pointer;
  color: var(--jl-brand, #de2910);
  font-size: 12px;
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
.jl-chat__chip:hover,
.jl-chat__chip--active {
  border-color: var(--jl-brand, #de2910);
  color: var(--jl-brand, #de2910);
}
.jl-model-settings__btns {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.jl-chat__send {
  padding: 9px 16px;
  border: 0;
  border-radius: 999px;
  background: var(--jl-brand, #de2910);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
}
.jl-chat__send:disabled {
  opacity: 0.7;
  cursor: default;
}
.jl-chat__send--ghost {
  background: transparent;
  color: var(--jl-brand, #de2910);
  border: 1px solid var(--jl-brand, #de2910);
}
.jl-chat__note {
  margin-top: 12px;
  font-size: 11px;
  color: #999;
  line-height: 1.5;
}
.jl-model-settings__presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
}
.jl-model-settings__status {
  margin: 0 0 12px;
  font-size: 12px;
  color: #999;
}
.jl-model-settings__status--ok {
  color: #1a7f37;
}
.jl-model-settings__error {
  margin: 8px 0 0;
  font-size: 12px;
  color: #a8331f;
}
.jl-model-settings__test {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #a8331f;
  word-break: break-word;
}
.jl-model-settings__test--ok {
  color: #1a7f37;
}
.jl-model-settings__test--pending {
  color: #888;
}

/* Page variant: render as a card on the /settings/ page. */
.jl-model-settings--page {
  max-width: 640px;
  padding: 18px 20px;
  border: 1px solid #eee;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
}
</style>

<style>
/* Dark mode (global: also applies when rendered inside the widget page). */
html.dark .jl-model-settings--page {
  background: #161616;
  border-color: #333;
}
html.dark .jl-model-settings__status {
  color: #b5b5b5;
}
html.dark .jl-model-settings__status--ok {
  color: #7ee2a8;
}
html.dark .jl-model-settings__test--ok {
  color: #7ee2a8;
}
html.dark .jl-model-settings__test--pending {
  color: #888;
}
html.dark .jl-model-settings__eye {
  background: #1f1f1f;
  border-color: #444;
  color: #bbb;
}
</style>
