# CONTROL-12 运维手册（Runbook）

> 适用：部署 CONTROL-12 签名企业开通指令队列的 Server 运维/值班。
> 配套：`docs/control-commands/api-spec.md`（接口与状态机）。

## 1. 配置项

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS` | 启用 CONTROL-12 时 | Control 信任根公钥（PEM，多把用逗号分隔；用 `parsePublicKeyList` 解析） |
| `OTTO_ENTERPRISE_CONTROL_REVOKED_KEY_IDS` | 否 | 已吊销公钥 ID（逗号分隔），吊销后对应 Key 签发的指令拒收 |
| `OTTO_ENTERPRISE_DEPLOYMENT_ID` | 否 | 本部署 ID；缺省回落到 `publicBaseUrl`，用于部署绑定校验 |
| `OTTO_LICENSE_PUBLIC_KEYS` 等 | 无关 | 企业许可/遥测，与 CONTROL-12 信任根独立 |

**重要**：未配置 `OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS` 时 CONTROL-12 **完全关闭**（fail closed，端点不挂载）。这是刻意的安全姿态——绝不提供「无信任根的人工导入」或「默认凭据」静默降级。

## 2. 快速验证（健康检查）

```sh
# 端点是否挂载（期望 404 = 未配置被关闭；配置后任意 /control/v1/* 有响应）
curl -i http://127.0.0.1:7777/control/v1/outbox/status

# outbox 状态
curl http://127.0.0.1:7777/control/v1/outbox/status
# → {"outbox":{"pending":0,"delivering":0,"delivered":0,"dead":0},"pendingCommands":0}
```

## 3. 常见运维动作

### 3.1 排查未执行/卡住的指令

1. `GET /control/v1/outbox/status` 看 `pendingCommands` 与 outbox 各状态计数。
2. `GET /control/v1/commands/poll` 触发一次领取执行（单条）。
3. `POST /control/v1/outbox/tick` 触发一次回执投递。
4. 若 `pendingCommands` 持续非零且 poll 每次都返回 `executed:false`，说明没有 `accepted` 的指令（可能是引用、格式或前置条件被拒）。

### 3.2 outbox 死信（dead）处理

`dead` 表示某条回执投递超限（默认 5 次，指数退避 1s→2s→4s…）。处理：

1. 确认 Control 端是否已恢复（网络/接收方）。
2. 若 Control 已恢复，复位该条目回 `pending`（开发运维直接对 SQLite 执行）：
   ```sql
   UPDATE control_command_outbox SET state='pending', delivery_attempts=0, next_attempt_at_ms=NULL, last_error=NULL WHERE command_id='<id>';
   ```
3. 再次 `POST /control/v1/outbox/tick` 重投。
4. 若反复 dead，检查 Control 接收接口契约（端点、鉴权、回执格式）。

### 3.3 崩溃恢复

进程崩溃后 stuck 在 `delivering` 的 outbox 条目会在超过 `staleAfterMs`（默认 60s）后被自动拉回 `pending` 重投（见 `recoverInFlightOutboxRows`）。无需人工干预；若长期卡住，检查是否有后台调度任务在跑 `outbox/tick`。

### 3.4 撤销（取消）一条待执行指令

尚未执行完成的 `accepted`/`running` 指令可取消：

```sql
UPDATE control_command_queue SET status='cancelled', locked_until_ms=NULL WHERE command_id='<id>';
```

已到终态（succeeded/failed/cancelled）的指令撤销请求被忽略（幂等）。

### 3.5 人工重驱一条终态指令（重新执行）

> ⚠️ 仅用于已确认业务未生效且幂等安全时。重新执行会创建/更新资源，务必先核对当前资源状态。

先确认该指令对应的业务资源不存在（避免重复创建），再重置：

```sql
UPDATE control_command_queue SET status='accepted', attempt=0, locked_until_ms=NULL, result_summary=NULL WHERE command_id='<id>';
UPDATE control_command_outbox SET state='pending', delivery_attempts=0, next_attempt_at_ms=NULL WHERE command_id='<id>';
```

然后 `POST /control/v1/commands/poll` 触发重执行。

## 4. 密钥轮换

**追加新信任根**（平滑轮换，两把同时有效一个过渡期）：

1. 将新公钥追加进 `OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS`（旧新并用）。
2. 部署重启生效。
3. 过渡期后，将旧公钥 ID 加入 `OTTO_ENTERPRISE_CONTROL_REVOKED_KEY_IDS` 吊销旧钥。
4. 吊销后立刻验证旧钥签发的指令被拒（`401 invalid_signature`）。

**紧急吊销**（密钥泄露）：立即将泄露公钥 ID 加入 `OTTO_ENTERPRISE_CONTROL_REVOKED_KEY_IDS` 并重启；所有用旧钥签发的指令即刻 fail closed。

## 5. 回执核对

- 每条成功指令对应一个 `succeeded` 回执，含 `resourceId`（创建出的企业/CEO 资源 ID）。
- 响应丢失场景：`GET /control/v1/receipts?commandId=<id>` 返回**同一个**签名收据——绝不会因重试而重复创建企业。
- 回执 `signature` 由部署私钥（Server 选项 `controlSigningPrivateKey`，PEM）签发；`receiptDigest` 是规范化摘要，用于人工核对内容未被篡改。
- 审计：指令签发/领取/执行/失败/重驱/撤销应形成双边审计记录（Server 侧结合既有审计日志）。

## 6. 故障场景速查

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| 端点 404 | 未配置信任根，CONTROL-12 关闭 | 配置 `OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS` 后重启；这是预期的 fail-closed |
| POST 返回 422 expired | 指令已过期 | Control 端重签（延长 `expiresAt`） |
| POST 返回 422 deployment_mismatch | 指令绑定到其它部署 | 核对 `deploymentId` 与 `OTTO_ENTERPRISE_DEPLOYMENT_ID` |
| POST 返回 401 | 签名无效或信任根未包含该 Key | 核对控制端密钥 + 是否被吊销 |
| outbox dead 累积 | Control 接收失败 | 见 §3.2 |
| 重复创建企业 | 若发生说明幂等被绕过 | 检查指令幂等 + 业务层原子性（SERVER-16），立即停止新指令并核对资源 |
