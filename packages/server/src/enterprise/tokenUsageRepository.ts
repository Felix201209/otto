/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { getAccount, getDB, getOrganization } from './db.js';

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const USAGE_DAILY_RECORD_LIMIT = Math.min(
  100_000,
  Math.max(1, Math.floor(envNum('OTTO_ENTERPRISE_USAGE_DAILY_LIMIT', 10_000))),
);

export interface AccountTokenUsageView {
  accountId: string;
  name: string;
  username: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

export interface OrganizationUsageSummary {
  organizationId: string;
  periodDays: number;
  source: 'client_reported';
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  requestCount: number;
  byAccount: AccountTokenUsageView[];
}

function sqliteUtcToIso(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const timestamp = Date.parse(withZone);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function normalizeReportedTokenCount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0)
    throw new Error('Token 用量必须是非负数字');
  return Math.min(1_000_000_000, Math.floor(number));
}

export function recordTokenUsage(input: {
  accountId: string;
  sessionId: string;
  messageId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}): boolean {
  const account = getAccount(input.accountId);
  if (!account) throw new Error('Account not found');
  const sessionId = input.sessionId.trim().slice(0, 160);
  const messageId = input.messageId.trim().slice(0, 160);
  if (!sessionId || !messageId)
    throw new Error('sessionId and messageId required');
  const inputTokens = normalizeReportedTokenCount(input.inputTokens);
  const outputTokens = normalizeReportedTokenCount(input.outputTokens);
  const totalTokens = Math.max(
    normalizeReportedTokenCount(input.totalTokens),
    inputTokens + outputTokens,
  );
  const duplicate = getDB()
    .prepare(
      'SELECT 1 AS found FROM account_token_usage WHERE account_id = ? AND message_id = ?',
    )
    .get(account.id, messageId) as { found?: number } | undefined;
  if (duplicate?.found === 1) return false;
  const recentCount = getDB()
    .prepare(
      `SELECT COUNT(*) AS count
     FROM account_token_usage
     WHERE account_id = ? AND datetime(created_at) >= datetime('now', '-1 day')`,
    )
    .get(account.id) as { count?: number } | undefined;
  if (Number(recentCount?.count ?? 0) >= USAGE_DAILY_RECORD_LIMIT) {
    throw new Error('账号今日 Token 用量记录已达上限');
  }
  const result = getDB()
    .prepare(
      `INSERT OR IGNORE INTO account_token_usage
       (id, organization_id, account_id, session_id, message_id, model,
        input_tokens, output_tokens, total_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `usage_${randomUUID()}`,
      account.organizationId,
      account.id,
      sessionId,
      messageId,
      input.model?.trim().slice(0, 120) || null,
      inputTokens,
      outputTokens,
      totalTokens,
    ) as { changes?: number | bigint };
  return Number(result.changes ?? 0) > 0;
}

export function getOrganizationUsageSummary(
  organizationId: string,
  periodDays = 30,
): OrganizationUsageSummary {
  if (!getOrganization(organizationId))
    throw new Error('Organization not found');
  const safePeriodDays = Math.min(
    365,
    Math.max(1, Math.floor(periodDays) || 30),
  );
  const since = new Date(
    Date.now() - safePeriodDays * 86_400_000,
  ).toISOString();
  const rows = getDB()
    .prepare(
      `SELECT a.id AS account_id, a.name, a.username,
            COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
            COUNT(u.id) AS request_count,
            MAX(u.created_at) AS last_used_at
     FROM accounts a
     LEFT JOIN account_token_usage u
      ON u.account_id = a.id
      AND u.organization_id = a.organization_id
      AND datetime(u.created_at) >= datetime(?)
     WHERE a.organization_id = ?
     GROUP BY a.id, a.name, a.username
     ORDER BY total_tokens DESC, a.name, a.username`,
    )
    .all(since, organizationId) as Array<{
    account_id: string;
    name: string;
    username: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    request_count: number;
    last_used_at: string | null;
  }>;
  const byAccount = rows.map((row) => ({
    accountId: row.account_id,
    name: row.name,
    username: row.username,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    requestCount: Number(row.request_count),
    lastUsedAt: sqliteUtcToIso(row.last_used_at),
  }));
  return {
    organizationId,
    periodDays: safePeriodDays,
    source: 'client_reported',
    totalInputTokens: byAccount.reduce((sum, row) => sum + row.inputTokens, 0),
    totalOutputTokens: byAccount.reduce(
      (sum, row) => sum + row.outputTokens,
      0,
    ),
    totalTokens: byAccount.reduce((sum, row) => sum + row.totalTokens, 0),
    requestCount: byAccount.reduce((sum, row) => sum + row.requestCount, 0),
    byAccount,
  };
}
