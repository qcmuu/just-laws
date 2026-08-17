<!-- @ts-nocheck -->
<!--
  Shared BYOK settings form, used in two places:
  - inside the floating chat widget (variant="panel", compact)
  - on the /settings/ page (variant="page", with status and preset details)

  Saving persists to localStorage (AES-GCM obfuscated key, see chat-settings.js)
  and dispatches the jl-chat-settings-saved event so every open UI re-reads it.
-->
<template>
  <div class="jl-model-settings" :class="{ 'jl-model-settings--page': variant === 'page' }">
    <p v-if="variant === 'page'" class="jl-chat__settings-intro">
      配置你的大模型接口后，全站任意页面的「AI 法律问答」浮窗即可使用。API Key 仅保存在
      <strong>你本机浏览器</strong>（AES-GCM 加密存储）、提问时直连你选择的服务商，<strong>不会经过本站</strong>。
    </p>
    <p v-else class="jl-chat__settings-intro">
      填入任意 <strong>OpenAI 兼容</strong> 接口（如商汤 SenseNova、DeepSeek、通义千问、智谱
      GLM 等）。Key 仅保存在你本机浏览器、直接发往你选择的服务商，<strong>不会经过本站</strong>。
    </p>

    <p v-if="variant === 'page' && configured" class="jl-model-settings__status jl-model-settings__status--ok">
      ✓ 已配置：{{ cfg.model }} @ {{ cfg.baseUrl.replace(/^https?:\/\//, "") }}
    </p>
    <p v-else-if="variant === 'page'" class="jl-model-settings__status">
      尚未完成配置（默认已预填商汤 SenseNova，粘贴 Key 即可用）。
    </p>

    <label class="jl-chat__field">
      <span>接口地址 Base URL</span>
      <input v-model.trim="form.baseUrl" type="text" placeholder="https://token.sensenova.cn/v1" />
    </label>
    <label class="jl-chat__field">
      <span>API Key</span>
      <input
        v-model.trim="form.apiKey"
        type="password"
        autocomplete="off"
        placeholder="sk-...（仅存本机浏览器）"
      />
    </label>
    <label class="jl-chat__field">
      <span>模型 Model</span>
      <input v-model.trim="form.model" type="text" placeholder="sensenova-6.7-flash-lite" />
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
          {{ p.name }}
        </button>
      </div>
      <button class="jl-chat__send" type="button" :disabled="saving" @click="save">
        {{ savedFlash ? "已保存 ✓" : "保存" }}
      </button>
    </div>
    <div v-else class="jl-chat__settings-row">
      <details class="jl-chat__presets">
        <summary>常用预设</summary>
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          class="jl-chat__chip"
          @click="applyPreset(p)"
        >
          {{ p.name }}
        </button>
      </details>
      <button class="jl-chat__send" type="button" :disabled="saving" @click="save">
        {{ savedFlash ? "已保存 ✓" : "保存" }}
      </button>
    </div>

    <p v-if="saveError" class="jl-model-settings__error">{{ saveError }}</p>
    <p class="jl-chat__note">
      注：OpenAI 官方端点（api.openai.com）不允许浏览器直连，会被 CORS 拦截；请使用上表预设、其他兼容服务或自建网关。
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
      cfg: { baseUrl: "", apiKey: "", model: "" },
    };
  },
  computed: {
    configured() {
      return !!(this.cfg.baseUrl && this.cfg.apiKey && this.cfg.model);
    },
  },
  async mounted() {
    this.cfg = await loadCfg();
    this.form = { ...this.form, ...this.cfg };
    // First-run pre-fill: ?provider=deepseek URL param, else the default
    // preset (商汤 SenseNova). Never overwrites an existing configuration.
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
.jl-chat__settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
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
}
.jl-chat__send:disabled {
  opacity: 0.7;
  cursor: default;
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
</style>
