/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 —— 部署一次性安全注册测试。
 *
 * 覆盖验收要点：
 *  - 公钥派生指纹取代可变硬件拼接（易变性 → 稳定性，确定性）；
 *  - bootstrap token 校验：过期 / 重放 / 坏签名 / 版本/类型不匹配；
 *  - 一次性注册（成功后不可重放）；
 *  - 防克隆（已注册部署不可再次注册）；
 *  - 端到端：实例身份生成 → 校验 → 原子落库 → registered；
 *  - 状态机仅允许合法转移。
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import {
  deriveInstanceFingerprint,
  buildBootstrapPayload,
  isBootstrapExpired,
  verifyExpectedMeta,
  canTransition,
  generateInstanceIdentity,
  createInMemorySigning,
  createDeploymentRegistrar,
  getRegistrationIdentity,
  type BootstrapTokenPayload,
} from './index.js';

const NOW_MS = 1_700_000_000_000;

function makeToken(overrides: Partial<BootstrapTokenPayload> = {}): BootstrapTokenPayload {
  return buildBootstrapPayload({
    deploymentId: 'dep-1',
    orderId: 'ord-1',
    customerId: 'cus-1',
    nonce: 'nonce-abc',
    issuedAtMs: NOW_MS - 10_000,
    expiresAtMs: NOW_MS + 60_000,
    ...overrides,
  });
}

function freshIdentity() {
  return generateInstanceIdentity();
}

/** 用给定身份对 nonce 签名，返回 (payload, nonceSignatureHex)。 */
function makeRegistrar(overrides: Record<string, unknown> = {}) {
  const db = new Database(':memory:');
  const identity = freshIdentity();
  const signing = createInMemorySigning({
    privateKeyPem: identity.privateKey as string,
    identity: identity.identity,
  });
  const registrar = createDeploymentRegistrar({
    db: () => db,
    now: () => NOW_MS,
    signing,
    ...overrides,
  });
  return { db, identity, signing, registrar };
}

/** 用给定身份对 nonce 签名，返回 (token, nonceSignatureHex)。 */
function registerWith(
  registrar: { register(input: { tokenPayload: BootstrapTokenPayload; nonceSignatureHex: string; claimedVersion: string; claimedKind?: string }): { ok: boolean; reason?: string } },
  singing: ReturnType<typeof createInMemorySigning>,
  token: BootstrapTokenPayload,
  meta: { claimedVersion: string; claimedKind?: string } = { claimedVersion: '3.2.0' },
) {
  return registrar.register({
    tokenPayload: token,
    nonceSignatureHex: singing.signInstance(token.nonce),
    ...meta,
  });
}

