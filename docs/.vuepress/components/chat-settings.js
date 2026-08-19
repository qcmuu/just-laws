// Shared BYOK LLM settings for the chat widget and the /settings/ page:
// localStorage persistence (AES-GCM obfuscated key), provider presets,
// first-run pre-fill, and a same-tab sync event so both UIs stay in step
// no matter where the user saves.

export const LS = {
  base: "jl_chat_base_url",
  key: "jl_chat_api_key",
  model: "jl_chat_model",
  wrap: "jl_chat_wrap_jwk",
};

// Dispatched on window whenever settings are saved from any component.
export const SETTINGS_EVENT = "jl-chat-settings-saved";

// `id` is the ?provider= URL-param value (e.g. /settings/?provider=deepseek).
// The first entry is what unconfigured users see pre-filled by default — it
// MUST be a provider whose API allows cross-origin browser calls (verified
// 2026-08-17: DeepSeek / 通义 / 智谱 preflight OK; SenseNova does not).
export const PRESETS = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
  },
  {
    id: "sensenova",
    name: "商汤 SenseNova",
    baseUrl: "https://token.sensenova.cn/v1",
    model: "sensenova-6.7-flash-lite",
    // token.sensenova.cn answers the CORS preflight (OPTIONS) with 404, so
    // browsers refuse to call it. Server-side tools work fine; a static
    // BYOK site with no backend cannot. Keep it listed (it still works
    // through a self-hosted gateway) but flag it so the UI can warn.
    corsBlocked: true,
  },
  {
    id: "ollama",
    name: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
  },
];

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

export async function loadCfg() {
  const cfg = { baseUrl: "", apiKey: "", model: "" };
  try {
    cfg.baseUrl = localStorage.getItem(LS.base) || "";
    cfg.model = localStorage.getItem(LS.model) || "";
    const stored = localStorage.getItem(LS.key) || "";
    cfg.apiKey = stored ? await decryptSecret(stored) : "";
    if (stored && !stored.startsWith("enc:v1:") && cfg.apiKey) {
      await saveCfg(cfg); // migrate legacy plaintext key to encrypted form
    }
  } catch (e) {
    cfg.apiKey = "";
  }
  return cfg;
}

export async function saveCfg(cfg) {
  localStorage.setItem(LS.base, cfg.baseUrl);
  localStorage.setItem(LS.model, cfg.model);
  const enc = await encryptSecret(cfg.apiKey);
  if (enc) localStorage.setItem(LS.key, enc);
  else localStorage.removeItem(LS.key);
}

export function notifySettingsSaved() {
  try {
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  } catch (e) {
    /* ignore */
  }
}

// ---- Shared error copy (chat widget ask path + settings panel test button) ----

// fetch() rejecting with TypeError before any HTTP response is almost always
// a CORS block or an unreachable host. The two known-bad providers are named
// so users stop burning time on keys that were never the problem.
export const CORS_HINT =
  "无法连接该接口（可能被 CORS 拦截或网络不可达）。注意：OpenAI 官方端点和商汤 SenseNova（token.sensenova.cn）都不允许浏览器直连，" +
  "请改用 DeepSeek、通义千问、智谱等支持跨域的兼容服务或自建网关，并确认 Base URL 正确。";

// Map the handful of HTTP statuses providers actually return to actionable
// Chinese copy, keeping the response snippet for diagnosis.
export function describeHttpError(status, detail) {
  const d = detail ? "（" + detail + "）" : "";
  if (status === 401) return "API Key 无效或未授权（HTTP 401），请检查 Key" + d;
  if (status === 402)
    return "账户余额不足（HTTP 402），请到服务商控制台充值" + d;
  if (status === 403)
    return (
      "无访问权限（HTTP 403）：Key 可能被禁用、无该模型权限或受地区限制" + d
    );
  if (status === 404)
    return "接口地址或模型名不存在（HTTP 404），请检查 Base URL 与模型名" + d;
  if (status === 429)
    return "请求过于频繁或额度受限（HTTP 429），请稍后重试" + d;
  if (status >= 500)
    return "模型服务端错误（HTTP " + status + "），请稍后重试" + d;
  return "HTTP " + status + d;
}

// Pre-fill shown to users who have not configured anything yet: honor a
// ?provider=<id> URL param (e.g. shared deep links), otherwise the default
// preset (DeepSeek). Never overwrites an existing configuration.
export function initialPreset() {
  try {
    if (localStorage.getItem(LS.base) || localStorage.getItem(LS.model)) {
      return null;
    }
    const q = new URLSearchParams(window.location.search).get("provider");
    if (q) {
      const hit = PRESETS.find((p) => p.id === q.trim().toLowerCase());
      if (hit) return hit;
    }
    return PRESETS[0];
  } catch (e) {
    return null;
  }
}
