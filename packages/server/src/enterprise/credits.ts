/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise Credits System
 *
 * 企业积分体系：
 * 1. 组织积分池（organizations.credit_balance）
 * 2. 兑换码（一次性，可指定面额）
 * 3. 积分流水（每笔消费/充值可审计）
 *
 * 本模块只提供积分数据与账本原语；是否在模型调用链启用计费由调用方显式决定，
 * 不能把存在余额表误报为已经强制托管模型或禁止 BYOK。
 */

import { getDB } from './db.js';
import { buildCreditsTablesSql } from './creditsSchema.js';
import * as crypto from 'node:crypto';

// ── 表结构（在 db.ts 初始化时创建）─────────────────────────────

export const CREDITS_TABLES_SQL = buildCreditsTablesSql('org_default');

// ── 兑换码生成 ──────────────────────────────────────────────────

const REDEEM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 无 I/O/0/1
const REDEEM_CODE_LENGTH = 12;
const MAX_QUERY_LIMIT = 200;
const REDEEM_CODE_STATUSES = new Set(['active', 'redeemed', 'revoked']);

type CreditsDatabase = ReturnType<typeof getDB>;

/** 可安全返回给 API 调用方的积分输入或业务状态错误。 */
export class CreditsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditsRequestError';
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CreditsRequestError(`${label}必须是正整数`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CreditsRequestError(`${label}必须是非负整数`);
  }
}

function assertQueryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) {
    throw new CreditsRequestError(`查询数量必须是 1 到 ${MAX_QUERY_LIMIT} 的整数`);
  }
}

function normalizeRedeemCode(code: string): string {
  const compact = code
    .trim()
    .toLocaleUpperCase('en-US')
    .replace(/[\s-]+/g, '');
  const validCharacters = new RegExp(`^[${REDEEM_ALPHABET}]{${REDEEM_CODE_LENGTH}}$`);
  if (!validCharacters.test(compact)) throw new CreditsRequestError('兑换码格式错误');
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
}

function activeOrganizationBalance(db: CreditsDatabase, organizationId: string): number {
  const row = db.prepare(
    'SELECT credit_balance FROM organizations WHERE id = ? AND status = ?',
  ).get(organizationId, 'active') as { credit_balance: number } | undefined;
  if (!row) throw new CreditsRequestError('企业不存在或已停用');
  if (!Number.isSafeInteger(row.credit_balance) || row.credit_balance < 0) {
    throw new Error('企业积分余额异常');
  }
  return row.credit_balance;
}

function assertAccountInOrganization(
  db: CreditsDatabase,
  accountId: string,
  organizationId: string,
  options: { requireAdmin?: boolean } = {},
): void {
  const account = db.prepare(
    `SELECT organization_id, is_admin, status
     FROM accounts
     WHERE id = ?`,
  ).get(accountId) as {
    organization_id: string;
    is_admin: number;
    status: 'active' | 'disabled';
  } | undefined;
  if (!account) throw new CreditsRequestError('账号不存在');
  if (account.organization_id !== organizationId) {
    throw new CreditsRequestError('账号不属于当前企业');
  }
  if (account.status !== 'active') throw new CreditsRequestError('账号已停用');
  if (options.requireAdmin && account.is_admin !== 1) {
    throw new CreditsRequestError('需要管理员权限');
  }
}

function withSavepoint<T>(
  db: CreditsDatabase,
  name: 'create_redeem_codes' | 'redeem_credit_code' | 'top_up_credits' | 'deduct_credits',
  operation: () => T,
): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    db.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}

function generateRedeemCode(): string {
  const bytes = crypto.randomBytes(REDEEM_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < REDEEM_CODE_LENGTH; i++) {
    code += REDEEM_ALPHABET[bytes[i] % REDEEM_ALPHABET.length];
  }
  // 格式化为 XXXX-XXXX-XXXX
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}

export interface RedeemCodeInfo {
  id: string;
  code: string;
  creditAmount: number;
  status: 'active' | 'redeemed' | 'revoked';
  createdBy: string;
  redeemedBy: string | null;
  redeemedAt: string | null;
  createdAt: string;
}

