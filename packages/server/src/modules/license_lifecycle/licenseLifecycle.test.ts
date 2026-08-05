/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 — License 生命周期 / 降配整改窗 / 离线窗 / 密钥轮换 / 回滚 / 审计测试。
 */

import { describe, expect, it } from 'vitest';
import {
  isCapacityReduced,
  isLegitimateUpgrade,
  offlineDecision,
  realizeDowngrade,
  revocationPolicy,
  licenseCanTransition,
  decideLicenseChange,
  revokeNow,
  licenseAccessPolicy,
  validateSignedLicenseTrust,
  buildLicenseAuditDetail,
  isKeyIdTrusted,
  checkRollbackSequence,
  verifyKeylineage,
  deriveKeyId,
  type LicenseEntitlementSnapshot,
  type TrustedSigningKey,
} from './index.js';

const DAY = 24 * 60 * 60 * 1000;

function snap(overrides: Partial<LicenseEntitlementSnapshot> = {}): LicenseEntitlementSnapshot {
  return {
    seatLimit: 50,
    modules: ['knowledge', 'park', 'billing'],
    expiresAtMs: 1_700_000_000_000 + 365 * DAY,
    offlineGraceMs: 7 * DAY,
    ...overrides,
  };
}

describe('CONTROL-11 License 生命周期', () => {
  it('升配必须伴随订单事件（不能凭空增大）', () => {
    const before = snap({ seatLimit: 50 });
    const after = snap({ seatLimit: 100 });
    expect(isLegitimateUpgrade(before, after, true)).toBe(true); // 有订单 → 合法
    expect(isLegitimateUpgrade(before, after, false)).toBe(false); // 无订单 → fail closed
  });

  it('降配进入整改窗口，不直接删数据（readonlyHint）', () => {
    const before = snap({ seatLimit: 50 });
    const after = snap({ seatLimit: 20 });
    expect(isCapacityReduced(before, after)).toBe(true);
    const d = realizeDowngrade({ from: 'active', before, after, graceMs: 30 * DAY, nowMs: 1_700_000_000_000 });
    expect(d.state).toBe('grace_downgrade');
    expect(d.readonlyHint).toBe(true);
    expect(d.graceEndsAtMs).toBeGreaterThan(1_700_000_000_000);
  });

  it('决策：降配 → grace_downgrade；无变化续费 → active', () => {
    expect(
      decideLicenseChange({
        from: 'active',
        before: snap({ seatLimit: 50 }),
        after: snap({ seatLimit: 20 }),
        orderEventPresent: true,
        downgradeGraceMs: 30 * DAY,
        nowMs: 1_700_000_000_000,
      }),
    ).toMatchObject({ ok: true, state: 'grace_downgrade', readonlyHint: true });

    expect(
      decideLicenseChange({
        from: 'active',
        before: snap(),
        after: snap({ expiresAtMs: 1_800_000_000_000 }),
        orderEventPresent: true,
        downgradeGraceMs: 30 * DAY,
        nowMs: 1_700_000_000_000,
      }),
    ).toMatchObject({ ok: true, state: 'active' });
  });

  it('无订单事件的升配被拒（fail closed）', () => {
    expect(
      decideLicenseChange({
        from: 'active',
        before: snap({ seatLimit: 50 }),
        after: snap({ seatLimit: 80 }),
        orderEventPresent: false,
        downgradeGraceMs: 30 * DAY,
        nowMs: 1_700_000_000_000,
      }),
    ).toMatchObject({ ok: false, reason: 'upgrade_without_order' });
  });

  it('离线：窗口内允许（保留已验证），窗口外 fail closed，从未验证一律拒绝', () => {
    const t0 = 1_700_000_000_000;
    expect(
      offlineDecision({ nowMs: t0 + 3 * DAY, noContactSinceMs: t0, offlineGraceMs: 7 * DAY, expiresAtMs: t0 + 365 * DAY, verifiedPreviously: true }).ok,
    ).toBe(true);
    expect(
      offlineDecision({ nowMs: t0 + 10 * DAY, noContactSinceMs: t0, offlineGraceMs: 7 * DAY, expiresAtMs: t0 + 365 * DAY, verifiedPreviously: true }),
    ).toMatchObject({ ok: false, reason: 'grace_exhausted' });
    expect(
      offlineDecision({ nowMs: t0 + 3 * DAY, noContactSinceMs: t0, offlineGraceMs: 7 * DAY, expiresAtMs: t0 + 365 * DAY, verifiedPreviously: false }),
    ).toMatchObject({ ok: false, reason: 'never_verified' });
    // 已过到期日 → expired
    expect(
      offlineDecision({ nowMs: t0 + 400 * DAY, noContactSinceMs: t0, offlineGraceMs: 7 * DAY, expiresAtMs: t0 + 365 * DAY, verifiedPreviously: true }),
    ).toMatchObject({ ok: false, reason: 'past_expiry' });
  });

  it('吊销/过期 → 只读/停用，不删数据', () => {
    expect(revocationPolicy('revoked')).toEqual({ allowWrite: false, allowRead: true, deleteData: false });
    expect(revocationPolicy('expired')).toEqual({ allowWrite: false, allowRead: true, deleteData: false });
    expect(revocationPolicy('grace_downgrade')).toEqual({ allowWrite: false, allowRead: true, deleteData: false });
    expect(revocationPolicy('active')).toEqual({ allowWrite: true, allowRead: true, deleteData: false });
    expect(licenseAccessPolicy('revoked').deleteData).toBe(false);
  });

  it('revokeNow：active→revoked；expired/revoked 终态幂等；其它合法状态→revoked', () => {
    expect(revokeNow('active')).toMatchObject({ ok: true, state: 'revoked' });
    expect(revokeNow('expired')).toMatchObject({ ok: true, state: 'expired', readonlyHint: true });
    expect(revokeNow('revoked')).toMatchObject({ ok: true, state: 'revoked', readonlyHint: true });
    expect(revokeNow('grace_downgrade')).toMatchObject({ ok: true, state: 'revoked' });
    expect(licenseAccessPolicy('revoked').deleteData).toBe(false);
  });

  it('状态机合法转移 / 终态不可恢复为 active', () => {
    expect(licenseCanTransition('revoked', 'active')).toBe(false);
    expect(licenseCanTransition('expired', 'active')).toBe(false);
    expect(licenseCanTransition('active', 'revoked')).toBe(true);
    expect(licenseCanTransition('degraded' as never, 'active' as never)).toBe(false); // 非合法状态名
  });
});

