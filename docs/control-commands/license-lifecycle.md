# CONTROL-11 License 生命周期、离线窗与签名密钥轮换 —— 状态机与接口规范

> Status: 版本化接口契约（v1）。随 `packages/server/src/modules/license_lifecycle/` 演进，变更需同步本文。
> 代码位置：`packages/server/src/modules/license_lifecycle/`（纯决策逻辑，无持久化依赖），
> 对偶：`packages/server/src/modules/order_license/`（CONTROL-11 License 签发核心）。

## 1. 目的

补全 CONTROL-11 的**生命周期**与**信任/恢复**维度：

1. 续费 / 升配 / 降配 / 暂停 / 退款 / 吊销 / 受控离线：
   - 降配先检查数据/席位影响并给**客户整改窗口**，不直接删数据；
   - 吊销与过期采取明确**只读/停用**策略，不远程删除客户数据；
2. 离线只能在**受控宽限期**内继续，不能生成默认/永久授权（fail closed）；
3. Control 签名密钥**轮换 + 回滚序列防护**（拒绝旧版本回滚 / 无关公钥注入）；
4. 审计**不含密钥材料**。

## 2. License 生命周期状态机（v1）

`LICENSE_STATES`：`active / grace_upgrade / grace_downgrade / suspended / expired / revoked / offline`。

- **升配**：席位/模块提升**必须伴随订单事件**（`isLegitimateUpgrade`），否则 fail closed 拒绝（`upgrade_without_order`）。
- **降配**：`isCapacityReduced` 检测，`realizeDowngrade` 进入 `grace_downgrade`（保留数据，`readonlyHint=true`，设整改窗口 `graceEndsAtMs`）。
- **终态**：`expired` / `revoked` 不可恢复为 `active`（无默认/永久授权）。

## 3. 受控离线与停用策略（v1）

- `offlineDecision`：`verifiedPreviously && now ≤ noContactSince+offlineGrace && now ≤ expiresAt` 才允许离线继续；
  从未验证→`never_verified`、超窗→`grace_exhausted`、已到期→`past_expiry`，一律 fail closed。
- `revocationPolicy` / `licenseAccessPolicy`：给出 `{ allowWrite, allowRead, deleteData }`——
  - active/offline：可读写；
  - grace_downgrade/suspended：只读；
  - expired/revoked：只读（**deleteData 恒 false**）。

## 4. 签名密钥轮换与回滚防护（v1）

- `TrustedSigningKey`：`{ keyId, publicKey, trustedFromMs, previousKeyId }`。
- `isKeyIdTrusted`：密钥 id 须在当前可信集内且已到 `trustedFromMs`。
- `checkRollbackSequence`：声明序列须**严格 >** 已接受最大序列 → 拒绝旧版本回滚。
- `verifyKeylineage`：所有已知密钥须能沿 `previousKeyId` 追溯到根（孤儿键 / 环 → 拒绝，防无关公钥注入）。
- `validateSignedLicenseTrust`：密钥信任 + 回滚序列组合校验，全过才授权。

## 5. 审计（无密钥材料）

`buildLicenseAuditDetail` 生成 `deployment=... order=... state=... reason=...` 结构化摘要；
写入前经既有 `redactAuditDetail`（`commercial_control/auditLogRepository.ts`）脱敏。
**严禁**把 CEO 密码、数据库凭据、云 AccessKey、E2EE 密钥写入 License 内容或日志。

## 6. 测试

`licenseLifecycle.test.ts`（13 项）：升配需订单、降配整改窗不删数据、离线窗 fail closed、吊销/过期只读策略、
状态机终态、密钥信任/回滚/lineage 负向、组合授权、审计无秘密。
