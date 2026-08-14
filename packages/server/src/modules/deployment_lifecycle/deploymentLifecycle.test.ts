/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 — 部署完整生命周期 + 密钥轮换 + bootstrap token 校验测试。
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import {
  deploymentCanTransition,
  isDeploymentUsable,
  checkTransition,
  stateFromAuditEvent,
  rootIdentity,
  rotateIdentity,
  isDescendantOf,
  buildRotationAudit,
  assertFingerprintMatches,
  buildBootstrapTokenPayload,
  signBootstrapToken,
  verifyBootstrapToken,
  validateNonceStrength,
  type BootstrapTokenSigner,
} from './index.js';

const NOW = 1_700_000_000_000;

/** 测试用 Ed25519 签/验实现（匹配 BootstrapTokenSigner 接口）。 */
function makeSigner(): BootstrapTokenSigner {
  return {
    sign(message: unknown, privateKeyPem: string): string {
      const msg = typeof message === 'string' ? message : JSON.stringify(message);
      return sign(null, Buffer.from(msg, 'utf8'), privateKeyPem).toString('hex');
    },
    verify(publicKey: string, signed: string, message: unknown): boolean {
      const msg = typeof message === 'string' ? message : JSON.stringify(message);
      return verify(
        null,
        Buffer.from(msg, 'utf8'),
        createPublicKey({ key: Buffer.from(publicKey, 'hex'), format: 'der', type: 'spki' }),
        Buffer.from(signed, 'hex'),
      );
    },
  };
}