interface RedeemCodeRow {
  id: string;
  code: string;
  credit_amount: number;
  status: RedeemCodeInfo['status'];
  created_by: string;
  redeemed_by: string | null;
  redeemed_at: string | null;
  created_at: string;
}

/** 管理员创建一批兑换码 */
export function createRedeemCodes(
  organizationId: string,
  adminAccountId: string,
  creditAmount: number,
  count: number = 1,
): RedeemCodeInfo[] {
  assertPositiveSafeInteger(creditAmount, '兑换码面额');
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new CreditsRequestError('兑换码生成数量必须是 1 到 100 的整数');
  }

  const db = getDB();
  return withSavepoint(db, 'create_redeem_codes', () => {
    activeOrganizationBalance(db, organizationId);
    assertAccountInOrganization(db, adminAccountId, organizationId, { requireAdmin: true });
    const now = new Date().toISOString();
    const results: RedeemCodeInfo[] = [];
    const insert = db.prepare(
      `INSERT INTO redeem_codes (id, organization_id, code, credit_amount, created_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    );

    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID();
      const code = generateRedeemCode();
      insert.run(id, organizationId, code, creditAmount, adminAccountId, now);
      results.push({
        id, code, creditAmount, status: 'active',
        createdBy: adminAccountId, redeemedBy: null, redeemedAt: null, createdAt: now,
      });
    }

    return results;
  });
}

/** 用户输入兑换码兑换积分 */
export function redeemCode(
  code: string,
  accountId: string,
): { creditAmount: number; newBalance: number } {
  const normalized = normalizeRedeemCode(code);
  const db = getDB();
  return withSavepoint(db, 'redeem_credit_code', () => {
    const redeemRow = db.prepare(
      'SELECT * FROM redeem_codes WHERE code = ?',
    ).get(normalized) as {
      id: string;
      organization_id: string;
      credit_amount: number;
      status: 'active' | 'redeemed' | 'revoked';
    } | undefined;

    if (!redeemRow) throw new CreditsRequestError('兑换码不存在');
    if (redeemRow.status !== 'active') {
      throw new CreditsRequestError(
        redeemRow.status === 'redeemed' ? '此兑换码已被使用' : '此兑换码已被作废',
      );
    }
    assertAccountInOrganization(db, accountId, redeemRow.organization_id);
    assertPositiveSafeInteger(redeemRow.credit_amount, '兑换码面额');
    const currentBalance = activeOrganizationBalance(db, redeemRow.organization_id);
    const newBalance = currentBalance + redeemRow.credit_amount;
    if (!Number.isSafeInteger(newBalance)) throw new Error('企业积分余额超出安全整数范围');

    const now = new Date().toISOString();
    const redeemed = db.prepare(
      `UPDATE redeem_codes
       SET status = ?, redeemed_by = ?, redeemed_at = ?
       WHERE id = ? AND status = ?`,
    ).run('redeemed', accountId, now, redeemRow.id, 'active');
    if (Number(redeemed.changes) !== 1) throw new CreditsRequestError('此兑换码已被处理');

    db.prepare(
      'UPDATE organizations SET credit_balance = ? WHERE id = ?',
    ).run(newBalance, redeemRow.organization_id);
    db.prepare(
      `INSERT INTO credit_transactions
         (id, organization_id, account_id, type, amount, balance_after, description, redeem_code_id, created_at)
       VALUES (?, ?, ?, 'redeem', ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      redeemRow.organization_id,
      accountId,
      redeemRow.credit_amount,
      newBalance,
      `兑换码兑换 ${redeemRow.credit_amount} 积分`,
      redeemRow.id,
      now,
    );

    return { creditAmount: redeemRow.credit_amount, newBalance };
  });
}

// ── 积分消耗 ────────────────────────────────────────────────────

export interface CreditBalance {
  balance: number;
  totalConsumed: number;
  totalToppedUp: number;
  todayConsumed: number;
}

