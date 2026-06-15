Tengo todas las anclas reales que necesito. Resumen de verificación de discrepancias clave entre los JSON y el código real:

- Dispatch de provider: **customModelAdapter.ts:3063-3089** (NO line 400 como decía un JSON) — `if (modelConfig.provider === 'openai'/'openai-responses'/'anthropic')`.
- Sesiones aisladas Feishu: **feishuCommand.ts:616** `isolatedSessions = new Map<string, {config, geminiClient}>()`, gateway creado en **feishuCommand.ts:2483**, `onMessage` en **2496** (no "100+" ni "57").
- Memoria: append a sección **memoryTool.ts:53** en **projectRoot/DEEPV.md (line 256)** — siempre raíz del proyecto, NO los 4 niveles que un JSON sugería existían.

Tengo lo necesario. Escribo el diseño.

---

# EasyCode × Hermes 嫁接架构设计（本机 CLI 后端 + 飞书）

> 全部 file:line 已对照真实源码核验。凡与接地 JSON 冲突处，以本文核验值为准（已在文末「JSON 纠偏」标注）。所有路径为绝对路径。

---

## 0. 一句话定位

在 **EasyCode 现有 CLI/agent 骨架**（`packages/core` + `packages/cli`）之上，**借鉴**（不照搬移植 Python）Hermes 的三样东西——**记忆 Provider 抽象 + 生命周期钩子 + 单外部 Provider 约束**；模型层加 **Codex OAuth / API Key 双鉴权**；飞书侧**直接复用已存在的 `FeishuGateway`**。明确**不做 Claude OAuth**。

EasyCode 已经不是空白：飞书网关（`gateway.ts` 3429 行）、CardKit 流式卡片、隔离会话、Turn 钩子（BeforeModel/AfterModel）、多 provider 适配器、proxyAuth token 管理**都已存在**。这是「增量嫁接」而非「重写」。

---

## 1. 总体形态（组件图）

```
┌──────────────────────────────────────────────────────────────────────┐
│                        本机进程 (Node/TS, 单机)                          │
│                                                                        │
│   ┌─────────────┐         ┌──────────────────────────────────────┐    │
│   │  CLI 入口    │         │           飞书桥接层                    │    │
│   │ packages/cli │         │  feishuCommand.ts (启动/编排, 5072行)  │    │
│   │  (TUI/REPL) │         │  FeishuGateway   (gateway.ts, 3429行)  │    │
│   └──────┬──────┘         │   - WSClient + EventDispatcher (1373)  │    │
│          │                │   - onMessage 回调 (2496)              │    │
│          │                │   - CardKit 流式卡片 (237/291)         │    │
│          │                └───────────────┬──────────────────────┘    │
│          │                                │ FeishuMessage             │
│          │        ┌───────────────────────┴──────────┐                │
│          └───────►│   会话路由 isolatedSessions Map     │                │
│                   │   (feishuCommand.ts:616)           │                │
│                   │   chatId → {Config, GeminiClient}  │                │
│                   └───────────────┬───────────────────┘                │
│                                   │                                    │
│   ┌───────────────────────────────▼─────────────────────────────┐     │
│   │                  Agent Harness (packages/core)               │     │
│   │                                                              │     │
│   │   GeminiClient → Turn.run() (turn.ts:247)                    │     │
│   │     ├─ 🪝 BeforeModel  (turn.ts:252)  ← 记忆 prefetch 注入    │     │
│   │     ├─ sendMessageStream (turn.ts:285) → customModelAdapter  │     │
│   │     └─ 🪝 AfterModel   (turn.ts:491)  ← 记忆 sync_turn        │     │
│   │                                                              │     │
│   │   ┌──────────────────┐   ┌──────────────────────────────┐   │     │
│   │   │  MemoryManager    │   │  customModelAdapter.ts        │   │     │
│   │   │  (新增, 借 Hermes) │   │  callCustomModel (3070)       │   │     │
│   │   │  + MemoryProvider │   │  provider 分发 (3087-3089):    │   │     │
│   │   │    抽象基类        │   │   openai / openai-responses /  │   │     │
│   │   │  + 内建 DEEPV.md   │   │   anthropic / +codex-oauth(新)│   │     │
│   │   └────────┬─────────┘   └──────────────┬───────────────┘   │     │
│   └────────────┼───────────────────────────┼───────────────────┘     │
│                │                            │                          │
│   ┌────────────▼────────┐      ┌────────────▼─────────────────┐       │
│   │ 本机记忆存储          │      │  鉴权层                        │       │
│   │ DEEPV.md (现状)      │      │  ProxyAuthManager (现状,JWT)   │       │
│   │ → SQLite (P2 可选)   │      │  + CodexAuthManager (新增)     │       │
│   └─────────────────────┘      │    读 ~/.codex/auth.json       │       │
│                                │    OAuth refresh / API Key     │       │
│                                └────────────┬───────────────────┘       │
└────────────────────────────────────────────┼──────────────────────────┘
                                              │ HTTPS
                          ┌───────────────────▼──────────────────┐
                          │ OpenAI/Codex API · auth.openai.com    │
                          │ (refresh)  ·  Anthropic API (api-key) │
                          └───────────────────────────────────────┘
```