describe('deployment registration (CONTROL-10)', () => {
  describe('公钥派生指纹取代可变硬件拼接', () => {
    it('同一公钥 → 同一稳定指纹（确定性，非易变硬件）', () => {
      const pub = 'abc123def456';
      const a = deriveInstanceFingerprint(pub);
      const b = deriveInstanceFingerprint(pub);
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(a.version).toBe(1);
      // 指纹绝不等于公钥本身，也不包含 hostname/platform 拼接痕迹
      expect(a.fingerprint).not.toContain(pub);
    });

    it('不同公钥 → 不同指纹', () => {
      const a = deriveInstanceFingerprint('AAA');
      const b = deriveInstanceFingerprint('BBB');
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });
  });

  describe('bootstrap token 校验（pure）', () => {
    it('未过期 token 通过（含签名、元数据）', () => {
      const { signing, registrar } = makeRegistrar();
      const verdict = registerWith(registrar, signing, makeToken(), {
        claimedVersion: '3.2.0',
        claimedKind: 'self-hosted',
      });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.deploymentId).toBe('dep-1');
        expect(verdict.identity.publicKeyHex).toBe(signing.createInstanceIdentity().publicKeyHex);
        expect(verdict.identity.fingerprint).toBe(signing.createInstanceIdentity().fingerprint);
      }
    });

    it('过期 token 被拒（token_expired）', () => {
      const { signing, registrar } = makeRegistrar();
      const verdict = registerWith(registrar, signing, makeToken({ expiresAtMs: NOW_MS - 1 }));
      expect(verdict).toMatchObject({ ok: false, reason: 'token_expired' });
    });

    it('坏签名被拒（signature_invalid）', () => {
      const { registrar } = makeRegistrar();
      const verdict = registrar.register({
        tokenPayload: makeToken(),
        nonceSignatureHex: 'deadbeef',
        claimedVersion: '3.2.0',
      });
      expect(verdict).toMatchObject({ ok: false, reason: 'signature_invalid' });
    });

    it('版本不匹配被拒（version_mismatch）', () => {
      const { signing, registrar } = makeRegistrar();
      const verdict = registerWith(registrar, signing, makeToken({ expected: { versionSatisfies: '3.2' } }), {
        claimedVersion: '2.9.1',
      });
      expect(verdict).toMatchObject({ ok: false, reason: 'version_mismatch' });
    });

    it('类型不匹配被拒（kind_mismatch）', () => {
      const { signing, registrar } = makeRegistrar();
      const verdict = registerWith(registrar, signing, makeToken({ expected: { kind: 'compute-nest' } }), {
        claimedVersion: '3.2.0',
        claimedKind: 'self-hosted',
      });
      expect(verdict).toMatchObject({ ok: false, reason: 'kind_mismatch' });
    });
  });

  describe('一次性 + 防重放 + 防克隆（持久化）', () => {
    it('成功注册后 nonce 不可重放', () => {
      const { db, signing, registrar } = makeRegistrar();
      const token = makeToken();
      expect(registerWith(registrar, signing, token).ok).toBe(true);

      // 同一 nonce 重放 → 拒绝（已是 registered 终态，防克隆优先短路也属拒绝）
      const replay = registerWith(registrar, signing, token);
      expect(replay.ok).toBe(false);
      expect(['token_replayed', 'already_registered']).toContain(replay.reason);

      expect(registrar.isRegistered('dep-1')).toBe(true);
      const stored = getRegistrationIdentity({ db: () => db }, 'dep-1');
      expect(stored?.publicKeyHex).toBe(signing.createInstanceIdentity().publicKeyHex);
    });

    it('同一 deployment 第二次注册被拒（already_registered / 防克隆）', () => {
      const { signing, registrar } = makeRegistrar();
      expect(registerWith(registrar, signing, makeToken()).ok).toBe(true);

      // 用不同 nonce 试图重新注册同一部署
      const token2 = makeToken({ nonce: 'nonce-def', expiresAtMs: NOW_MS + 60_000 });
      const again = registerWith(registrar, signing, token2);
      expect(again).toMatchObject({ ok: false, reason: 'already_registered' });
    });

    it('恢复持久化后仍可判定已注册（重启安全）', () => {
      const { db, signing } = makeRegistrar();
      const registrar1 = createDeploymentRegistrar({ db: () => db, now: () => NOW_MS, signing });
      expect(registerWith(registrar1, signing, makeToken()).ok).toBe(true);

      // 模拟重启：同一 db + 新 registrar 实例
      const registrar2 = createDeploymentRegistrar({ db: () => db, now: () => NOW_MS, signing });
      expect(registrar2.isRegistered('dep-1')).toBe(true);
    });
  });

  describe('注册状态机', () => {
    it('仅允许合法转移（ordered/bootstrap_issued→registering→registered）', () => {
      expect(canTransition(undefined, 'registering')).toBe(true);
      expect(canTransition('ordered', 'registering')).toBe(true);
      expect(canTransition('bootstrap_issued', 'registering')).toBe(true);
      expect(canTransition('registering', 'registered')).toBe(true);
      // 终态不可再变，防克隆
      expect(canTransition('registered', 'registered')).toBe(false);
      expect(canTransition('registered', 'registering')).toBe(false);
      // 不可乱跳
      expect(canTransition('ordered', 'registered')).toBe(false);
      expect(canTransition('registering', 'ordered')).toBe(false);
    });
  });

  describe('isBootstrapExpired / verifyExpectedMeta', () => {
    it('过期判断', () => {
      expect(isBootstrapExpired(makeToken({ expiresAtMs: NOW_MS + 1000 }), NOW_MS)).toBe(false);
      expect(isBootstrapExpired(makeToken({ expiresAtMs: NOW_MS - 1 }), NOW_MS)).toBe(true);
      expect(isBootstrapExpired(makeToken({ expiresAtMs: undefined }), NOW_MS)).toBe(false);
    });

    it('无期望元数据时默认通过', () => {
      expect(verifyExpectedMeta(makeToken(), { version: '9.9.9' }).ok).toBe(true);
    });
  });
});