describe('CONTROL-11 签名密钥轮换 + 回滚防护', () => {
  function keys(kp: Array<{ keyId: string; publicKey: string }>): TrustedSigningKey[] {
    return kp.map((k, i) => ({
      keyId: k.keyId,
      publicKey: k.publicKey,
      trustedFromMs: 1000,
      previousKeyId: i === 0 ? null : kp[i - 1].keyId,
    }));
  }

  it('签名密钥 id 必须在可信集内', () => {
    const trusted = keys([{ keyId: 'k1', publicKey: 'A'.repeat(64) }]);
    expect(isKeyIdTrusted(trusted, 'k1', 2000)).toMatchObject({ ok: true });
    expect(isKeyIdTrusted(trusted, 'k99', 2000)).toMatchObject({ ok: false, reason: 'unknown_key' });
    expect(isKeyIdTrusted(trusted, 'k1', 500)).toMatchObject({ ok: false, reason: 'not_yet_trusted' });
  });

  it('回滚序列必须严格单调（拒绝旧版本回滚）', () => {
    expect(checkRollbackSequence({ declaredKeyId: 'k1', declaredRollbackSeq: 10, acceptedMaxSeq: 5 })).toMatchObject({ ok: true });
    expect(checkRollbackSequence({ declaredKeyId: 'k1', declaredRollbackSeq: 5, acceptedMaxSeq: 5 })).toMatchObject({ ok: false, reason: 'rollback_rejected' });
    expect(checkRollbackSequence({ declaredKeyId: 'k1', declaredRollbackSeq: 3, acceptedMaxSeq: 5 })).toMatchObject({ ok: false, reason: 'rollback_rejected' });
  });

  it('信任根 lineage：合法链通过，孤儿键 / 环被拒（防注入无关公钥）', () => {
    const legit = keys([{ keyId: 'k1', publicKey: 'A' }, { keyId: 'k2', publicKey: 'B' }, { keyId: 'k3', publicKey: 'C' }]);
    expect(verifyKeylineage(legit, 2000)).toMatchObject({ ok: true });

    // 孤儿键：k4 声明父 k9 不存在
    const orphan = [
      { keyId: 'k1', publicKey: 'A', trustedFromMs: 1000, previousKeyId: null },
      { keyId: 'k4', publicKey: 'D', trustedFromMs: 1000, previousKeyId: 'k9' },
    ];
    expect(verifyKeylineage(orphan, 2000)).toMatchObject({ ok: false, reason: 'orphan_key' });

    // 环
    const cycle = [
      { keyId: 'x1', publicKey: 'X', trustedFromMs: 1000, previousKeyId: 'x2' },
      { keyId: 'x2', publicKey: 'Y', trustedFromMs: 1000, previousKeyId: 'x1' },
    ];
    expect(verifyKeylineage(cycle, 2000)).toMatchObject({ ok: false, reason: 'cycle' });
  });

  it('组合校验：密钥信任 + 回滚都通过才授权', () => {
    const trusted = keys([{ keyId: 'k1', publicKey: deriveKeyId('A'.repeat(64)) }, { keyId: 'k2', publicKey: 'B'.repeat(64) }]);
    expect(
      validateSignedLicenseTrust({ declaredKeyId: 'k1', declaredRollbackSeq: 10, acceptedMaxSeq: 5, trustedKeys: trusted, nowMs: 2000 }),
    ).toEqual({ ok: true });
    // 未知密钥
    expect(
      validateSignedLicenseTrust({ declaredKeyId: 'k99', declaredRollbackSeq: 10, acceptedMaxSeq: 5, trustedKeys: trusted, nowMs: 2000 }),
    ).toMatchObject({ ok: false, reason: 'unknown_key' });
    // 回滚
    expect(
      validateSignedLicenseTrust({ declaredKeyId: 'k1', declaredRollbackSeq: 3, acceptedMaxSeq: 5, trustedKeys: trusted, nowMs: 2000 }),
    ).toMatchObject({ ok: false, reason: 'rollback_rejected' });
  });
});

describe('CONTROL-11 审计（无密钥材料）', () => {
  it('审计 detail 不含 secrets，且可被 redact 层处理', () => {
    const detail = buildLicenseAuditDetail({
      deploymentId: 'dep-1',
      orderId: 'ord-1',
      state: 'revoked',
      reason: 'order refunded',
    });
    expect(detail).toContain('deployment="dep-1"');
    expect(detail).toContain('state=revoked');
    // 不含典型秘密令牌形态
    expect(detail).not.toMatch(/sk_[a-z0-9]{12,}/i);
    expect(detail).not.toMatch(/password\s*[:=]/i);
  });
});