核心取舍：**不引入独立 gateway 进程 + 线程池**（Hermes 那套是 Python asyncio 多平台网关）。EasyCode 是 Node 单进程、事件循环天然异步、飞书 `WSClient` 已经是长连接回调模型，再叠一层网关进程是过度工程。直接在 `onMessage` 回调里 `await Turn.run()` 即可。

---

## 2. Harness：从 Hermes 借什么、怎么融进 EasyCode 的 agent loop

### 2.1 借鉴清单（明确取舍）

| Hermes 机制 | 借 / 不借 | 理由 |
|---|---|---|
| MemoryProvider ABC + 12 生命周期钩子 (`memory_provider.py:42-297`) | **借（精简到 5 钩子）** | 是干净的扩展点，端口成 TS 成本低 |
| 单外部 Provider 约束 (`memory_manager.py:273-296`) | **借** | 防工具 schema 膨胀，一行 guard |
| `<memory-context>` fence + StreamingContextScrubber (`memory_manager.py:62-250`) | **借（简化版）** | 防注入污染 LLM 输出，必要 |
| 后台 ThreadPoolExecutor + jitter retry (`memory_manager.py:513-550`) | **不借** | Node 用 `void promise.catch()` 异步即可，无需线程池 |
| 独立 gateway 进程 + 线程池委派 (`gateway/run.py:13034`) | **不借** | EasyCode 已有 onMessage 异步回调 |
| SQLite SessionDB + FTS5/trigram (`hermes_state.py:657+`) | **P2 可选** | MVP 用文件足够；搜索需求出现再上 |
| 插件 register(ctx) + 18 钩子 (`plugins.py:128-170`) | **P2 借子集** | EasyCode 已有 hooks 子系统（见下），先复用现有 |

### 2.2 EasyCode 现有钩子点（嫁接锚点，已核验）

EasyCode 的 `Turn.run()` 已经内置了 **Hermes 风格的钩子触发**，这是最关键的现成切口：

- **`turn.ts:247`** `async *run(...)` — agent 单轮主循环（生成器）。
- **`turn.ts:252-266`** `🪝 BeforeModel` 钩子 `fireBeforeModelEvent(...)` —— **记忆 prefetch 注入点**。在这里把 `MemoryManager.prefetch()` 拿到的 `<memory-context>` 拼进即将发给模型的请求。
- **`turn.ts:280`** `🪝 BeforeToolSelection` 钩子 —— 工具过滤点（P2 用）。
- **`turn.ts:285`** `this.chat.sendMessageStream(...)` —— 实际调模型，下游进 `customModelAdapter`。
- **`turn.ts:491-501`** `🪝 AfterModel` 钩子 `fireAfterModelEvent(...)` —— **记忆 sync_turn 写回点**。
- `turn.ts:226` `private config: any` —— 钩子通过 config 拿全局引用；`MemoryManager` 挂在 config 上即可被钩子访问。

