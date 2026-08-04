/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 — License 生命周期编排（纯逻辑门面）。
 *
 * 把状态机 / 降配整改窗 / 离线窗 / 回滚序列 / 审计串联为一个可测的决策单元，
 * 由上层接仓库与 Control 网络。全部 fail closed：不生成默认/永久授权，
 * 吊销/过期采取只读/停用，不远程删除数据。
 */

import {
  LICENSE_STATES,
  isCapacityReduced,
  isLegitimateUpgrade,
  offlineDecision,
  realizeDowngrade,
  revocationPolicy,
  licenseCanTransition,
  type LicenseEntitlementSnapshot,
  type LicenseState,
} from './licenseLifecycleMachine.js';
import { checkRollbackSequence, isKeyIdTrusted, type TrustedSigningKey } from './licenseSigningKeyRotation.js';

export interface LicenseLifecycleDecisionDeps {
  nowMs: number;
}

export type LicenseChangeOutcome =
  | { ok: true; state: LicenseState; graceEndsAtMs?: number; readonlyHint?: boolean }
  | { ok: false; reason: string; stateFrom?: LicenseState };

/** 处理一次权益变更（续费/升配/降配），返回新状态与整改窗口。 */
export function decideLicenseChange(input: {
  from: LicenseState;
  before: LicenseEntitlementSnapshot;
  after: LicenseEntitlementSnapshot;
  /** 是否伴随合法订单事件（升配必需）。 */
  orderEventPresent: boolean;
  downgradeGraceMs: number;
  nowMs: number;
}): LicenseChangeOutcome {
  // 升配合法性：席位/模块提升必须伴随订单事件
  if (!isLegitimateUpgrade(input.before, input.after, input.orderEventPresent)) {
    return { ok: false, reason: 'upgrade_without_order' };
  }

  // 降配：进入整改窗口
  if (isCapacityReduced(input.before, input.after)) {
    const d = realizeDowngrade({
      from: input.from,
      before: input.before,
      after: input.after,
      graceMs: input.downgradeGraceMs,
      nowMs: input.nowMs,
    });
    if (!licenseCanTransition(input.from, d.state)) {
      return { ok: false, reason: 'invalid_transition', stateFrom: input.from };
    }
    return { ok: true, state: d.state, graceEndsAtMs: d.graceEndsAtMs, readonlyHint: d.readonlyHint };
  }

  // 无容量变化 → 续费/延期，状态回 active
  if (!licenseCanTransition(input.from, 'active')) {
    return { ok: false, reason: 'invalid_transition', stateFrom: input.from };
  }
  return { ok: true, state: input.from === 'active' ? 'active' : 'active' };
}

/** 离线决策（受控窗口，fail closed）。 */
export function decideOffline(input: {
  nowMs: number;
  noContactSinceMs: number;
  offlineGraceMs: number;
  expiresAtMs: number;
  verifiedPreviously: boolean;
}): LicenseChangeOutcome {
  const d = offlineDecision(input);
  if (!d.ok) return { ok: false, reason: d.reason };
  return { ok: true, state: d.stateAfterMs };
}

/** 吊销/过期：返回明确的停用/只读策略（不删数据）。已终态则幂等返回。 */
export function revokeNow(stateFrom: LicenseState): LicenseChangeOutcome {
  // 已吊销/已过期 → 幂等返回当前终态
  if (stateFrom === 'revoked' || stateFrom === 'expired') {
    const policy = revocationPolicy(stateFrom);
    return { ok: true, state: stateFrom, readonlyHint: !policy.allowWrite };
  }
  const target: LicenseState = 'revoked';
  if (!licenseCanTransition(stateFrom, target)) {
    return { ok: false, reason: 'invalid_transition', stateFrom };
  }
  const policy = revocationPolicy(target);
  return { ok: true, state: target, readonlyHint: !policy.allowWrite };
}

/** 吊销/过期后的读写策略查询。 */
export function licenseAccessPolicy(state: LicenseState): {
  allowWrite: boolean;
  allowRead: boolean;
  deleteData: boolean;
} {
  return revocationPolicy(state);
}

/** 校验 License 签名密钥信任 + 回滚序列（组合防护）。 */
export function validateSignedLicenseTrust(input: {
  declaredKeyId: string;
  declaredRollbackSeq: number;
  acceptedMaxSeq: number;
  trustedKeys: TrustedSigningKey[];
  nowMs: number;
}): { ok: true } | { ok: false; reason: 'unknown_key' | 'not_yet_trusted' | 'rollback_rejected' | 'keylineage_broken' } {
  const keyTrust = isKeyIdTrusted(input.trustedKeys, input.declaredKeyId, input.nowMs);
  if (!keyTrust.ok) return { ok: false, reason: keyTrust.reason ?? 'unknown_key' };
  const rollback = checkRollbackSequence({
    declaredKeyId: input.declaredKeyId,
    declaredRollbackSeq: input.declaredRollbackSeq,
    acceptedMaxSeq: input.acceptedMaxSeq,
  });
  if (!rollback.ok) return { ok: false, reason: 'rollback_rejected' };
  return { ok: true };
}

/** 组装一次审计 detail（已对未来写入 redact 层做好准备：此处不含秘密字段）。 */
export function buildLicenseAuditDetail(params: {
  deploymentId: string;
  orderId?: string;
  state: LicenseState;
  reason: string;
}): string {
  const order = params.orderId ? ` order="${params.orderId}"` : '';
  return `deployment="${params.deploymentId}"${order} state=${params.state} reason=${params.reason}`;
}

export { LICENSE_STATES };
