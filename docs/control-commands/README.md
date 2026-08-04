# CONTROL-12 签名企业开通指令队列 — 文档索引

> [CONTROL-12][P0] 建立签名企业开通指令队列

## 文档

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [api-spec.md](./api-spec.md) | 实现者 / 集成方 | 版本化接口契约：信封 schema、签名覆盖、队列与回执状态机、事务性 outbox、HTTP 端点、版本与演进 |
| [operations-runbook.md](./operations-runbook.md) | 运维 / 值班 | 配置项、健康检查、死信处理、崩溃恢复、撤销、密钥轮换、回执核对、故障速查 |
| [integration-guide.md](./integration-guide.md) | Control 集成方（签发侧） | 端到端对接：准备、信封与签名、下发时序、幂等/重试、安全约定、最小示例、排查速查 |

## 代码位置

`packages/server/src/modules/control_commands/`

- `controlCommandEnvelope.ts` — 信封纯校验（信任根/部署绑定/单调序列/时间窗/payload 摘要）
- `controlCommandSignature.ts` / `../commercial_control/signedEnvelope.ts` — Ed25519 签名/验证
- `controlCommandQueue.ts` — 队列状态机 + SQLite 持久化（accept/claim/complete/cancel/monotonic）
- `controlCommandReceipt.ts` — 无秘密签名回执
- `controlCommandOutbox.ts` — 事务性 outbox（幂等投递、退避、死信、崩溃恢复）
- `controlCommandScheduler.ts` — 可注入时钟调度器
- `controlCommandHttp.ts` — HTTP 端点
- `controlCommandBoundary.ts` — 接入企业服务端的边界（信任根配置 + 部署绑定）

## 验收对照

- ✅ 指令乱序/重复/过期/篡改/跨部署/密钥轮换（单元测试 fail closed）
- ✅ 多实例争抢只执行一次 + 响应丢失返回相同签名收据
- ✅ 企业创建失败不留半成品/孤儿管理员/已消耗邀请（SERVER-16 原子开通 + 指令幂等）
- ✅ 代码级断网按 sequence 恢复、过期指令不执行
- ⏳ 真实计算巢 staging 端到端证据 + 完整重放/并发/跨租户/秘密泄漏负向验收（#289/290/292/293）