> 关键事实：**不需要新造钩子框架**。Hermes 的 `pre_llm_call`/`post_llm_call`（`plugins.py`）在 EasyCode 里已对应 `BeforeModel`/`AfterModel`。嫁接 = 在这两个已存在的钩子回调里调 MemoryManager。

### 2.3 会话上下文载体

`packages/core/src/config/agent-loop-context.ts:25-59` 已定义 `AgentLoopContext`，携带 `promptId`(line 30)、`parentSessionId`(line 33)、`geminiClient`(line 52)。**缺一个 `sessionId` 给记忆层用**——这是接地 JSON 第 2 份指出的 gap，确认属实：当前 memory 层拿不到 session 身份。

嫁接动作：给 `AgentLoopContext` 加 `readonly sessionId?: string`，飞书侧用 `chatId` 当 sessionId（`feishuCommand.ts:616` 的 isolatedSessions key 已经是 chatId，天然稳定键）。

---

## 3. 记忆系统：Hermes 式分层 → 从 DEEPV.md 迁移

### 3.1 EasyCode 现状（已核验，比 JSON 描述更朴素）

- `memoryTool.ts:53` 段落头 `## DeepV Code Added Memories`。
- `memoryTool.ts:256` **始终写 `config.getProjectRoot()/DEEPV.md`**——即只有「项目级」一档，**接地 JSON 说的「四级 sessionMemory/agentMemory/userMemory/globalMemory」当前并不存在**，是要新建的目标态。
- `memoryTool.ts:341` 同步 `writeFile`（确认无异步/无 prefetch/无搜索）。
- `memoryDiscovery.ts` 提供向上/向下发现 DEEPV.md 的层级搜索（340 行），是分层迁移可复用的基础设施。

### 3.2 目标态：三层结构化记忆（敢取舍——砍到 3 层，不照搬 Hermes 全量）

```
全局记忆  ~/.easycode-user/memory/global.md      # 跨项目、跨会话（用户偏好/习惯）
项目记忆  <projectRoot>/DEEPV.md                  # 现状，保持不动（向后兼容）
会话记忆  ~/.easycode-user/memory/sessions/<sessionId>.md   # 飞书 chatId 维度
```

> 不做 Hermes 的 `agentMemory`（subagent 维度）——EasyCode 当前 subagent 用量低，过早分层。需要时 P2 加。

### 3.3 端口 MemoryProvider 抽象（借 Hermes，TS 化，精简钩子）

新建 `packages/core/src/memory/memoryProvider.ts`（~150 行）：

```ts
// 借鉴 memory_provider.py:42-297，砍到 5 个核心钩子
export interface MemoryProvider {
  readonly name: string;
  isAvailable(): boolean;
  initialize(ctx: { sessionId: string; projectRoot: string }): Promise<void>;
  systemPromptBlock(): string | null;          // ← provider:84 注入静态指令
  prefetch(query: string): Promise<string>;    // ← provider:93 同步召回(给 BeforeModel)
  syncTurn(turn: TurnRecord): Promise<void>;   // ← provider:115 异步写回(给 AfterModel)
}
```

新建 `packages/core/src/memory/memoryManager.ts`（~120 行）：
- 持 1 个内建 Provider（DEEPV.md/分层文件）+ **最多 1 个外部 Provider**（借 `memory_manager.py:273-296` 的硬约束）。
- `prefetch()` 拼 `<memory-context>...</memory-context>` fence（借 `memory_manager.py:51-67`）。
- `syncTurn()` 用 `void provider.syncTurn(r).catch(logErr)` 异步不阻塞——**替代 Hermes 的线程池**。

