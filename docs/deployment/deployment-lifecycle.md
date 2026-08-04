# CONTROL-10 部署生命周期、身份轮换与一次性 bootstrap —— 状态机与接口规范

> Status: 版本化接口契约（v1）。随 `packages/server/src/modules/deployment_lifecycle/` 演进，变更需同步本文。
> 代码位置：`packages/server/src/modules/deployment_lifecycle/`（纯函数，无可持久化依赖），
> 对偶：`packages/server/src/modules/deployment_registration/`（CONTROL-10 一次性注册核心）。

## 1. 目的

把 CONTROL-10 从「注册终态」扩展为完整部署生命周期，并实现三个验收关键点：

1. **公钥派生指纹 + 密钥轮换保留连续身份**（取代 `getMachineFingerprint` 的可变硬件拼接）；
2. **计算巢注入的一次性 bootstrap token**（短时、限定 deploymentId 与制品摘要）；
3. **fail closed**：未注册/已停用部署不得进入可用状态；旧密钥立即失效；不接收业务秘密。

## 2. 部署生命周期状态机（v1）

`DEPLOYMENT_STATES`（严格有序，无隐式乱跳；revoked / decommissioned 为终态防复活）：

```
ordered → bootstrap_issued → registering → registered
registered → installing → activating → initializing → healthy
healthy ↔ degraded
healthy/degraded → revoked | decommissioned（终态）
```

- **usable**（`isDeploymentUsable`）：`registered` 及之后为可用；`ordered/bootstrap_issued`（未注册）与 `revoked/decommissioned`（停用）为**不可用**（fail closed）。
- **版本单调**：每次迁移带单调 `version`；仓库层以 `latestVersion` 拒绝陈旧/乱序/旧制品回放（`checkTransition`）。
- **幂等键**：`transitionId` 保证同一操作重复提交返回同一结果。
- **审计**：每次迁移映射到 `DEPLOYMENT_AUDIT_EVENTS[state]`（如 `deployment.healthy`）；`stateFromAuditEvent` 可反推状态用于恢复投影。

## 3. 部署身份轮换（v1）

`DeploymentKeyIdentity`：`{ deploymentId, publicKeyHex, fingerprint, epoch, previousFingerprint }`。

- `rootIdentity`：epoch=0，无前置指纹。
- `rotateIdentity`：保留 `deploymentId` 连续身份，派生指纹链接到旧指纹（lineage），epoch+1。
- **旧密钥立即失效**：轮换后旧公钥列入 revoked 集；验签一律用当前活钥。
- **连续身份**：`isDescendantOf(given, ancestor)` 校验 `given` 必须是 `ancestor` 的直接子代（同 deploymentId、epoch+1、前置指纹一致）——防止伪造/克隆身份。
- **双向审计**：`buildRotationAudit` 产 `deployment.key_rotated`（from/to 指纹 + 原因 + 时间，**不含密钥材料**）。

## 4. 一次性 bootstrap token（v1）

`BootstrapTokenBundled` 信封：`{ alg:'otto-bootstrap-v1', payload, signatureHex, signingKeyId }`。

`payload` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `nonce` | string | 一次性随机凭据（`validateNonceStrength` 要求 ≥32 hex） |
| `deploymentId` | string | 绑定部署（防跨订单替换） |
| `orderId` / `customerId` | string | 订单/客户归属约束 |
| `issuedAtMs` / `ttlMs` | number | 短时时间窗 |
| `artifactsDigest` | string | 制品摘要（防旧制品注册） |
| `kind` / `versionSatisfies` | string? | 部署类型/期望版本前缀 |

`verifyBootstrapToken` 严格校验（任一失败 → fail closed）：

1. `alg` 与格式；
2. **签名**（Control 信任根 Ed25519，`verify`）；
3. **时间窗**：未生效（含时钟偏差超阈 → `clock_skew`）、过期（`expired`）；
4. **绑定**：deploymentId / orderId / customerId 匹配（否则 `wrong_deployment` / `wrong_customer`）；
5. **制品摘要**（否则 `artifact_mismatch`）。

一次性（复用）由 `deployment_registration` 的 `consumed_bootstrap_nonces` 防重放层保证。

## 5. 安全与 fail-closed 规则

- 未注册（ordered/bootstrap_issued）不得进入 installing 及之后可用状态。
- 已停用（revoked/decommissioned）不得复活。
- bootstrap token 过期/复用/跨订单/制品不符/重放一律拒绝。
- 所有校验输入不含 CEO 密码、数据库凭据、云 AccessKey、E2EE 密钥。

## 6. 测试

`deploymentLifecycle.test.ts`（16 项）：生命周期转移、usable/fail-closed、版本单调、密钥轮换 lineage、bootstrap token 全负向（过期/签名/跨订单/制品/时间回拨/nonce 强度）。
