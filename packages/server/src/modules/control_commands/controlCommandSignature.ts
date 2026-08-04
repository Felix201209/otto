/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 指令签名校验（CONTROL-12）。
 *
 * 包一层 signedEnvelope 的 Ed25519 验证：接收方提供信任根密钥环（含轮换
 * 密钥），校验 Control 签名覆盖的规范信封。
 */

import { canonicalJson, verifyEd25519Envelope } from '../commercial_control/signedEnvelope.js';
import type { ControlCommandEnvelope } from './controlCommandEnvelope.js';

/**
 * 对 Control 指令信封做签名校验。
 * @param keyring 信任根公钥列表（每个为 PEM 或 DER base64）。
 * @param expectedKeyId 可选：若提供则只接受匹配该 keyId 的键（轮换时约束）。
 */
export function verifyControlCommandSignature(
  envelope: ControlCommandEnvelope,
  keyring: readonly string[],
  expectedKeyId?: string | null,
): { valid: boolean; keyId: string | null } {
  const signedBody = {
    commandId: envelope.commandId,
    deploymentId: envelope.deploymentId,
    type: envelope.type,
    schemaVersion: envelope.schemaVersion,
    sequence: envelope.sequence,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    idempotencyKey: envelope.idempotencyKey,
    payloadDigest: envelope.payloadDigest,
    payload: envelope.payload,
  };
  // canonicalJson 与 signedEnvelope 使用同一编码，签名可复验。
  return verifyEd25519Envelope(
    { envelope: signedBody },
    envelope.signature,
    keyring,
    expectedKeyId,
  );
}

// canonicalJson 引用仅为类型稳定性；验证逻辑由 verifyEd25519Envelope 承担。
void canonicalJson;