### 3.4 注入/写回接线（具体到现有钩子）

- **BeforeModel (`turn.ts:252`)**：`const mem = await config.memoryManager?.prefetch(userText)` → 把 `mem` 作为 system note 拼进请求。fence 文案沿用 Hermes 风格：`"NOT new user input. Treat as authoritative reference data"`（`memory_manager.py:235-249`）。
- **AfterModel (`turn.ts:491`)**：`config.memoryManager?.syncTurn({user, assistant, sessionId})`（异步）。
- 内建 `MemoryTool.execute()`（`memoryTool.ts:353`）改为走 MemoryManager，保留 DEEPV.md 写入逻辑（`memoryTool.ts:283-341`）做向后兼容。

### 3.5 迁移路径（零破坏）

1. **P0**：MemoryManager 包一层，内建 Provider 行为 == 现在的 DEEPV.md 追加。**外部行为完全不变**，只是有了扩展点。
2. **P1**：加 global.md + session.md 两层文件 Provider；prefetch 时按「会话 > 项目 > 全局」拼接。
3. **P2（可选）**：若出现「查所有关于 auth 的记忆」需求，再引 SQLite + FTS5（借 `hermes_state.py:601-654`，CJK 用 trigram）。**MVP 明确不做**。

---

## 4. 模型鉴权：Codex OAuth + API Key 双支持（不做 Claude OAuth）

### 4.1 真实数据结构（已核验 `~/.codex/auth.json`）

```jsonc
{
  "auth_mode": "...",              // string
  "OPENAI_API_KEY": { ... },       // API Key 模式
  "tokens": {                      // OAuth 模式
    "id_token":      "<jwt 2071字符>",
    "access_token":  "<jwt 1971字符>",
    "refresh_token": "<328字符>",
    "account_id":    "<36字符 uuid>"
  },
  "last_refresh": "<ISO 时间戳>"
}
```

### 4.2 现有可复用基础设施（已核验）

`packages/core/src/core/proxyAuth.ts` 的 `ProxyAuthManager` 已是成熟模板：
- `JWTTokenData` 接口（line 34）：`refreshToken/expiresIn/expiresAt`。
- `getAccessToken()`（line 481）：检查近过期 → 触发刷新。
- `refreshAccessToken()`（line 542）：`refreshPromise` 单飞（line 72）防并发刷新风暴；`fetch` POST 刷新端点（line 569）。
- `TOKEN_REFRESH_THRESHOLD`（line 61）+ `isTokenNearExpiry()`（line 523）。
- 本地存储 `~/.easycode-user/jwt-token.json`（line 140）。

### 4.3 设计：新增 CodexAuthManager（克隆 proxyAuth 模式）

新建 `packages/core/src/core/codexAuth.ts`：

```ts
interface CodexAuthData {
  authMode: 'oauth' | 'apikey';
  apiKey?: string;                              // OPENAI_API_KEY 字段
  tokens?: { idToken; accessToken; refreshToken; accountId };
  lastRefresh?: string;
}

class CodexAuthManager {
  private path = path.join(os.homedir(), '.codex', 'auth.json');  // 复用 Codex 官方文件
  private refreshPromise: Promise<string> | null = null;          // 借 proxyAuth.ts:72 单飞

  async getAuthHeaders(): Promise<Record<string,string>> {
    if (this.data.authMode === 'apikey')                          // ① API Key 优先级
      return { 'Authorization': `Bearer ${this.data.apiKey}` };
    const token = await this.getValidAccessToken();               // ② OAuth
    const h = { 'Authorization': `Bearer ${token}` };
    if (this.data.tokens?.accountId)                              // ChatGPT-Account-Id 可选
      h['ChatGPT-Account-Id'] = this.data.tokens.accountId;
    return h;
  }

  // 借 proxyAuth.ts:481+542 — 近 8 天过期则用 refresh_token 换新
  private async refresh(): Promise<string> {
    // POST https://auth.openai.com/oauth/token
    // grant_type=refresh_token, client_id=app_EMoamEEZ73f0CkXaXp7hrann
    // 单飞 + 写回 ~/.codex/auth.json 的 tokens + last_refresh
  }
}
```

