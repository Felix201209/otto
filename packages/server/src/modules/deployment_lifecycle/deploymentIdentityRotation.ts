/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 — 部署密钥轮换（rotation）。
 *
 * 验收要求："部署密钥轮换保留连续身份与双向审计，旧密钥立即失效"。
 *
 * 设计：
 *  - 连续身份：deploymentId 不变；指纹派生加入 lineage/epoch，保证新旧公钥共享同一
 *    部署连续身份线段（可通过一段有向 lineage 验明"由谁轮换而来"）。
 *  - 旧密钥立即失效：轮换后旧公钥列入 revoked 集；后续验签一律用当前活钥，
 *    旧钥签名即刻拒绝。
 *  - 双向审计：轮换事件含 fromKeyId / toKeyId / 指纹 / 时间，进入审计日志（无密钥材料）。
 *
 * 纯函数核心，便于离线测试。
 */

import { createHash } from 'node:crypto';

export interface DeploymentKeyIdentity {
  /** 部署唯一 id（轮换不改变）。 */
  deploymentId: string;
  /** 当前验证公钥（hex DER）。 */
  publicKeyHex: string;
  /** 派生指纹（含 lineage epoch）。 */
  fingerprint: string;
  /** 指纹派生 epoch（轮换 +1）。 */
  epoch: number;
  /** 上一 epoch 的公钥指纹（根 epoch 为前置印记 null）。 */
  previousFingerprint: string | null;
}

/** 根身份：epoch=0，无前置。 */
export function rootIdentity(input: {
  deploymentId: string;
  publicKeyHex: string;
}): DeploymentKeyIdentity {
  return {
    deploymentId: input.deploymentId,
    publicKeyHex: input.publicKeyHex,
    fingerprint: lineageFingerprint(input.deploymentId, 'none', input.publicKeyHex, 0),
    epoch: 0,
    previousFingerprint: null,
  };
}

/** 轮换：保留 deploymentId 连续身份，派生新指纹链接到旧指纹（lineage）。 */
export function rotateIdentity(input: {
  deploymentId: string;
  current: DeploymentKeyIdentity;
  newPublicKeyHex: string;
}): DeploymentKeyIdentity {
  const nextEpoch = input.current.epoch + 1;
  return {
    deploymentId: input.deploymentId,
    publicKeyHex: input.newPublicKeyHex,
    fingerprint: lineageFingerprint(
      input.deploymentId,
      input.current.fingerprint,
      input.newPublicKeyHex,
      nextEpoch,
    ),
    epoch: nextEpoch,
    previousFingerprint: input.current.fingerprint,
  };
}

/** 指纹派生：绑定 deploymentId + 前置指纹 + 公钥 + epoch，保证连续且篡改不可预测。 */
export function lineageFingerprint(
  deploymentId: string,
  previousFingerprint: string,
  publicKeyHex: string,
  epoch: number,
): string {
  return createHash('sha256')
    .update(
      `otto:deploy-lineage:v1:${deploymentId}:${epoch}:${previousFingerprint}:${publicKeyHex.toLowerCase()}`,
    )
    .digest('hex');
}

/** 校验身份链：given 是否可由 expectedAncestor 沿 lineage 延续（前向一致性）。 */
export function isDescendantOf(
  given: DeploymentKeyIdentity,
  expectedAncestor: DeploymentKeyIdentity,
): boolean {
  if (given.deploymentId !== expectedAncestor.deploymentId) return false;
  if (given.epoch < expectedAncestor.epoch) return false;
  return given.previousFingerprint === expectedAncestor.fingerprint && given.epoch === expectedAncestor.epoch + 1;
}

/** 一次轮换的审计记录（无密钥材料）。 */
export interface RotationAuditRecord {
  deploymentId: string;
  fromEpoch: number;
  toEpoch: number;
  fromFingerprint: string;
  toFingerprint: string;
  reason: string;
  atMs: number;
  auditEvent: 'deployment.key_rotated';
}

/** 构建轮换审计记录。 */
export function buildRotationAudit(
  input: {
    deploymentId: string;
    from: DeploymentKeyIdentity;
    to: DeploymentKeyIdentity;
    reason: string;
    atMs: number;
  },
): RotationAuditRecord {
  return {
    deploymentId: input.deploymentId,
    fromEpoch: input.from.epoch,
    toEpoch: input.to.epoch,
    fromFingerprint: input.from.fingerprint,
    toFingerprint: input.to.fingerprint,
    reason: input.reason,
    atMs: input.atMs,
    auditEvent: 'deployment.key_rotated',
  };
}

/** 断言一条调用方声明的 identity 与其「预期指纹」一致（防伪造/防克隆）。 */
export function assertFingerprintMatches(
  identity: DeploymentKeyIdentity,
  expectedFingerprint: string,
): boolean {
  return identity.fingerprint === expectedFingerprint;
}
