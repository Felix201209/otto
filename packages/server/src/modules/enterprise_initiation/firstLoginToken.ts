/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 首次登录令牌服务（SERVER-16）。
 *
 * 安全不变量：
 *  - 不创建/返回默认密码；
 *  - 生成短时、单次、绑定企业/账号/目的的邀请令牌；
 *  - 数据库只保存安全摘要（SHA-256），明文只在签发瞬间返回给调用方；
 *  - 支持过期、使用、撤销、重新签发，且保持幂等与审计友好。
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../data_platform/index.js';

export type FirstLoginPurpose = 'ceo_password_set';

export interface FirstLoginTokenInput {
  organizationId: string;
  accountId: string;
  purpose: FirstLoginPurpose;
  ttlMs: number;
  now?: number;
}

export interface FirstLoginTokenIssueResult {
  /** 明文令牌（一次性返回，之后不可再取）。 */
  token: string;
  tokenHash: string;
  expiresAt: string;
  purpose: FirstLoginPurpose;
}

/** 调用方需提供的持久层能力（便于在 SQLite / 未来 PostgreSQL 上复用）。 */
export interface FirstLoginTokenStore {
  db(): Database;
  now(): number;
  createTokenId(): string;
}

export function hashFirstLoginToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function assertFirstLoginTtl(ttlMs: number): void {
  // 短时：默认不应超过 30 分钟；拒绝小于 60 秒的过期把（防止错配为 0）。
  if (!Number.isFinite(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 60_000) {
    throw new Error('First-login token TTL must be between 1 and 30 minutes');
  }
}

export function createFirstLoginTokenInRepository(
  store: FirstLoginTokenStore,
  input: FirstLoginTokenInput,
): FirstLoginTokenIssueResult {
  assertFirstLoginTtl(input.ttlMs);
  if (!input.organizationId || !input.accountId) {
    throw new Error('First-login token requires organizationId and accountId');
  }
  // 32 字节随机令牌，base64url 编码。
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashFirstLoginToken(token);
  const now = input.now ?? store.now();
  const expiresAtMs = now + input.ttlMs;
  // 同一账号、同一目的、未使用的旧令牌先视为过期（重新签发语义：撤销旧 token）。
  store
    .db()
    .prepare(
      `UPDATE first_login_tokens
       SET revoked_at_ms = COALESCE(revoked_at_ms, ?)
       WHERE account_id = ? AND purpose = ? AND used_at_ms IS NULL AND revoked_at_ms IS NULL`,
    )
    .run(now, input.accountId, input.purpose);
  store
    .db()
    .prepare(
      `INSERT INTO first_login_tokens
         (id, token_hash, organization_id, account_id, purpose,
          expires_at_ms, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      store.createTokenId(),
      tokenHash,
      input.organizationId,
      input.accountId,
      input.purpose,
      expiresAtMs,
      now,
    );
  return {
    token,
    tokenHash,
    expiresAt: new Date(expiresAtMs).toISOString(),
    purpose: input.purpose,
  };
}

/**
 * 核销一个首次登录令牌（用于「设置密码」场景）。
 * 校验：令牌存在、摘要匹配、未过期、未使用、未撤销、目的一致。
 * 成功返回账号信息并原子标记为已使用；否则返回 null。
 */
export function redeemFirstLoginTokenInRepository(
  store: FirstLoginTokenStore,
  token: string,
  expectedPurpose: FirstLoginPurpose,
): { accountId: string; organizationId: string } | null {
  if (!token) return null;
  const tokenHash = hashFirstLoginToken(token);
  const row = store.db().prepare(
    `SELECT id, organization_id, account_id, purpose, expires_at_ms,
            used_at_ms, revoked_at_ms
     FROM first_login_tokens WHERE token_hash = ?`,
  ).get(tokenHash) as {
    id: string;
    organization_id: string;
    account_id: string;
    purpose: string;
    expires_at_ms: number;
    used_at_ms: number | null;
    revoked_at_ms: number | null;
  } | undefined;
  if (!row) return null;
  const now = store.now();
  if (
    row.purpose !== expectedPurpose ||
    row.used_at_ms !== null ||
    row.revoked_at_ms !== null ||
    row.expires_at_ms <= now
  ) {
    return null;
  }
  const result = { accountId: row.account_id, organizationId: row.organization_id };
  const info = store.db().prepare(
    `UPDATE first_login_tokens SET used_at_ms = ?
     WHERE id = ? AND used_at_ms IS NULL AND revoked_at_ms IS NULL`,
  );
  const changed = Number(info.run(now, row.id).changes);
  // 原子单次：若 UPDATE 未命中（并发已核销/撤销），本次视为失败，返回 null。
  if (changed === 0) {
    return null;
  }
  return result;
}

/** 撤销某账号某个目的的未使用令牌（幂等；用于管理员邮箱变更/重新签发）。 */
export function revokeFirstLoginTokens(
  store: FirstLoginTokenStore,
  accountId: string,
  purpose: FirstLoginPurpose,
): number {
  const now = store.now();
  const info = store.db().prepare(
    `SELECT changes() AS total`,
  );
  store.db().prepare(
    `UPDATE first_login_tokens SET revoked_at_ms = ?
     WHERE account_id = ? AND purpose = ? AND used_at_ms IS NULL AND revoked_at_ms IS NULL`,
  ).run(now, accountId, purpose);
  return (info.get() as { total: number }).total;
}