### 4.4 customModelAdapter 改造切口（精确）

现有 provider 分发在 **`customModelAdapter.ts:3087-3089`**（`callCustomModel`）和 **`:3063-3065`**（`callCustomModelStream`），形如：

```ts
if (modelConfig.provider === 'openai') return callOpenAICompatibleModel(...);
else if (modelConfig.provider === 'openai-responses') return callOpenAIResponsesModel(...);
else if (modelConfig.provider === 'anthropic') return callAnthropicModel(...);
```

鉴权头当前在各 call 函数里硬拼 `'Authorization': Bearer ${apiKey}`（`:974`/`:1315`/`:1397`），`apiKey` 来自 `resolveEnvVar(modelConfig.apiKey)`（`:947`/`:1277`/`:1368`）。

**改造方案（最小 diff，不新增 provider 分支，复用 `openai-responses` 协议）**：
- Codex 走 OpenAI 兼容 / Responses 协议，**协议层不变**，只换鉴权头来源。
- 在 `callOpenAICompatibleModel`/`callOpenAIResponsesModel` 里，把 `apiKey` 解析改为：若 `modelConfig.apiKey === '${CODEX_OAUTH}'`（哨兵值），则 `headers = await codexAuthManager.getAuthHeaders()`，否则走现状 `Bearer ${resolveEnvVar(...)}`。
- 切口就在 `:974`/`:1315`/`:1397` 的 headers 构造前插一个分支。**不碰协议、不碰流式解析**。

> 取舍：**不新增 `codex-oauth` provider 类型**（接地 JSON 第 5 份建议新增两个 provider）。因为 Codex 就是 OpenAI 协议，新增 provider = 复制两套 call 函数 = 重复 ~600 行。用「哨兵 apiKey + 鉴权头注入」更省。
> **明确不做 Claude OAuth**：`anthropic` provider（`:1594`）保持只用 `x-api-key`/`Bearer` + 静态 key，不接任何 OAuth 刷新逻辑。

### 4.5 优先级 / 生命周期（接地 JSON 标注的 gap，此处定规则）

- **provider 内优先级**：`auth_mode === 'apikey'` 且 `OPENAI_API_KEY` 存在 → 用 API Key（无刷新，最简）；否则用 OAuth。
- **飞书 + Codex 嵌套 token**：两条独立生命周期，互不耦合。飞书 token 由 `FeishuGateway` 自己的 tenant_access_token 管（`gateway.ts` 内）；Codex token 由 `CodexAuthManager` 管。**onMessage 回调里只在真正调模型时才触发 Codex 刷新**，单飞保证一个 chatId 风暴不会引发多次刷新。

---

## 5. 飞书接入：复用现有 gateway / lark-cli

**几乎全部现成，无需新建。** 已核验：

- **`gateway.ts:343`** `class FeishuGateway` —— WSClient + EventDispatcher（`:1373`）长连接，注册 `im.message.receive`（`:1386`）。
- **`gateway.ts:57`** `OnMessageCallback = (msg: FeishuMessage) => Promise<string | null>` —— 这就是嫁接 agent 的唯一接口点。
- **`gateway.ts:1528-1538`** 收消息 → 调 `this.onMessage(feishuMsg)` → `sendMessage` 回复。去重在调 onMessage 前落盘（`:1504` 注释，防进程中断重复处理）。
- **CardKit 流式卡片**：`buildCardKitStreamingCard`（`:237`）/`buildCardKitFinalCard`（`:291`），流式元素 id `:111`。Turn 的流式输出可逐块 `updateMessage` 进卡片——对应 Hermes 的 `tool_progress_callback → 消息编辑` 模式。
- **`feishuCommand.ts:2483`** `new FeishuGateway(appId, appSecret, domain)` → **`:2496`** `gateway.onMessage = async (msg) => {...}` 里已经在跑 agent。
- **`feishuCommand.ts:616`** `isolatedSessions: Map<chatId, {Config, GeminiClient}>` —— 每个飞书会话一套隔离的 Config+Client。**这就是 sessionId 的天然来源**（解决 §2.3 的 gap）。
- **`lark-cli.ts`**（853 行）+ `feishu-send-file-tool.ts` —— 文件/图片发送工具，agent 可直接调。

