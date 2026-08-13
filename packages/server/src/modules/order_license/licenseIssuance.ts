/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 签名 License 签发（Control 侧）。
 *
 * 根据已验证订单派生的权益，构建「无秘密」的签名 License 负载，供已注册
 * Server 自动领取并通过 importDeploymentLicense 验证激活。
 *
 * 生成的负载与 commercial_control/deploymentRepository.importDeploymentLicense
 * 消费的 schema 对齐：
 *  - 顶层 { license: { ... }, signature, signingKeyId }
 *  - 负载含 deploymentId / organizationId / machineFingerprint / modules /
 *    id / expiresAtMs / issuedAtMs / seatLimit / revision / gracePeriodMs /
 *    seatEnforcement / offline / billingEnforcement / telemetryAllowed
 *  - 签名用 Ed25519（signedEnvelope），私钥在隔离签名服务/KMS/HSM，落在签名
 *    服务而非普通数据库与日志。
 *
 * 无秘密原则：负载与签发日志绝不包含 CEO 密码、数据库凭据、云 AccessKey、
 * E2EE 密钥——只含授权权益与客户/组织显示信息。
 */

import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, signEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import type { LicenseEntitlement } from './orderLicenseTypes.js';

export interface SignLicenseInput {
  entitlement: LicenseEntitlement;
  /** Control 侧部署签名私钥（PEM）。 */
  signingPrivateKey: string;
  /** 签名密钥 ID（轮换可追踪）。 */
  signingKeyId: string;
  /** 目标部署 machine fingerprint（Server 领取后回填）。 */
  machineFingerprint?: string;
  /** 回滚序列（随版本递增；旧版本回滚被拒绝）。 */
  rollbackSequence: number;
  /** USB 离线首次激活的唯一标识；签名后不可回填负载。 */
  activationNonce?: string;
}

export interface IssuedLicenseEnvelope {
  license: Record<string, unknown>;
  signature: string;
  signingKeyId: string;
}

/** 无秘密的 LICENSE 负载摘要（用于审计/核对）。 */
export function licensePayloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');
}

/**
 * 由权益构建 License 负载（离线授权，免租约端点依赖）。
 */
export function buildLicensePayload(
  entitlement: LicenseEntitlement,
  rollbackSequence: number,
  machineFingerprint?: string,
  activationNonce?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: entitlement.licenseId,
    deploymentId: entitlement.deploymentId,
    organizationId: entitlement.organizationId,
    customerName: entitlement.customer.name,
    plan: entitlement.plan,
    revision: entitlement.revision,
    rollbackSequence,
    issuedAtMs: entitlement.issuedAtMs,
    expiresAtMs: entitlement.expiresAtMs,
    seatLimit: entitlement.seatLimit,
    modules: entitlement.modules,
    seatEnforcement: 'monitor',
    offline: true,
    billingEnforcement: entitlement.billingEnforcement ? 'enforce' : 'disabled',
    telemetryAllowed: true,
    gracePeriodMs: entitlement.gracePeriodMs,
  };
  if (machineFingerprint) {
    payload.machineFingerprint = machineFingerprint;
  }
  if (activationNonce) {
    payload.activationNonce = activationNonce;
    payload.machineFingerprint ??= '';
  }
  return payload;
}

/**
 * 签发一份签名 License（离线）。
 * @returns 签名信封 { license, signature, signingKeyId }，可直接交付 Server 导入。
 */
export function issueSignedLicense(input: SignLicenseInput): IssuedLicenseEnvelope {
  const payload = buildLicensePayload(
    input.entitlement,
    input.rollbackSequence,
    input.machineFingerprint,
    input.activationNonce,
  );
  const signature = signEd25519Envelope(payload, input.signingPrivateKey);
  return {
    license: payload,
    signature,
    signingKeyId: input.signingKeyId,
  };
}

/** 生成确定性 licenseId（幂等绑定到 order+deployment+plan）。 */
export function deterministicLicenseId(input: {
  deploymentId: string;
  orderId: string;
  plan: string;
}): string {
  const digest = createHash('sha256')
    .update(canonicalJson(input))
    .digest('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24);
  return `lic_${input.orderId.slice(0, 8)}_${digest}`;
}

/** 生成不确定性的 licenseId（非幂等场景）。 */
export function randomLicenseId(): string {
  return `lic_${randomUUID().replace(/-/g, '')}`;
}