function makeKeyPair(): { publicKey: string; privateKey: string } {
  const kp = generateKeyPairSync('ed25519');
  return {
    publicKey: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('CONTROL-10 部署完整生命周期', () => {
  it('isDeploymentUsable：registered 及之后可用，未注册（含 registering 进行中）/停用不可用（fail closed）', () => {
    expect(isDeploymentUsable('ordered')).toBe(false);
    expect(isDeploymentUsable('bootstrap_issued')).toBe(false);
    expect(isDeploymentUsable('registering')).toBe(false); // 尚未注册完成，不可用
    expect(isDeploymentUsable('registered')).toBe(true);
    expect(isDeploymentUsable('healthy')).toBe(true);
    expect(isDeploymentUsable('revoked')).toBe(false);
    expect(isDeploymentUsable('decommissioned')).toBe(false);
    expect(isDeploymentUsable(undefined)).toBe(false);
  });

  it('合法转移链 registered→installing→activating→initializing→healthy；healthy↔degraded', () => {
    expect(deploymentCanTransition('registered', 'installing')).toBe(true);
    expect(deploymentCanTransition('installing', 'activating')).toBe(true);
    expect(deploymentCanTransition('activating', 'initializing')).toBe(true);
    expect(deploymentCanTransition('initializing', 'healthy')).toBe(true);
    expect(deploymentCanTransition('healthy', 'degraded')).toBe(true);
    expect(deploymentCanTransition('degraded', 'healthy')).toBe(true);
  });

  it('revoked / decommissioned 为终态，防复活', () => {
    for (const t of ['installing', 'activating', 'healthy', 'registered', 'degraded']) {
      expect(deploymentCanTransition('revoked', t as never)).toBe(false);
      expect(deploymentCanTransition('decommissioned', t as never)).toBe(false);
    }
  });

  it('未注册（ordered/bootstrap_issued）不得跳入部署可用状态（fail closed）', () => {
    expect(deploymentCanTransition('ordered', 'installing')).toBe(false);
    expect(deploymentCanTransition('bootstrap_issued', 'healthy')).toBe(false);
  });

  it('checkTransition：合法 + 版本单调；陈旧版本拒绝', () => {
    expect(checkTransition({ from: 'registered', to: 'installing', version: 2, latestVersion: 1 })).toMatchObject({ ok: true });
    expect(checkTransition({ from: 'registered', to: 'installing', version: 2, latestVersion: 2 })).toMatchObject({ ok: false, reason: 'version_stale' });
    expect(checkTransition({ from: 'revoked', to: 'healthy', version: 9, latestVersion: 1 })).toMatchObject({ ok: false, reason: 'invalid_from' });
  });

  it('审计事件 ↔ 状态互推', () => {
    expect(stateFromAuditEvent('deployment.healthy')).toBe('healthy');
    expect(stateFromAuditEvent('deployment.revoked')).toBe('revoked');
    expect(stateFromAuditEvent('deployment.nonexistent')).toBeNull();
  });
});

describe('CONTROL-10 部署密钥轮换', () => {
  it('轮换保留连续身份（deploymentId 不变，lineage 可追溯），指纹改变', () => {
    const root = rootIdentity({ deploymentId: 'dep-1', publicKeyHex: 'A'.repeat(64) });
    const rotated = rotateIdentity({ deploymentId: 'dep-1', current: root, newPublicKeyHex: 'B'.repeat(64) });

    expect(rotated.deploymentId).toBe('dep-1');
    expect(rotated.epoch).toBe(1);
    expect(rotated.previousFingerprint).toBe(root.fingerprint);
    expect(rotated.fingerprint).not.toBe(root.fingerprint);
    expect(isDescendantOf(rotated, root)).toBe(true);
    expect(assertFingerprintMatches(rotated, rotated.fingerprint)).toBe(true);
  });

  it('非亲缘/不同部署 lineage 校验失败（防伪造身份）', () => {
    const kpA = makeKeyPair();
    const kpB = makeKeyPair();
    const rootA = rootIdentity({ deploymentId: 'dep-1', publicKeyHex: kpA.publicKey });
    const rootB = rootIdentity({ deploymentId: 'dep-1', publicKeyHex: kpB.publicKey });
    // B 试图把自己声明为 A 的后代 → 失败（前置指纹不匹配 / 非直接子代）
    expect(isDescendantOf(rootB, rootA)).toBe(false);
  });

  it('轮换审计记录不含密钥材料', () => {
    const root = rootIdentity({ deploymentId: 'dep-1', publicKeyHex: 'A'.repeat(64) });
    const rotated = rotateIdentity({ deploymentId: 'dep-1', current: root, newPublicKeyHex: 'B'.repeat(64) });
    const audit = buildRotationAudit({ deploymentId: 'dep-1', from: root, to: rotated, reason: 'scheduled', atMs: NOW });
    expect(audit.auditEvent).toBe('deployment.key_rotated');
    expect(audit.toFingerprint).toBe(rotated.fingerprint);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE');
  });
});

describe('CONTROL-10 bootstrap token（计算巢注入，一次性）', () => {
  function validToken(kp: { publicKey: string; privateKey: string }) {
    const payload = buildBootstrapTokenPayload({
      nonce: 'a'.repeat(64),
      deploymentId: 'dep-1',
      orderId: 'ord-1',
      customerId: 'cus-1',
      issuedAtMs: NOW - 1000,
      ttlMs: 60_000,
      artifactsDigest: 'sha256:deadbeef',
      kind: 'compute-nest',
    });
    return signBootstrapToken(makeSigner(), {
      payload,
      privateKeyPem: kp.privateKey,
      signingKeyId: 'ctl-boot-2026',
    });
  }
  function verifyOpts(overrides: Record<string, unknown> = {}) {
    return {
      receiverNowMs: NOW,
      expectedDeploymentId: 'dep-1',
      expectedOrderId: 'ord-1',
      expectedCustomerId: 'cus-1',
      expectedArtifactsDigest: 'sha256:deadbeef',
      controlPublicKey: '',
      ...overrides,
    };
  }

  it('合法 token 通过（签名 + 时间窗 + 绑定 + 制品摘要）', () => {
    const ctl = makeKeyPair();
    const token = validToken(ctl);
    const verdict = verifyBootstrapToken(makeSigner(), token, verifyOpts({ controlPublicKey: ctl.publicKey }));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.payload.deploymentId).toBe('dep-1');
  });

  it('过期 token 被拒（expired）', () => {
    const ctl = makeKeyPair();
    const token = validToken(ctl);
    const verdict = verifyBootstrapToken(makeSigner(), token, verifyOpts({ receiverNowMs: NOW + 120_000, controlPublicKey: ctl.publicKey }));
    expect(verdict).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('错误签名被拒（bad_signature）', () => {
    const ctl = makeKeyPair();
    const attacker = makeKeyPair();
    const token = validToken(attacker); // 由无关方签发
    const verdict = verifyBootstrapToken(makeSigner(), token, verifyOpts({ controlPublicKey: ctl.publicKey }));
    expect(verdict).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('防跨订单替换：deploymentId/order/customer 不符被拒', () => {
    const ctl = makeKeyPair();
    const token = validToken(ctl);
    expect(
      verifyBootstrapToken(makeSigner(), token, verifyOpts({ controlPublicKey: ctl.publicKey, expectedDeploymentId: 'dep-999' })),
    ).toMatchObject({ ok: false, reason: 'wrong_deployment' });
    expect(
      verifyBootstrapToken(makeSigner(), token, verifyOpts({ controlPublicKey: ctl.publicKey, expectedOrderId: 'ord-999' })),
    ).toMatchObject({ ok: false, reason: 'wrong_deployment' });
    expect(
      verifyBootstrapToken(makeSigner(), token, verifyOpts({ controlPublicKey: ctl.publicKey, expectedCustomerId: 'cus-999' })),
    ).toMatchObject({ ok: false, reason: 'wrong_customer' });
  });

  it('旧制品摘要注册被拒（artifact_mismatch）', () => {
    const ctl = makeKeyPair();
    const token = validToken(ctl);
    expect(
      verifyBootstrapToken(makeSigner(), token, verifyOpts({ controlPublicKey: ctl.publicKey, expectedArtifactsDigest: 'sha256:other' })),
    ).toMatchObject({ ok: false, reason: 'artifact_mismatch' });
  });

  it('时间回拨（issuedAt 远晚于接收时钟）被拒（clock_skew）', () => {
    const ctl = makeKeyPair();
    const token = validToken(ctl); // issuedAt = NOW-1000
    // 模拟接收时钟比签发时间早 1 小时 → skew 超阈值
    const verdict = verifyBootstrapToken(
      makeSigner(),
      token,
      verifyOpts({ controlPublicKey: ctl.publicKey, receiverNowMs: NOW - 3600_000 }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(['clock_skew', 'not_yet_valid']).toContain(verdict.reason);
  });

  it('nonce 强度校验：弱随机/短 nonce 被拒', () => {
    expect(validateNonceStrength('a'.repeat(64))).toBe(true);
    expect(validateNonceStrength('short')).toBe(false);
    expect(validateNonceStrength('').toString()).toBe('false');
  });
});