嫁接动作（极小）：在 `:2496` 的 onMessage 闭包里，把 `chatId` 作为 `sessionId` 传入 `AgentLoopContext`，使记忆层能按会话分桶。其余飞书逻辑**一行不改**。

> 飞书 OAuth bridging（接地 JSON 第 1 份的 gap）：**确认非问题**。`FeishuGateway` 用的是 app_id/app_secret → tenant_access_token，已在 gateway 内实现；这与 Codex 的用户 OAuth 是两回事，不混淆。

---

## 6. 分阶段嫁接计划（每步可独立验证）

### P0 — 双鉴权打通（不碰记忆，最高价值/最低风险）
1. 新建 `codexAuth.ts`：读 `~/.codex/auth.json`，实现 `getAuthHeaders()`（API Key 分支 + OAuth 分支 + refresh 单飞）。
2. 在 `customModelAdapter.ts:974` 区域插哨兵分支：`apiKey === '${CODEX_OAUTH}'` → 用 CodexAuthManager 头。
3. **验证**：配一个 model 用 Codex OAuth，`callCustomModel` 实跑一次拿到 200 响应；再切 API Key 模式跑一次；故意把 access_token 改过期，看是否触发 refresh 并成功。三条都跑通才算完成。

### P1 — 记忆扩展点 + 飞书 sessionId（行为向后兼容）
4. 新建 `memoryProvider.ts` + `memoryManager.ts`；内建 Provider == 现 DEEPV.md 行为。
5. `AgentLoopContext` 加 `sessionId`；`feishuCommand.ts:2496` 传 `chatId`。
6. 在 `turn.ts:252`（BeforeModel）接 `prefetch`、`turn.ts:491`（AfterModel）接 `syncTurn`。
7. 加 global.md / session.md 两层文件 Provider。
8. **验证**：飞书里在 chatA 说「记住我喜欢简洁回复」→ 新开 chatA 一轮，确认 prefetch 把它注入了；chatB 不受影响（会话隔离）；DEEPV.md 原有内容/格式不变（diff 为空或仅追加）。截图飞书卡片实测。

### P2 — 可选增强（按真实需求触发，否则不做）
9. SQLite + FTS5 记忆搜索（借 `hermes_state.py:601-654`）——仅当「检索历史记忆」成为真实需求。
10. 复用 EasyCode 现有 hooks 子系统（`packages/core/src/hooks`）暴露 Hermes 式 plugin 子集。
11. 定时任务（借 `cron/scheduler.py` 文件锁 + tick）——若要「飞书定时数字同事」再做。

---

## 7. 风险与未知（诚实标注）

