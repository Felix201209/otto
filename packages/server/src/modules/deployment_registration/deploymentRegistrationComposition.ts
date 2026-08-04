/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 编排：bootstrap token → 一次性校验 → 状态机 → 原子持久化。
 *
 * 入口 registerDeployment：
 *  - 防克隆/防重放快速路径；
 *  - 生成实例身份，用其公钥校验 nonce 签名 + token 过期/元数据匹配（pure verifyRegistration）；
 *  - 校验通过后在同一事务内原子落库（防重放 + 防克隆）。
 */

import type { Database } from '../data_platform/index.js';
import type { BootstrapTokenPayload, RegistrationSigning, RegistrationVerdict } from './deploymentRegistrationTypes.js';
import { verifyRegistration, buildRegistrationRecord } from './deploymentRegistration.js';
import {
  isDeploymentRegistered,
  isNonceConsumed,
  persistRegistration,
  type RegistrationStore,
} from './deploymentRegistrationRepository.js';

export interface RegistrationDeps {
  db(): Database;
  /** 可注入时钟（ms）。 */
  now?(): number;
  /** 实例身份签名能力（密钥库提供）。 */
  signing: RegistrationSigning;
}

export type RegisterOutcome =
  | {
      ok: true;
      deploymentId: string;
      orderId: string;
      customerId: string;
      identity: { fingerprint: string; publicKeyHex: string };
    }
  | { ok: false; reason: string };

export function createDeploymentRegistrar(
  deps: RegistrationDeps,
): {
  register(input: {
    tokenPayload: BootstrapTokenPayload;
    nonceSignatureHex: string;
    claimedVersion: string;
    claimedKind?: string;
  }): RegisterOutcome;
  isRegistered(deploymentId: string): boolean;
} {
  const store: RegistrationStore = { db: deps.db };
  const now = deps.now ?? (() => Date.now());
  const signing = deps.signing;

  return {
    register(input): RegisterOutcome {
      const nowMs = now();

      // 0. 防克隆快速路径（终态）
      if (isDeploymentRegistered(store, input.tokenPayload.deploymentId)) {
        return { ok: false, reason: 'already_registered' };
      }
      // 1. 防重放（nonce 已消费）
      if (isNonceConsumed(store, input.tokenPayload.nonce)) {
        return { ok: false, reason: 'token_replayed' };
      }

      // 2. 生成实例身份（每个部署安装仅一次）
      const identity = signing.createInstanceIdentity();

      // 3. 校验 token：过期、签名（nonce 由该公钥私钥签名）、元数据匹配
      const verdict: RegistrationVerdict = verifyRegistration({
        tokenPayload: input.tokenPayload,
        publicKeyHex: identity.publicKeyHex,
        nonceSignatureHex: input.nonceSignatureHex,
        claimedVersion: input.claimedVersion,
        claimedKind: input.claimedKind,
        nowMs,
        verifySignature: (givenPublicKey, signed, message) =>
          signing.verify(givenPublicKey, signed, message),
      });

      if (!verdict.ok) {
        return { ok: false, reason: verdict.reason };
      }

      // 4. 原子落库（防重放 + 防克隆）
      const record = buildRegistrationRecord({
        verdict,
        identity,
        consumedNonce: input.tokenPayload.nonce,
        nowMs,
      });
      const persisted = persistRegistration(store, record, nowMs);
      if (!persisted.ok) {
        return { ok: false, reason: persisted.reason ?? 'persist_failed' };
      }

      return {
        ok: true,
        deploymentId: record.deploymentId,
        orderId: record.orderId,
        customerId: record.customerId,
        identity: { fingerprint: record.fingerprint, publicKeyHex: record.publicKeyHex },
      };
    },

    isRegistered(deploymentId: string): boolean {
      return isDeploymentRegistered(store, deploymentId);
    },
  };
}
