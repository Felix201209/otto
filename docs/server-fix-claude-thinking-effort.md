# 服务端修复说明：Claude adaptive thinking 缺失 effort 参数

> **致后端同事**：客户端 (Otto CLI) 已经按 Anthropic 官方协议把 `effort`
> 写入了请求体，但服务端 `claude.ts` 策略只透传了 `thinking` 字段，没透传
> `output_config`，导致现代 Claude（Opus 4.7 等）走 adaptive 模式时拿不到
> effort 上限，行为不稳定。本文档给出最小修复 patch 与验证方法。

---

## 1. 问题现象

| 模型 | 客户端 `/thinking on max` | 实际表现 |
|---|---|---|
| Sonnet 4.6 | 正常 | 思考几秒后逐段下发 reasoning，UI流畅 |
| **Opus 4.7** | **异常** | 简单题 `thoughtsTokenCount=0`（直接跳过思考）；难题 SSE 长时间静默（30s–2min 无任何 chunk），用户体验上像"卡死" |

两个模型走的是**完全相同**的客户端代码 + 相同的服务端 `claude.ts` 策略，请求体差异只有 `model` 字段。差异行为来自上游 Anthropic 对 adaptive 模式缺 effort 时的不同默认策略。

## 2. 根因：服务端只透传了 `thinking`，丢掉了 `output_config`

### 2.1 客户端实际发送的请求体

客户端 `packages/core/src/types/customModel.ts::applyAnthropicAdaptiveThinking()` 严格按 Anthropic 官方文档构造：

```json
{
  "config": {
    "generationConfig": {
      "thinking": { "type": "adaptive", "display": "summarized" },
      "output_config": { "effort": "high" }
    }
  }
}
```

> 注：`effort` 在 Anthropic 官方协议里**属于 `output_config.effort`，不属于 `thinking.effort`**。把它放进 `thinking` 内部会被 Bedrock 拒绝（ValidationException）。这是 Anthropic 在 Claude 4.6+ 引入adaptive 时定的硬约束。

### 2.2 服务端 `claude.ts` 当前实现（`src/routes/chat/strategies/claude.ts:2071-2076`）

```ts
const clientThinking =
  rawReq.thinking ??
  rawReq.config?.thinking ??
  rawReq.config?.generationConfig?.thinking;
if (clientThinking !== undefined) {
  claudeRequest.thinking = clientThinking;
  logger.info('[Claude] 透传 thinking 配置', { ... });
}
```

只读取了 `thinking`，**没有任何代码读取 `output_config`**：

```bash
$ grep -rn "output_config" src/
# 0 matches
```

### 2.3 转发到 Anthropic 上游的请求

```json
{
  "thinking": { "type": "adaptive", "display": "summarized" }
  // ↑ 注意：没有 output_config，effort 字段完全丢失
}
```

Anthropic 官方文档明确：adaptive 模式缺 `output_config.effort` 时，模型会使用一个**保守的内部默认值**。Sonnet 4.6 的默认值偏高，所以表现"正常"；Opus 4.7 的默认值偏低，导致简单题直接跳过思考、难题思考预算不够提前截断。

服务端注释里其实已经写过这个字段（`src/routes/chat/types/request.ts:200-201`、`src/services/claude-compat/claudeFormatConverter.ts:101-102`），只是忘了在 strategy 里实现透传。

## 3. 修复 patch

### 3.1 文件：`src/routes/chat/strategies/claude.ts`

在 `claude.ts` 现有的"透传 thinking"代码块之后（约第 2076 行），追加一段透传 `output_config`：

```ts
// 🆕 thinking 参数透传：客户端按 Anthropic 官方格式传 thinking 字段即可启用 Extended Thinking
const clientThinking =
  rawReq.thinking ??
  rawReq.config?.thinking ??
  rawReq.config?.generationConfig?.thinking;
if (clientThinking !== undefined) {
  claudeRequest.thinking = clientThinking;
  logger.info('[Claude] 透传 thinking 配置', {
    model: modelName,
    thinking: clientThinking,
  });
}

// ===== 新增 START =====
// 🆕 output_config 透传：Anthropic adaptive thinking 模式的 effort 上限字段
// 必须独立于 thinking 字段透传——effort 在官方协议里属于 output_config.effort，
// 放进 thinking 内部会被 Bedrock 拒绝 (ValidationException)。
// 现代 Claude (Opus 4.7 / Mythos / 4.6+) 的 adaptive 模式缺该字段时，
// 上游会使用保守默认值，导致 thoughtsTokenCount=0 或 SSE 长时间静默。
const clientOutputConfig =
  rawReq.output_config ??
  rawReq.config?.output_config ??
  rawReq.config?.generationConfig?.output_config;
if (clientOutputConfig !== undefined) {
  (claudeRequest as any).output_config = clientOutputConfig;
  logger.info('[Claude] 透传 output_config (effort) 配置', {
    model: modelName,
    output_config: clientOutputConfig,
  });
}
// ===== 新增 END =====
```

### 3.2 文件：`src/routes/chat/types/request.ts`（类型补全，可选但推荐）

在 `ClaudeAPIRequest` 类型里加上 `output_config` 字段，避免再用 `as any`：

```ts
export interface ClaudeAPIRequest {
  // ... 现有字段 ...
  thinking?: {
    type: 'enabled' | 'adaptive' | 'disabled';
    budget_tokens?: number;
    display?: 'summarized';
  };

  // 🆕 新增：Claude 4.6+ adaptive 模式的 effort 上限
  output_config?: {
    effort?: 'low' | 'medium' | 'high';
  };
}
```

