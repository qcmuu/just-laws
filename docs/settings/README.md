---
title: AI 问答设置
description: 配置浏览器端大模型接口（BYOK），启用全站 AI 法律问答。
---

# AI 问答设置

本站的 AI 法律问答完全在你的浏览器中运行：法条检索在本地完成，提问直连**你自己配置**的大模型接口（BYOK，Bring Your Own Key）。本站没有后端服务器，你的 API Key **不会经过本站**。

<ClientOnly>
<LawModelSettings variant="page" />
</ClientOnly>

::: tip
填好后建议先点「**测试连接**」：浏览器会向该接口发一个 1 token 的最小请求，立刻验证 Key、模型名和跨域是否可用（绿色 ✓ 表示通过），确认无误再点「保存」。
:::

## 如何获取 API Key

| 服务商 | 控制台 | 接口地址（点击预设自动填入） | 模型示例 |
| :--- | :--- | :--- | :--- |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/) | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问 | [bailian.console.aliyun.com](https://bailian.console.aliyun.com/) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 GLM | [open.bigmodel.cn](https://open.bigmodel.cn/) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash`（免费） |
| 商汤 SenseNova ⚠️ | [console.sensecore.cn](https://console.sensecore.cn/) | `https://token.sensenova.cn/v1` | `sensenova-6.7-flash-lite` |

- 智谱 GLM 的 `glm-4-flash` 免费，适合个人用户试用；DeepSeek 注册即送额度。
- ⚠️ **商汤 SenseNova 的官方接口不允许浏览器跨域直连（CORS），在本站网页端无法使用**；如需使用商汤模型，请通过自建网关（one-api、vLLM 等）转发，再填入网关地址。
- 也可填写任意 **OpenAI 兼容**的自建网关地址（vLLM、one-api 等）。

## 一键预填

把带 `provider` 参数的链接分享给别人，对方打开后接口与模型已自动填好，只需粘贴自己的 Key。点击下表链接立即体验（在本页追加参数并刷新）：

| 预填 | 链接写法（相对参数，任意页面通用） |
| :--- | :--- |
| [DeepSeek](?provider=deepseek) | `?provider=deepseek` |
| [通义千问](?provider=qwen) | `?provider=qwen` |
| [智谱 GLM](?provider=zhipu) | `?provider=zhipu` |
| [商汤 SenseNova](?provider=sensenova)（网页端不可用，见上） | `?provider=sensenova` |
| [本地 Ollama](?provider=ollama) | `?provider=ollama` |

::: tip
参数对全站任意页面生效，例如访问任意法条页时带上 `?provider=deepseek`，用户随后点开问答浮窗的 ⚙ 设置时同样已预填。
:::

## 安全与隐私

- API Key 以 **AES-GCM 加密**形式存放在你浏览器的 localStorage 中，防止被直接读取；但请注意，浏览器本地存储无法抵御你本机上运行的恶意脚本，请保持浏览器环境可信。
- Key 仅在提问时由你的浏览器直接发往你配置的服务商。
- 清除浏览器站点数据即可彻底删除 Key；换设备需要重新配置（Key 不跟随站点，本站也没有账号系统）。

## 技术方案

采用浏览器端 RAG：MiniSearch 在本机检索已收录法条，再由用户配置的大模型接口（BYOK）基于命中条文生成回答。

<div class="jl-arch">
  <ol class="jl-arch__steps">
    <li>
      <strong>法条入库</strong>
      <span>构建时按「一条一卡」切分现行法律，生成约 2.4 万条可检索语料，随静态站一起发布。</span>
    </li>
    <li>
      <strong>本机索引</strong>
      <span>首次打开问答时，在 Web Worker 里用 MiniSearch 建立中文单字与双字索引，语料缓存在 IndexedDB，之后不必重新下载。</span>
    </li>
    <li>
      <strong>问句检索</strong>
      <span>口语会先扩成法律用语（例如「案子审完」补上申请执行、判决生效），再在本机检索最相关的若干条文。</span>
    </li>
    <li>
      <strong>带出处作答</strong>
      <span>只把这些条文和问题发给你配置的兼容接口，流式返回回答；参考来源可点回本站原文。模型不得编造未检索到的条号。</span>
    </li>
  </ol>
  <p class="jl-arch__note">AI 问答的答案质量取决于是否能够检索到对应的法条，以及模型的指令遵循能力。<br>回答仅供参考，专业问题建议咨询执业律师。</p>
</div>

## 常见问题

**Q：提示「无法连接该接口（可能被 CORS 拦截）」？**
OpenAI 官方端点（api.openai.com）、商汤 SenseNova（token.sensenova.cn）等不允许浏览器直连。请改用上表预设（DeepSeek / 通义 / 智谱均支持浏览器跨域调用）、其他兼容服务，或自建网关。

**Q：为什么商汤 SenseNova 不能用？我 Key 明明是有效的？**
商汤接口服务器对浏览器跨域预检请求（OPTIONS）返回 404，浏览器会直接拦截后续请求——这与你的 Key 无关（在服务器端、curl 或本地工具里同一 Key 可以正常调用）。本站是无后端的纯静态站，无法替你转发，因此网页端用不了商汤官方接口；需要的话请自建网关转发。

**Q：本地 Ollama 怎么用？**
安装 [Ollama](https://ollama.com/) 后，以允许跨域的方式启动：`OLLAMA_ORIGINS=* ollama serve`，拉取一个模型如 `ollama pull qwen2.5:7b`，然后点击「本地 Ollama」预设并保存即可。

**Q：模型名从哪里查？**
各服务商控制台的模型列表页。填错模型名会返回 404 / 模型不存在错误，改正后重试即可。

**Q：配置好了在哪里用？**
任意页面右下角的「AI 法律问答」浮窗。未配置时首次打开浮窗会自动弹出设置面板。
