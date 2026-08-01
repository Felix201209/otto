/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type {
  AccountTokenUsageView,
  ModelUsageAccount,
  ModelUsageOrganization,
  OrganizationUsageSummary,
  RecordModelUsageInput,
} from './modelUsageTypes.js';

const MAX_USAGE_ID_LENGTH = 160;
const MAX_MODEL_LENGTH = 120;
const MAX_REPORTED_TOKEN_COUNT = 1_000_000_000;

export interface ModelUsageRepositoryStore<
  TAccount extends ModelUsageAccount = ModelUsageAccount,
  TOrganization extends ModelUsageOrganization = ModelUsageOrganization,
> {
  db(): Database;
  getAccount(accountId: string): TAccount | null;
  getOrganization(organizationId: string): TOrganization | null;
  listOrganizationAccounts(organizationId: string): TAccount[];
  createUsageId(): string;
  onRecordedUsage?(input: {
    organizationId: string;
    messageId: string;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): void;
}

interface UsageAggregateRow {
  account_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  request_count: number;
  last_used_at: string | null;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function dailyRecordLimit(): number {
  return Math.min(
    100_000,
    Math.max(
      1,
      Math.floor(envNum('OTTO_ENTERPRISE_USAGE_DAILY_LIMIT', 10_000)),
    ),
  );
}

function normalizeRequiredId(
  value: unknown,
  fieldName: 'sessionId' | 'messageId',
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error('sessionId and messageId required');
  if (normalized.length > MAX_USAGE_ID_LENGTH) {
    throw new Error(`${fieldName} 不能超过 ${MAX_USAGE_ID_LENGTH} 个字符`);
  }
  return normalized;
}

function normalizeModel(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const model = value.trim();
  if (model.length > MAX_MODEL_LENGTH) {
    throw new Error(`model 不能超过 ${MAX_MODEL_LENGTH} 个字符`);
  }
  return model;
}

function normalizeReportedTokenCount(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('Token 用量必须是非负数字');
  }
  if (number > MAX_REPORTED_TOKEN_COUNT) {
    throw new Error(`单项 Token 用量不能超过 ${MAX_REPORTED_TOKEN_COUNT}`);
  }
  return Math.floor(number);
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

export function recordModelUsageInRepository<
  TAccount extends ModelUsageAccount,
  TOrganization extends ModelUsageOrganization,
>(
  store: ModelUsageRepositoryStore<TAccount, TOrganization>,
  input: RecordModelUsageInput,
): boolean {
  const account = store.getAccount(input.accountId);
  if (!account) throw new Error('Account not found');
  if (account.status !== 'active') throw new Error('Account is disabled');
  const organization = store.getOrganization(account.organizationId);
  if (!organization) throw new Error('Organization not found');
  if (organization.status !== 'active') {
    throw new Error('Organization is disabled');
  }

  const sessionId = normalizeRequiredId(input.sessionId, 'sessionId');
  const messageId = normalizeRequiredId(input.messageId, 'messageId');
  const model = normalizeModel(input.model);
  const inputTokens = normalizeReportedTokenCount(input.inputTokens);
  const outputTokens = normalizeReportedTokenCount(input.outputTokens);
  const totalTokens = Math.max(
    normalizeReportedTokenCount(input.totalTokens),
    inputTokens + outputTokens,
  );

  const database = store.db();
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const duplicate = database
      .prepare(
        `SELECT 1 AS found FROM account_token_usage
         WHERE organization_id = ? AND account_id = ? AND message_id = ?`,
      )
      .get(account.organizationId, account.id, messageId) as
      { found?: number } | undefined;
    if (duplicate?.found === 1) {
      if (ownsTransaction) database.exec('COMMIT');
      return false;
    }

    const recentCount = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM account_token_usage
         WHERE organization_id = ? AND account_id = ?
           AND datetime(created_at) >= datetime('now', '-1 day')`,
      )
      .get(account.organizationId, account.id) as
      { count?: number } | undefined;
    if (Number(recentCount?.count ?? 0) >= dailyRecordLimit()) {
      throw new Error('账号今日 Token 用量记录已达上限');
    }

    const result = database
      .prepare(
        `INSERT OR IGNORE INTO account_token_usage
         (id, organization_id, account_id, session_id, message_id, model,
          input_tokens, output_tokens, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        store.createUsageId(),
        account.organizationId,
        account.id,
        sessionId,
        messageId,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
      );
    const recorded = Number(result.changes ?? 0) > 0;
    if (recorded) {
      store.onRecordedUsage?.({
        organizationId: account.organizationId,
        messageId,
        model,
        inputTokens,
        outputTokens,
        totalTokens,
      });
    }
    if (ownsTransaction) database.exec('COMMIT');
    return recorded;
  } catch (error) {
    if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function getOrganizationUsageSummaryFromRepository<
  TAccount extends ModelUsageAccount,
  TOrganization extends ModelUsageOrganization,
>(
  store: ModelUsageRepositoryStore<TAccount, TOrganization>,
  organizationId: string,
  periodDays = 30,
): OrganizationUsageSummary {
  const organization = store.getOrganization(organizationId);
  if (!organization) throw new Error('Organization not found');
  if (organization.status !== 'active') {
    throw new Error('Organization is disabled');
  }
  const safePeriodDays = Math.min(
    365,
    Math.max(1, Math.floor(periodDays) || 30),
  );
  const since = new Date(
    Date.now() - safePeriodDays * 86_400_000,
  ).toISOString();
  const aggregates = store
    .db()
    .prepare(
      `SELECT account_id,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COUNT(id) AS request_count,
              MAX(created_at) AS last_used_at
       FROM account_token_usage
       WHERE organization_id = ? AND datetime(created_at) >= datetime(?)
       GROUP BY account_id`,
    )
    .all(organizationId, since) as UsageAggregateRow[];
  const usageByAccount = new Map(
    aggregates.map((row) => [row.account_id, row] as const),
  );
  const byAccount: AccountTokenUsageView[] = store
    .listOrganizationAccounts(organizationId)
    .filter((account) => account.organizationId === organizationId)
    .map((account) => {
      const usage = usageByAccount.get(account.id);
      return {
        accountId: account.id,
        name: account.name,
        username: account.username,
        inputTokens: Number(usage?.input_tokens ?? 0),
        outputTokens: Number(usage?.output_tokens ?? 0),
        totalTokens: Number(usage?.total_tokens ?? 0),
        requestCount: Number(usage?.request_count ?? 0),
        lastUsedAt: sqliteUtcToIso(usage?.last_used_at ?? null),
      };
    })
    .sort(
      (left, right) =>
        right.totalTokens - left.totalTokens ||
        left.name.localeCompare(right.name) ||
        left.username.localeCompare(right.username),
    );

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
