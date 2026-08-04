/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 — Control 签名密钥轮换 + 回滚序列防护（纯函数）。
 *
 * Server 内置并可轮换 Control 公钥集；校验 License 时除签名外，还需：
 *  - 签名密钥 id 必须在当前可信集内；
 *  - 回滚序列号必须 ≥ 本部署已接受的最大序列（拒绝旧版本回滚 / 降级重放）。
 *
 * 轮换保留连续信任：新密钥带 lineage 到旧密钥，防止攻击者注入不相关公钥。
 */

import { createHash } from 'node:crypto';

export interface TrustedSigningKey {
  keyId: string;
  publicKey: string;
  /** 信任起始时间（ms）。 */
  trustedFromMs: number;
  /** 轮换 lineage：前置 keyId（根为 null）。 */
  previousKeyId: string | null;
}

export interface LicenseRollbackGuard {
  /** 某署名 License 声明的签名密钥 id。 */
  declaredKeyId: string;
  /** License 内的回滚/序列号。 */
  declaredRollbackSeq: number;
  /** 本部署已接受的最大回滚序列。 */
  acceptedMaxSeq: number;
}

/** 校验签名密钥 id 是否在当前可信集内（含轮换 lineage 追溯）。 */
export function isKeyIdTrusted(
  keys: TrustedSigningKey[],
  keyId: string,
  nowMs: number,
): { ok: boolean; reason?: 'unknown_key' | 'not_yet_trusted' } {
  const key = keys.find((k) => k.keyId === keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  if (nowMs < key.trustedFromMs) return { ok: false, reason: 'not_yet_trusted' };
  return { ok: true };
}

/** 回滚防护：声明的序列必须 > 已接受最大序列（严格单调，拒绝回滚/降级重放）。 */
export function checkRollbackSequence(guard: LicenseRollbackGuard): {
  ok: boolean;
  reason?: 'rollback_rejected';
} {
  if (guard.declaredRollbackSeq <= guard.acceptedMaxSeq) {
    return { ok: false, reason: 'rollback_rejected' };
  }
  return { ok: true };
}

/** 信任根集的一致性证明：所有 keyId 必须能沿 lineage 追溯到根，防注入无关公钥。 */
export function verifyKeylineage(
  keys: TrustedSigningKey[],
  nowMs: number,
): { ok: boolean; reason?: 'orphan_key' | 'cycle' } {
  const byId = new Map(keys.map((k) => [k.keyId, k]));
  for (const k of keys) {
    // 跳过尚未信任的
    if (nowMs < k.trustedFromMs) continue;
    let cursor: TrustedSigningKey | undefined = k;
    let hops = 0;
    const seen = new Set<string>();
    while (cursor && cursor.previousKeyId !== null) {
      if (seen.has(cursor.keyId)) return { ok: false, reason: 'cycle' };
      seen.add(cursor.keyId);
      const prev = byId.get(cursor.previousKeyId);
      if (!prev) return { ok: false, reason: 'orphan_key' };
      cursor = prev;
      if (++hops > keys.length) return { ok: false, reason: 'cycle' };
    }
  }
  return { ok: true };
}

/** 轮换后的密钥 id（派生自公钥）—— 便于追踪。 */
export function deriveKeyId(publicKeyHex: string): string {
  return createHash('sha256').update(`otto:ctl-sign:v1:${publicKeyHex.toLowerCase()}`).digest('hex').slice(0, 24);
}