/** 查询组织积分余额 */
export function getCreditBalance(organizationId: string): CreditBalance {
  const db = getDB();
  const orgRow = db.prepare(
    'SELECT credit_balance FROM organizations WHERE id = ?',
  ).get(organizationId) as { credit_balance: number } | undefined;

  const balance = orgRow?.credit_balance ?? 0;

  // 今日消耗
  const today = new Date().toISOString().split('T')[0];
  const todayConsumed = (db.prepare(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total
     FROM credit_transactions
     WHERE organization_id = ? AND type = 'consume' AND date(created_at) = ?`,
  ).get(organizationId, today) as { total: number })?.total ?? 0;

  const totalConsumed = (db.prepare(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total
     FROM credit_transactions
     WHERE organization_id = ? AND type = 'consume'`,
  ).get(organizationId) as { total: number })?.total ?? 0;

  const totalToppedUp = (db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM credit_transactions
     WHERE organization_id = ? AND type IN ('topup','redeem')`,
  ).get(organizationId) as { total: number })?.total ?? 0;

  return { balance, totalConsumed, totalToppedUp, todayConsumed };
}

/**
 * 积分消耗。每次调用前先检查余额，成功后登记使明细
 * @param estimatedTokens 预估将消耗的token数（1 积分 ≈ 1000 tokens）
 * @returns { allowed, balance, estimatedCost }
 */
export function checkAndReserveCredits(
  organizationId: string,
  accountId: string,
  estimatedTokens: number,
): { allowed: boolean; balance: number; estimatedCost: number; reason?: string } {
  assertNonNegativeSafeInteger(estimatedTokens, 'estimatedTokens');
  const db = getDB();
  assertAccountInOrganization(db, accountId, organizationId);
  const balance = activeOrganizationBalance(db, organizationId);
  // 1 积分 ≈ 1000 tokens（可配置）
  const rateRaw = process.env['OTTO_CREDIT_TOKEN_RATE'] || '1000';
  const rate = Number(rateRaw);
  if (!Number.isSafeInteger(rate) || rate <= 0) {
    throw new Error('OTTO_CREDIT_TOKEN_RATE 必须是正整数');
  }
  const estimatedCost = Math.max(1, Math.ceil(estimatedTokens / rate));

  if (balance < estimatedCost) {
    return {
      allowed: false, balance, estimatedCost,
      reason: `积分余额不足（需要 ${estimatedCost} 积分，剩余 ${balance} 积分）。请联系管理员充值。`,
    };
  }

  return { allowed: true, balance, estimatedCost };
}

/**
 * 实际扣减积分（在 LLM 调用完成后）
 */
export function deductCredits(
  organizationId: string,
  accountId: string,
  amount: number,
  description: string,
  model?: string | null,
  messageId?: string,
): number {
  assertPositiveSafeInteger(amount, '扣费金额');
  const db = getDB();
  const normalizedMessageId = messageId?.trim() || null;

  return withSavepoint(db, 'deduct_credits', () => {
    assertAccountInOrganization(db, accountId, organizationId);

    // 先取得 SQLite 写锁，再检查幂等键，避免并发重试同时看到“尚未记账”。
    const locked = db.prepare(
      `UPDATE organizations
       SET credit_balance = credit_balance
       WHERE id = ? AND status = ?`,
    ).run(organizationId, 'active');
    if (Number(locked.changes) !== 1) {
      throw new CreditsRequestError('企业不存在或已停用');
    }

    if (normalizedMessageId) {
      const previous = db.prepare(
        `SELECT id
         FROM credit_transactions
         WHERE organization_id = ? AND account_id = ? AND type = 'consume' AND message_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      ).get(organizationId, accountId, normalizedMessageId) as
        | { id: string }
        | undefined;
      if (previous) return activeOrganizationBalance(db, organizationId);
    }

    const balance = activeOrganizationBalance(db, organizationId);
    if (balance < amount) {
      throw new CreditsRequestError(
        `积分余额不足（需要 ${amount} 积分，剩余 ${balance} 积分）`,
      );
    }

    const deducted = db.prepare(
      `UPDATE organizations
       SET credit_balance = credit_balance - ?
       WHERE id = ? AND status = ? AND credit_balance >= ?`,
    ).run(amount, organizationId, 'active', amount);
    if (Number(deducted.changes) !== 1) throw new CreditsRequestError('积分余额不足');

    const newBalance = balance - amount;
    db.prepare(
      `INSERT INTO credit_transactions
         (id, organization_id, account_id, type, amount, balance_after, description, model, message_id, created_at)
       VALUES (?, ?, ?, 'consume', ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      organizationId,
      accountId,
      -amount,
      newBalance,
      description,
      model || null,
      normalizedMessageId,
      new Date().toISOString(),
    );

    return newBalance;
  });
}

// ── 管理员充值 ──────────────────────────────────────────────────

/** 管理员直接给组织充值积分 */
export function topUpCredits(
  organizationId: string,
  adminAccountId: string,
  amount: number,
  note?: string,
): { newBalance: number } {
  assertPositiveSafeInteger(amount, '充值金额');
  const db = getDB();
  return withSavepoint(db, 'top_up_credits', () => {
    assertAccountInOrganization(db, adminAccountId, organizationId, { requireAdmin: true });
    const balance = activeOrganizationBalance(db, organizationId);
    const newBalance = balance + amount;
    if (!Number.isSafeInteger(newBalance)) throw new Error('企业积分余额超出安全整数范围');

    db.prepare(
      'UPDATE organizations SET credit_balance = ? WHERE id = ? AND status = ?',
    ).run(newBalance, organizationId, 'active');
    db.prepare(
      `INSERT INTO credit_transactions
         (id, organization_id, account_id, type, amount, balance_after, description, created_at)
       VALUES (?, ?, ?, 'topup', ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      organizationId,
      adminAccountId,
      amount,
      newBalance,
      note?.trim() || `管理员充值 ${amount} 积分`,
      new Date().toISOString(),
    );

    return { newBalance };
  });
}