### 3.3 文件：`src/services/claude-compat/claudeFormatConverter.ts`（可选）

如果该文件里也有 `ClaudeAPIRequest` 同名类型定义，需要同步加 `output_config?` 字段。`grep -n "output_config" src/` 应该能定位所有需要补的位置。

## 4. effort 取值合法性

Anthropic 官方文档列出的合法值：`"low" | "medium" | "high"`。

客户端会发送以下值（已在客户端做了归一化或会归一化到这个集合）：

| 客户端 `/thinking` 设置 | 客户端发送的 effort | 备注 |
|---|---|---|
| `low` | `low` | 直接透传 |
| `medium` | `medium` | 直接透传 |
| `high` | `high` | 直接透传 |
| `max` | `high`（客户端这次会同步钳制） | 客户端会做归一化，避免把不在合法集的值发上去 |
| `xhigh` | `high`（同上） | 同上 |
| `auto` | 不发送 effort 字段 | 让 Anthropic 用默认 |

服务端**无需做合法性校验**，直接透传即可。如果未来 Anthropic 扩展了合法值集（如 `max`），客户端先升级，服务端零改动。

## 5. 验证方法

### 5.1 修改前打日志确认现象

把日志级别开到 info，在 `claude.ts` 入口处临时加一行打印完整的 `rawReq`：

```ts
logger.info('[Claude DEBUG] full incoming request', {
  hasThinking: rawReq.config?.generationConfig?.thinking !== undefined,
  hasOutputConfig: rawReq.config?.generationConfig?.output_config !== undefined,
  thinking: rawReq.config?.generationConfig?.thinking,
  output_config: rawReq.config?.generationConfig?.output_config,
});
```

预期能看到 `hasThinking=true` + `hasOutputConfig=true` 但 effort 没被透传到上游。

### 5.2 修复后端到端验证

用 Opus 4.7 跑一道**确定需要思考的难题**（避免 adaptive 决定不思考）：

```
设计 O(n) 时间、O(1) 空间的算法，输出数组中所有出现次数 > n/3 的元素。
要求：
1. 完整伪代码；
2. 严格证明正确性（尤其是为什么两轮扫描就够）；
3. 证明 > n/4 版本在同样空间约束下不可能 O(n) 解决（给出下界论证）。
```

#### 验证指标

- 服务端日志出现 `[Claude] 透传 output_config (effort) 配置`
- 客户端日志 `[STOP-DEBUG][adapter]` 流中：
  - 短时间内（< 5s）出现非空 `reasoning` chunk，**不再是空字符串占位**
  - 最终 `usageMetadata.thoughtsTokenCount > 0`（修复前 Opus 简单题为 0）
- 客户端 UI 看到逐段流出的 thinking 摘要，而不是长时间静默

#### 对比测试

| 场景 | 修复前 | 修复后预期 |
|---|---|---|
| Opus 4.7 + 难题 + `effort: high` | SSE 静默 30s–2min | 几秒内开始流式输出 reasoning |
| Opus 4.7 + 简单题 + `effort: high` | `thoughtsTokenCount=0` | `thoughtsTokenCount > 0`（至少几百） |
| Sonnet 4.6（任意题） | 正常 | 应**保持原样**或更好（不应回归） |
| 不传 effort 的旧客户端 | 当前行为 | **必须保持一致**（兼容性） |

## 6. 兼容性 / 回归风险

| 风险点 | 评估 |
|---|---|
| 旧客户端不发 `output_config` | `if (clientOutputConfig !== undefined)` 守卫，无变化 |
| 新客户端发了不合法的 effort | 上游 Anthropic 拒绝并报 400，错误会原样透传给客户端，行为可控；客户端这边也已做归一化 |
| `thinking` + `output_config` 字段同时存在但 mode 不是 adaptive | Anthropic 的 enabled 模式会忽略 `output_config`，无副作用 |
| 客户端走的是 `thinking` 顶层而不是 `config.generationConfig.thinking` | 修复中三层 `??` 已覆盖三种路径，与现有 thinking 透传保持一致 |

风险评级：**低**。新增逻辑完全位于 `if undefined` 守卫内，对现有流量零影响。

## 7. 相关文件 & 行号速查

| 路径 | 用途 |
|---|---|
| `src/routes/chat/strategies/claude.ts:2071-2076` | thinking 透传现状 |
| `src/routes/chat/strategies/claude.ts:2076 之后` | **本次需要新增的代码位置** |
| `src/routes/chat/types/request.ts:200-201` | 类型注释中已提及 effort，但未落地 |
| `src/services/claude-compat/claudeFormatConverter.ts:101-102` | 同上 |
| `src/services/ai-clients/easyrouterClaudeClient.ts` | 仅做透传，无需改动 |

## 8. 如有疑问

客户端这边的相关实现：

- 字段构造：`packages/core/src/types/customModel.ts::applyAnthropicAdaptiveThinking()`
- 注入到请求体：`packages/core/src/core/OttoServerAdapter.ts::applyGenAIThinkingConfig()`
- 自定义模型直连路径（不走 Otto 服务端，参考用）：`packages/core/src/core/customModelAdapter.ts::callAnthropicModelStream()`

调试日志开关：客户端启用 `[thinking-debug]` 日志（已加在 `applyGenAIThinkingConfig` 入口和出口），可逐请求打印实际发送的字段，方便联调比对。

---

**总结一行话**：在 `claude.ts` 的 thinking 透传旁边补一段对称的 output_config 透传即可，~10 行代码，零回归风险。
