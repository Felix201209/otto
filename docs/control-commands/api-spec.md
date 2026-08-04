# CONTROL-12 签名企业开通指令队列 — 接口与状态机规格

> Status: 版本化接口契约（v1）。随 `packages/server/src/modules/control_commands/` 演进，变更需同步本文件。
> 代码位置：`packages/server/src/modules/control_commands/`

## 1. 目的

将「创建企业、CEO、套餐与模块配置」从人工登录服务器初始化，改为 **Control 下发签名指令、Server 幂等执行、可追踪确认** 的指令队列。替代人工服务器初始化，杜绝半初始化与重复创建。

## 2. 信任模型与安全边界

- **信任根**：Server 通过部署时配置的公钥列表（`OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS`）验证 Control 指令签名；未配置信任根时端点 **fail closed**（不挂载、不执行、绝不静默降级）。
- **部署绑定**：每条指令携带 `deploymentId`，与 Server 自身部署 ID（`OTTO_ENTERPRISE_DEPLOYMENT_ID` 或 `publicBaseUrl`）不一致即拒收。
- **无秘密原则**：Payload 只含组织显示信息、管理员身份声明、套餐与模块配置；**禁止**明文密码、License 私钥、数据库凭据、客户端 E2EE 私钥。回执同样不含任何账号秘密。
- **幂等**：`(commandId)` 唯一；重复投递同一条返回既有结果，不重复执行。

## 3. 指令信封（v1）

字段（`ControlCommandEnvelope`）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `commandId` | string | 全局唯一指令 ID |
| `deploymentId` | string | 目标 Server 部署 ID（绑定校验） |
| `type` | string | 指令类型，仅 `enterprise.initiate`（v1 注册类型） |
| `schemaVersion` | number | 信封 schema 版本，当前 `1` |
| `sequence` | number | 单调递增序列（乱序拒收） |
| `issuedAt` | string | 签发时间（ISO8601），不得超过 Server 当前时间 +5min |
| `expiresAt` | string | 过期时间（ISO8601），过期指令不执行 |
| `idempotencyKey` | string? | 幂等键（可选） |
| `payloadDigest` | string | 规范化 payload 的 SHA-256（防篡改） |
| `preconditions` | object? | 前置条件声明（可选） |
| `payload` | object | 业务负载（见 §5） |
| `signature` | string | Ed25519 签名（覆盖完整规范化信封） |

### 签名覆盖范围

Control 用 Ed25519 私钥对规范化的 `{ envelope: { commandId, deploymentId, type, schemaVersion, sequence, issuedAt, expiresAt, idempotencyKey, payloadDigest, payload } }` 做签名（`canonicalJson` 编码，与 `signedEnvelope.ts` 一致）。

## 4. 队列与回执状态机

### 指令状态

```
                 ┌──────────────┐
                 │   accepted   │◄── 入队（未过期）
                 └──────┬───────┘
        expire 过期 ┌───┴──── 领取(claim, 独占租约)
          ┌─────────┴────────┐
    ┌─────▼─────┐     ┌──────▼──────┐
    │  expired  │     │   running   │
    └───────────┘     └──────┬──────┘
              ┌──────────────┼───────────────┐
              │              │               │
        ┌─────▼─────┐  ┌─────▼─────┐   ┌──────▼──────┐
        │ succeeded │  │  failed   │   │unknown_outc.│
        └───────────┘  └───────────┘   └─────────────┘

   cancelled：任一非终态（accepted/running）经人工撤销 → cancelled
```

- 状态集合：`accepted | running | succeeded | failed | unknown_outcome | expired | cancelled`
- **独占执行**：多 Server 实例只有一个能 `claim` 成功（排他租约）；`running` 持有 `locked_until_ms` 租约。
- **幂等 accept**：同一 `commandId` 重复 accept 返回既有状态（`replayed`）。
- **单调序列**：`sequence <= 已见最大序列` 拒收（乱序 fail closed）。
- **响应丢失恢复**：查询回执 (`GET /control/v1/receipts`) 返回相同签名收据，避免重复创建。

### 回执（无秘密）

`ControlCommandReceipt`：

| 字段 | 说明 |
| --- | --- |
| `commandId` | 指令 ID |
| `deploymentId` | 部署 ID |
| `executionVersion` | 执行版本（密钥轮换/回滚感知） |
| `status` | 终态（succeeded/failed/unknown_outcome/expired/cancelled） |
| `resultSummary` | 结果摘要（不含秘密） |
| `resourceId` | 资源 ID（如企业/CEO ID，可选） |
| `errorCategory` | 错误分类（供重试/死信决策，可选） |
| `receiptDigest` | 回执规范化摘要（SHA-256） |
| `signature` | 部署签名（可选；未配私钥则只含 digest） |

## 5. 事务性 outbox（投递意图）

Server 将「指令入队/执行完成 + 待投递确认」写入 `control_command_outbox`，保证崩溃重启后能安全重试，且不重复创建企业（执行侧靠指令幂等保证）。

outbox 状态：`pending → delivering → delivered`；投递失败按 **指数退避**（1s→2s→4s…）延后，超过 `maxAttempts`（默认 5）进入 **dead**（死信）。进程崩溃后 stuck 的 `delivering` 会被拉回 `pending` 重投。

## 6. HTTP 端点（v1，前缀 `/control/v1`）

配置了信任根公钥时挂载（capability：`control_command_queue_v1`）。

| 方法 | 路径 | 说明 | 成功 | 失败 |
| --- | --- | --- | --- | --- |
| POST | `/control/v1/commands` | 下发签名指令 | 201 accepted | 400 畸形 / 401 签名无效 / 422 字段不合法(含过期) |
| GET | `/control/v1/commands/poll` | 长轮询/主动领取执行一条 | 200 `{executed}` | — |
| GET | `/control/v1/receipts?commandId=` | 响应丢失恢复查询回执 | 200 receipt | 400 缺 commandId / 404 未达终态 |
| POST | `/control/v1/outbox/tick` | 触发一次回执投递 | 200 `{delivered,recovered}` | — |
| GET | `/control/v1/outbox/status` | 运维查看 outbox/queue 状态 | 200 | — |

## 7. 版本与演进

- 当前 schema 版本：`CONTROL_COMMAND_SCHEMA_VERSION = 1`
- 新增指令类型：扩展 `CONTROL_COMMAND_TYPES`（fail-open 只接受已注册类型，未知类型拒收）。
- `schemaVersion` 越界：**拒绝**（不静默接受未知版本）。
- 后端 `commercial_control/signedEnvelope.ts` 与 `control_commands/` 共享签名/规范化实现，**必须保持对称**。

## 8. 运行依赖

- 队列与 outbox 表由 `ensureTable` 自动建表（`control_command_queue`、`control_command_outbox`）。
- 多实例排他执行依赖 SQLite 事务/UPDATE 命中校验（单机多进程 + 未来 PostgreSQL 可插拔 store）。