// ── 兑换码查询 ──────────────────────────────────────────────────

/** 查询兑换码列表 */
export function listRedeemCodes(
  organizationId: string,
  status?: 'active' | 'redeemed' | 'revoked',
): RedeemCodeInfo[] {
  if (status !== undefined && !REDEEM_CODE_STATUSES.has(status)) {
    throw new CreditsRequestError('兑换码状态无效');
  }
  const db = getDB();
  let rows: RedeemCodeRow[];
  if (status) {
    rows = db.prepare(
      'SELECT * FROM redeem_codes WHERE organization_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200',
    ).all(organizationId, status) as RedeemCodeRow[];
  } else {
    rows = db.prepare(
      'SELECT * FROM redeem_codes WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200',
    ).all(organizationId) as RedeemCodeRow[];
  }

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    creditAmount: r.credit_amount,
    status: r.status,
    createdBy: r.created_by,
    redeemedBy: r.redeemed_by,
    redeemedAt: r.redeemed_at,
    createdAt: r.created_at,
  }));
}

/** 作废兑换码 */
export function revokeRedeemCode(codeId: string, organizationId: string): boolean {
  const db = getDB();
  const result = db.prepare(
    'UPDATE redeem_codes SET status = ? WHERE id = ? AND organization_id = ? AND status = ?',
  ).run('revoked', codeId, organizationId, 'active');
  return Number(result.changes) > 0;
}

// ── 交易查询 ────────────────────────────────────────────────────

export interface CreditTransaction {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string;
  accountName?: string;
  createdAt: string;
}

interface CreditTransactionRow {
  id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string;
  account_name: string | null;
  created_at: string;
}

/** 查询积分流水 */
export function listCreditTransactions(
  organizationId: string,
  limit: number = 50,
): CreditTransaction[] {
  assertQueryLimit(limit);
  const db = getDB();
  const rows = db.prepare(
    `SELECT ct.*, a.name as account_name
     FROM credit_transactions ct
     LEFT JOIN accounts a ON a.id = ct.account_id
     WHERE ct.organization_id = ?
     ORDER BY ct.created_at DESC
     LIMIT ?`,
  ).all(organizationId, limit) as CreditTransactionRow[];

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    balanceAfter: r.balance_after,
    description: r.description,
    accountName: r.account_name ?? undefined,
    createdAt: r.created_at,
  }));
}
