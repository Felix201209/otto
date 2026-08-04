/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 签名开通指令信封（CONTROL-12）。
 *
 * 纯函数核心：校验 Control 下发的指令信封。不访问数据库、不依赖 PostgreSQL
 * 或 Control 网络，可完全单元测试。
 *
 * 校验维度：
 *  - 信任根：仅接受公开注册的指令类型与版本（fail closed）；
 *  - 部署绑定：deploymentId 必须与 Server 自身一致；
 *  - 单调序列：sequence 必须 > 已见最大序列（在带状态调用中由调用方推进）；
 *  - 时间窗：issuedAt/expiresAt 校验；
 *  - payload 摘要：payloadDigest 必须匹配规范化 payload；
 *  - 幂等：idempotencyKey 存在时用于去重。
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../commercial_control/signedEnvelope.js';

export const CONTROL_COMMAND_SCHEMA_VERSION = 1;

/** 公开注册的指令类型。未知类型 fail closed。 */
export const CONTROL_COMMAND_TYPES = ['enterprise.initiate'] as const;
export type ControlCommandType = (typeof CONTROL_COMMAND_TYPES)[number];

/** 指令前置条件（可选）。 */
export interface ControlCommandPreconditions {
  licenseStatus?: string;
  minModuleVersion?: string;
}

export interface ControlCommandEnvelope {
  commandId: string;
  deploymentId: string;
  type: ControlCommandType;
  schemaVersion: number;
  sequence: number;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey?: string;
  payloadDigest: string;
  preconditions?: ControlCommandPreconditions;
  payload: Record<string, unknown>;
  /** Control 侧签名（由签名层校验，此处校验摘要与字段）。 */
  signature: string;
}

export type EnvelopeValidationResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

/** 计算规范化的 payload 摘要（与签名同一 canonical 编码）。 */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(payload), 'utf8')
    .digest('hex');
}

/**
 * 校验指令信封的字段级合法性（不含签名本身与单调序列——序列需带状态推进）。
 * 返回失败原因，绝不抛出（便于上层汇总）。
 */
export function validateControlCommandEnvelope(
  envelope: ControlCommandEnvelope,
  context: {
    serverDeploymentId: string;
    now: number;
    allowTypes?: readonly ControlCommandType[];
  },
): EnvelopeValidationResult {
  const { serverDeploymentId, now } = context;
  const allowTypes = context.allowTypes ?? CONTROL_COMMAND_TYPES;

  if (!envelope.commandId || typeof envelope.commandId !== 'string') {
    return { ok: false, code: 'missing_command_id', reason: 'missing commandId' };
  }
  if (envelope.deploymentId !== serverDeploymentId) {
    return {
      ok: false,
      code: 'deployment_mismatch',
      reason: `command bound to another deployment: ${envelope.deploymentId}`,
    };
  }
  if (!allowTypes.includes(envelope.type)) {
    return {
      ok: false,
      code: 'unknown_command_type',
      reason: `unknown command type: ${envelope.type}`,
    };
  }
  if (envelope.schemaVersion !== CONTROL_COMMAND_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'unsupported_schema_version',
      reason: `unsupported schemaVersion ${envelope.schemaVersion}`,
    };
  }
  if (!Number.isFinite(envelope.sequence) || envelope.sequence <= 0) {
    return { ok: false, code: 'invalid_sequence', reason: 'sequence must be a positive integer' };
  }
  const issuedMs = Date.parse(envelope.issuedAt);
  const expiresMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return { ok: false, code: 'invalid_time_window', reason: 'issuedAt/expiresAt must be parseable' };
  }
  if (expiresMs <= now) {
    return { ok: false, code: 'expired', reason: 'command expired' };
  }
  if (issuedMs > now + 5 * 60 * 1000) {
    return { ok: false, code: 'issued_in_future', reason: 'command issued too far in the future' };
  }
  if (typeof envelope.payloadDigest !== 'string' || envelope.payloadDigest.length === 0) {
    return { ok: false, code: 'missing_payload_digest', reason: 'missing payloadDigest' };
  }
  const actualDigest = payloadDigest(envelope.payload);
  if (actualDigest !== envelope.payloadDigest) {
    return { ok: false, code: 'payload_digest_mismatch', reason: 'payload digest mismatch' };
  }
  if (envelope.payload && typeof envelope.payload !== 'object') {
    return { ok: false, code: 'invalid_payload', reason: 'payload must be an object' };
  }
  return { ok: true };
}
