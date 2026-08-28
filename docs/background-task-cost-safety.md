# 后台任务与成本安全

本文是 Otto 后台任务、付费调用和外部写操作的权威工程契约。

## 默认行为

- 新安装采用手动授权。
- 后台模型任务默认关闭；缺失、非法或旧版配置都按关闭处理。
- 个人版空闲状态不得产生模型或其他付费调用。
- 用户只有通过明确设置开启后，后台模型分析才能注册和运行；关闭设置必须立即停止已注册任务。
- 关闭桌面窗口时必须明确选择继续后台运行、停止任务并退出或取消关闭。

## 周期任务

新的生产周期任务不得直接使用 `setInterval`。任务必须通过统一注册表登记：

- 稳定任务名称和代码来源；
- 周期与单次估算费用；
- 当前输入版本；
- 可调用的停止函数；
- 串行执行语义，前一次未完成时不得重叠。

输入版本缺失或与上次成功版本相同，任务必须跳过。`scripts/check-recurring-task-policy.cjs` 在 CI 中禁止扩大历史裸定时器清单；清单只能缩小，不能增加。

当前实现入口：

- `packages/core/src/services/recurringTaskRegistry.ts`
- `packages/core/src/orchestration/habitAnalyzer.ts`
- `packages/server/src/userSettings.ts`
- `packages/desktop/src/renderer/components/hub/SettingsPanels.tsx`

## 外部调用

模型、短信、S3、KMS、Control、邮件和外部 HTTP 调用应通过可拦截边界执行。每次调用至少记录：

- `origin` 和供应商；
- Token 用量，不记录密钥或原始 Authorization；
- 重试次数和估算成本；
- 成功、失败、阻断或提交结果。

外部写操作还必须携带幂等键并持久记录 `prepared`、`failed`、`committed` 状态。恢复只重试失败的单项操作并沿用原幂等键，不得重新执行整轮任务。

统一契约位于 `packages/server/src/modules/integration_adapters/externalCallBoundary.ts`。新的外部适配器不得绕过该契约；旧调用点按历史清单逐步迁移。

## 自动验证

CI 必须覆盖：

- 24 小时和 72 小时新安装空闲运行，所有付费和外部调用为零；
- 断网、429、5xx、超时；
- 崩溃恢复、密钥丢失、磁盘满和重连；
- 后台模型开关缺省关闭、显式开启和运行时关闭；
- 输入未变化不重复执行；
- 外部写的幂等冲突、失败状态和单项恢复。

主要回归测试位于：

- `packages/core/src/services/recurringTaskRegistry.test.ts`
- `packages/core/src/orchestration/habitAnalyzer.backgroundSafety.test.ts`
- `packages/server/src/modules/integration_adapters/externalCallBoundary.test.ts`
- `packages/desktop/src/main/idle-safety-simulation.test.ts`
- `packages/desktop/src/main/window-close-policy.test.ts`

## 当前迁移状态

统一契约已建立并保护新代码，但仓库仍有历史裸定时器和未迁移的外部请求。它们是明确的迁移债务，不代表允许新增同类实现。每次触碰相关模块时，应优先迁移并缩减 CI 基线。
