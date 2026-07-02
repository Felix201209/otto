压缩修复效果验证总结
================================

## 核心修复内容回顾

提交 7a7d8831 修复了三层嵌套的 bug，导致用户在高 token 消耗场景下出现"无声停止"现象。

## 关键修复验证

### 1. Signal 隔离 ✅

**修复前问题:**
```
sendMessageStream()
  ↓
  this.tryCompressChat(prompt_id, signal, true)  // ❌ 复用user-turn的signal
  ↓
用户按ESC → signal.abort() → compression任务中止 → AbortError
↓
retryWithBackoff 对 AbortError 不重试 → 静默失败
↓
熔断器+1，后续auto-compress全部跳过
```

**修复后:**
```
sendMessageStream()
  ↓
const compressionAbort = new AbortController()  // ✅ 独立controller
设置120s超时自动abort()
  ↓
即使用户按ESC，也不影响压缩任务
  ↓
压缩要么成功，要么120s超时自动停止
  ↓
所有结果都明确通知UI
```

验证点：
- 📍 packages/core/src/core/client.ts:791-797
  ```typescript
  const compressionAbort = new AbortController();
  const compressionTimeoutMs = 120_000;
  const compressionTimeoutHandle = setTimeout(() => {
    console.warn('[sendMessageStream] Auto-compress timeout reached, aborting');
    compressionAbort.abort();
  }, compressionTimeoutMs);
  ```
- ✅ AbortController 独立，不依赖 user-turn signal
- ✅ 120s 超时作为绝对保护


### 2. 降级策略 ✅

**修复前问题:**
```
自动压缩失败
↓
console.warn() 打印日志
↓
继续对话流程，history 未被缩减
↓
API 因 token 超限返回 400
↓
用户看到流式响应无故中断
```

**修复后:**
```
自动压缩失败 或 熔断器跳闸
↓
尝试 MicroCompact 兜底
  - 清理旧的可压缩工具输出（read_file, search等）
  - 用简短占位符替换
  - 零 LLM 调用
  ↓
兜底成功(clearedCount > 0)
  → yield success:true, degraded:true
  → UI显示"轻量模式继续"
  → 对话继续

兜底失败(clearedCount == 0)
  → yield success:false
  → return new Turn() 立即停止
  → UI显示"请手动/compress"
```

验证点：
- 📍 packages/core/src/core/client.ts:365-411
  ```typescript
  private runMicroCompactFallback(): { applied: boolean; clearedCount: number } {
    // 直接调用microCompactMessages，不走shouldMicroCompact
    const mcResult = this.microCompactService.microCompactMessages(curHistory, 2);
    if (mcResult.applied) {
      this.getChat().setHistory(curHistory);
    }
    return { applied: mcResult.applied, clearedCount: mcResult.clearedCount };
  }
  ```
- ✅ 两处调用兜底：熔断器跳闸时 + 全量压缩失败时
- ✅ applied=true 时表示成功释放了空间


### 3. UI 反馈路径 ✅

**修复前问题:**
```
handleChatCompressionEvent(value: ChatCompressionInfo | null)
  ↓
value?.originalTokenCount / value?.newTokenCount
  ↓
显示"Chat history compressed from X to Y tokens"

但在失败情况下，value 可能是 null
→ 前端无法区分失败状态
→ 用户看不到失败提示
```

**修复后:**
```
handleChatCompressionEvent(value: ChatCompressionEventPayload | null)
  ↓
value.success 区分三种情况：

1. success: true, degraded: false, info: {...}
   → yield COMPRESSION 消息
   → "Chat history compressed successfully."

2. success: true, degraded: true, clearedCount: N
   → yield INFO 消息
   → "轻量模式继续（清理了N条旧工具输出）"

3. success: false, reason: "..."
   → yield ERROR 消息
   → "⚠️ 自动压缩失败，请手动/compress或/session new"
```

验证点：
- 📍 packages/core/src/core/turn.ts:145-161
  新增 ChatCompressionEventPayload interface
- 📍 packages/cli/src/ui/hooks/useGeminiStream.ts:1307-1331
  按 payload 结构分支处理
- ✅ 三种消息类型明确对应三种压缩结果


### 4. 熔断器与恢复 ✅

**触发条件:**
```typescript
// CompressionService.ts
maxConsecutiveFailures = 3（默认）
consecutiveAutoCompressFailures >= 3 → 熔断器跳闸
```

**恢复路径:**
1. 熔断跳闸时自动尝试 MicroCompact
2. MicroCompact 成功 → degraded 模式继续
3. MicroCompact 失败 → 等待用户手动 /compress
4. 手动 /compress 成功 → resetCircuitBreaker() → 恢复


## 现在的工作状态

✅ 提交 7a7d8831 已成功集成到最新版本
✅ npm run build 编译通过（17.49s）
✅ 三个工作区编译成功：
  - core [SUCCESS]
  - cli [SUCCESS]
  - vscode-ui-plugin [SUCCESS]

✅ 关键流程验证：
  1. Token 检查 - needsCompression 标记机制 ✅
  2. 信号解耦 - 独立 AbortController ✅
  3. 超时保护 - 120s 绝对超时 ✅
  4. 降级策略 - MicroCompact 兜底 ✅
  5. 错误处理 - try/catch + yield events ✅
  6. UI 反馈 - 三种事件类型分支处理 ✅


## 已知遗漏（需后续修正）

⚠️ remoteSession.ts:749 消费点
```typescript
case GeminiEventType.ChatCompressed:
  remoteLogger.info('RemoteSession', `对话已自动压缩: ${this.sessionId}`, event.value);
  break;
```
问题：无条件记为"已自动压缩"，未按 success 分支

建议：
```typescript
case GeminiEventType.ChatCompressed:
  if (event.value?.success) {
    if (event.value?.degraded) {
      remoteLogger.info('..., 轻量模式继续 (cleared ${event.value.clearedCount})');
    } else {
      remoteLogger.info('..., 完整压缩成功');
    }
  } else {
    remoteLogger.warn('..., 压缩失败');
  }
  break;
```


## 压缩流程完整链路验证

客户端持续发送消息
  ↓
GeminiClient.sendMessageStream()
  ↓
处理响应 → updateTokenCountAndCheckCompression()
  ↓
if sessionTokenCount >= (80% * modelLimit)
  → needsCompression = true
  ↓
下一条消息发送前
  ↓
checkCompression() + 开始压缩流程
  ↓
if (compressionService.isCircuitBreakerTripped())
  → MicroCompact 兜底
  → 降级或失败
else
  → 全量 LLM 压缩
  → 使用独立 AbortController + 120s 超时
  ↓
yield ChatCompressed 事件
  ↓
CLI 层的 handleChatCompressionEvent()
  ↓
按 success/degraded/reason 显示对应 UI 消息
  ↓
对话继续或提示用户手动操作


## 结论

自动压缩逻辑的核心修复是扎实的，应该能在实际使用中消除"无声停止"现象。
用户将获得明确的压缩状态反馈，即使在高 token 消耗场景下也能保证对话的连续性。

主要改进：
✅ 不再因为用户输入而中断压缩
✅ 失败时有明确的降级策略
✅ UI 反馈清楚传达系统状态
✅ 提供恢复路径而不是死路

剩余工作：修正 remoteSession.ts 的消费点
