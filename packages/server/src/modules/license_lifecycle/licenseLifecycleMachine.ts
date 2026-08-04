/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 — License 生命周期状态机与权益一致性（纯函数）。
 *
 * 处理：续费 renew、升配 upgrade、降配 downgrade（需整改窗口，不直接删数据）、
 *      暂停 suspend、退款 refund、吊销 revoke、受控离线 offline。全部 fail closed：
 *      不生成默认/永久授权；吊销/过期采取明确的停用/只读策略。
 *
 * 关键不变量：
 *  - 权益不可在无授权变更时凭空增大（升配必须伴随订单事件提升）。
 *  - 降配：seatLimit / modules 减少时，进入整改宽限期（grace），期间只读或受限，
 *    届满仍未处理则停用对应超量席位——绝不直接删除数据。
 *  - 吊销/过期 → 只读/停用，不远程删数据。
 *  - 离线只能在受控窗口内继续，窗口外 fail closed（不延长为永久）。
 */

export const LICENSE_STATES = [
  'active',
  'grace_upgrade',
  'grace_downgrade',
  'suspended',
  'expired',
  'revoked',
  'offline',
] as const;

export type LicenseState = (typeof LICENSE_STATES)[number];

export interface LicenseEntitlementSnapshot {
  seatLimit: number;
  modules: string[];
  expiresAtMs: number;
  /** 离线宽限期（ms）。 */
  offlineGraceMs: number;
}

/** 比对席位/模块是否减少（用于识别降配）。 */
export function isCapacityReduced(
  before: LicenseEntitlementSnapshot,
  after: LicenseEntitlementSnapshot,
): boolean {
  if (after.seatLimit < before.seatLimit) return true;
  const beforeSet = new Set(before.modules);
  return after.modules.some((m) => !beforeSet.has(m));
}

/** 升配是否合法：只能随授权变更提升，不凭空增大。 */
export function isLegitimateUpgrade(
  before: LicenseEntitlementSnapshot,
  after: LicenseEntitlementSnapshot,
  orderEventPresent: boolean,
): boolean {
  // 席位/模块有提升必须要有对应订单事件
  const grew =
    after.seatLimit > before.seatLimit || (() => {
      const beforeSet = new Set(before.modules);
      return after.modules.some((m) => !beforeSet.has(m));
    })();
  if (!grew) return true; // 无提升，无需订单事件
  return orderEventPresent;
}

/** 降配后的整改窗口内状态：需给客户整改时间，不删数据。 */
export function realizeDowngrade(input: {
  from: LicenseState;
  before: LicenseEntitlementSnapshot;
  after: LicenseEntitlementSnapshot;
  graceMs: number;
  nowMs: number;
}): { state: LicenseState; graceEndsAtMs: number; readonlyHint: boolean } {
  if (isCapacityReduced(input.before, input.after)) {
    return {
      state: 'grace_downgrade',
      graceEndsAtMs: input.nowMs + input.graceMs,
      readonlyHint: true,
    };
  }
  return { state: 'active', graceEndsAtMs: input.nowMs, readonlyHint: false };
}

/** 离线判断：窗口内允许（保留已验证 License），窗口外 fail closed。 */
export function offlineDecision(input: {
  nowMs: number;
  noContactSinceMs: number;
  offlineGraceMs: number;
  expiresAtMs: number;
  verifiedPreviously: boolean;
}): { ok: boolean; stateAfterMs: LicenseState; reason: string } {
  if (!input.verifiedPreviously) {
    // 从未验证：绝不允许离线继续（fail closed）
    return { ok: false, stateAfterMs: 'revoked', reason: 'never_verified' };
  }
  const graceDeadline = input.noContactSinceMs + input.offlineGraceMs;
  if (input.nowMs <= graceDeadline && input.nowMs <= input.expiresAtMs) {
    return { ok: true, stateAfterMs: 'offline', reason: 'within_grace' };
  }
  if (input.nowMs > input.expiresAtMs) {
    return { ok: false, stateAfterMs: 'expired', reason: 'past_expiry' };
  }
  return { ok: false, stateAfterMs: 'revoked', reason: 'grace_exhausted' };
}

/** 吊销/过期 → 明确停用策略（只读/停用，不删数据）。 */
export function revocationPolicy(state: LicenseState): {
  allowWrite: boolean;
  allowRead: boolean;
  deleteData: boolean;
} {
  switch (state) {
    case 'active':
    case 'grace_upgrade':
    case 'offline':
      return { allowWrite: true, allowRead: true, deleteData: false };
    case 'grace_downgrade':
    case 'suspended':
      return { allowWrite: false, allowRead: true, deleteData: false };
    case 'expired':
    case 'revoked':
      return { allowWrite: false, allowRead: true, deleteData: false };
    default:
      return { allowWrite: false, allowRead: false, deleteData: false };
  }
}

/** License 状态机的合法转移。 */
export function licenseCanTransition(from: LicenseState, to: LicenseState): boolean {
  switch (from) {
    case 'active':
      return ['grace_upgrade', 'grace_downgrade', 'suspended', 'expired', 'revoked', 'offline', 'active'].includes(to);
    case 'grace_upgrade':
      return ['active', 'grace_downgrade', 'suspended', 'expired', 'revoked'].includes(to);
    case 'grace_downgrade':
      return ['active', 'suspended', 'expired', 'revoked'].includes(to);
    case 'suspended':
      return ['active', 'expired', 'revoked'].includes(to);
    case 'offline':
      return ['active', 'expired', 'revoked', 'suspended'].includes(to);
    case 'expired':
    case 'revoked':
      return false; // 终态（过期/吊销不可恢复为 active）
    default:
      return false;
  }
}
