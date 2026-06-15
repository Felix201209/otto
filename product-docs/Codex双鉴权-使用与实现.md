# Codex 双鉴权(OAuth + API Key)· 使用与实现

> 状态:**P0 已实现,端到端实测通过**(2026-06-14)。Claude OAuth 按要求不做。

## 这是什么

让本产品的"自定义模型"可以直接复用本机 **Codex CLI 的凭证**(`~/.codex/auth.json`)调用模型:
- **OAuth 模式**(ChatGPT 订阅登录):用 `tokens.access_token` + `chatgpt-account-id` 调 ChatGPT 后端。
- **API Key 模式**:`auth_mode=apikey` 且有 `OPENAI_API_KEY` 时直接 Bearer 该 key。

与 Codex CLI **共用同一份凭证文件**,你 `codex login` 一次,这里就能用。

## 怎么用(配置)

在 `~/.easycode-user/custom-models.json` 加一条:

```json
{
  "models": [
    {
      "displayName": "Codex (ChatGPT OAuth)",
      "provider": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "apiKey": "${CODEX_OAUTH}",
      "modelId": "gpt-5.5",
      "maxTokens": 200000,
      "enabled": true
    }
  ]
}
```

关键:`apiKey` 填哨兵值 **`${CODEX_OAUTH}`** → 触发走 Codex 凭证;`provider` 必须是 `openai-responses`;`baseUrl` 指 ChatGPT 后端。然后 `/model` 选它即可,**无需任何登录/API key**。

> API Key 模式:把 `apiKey` 换成你自己的 `${OPENAI_API_KEY}` 环境变量 + `baseUrl` 指 `https://api.openai.com/v1`,走 easycode 原生 openai 路径即可,本来就支持。

## 实测验证(都是真跑过的,不是推断)

| 项 | 结果 |
|----|------|
| 端点 | `POST https://chatgpt.com/backend-api/codex/responses` ✅ |
| 鉴权头 | `Authorization: Bearer <access_token>` + `chatgpt-account-id: <account_id>` ✅ |
| 请求体强制字段 | `instructions`(必填)、`input`(必须 list)、`store:false`、**`stream:true`(强制,不支持非流式)**、`reasoning` ✅ |
| 返回 | 标准 Responses SSE(`output_text.delta` …),easycode 现有流式解析器直接吃 ✅ |
| 集成 | 编译后的 `CodexAuthManager.getAuthHeaders()` → 真调用 → HTTP 200 + 文本流 ✅ |
| client_id(刷新用) | `app_EMoamEEZ73f0CkXaXp7hrann`(来自 access_token 的 claim,已证实)✅ |

## 实现位置

- 新增 `packages/core/src/core/codexAuth.ts` —— `CodexAuthManager`(单例 + 单飞刷新 + 近过期检测,仿 `proxyAuth.ts`)。
- 改 `packages/core/src/core/customModelAdapter.ts`:
  - 加 `CODEX_OAUTH_SENTINEL` + `isCodexAuth()` + `resolveAuthHeaders()` + `extractSystemText()`(`resolveEnvVar` 之后)。
  - 流式 `callOpenAIResponsesModelStream`:① codex 时注入 `instructions`;② 鉴权头改用 `resolveAuthHeaders()`。
- 非 codex 路径**行为完全不变**(helper 对普通 key 返回 `Bearer <key>`,与改造前一致)。

## ⚠️ 唯一未亲验的点(诚实标注)

**token 自动刷新**没有真触发过——因为当前 access_token 还有 ~9 天有效期。刷新代码是按**已证实的参数**(client_id、`auth.openai.com/oauth/token` 标准端点)写的,但实际刷新往返**未实测**。

验证方法(token 快过期时,或想提前验):临时把 `REFRESH_THRESHOLD_MS` 调到一个超过当前剩余有效期的值,触发刷新路径,看是否成功换到新 token。若 OpenAI 的刷新请求格式有出入(如要 form-urlencoded 而非 JSON),按报错调 `doRefresh()` 即可——位置已隔离在单个方法里。

## 限制 / 已知

- Codex(ChatGPT 后端)**只支持流式**;非流式 `callOpenAIResponsesModel` 对 codex 会 400。agent 主循环走流式,不受影响。
- codex 的 `instructions` 目前取请求里的 systemInstruction(取不到则用默认串),可能与 input 里的 system 有少量重复,后续可优化为"系统提示只走 instructions"。