| # | 风险/未知 | 状态 | 缓解 |
|---|---|---|---|
| R1 | Codex OAuth refresh 端点/client_id 是否仍为 `app_EMoamEEZ73f0CkXaXp7hrann` | **未亲验**（来自接地 JSON 第 4 份，非我跑通）| P0 step 3 必须实跑刷新；失败则抓 Codex CLI 真实刷新请求对照 |
| R2 | `~/.codex/auth.json` 的 `OPENAI_API_KEY` 字段是 object 不是 string（我核验所见） | **已发现差异** | 解析时按 object 处理，别假设是裸字符串；需读子字段确认实际 key 位置 |
| R3 | `customModelAdapter.ts` 有 3 处 headers 构造（:974/:1315/:1397），改一处漏两处 | 已知 | P0 三处都改，或抽 `buildAuthHeaders()` 单一事实源（文件 :71 注释提到已有「单一事实源」倾向，顺势复用）|
| R4 | Turn 钩子 `fireBeforeModelEvent` 的实际签名/返回值能否改请求体 | **未读钩子实现** | P1 前先读 `config.fireBeforeModelEvent` 定义，确认能注入 context；不能则改用 chat history 注入 |
| R5 | StreamingContextScrubber 在 EasyCode 流式（Responses/Anthropic SSE）下的分块边界 | 未实现 | P1 先用「整块注入 + 不回显 fence」简化版；流式擦除 P2 再精修 |
| R6 | DEEPV.md 当前只写 projectRoot（:256），多会话并发写同一文件可能竞争 | 已知 | session 记忆写独立文件（sessions/<id>.md）天然规避；global.md 需加文件锁或串行 |
| R7 | 飞书长连接断线重连 / 去重落盘（:1504）与记忆 syncTurn 的幂等性 | 部分已知 | syncTurn 设计成幂等（按 messageId 去重），借飞书已有去重机制 |
| R8 | 接地 JSON 的若干 file:line 与真实不符（见下「纠偏」），其余未逐一复验 | 部分核验 | 凡本文引用的 file:line 均已核验；P2 涉及的 Hermes Python 行号未复验（不阻塞 MVP）|

### JSON 纠偏（基于真实源码）
- **provider 分发不在 `customModelAdapter.ts:400+`**，实际在 **:3063-3089**（`callCustomModel`/`callCustomModelStream`）。
- **建议「新增 codex-oauth/codex-apikey 两个 provider」→ 不采纳**：用哨兵 apiKey + 鉴权头注入，省 ~600 行重复。
- **「memoryTool 四级分层存储已存在」不实**：现状只有 projectRoot/DEEPV.md 单档（:256），四层是目标态需新建。
- **`feishuCommand.ts:100+` 创建 HermesAgent / `gateway.ts:57` 是 OnMessageCallback 类型定义**：实际 agent 编排在 :2483/:2496，:616 的 isolatedSessions 才是会话路由核心；:57 是回调类型签名（正确）。
- **`~/.codex/auth.json` 的 `OPENAI_API_KEY` 是 object**，非接地 JSON 暗示的裸字符串 `sk-...`。

---

关键文件清单（绝对路径，嫁接时直接打开）：
- Turn 钩子点：`/Users/felix/Desktop/EasyCode/packages/core/src/core/turn.ts`（:247/:252/:285/:491）
- Provider 分发 + 鉴权头：`/Users/felix/Desktop/EasyCode/packages/core/src/core/customModelAdapter.ts`（:3063-3089/:974/:1315/:1397/:947）
- 鉴权模板：`/Users/felix/Desktop/EasyCode/packages/core/src/core/proxyAuth.ts`（:34/:72/:481/:542/:140）
- 记忆现状：`/Users/felix/Desktop/EasyCode/packages/core/src/tools/memoryTool.ts`（:53/:256/:341），`/Users/felix/Desktop/EasyCode/packages/core/src/utils/memoryDiscovery.ts`
- 会话上下文：`/Users/felix/Desktop/EasyCode/packages/core/src/config/agent-loop-context.ts`（:25-59）
- 飞书网关：`/Users/felix/Desktop/EasyCode/packages/cli/src/services/feishu/gateway.ts`（:57/:343/:1373/:1528/:237/:291）
- 飞书编排：`/Users/felix/Desktop/EasyCode/packages/cli/src/ui/commands/feishuCommand.ts`（:616/:2483/:2496）
- Codex 凭证：`/Users/felix/.codex/auth.json`（tokens.{id_token,access_token,refresh_token,account_id} + OPENAI_API_KEY + auth_mode + last_refresh）