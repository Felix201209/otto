# CONTROL-12 集成指南（Control 端 → Server 对接）

> 读者：Control 网络端 / 命令签发侧集成方。本指南给出一条真实可复现的下发指令→接收回执的完整路径。
> 配套：`api-spec.md`（接口契约）、`operations-runbook.md`（运维）。

## 1. 你（Control）需要准备什么

1. **一对 Ed25519 密钥**（签发指令用）。私钥留在 Control，公钥交给 Server 部署方配置到 `OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS`。
2. **Server 部署 ID**（`OTTO_ENTERPRISE_DEPLOYMENT_ID`，未设则等于 Server 的公网基址），用于每条指令的 `deploymentId`。
3. **Server 的 `/control/v1/*` 基址**（配置了信任根后才挂载该端点）。

## 2. 指令信封

下发的每一条指令是一个如下 JSON（字段含义见 `api-spec.md`）：

```json
{
  "commandId": "cmd-<uuid>",
  "deploymentId": "<server-deployment-id>",
  "type": "enterprise.initiate",
  "schemaVersion": 1,
  "sequence": 1,
  "issuedAt": "2026-08-04T03:00:00.000Z",
  "expiresAt": "2026-08-04T04:00:00.000Z",
  "idempotencyKey": "ik-<uuid>",
  "payloadDigest": "<sha256-of-payload>",
  "payload": {
    "organization": { "name": "Acme", "displayName": "Acme Corp" },
    "adminIdentity": { "email": "ceo@acme.example", "displayName": "CEO" },
    "plan": "pro",
    "modules": ["knowledge", "park", "billing"]
  },
  "signature": "ed25519:<base64url-signature>"
}
```

### 签名（关键，必须与 Server 对称）

Server 验证时对**规范化后的 `{ envelope: { ...10 字段 } }`** 做 Ed25519 校验。10 个字段顺序固定：

```
envelope = {
  commandId, deploymentId, type, schemaVersion, sequence,
  issuedAt, expiresAt, idempotencyKey, payloadDigest, payload
}
```

签名字节 = Ed25519( canonicalJson(envelope), 你的私钥 )，结果以 `ed25519:` 前缀 + base64url 形式放入 `signature` 字段。

**canonicalJson 规则**：Server 用 `canonicalJson(value)`（key 稳定排序、无空格紧凑 JSON）。Control 侧必须用**逐字节一致**的规范化实现，否则验签失败（常见坑：对象 key 顺序、空格、数字精度）。最稳的办法：直接调用 Server 导出的 `signEd25519Envelope({ envelope }, privateKey)`（同一实现）。

```ts
import { signEd25519Envelope, canonicalJson } from 'otto-server/commercial_control';
import { createHash } from 'node:crypto';

const envelope = {
  commandId, deploymentId, type, schemaVersion, sequence,
  issuedAt, expiresAt, idempotencyKey, payloadDigest, payload,
};
// payloadDigest = sha256(canonicalJson(payload))
envelope.payloadDigest = createHash('sha256')
  .update(canonicalJson(payload)).digest('hex');
// signature
const signature = signEd25519Envelope({ envelope }, controlPrivateKey);
```

## 3. 下发流程（推荐时序）

```
Control                             Server
  │  1. POST /control/v1/commands     │
  ├──────────────────────────────────►│  验签+字段校验+入队
  │  2. 201 {commandId,status,replayed}│
  │◄──────────────────────────────────┤
  │  3. (可选) GET /control/v1/commands/poll  → 触发执行
  │  4. (响应丢失时) GET /control/v1/receipts?commandId=… → 200 签名回执
```

1. **下发**：`POST /control/v1/commands`，body 为上述 JSON。
2. **响应码**：`201`（accepted）成功；`400` 畸形；`401` 签名无效/密钥未信任；`422` 字段不合法（含 `expired`、`deployment_mismatch`、`non_monotonic_sequence`、`payload_digest_mismatch`、`unknown_command_type`、`unsupported_schema_version`）。
3. **执行**：Server 通过 poll 或后台调度领取执行。Control 可主动 `GET /control/v1/commands/poll` 触发。
4. **收据确认**：执行完成产生终态回执；**若下发响应丢失，用同一 `commandId` 重查 `GET /control/v1/receipts`，拿到的是同一个签名收据**——绝不会重复创建企业。未达终态返回 `404`。

## 4. 幂等与重试语义

- 同一 `commandId` 重复下发：返回既有状态（`replayed:true`），**不重复执行**。
- 响应丢失：重查回执而非重发指令。
- `sequence` 必须为该 `commandId` 单调递增；乱序（≤ 已见）被拒（`non_monotonic_sequence`）。跨 `commandId` 的 sequence 相互独立。
- `expiresAt` 之前未执行的指令会在领取时标记 `expired` 且不执行。

## 5. 安全约定（必须遵守）

- payload **禁止**含明文密码、License 私钥、数据库凭据、客户端 E2EE 私钥。CEO 首次登录走短时一次性邀请/设置密码链接或企业 SSO。
- `deploymentId` 必须等于目标 Server 部署 ID，否则拒收（跨部署投递 fail closed）。
- 密钥轮换：Control 追加新公钥给 Server 部署方，过渡期新旧并用；废止旧钥后 Server 只认新钥。

## 6. 最小可运行示例

```bash
# 1) 下发
curl -X POST http://<server>:7777/control/v1/commands \
  -H 'Content-Type: application/json' -d @command.json
# → {"commandId":"cmd-...","status":"accepted","replayed":false}

# 2) 触发执行（可选）
curl http://<server>:7777/control/v1/commands/poll
# → {"executed":true}

# 3) 查回执
curl 'http://<server>:7777/control/v1/receipts?commandId=cmd-...'
# → {"commandId":"cmd-...","deploymentId":"...","executionVersion":1,
#    "status":"succeeded","resultSummary":"...","resourceId":"ent-...",
#    "receiptDigest":"...","signature":"ed25519:..."}
```

## 7. 出错排查速查

| 响应 | 含义 | Control 侧动作 |
| --- | --- | --- |
| 404 无此端点 | Server 未配置 CONTROL-12 信任根，端点关闭 | 通知 Server 部署方配置 `OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS` |
| 401 | 签名无效 / 密钥未信任 / 已吊销 | 核对私钥、规范化一致性、吊销状态 |
| 422 expired | 指令过期 | 重新签发（延长 `expiresAt`） |
| 422 deployment_mismatch | 绑定到其它部署 | 改用目标 Server 的 `deploymentId` |
| 422 non_monotonic_sequence | 序列未递增 | 用更大的 `sequence` 重签 |
| 422 payload_digest_mismatch | digest 与 payload 不符 | 用 `canonicalJson(payload)` 重算 digest |
