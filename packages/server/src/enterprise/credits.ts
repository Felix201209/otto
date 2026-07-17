/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise Credits System
 *
 * 企业积分体系：
 * 1. 组织积分池（organizations.credit_balance）
 * 2. 兑换码（一次性，可指定面额）
 * 3. 积分流水（每笔消费/充值可审计）
 * 4. 企业版禁止 BYOK，只允许 Otto 托管的模型
 */

import { getDB, DEFAULT_ORGANIZATION_ID } from './db.js';
import * as crypto from 'node:crypto';

// ── 表结构（在 db.ts 初始化时创建）─────────────────────────────

export const CREDITS_TABLES_SQL = [
  // 积分交易流水
  `CREATE TABLE IF NOT EXISTS credit_transactions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
    account_id TEXT,                    -- NULL=系统操作（管理员充值）
    type TEXT NOT NULL CHECK(type IN ('topup','redeem','consume','refund')),
    amount INTEGER NOT NULL,            -- 正=入账，负=出账
    balance_after INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    redeem_code_id TEXT,                -- 关联兑换码
    model TEXT,                         -- consume 时记录用了哪个模型
    message_id TEXT,                    -- consume 时记录关联消息
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (account_id) REFERENCES accounts(id),
    FOREIGN KEY (redeem_code_id) REFERENCES redeem_codes(id)
  )`,

  // 兑换码表
  `CREATE TABLE IF NOT EXISTS redeem_codes (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL DEFAULT '${DEFAULT_ORGANIZATION_ID}',
    code TEXT NOT NULL UNIQUE,           -- 兑换码（12位字母数字）
    credit_amount INTEGER NOT NULL,      -- 面额（积分）
    created_by TEXT NOT NULL,            -- 管理员账号ID
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','redeemed','revoked')),
    redeemed_by TEXT,                    -- 兑换人账号ID
    redeemed_at TEXT,                    -- 兑换时间
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id),
    FOREIGN KEY (created_by) REFERENCES accounts(id)
  )`,

  // 组织积分余额（扩展现有 organizations 表）
  `ALTER TABLE organizations ADD COLUMN credit_balance INTEGER NOT NULL DEFAULT 0`,

  `CREATE INDEX IF NOT EXISTS idx_credit_transactions_org
    ON credit_transactions(organization_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_credit_transactions_account
    ON credit_transactions(account_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_redeem_codes_org
    ON redeem_codes(organization_id, status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_redeem_codes_code
    ON redeem_codes(code)`,
];

// ── 兑换码生成 ──────────────────────────────────────────────────

const REDEEM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 无 I/O/0/1
const REDEEM_CODE_LENGTH = 12;
const REDEEM_CODE_FORMAT = 'XXXX-XXXX-XXXX'; // 4-4-4

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

/** 管理员创建一批兑换码 */
export function createRedeemCodes(
  organizationId: string,
  adminAccountId: string,
  creditAmount: number,
  count: number = 1,
): RedeemCodeInfo[] {
  if (creditAmount <= 0) throw new Error('兑换码面额必须大于 0');
  if (count < 1 || count > 100) throw new Error('一次最多生成 100 个兑换码');

  const results: RedeemCodeInfo[] = [];
  const db = getDB();
  const now = new Date().toISOString();

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
}

/** 用户输入兑换码兑换积分 */
export function redeemCode(
  code: string,
  accountId: string,
): { creditAmount: number; newBalance: number } {
  const normalized = code.replace(/[^A-Z2-9]/gi, '').toUpperCase();
  if (normalized.length !== 12) throw new Error('兑换码格式错误');

  const db = getDB();
  const row = db.prepare(
    'SELECT * FROM redeem_codes WHERE code = ?',
  ).get(code.replace(/-/g, '').replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3')) as any;

  // Try different formats
  const redeemRow = row ?? db.prepare(
    'SELECT * FROM redeem_codes WHERE REPLACE(code, "-", "") = ?',
  ).get(code.replace(/-/g, '')) as any;

  if (!redeemRow) throw new Error('兑换码不存在');
  if (redeemRow.status !== 'active') throw new Error(redeemRow.status === 'redeemed' ? '此兑换码已被使用' : '此兑换码已被作废');

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!account) throw new Error('账号不存在');

  const now = new Date().toISOString();

  // 1. 标记兑换码已使用
  db.prepare(
    'UPDATE redeem_codes SET status = ?, redeemed_by = ?, redeemed_at = ? WHERE id = ?',
  ).run('redeemed', accountId, now, redeemRow.id);

  // 2. 增加组织积分余额
  db.prepare(
    'UPDATE organizations SET credit_balance = credit_balance + ? WHERE id = ?',
  ).run(redeemRow.credit_amount, redeemRow.organization_id);

  const balanceRow = db.prepare(
    'SELECT credit_balance FROM organizations WHERE id = ?',
  ).get(redeemRow.organization_id) as { credit_balance: number };

  // 3. 记流水
  db.prepare(
    `INSERT INTO credit_transactions (id, organization_id, account_id, type, amount, balance_after, description, redeem_code_id, created_at)
     VALUES (?, ?, ?, 'redeem', ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), redeemRow.organization_id, accountId,
    redeemRow.credit_amount, balanceRow.credit_balance,
    `兑换码兑换 ${redeemRow.credit_amount} 积分`,
    redeemRow.id, now,
  );

  return { creditAmount: redeemRow.credit_amount, newBalance: balanceRow.credit_balance };
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
  const db = getDB();
  const row = db.prepare(
    'SELECT credit_balance FROM organizations WHERE id = ?',
  ).get(organizationId) as { credit_balance: number } | undefined;

  const balance = row?.credit_balance ?? 0;
  // 1 积分 ≈ 1000 tokens（可配置）
  const rate = parseInt(process.env['OTTO_CREDIT_TOKEN_RATE'] || '1000', 10);
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
  const db = getDB();

  const orgRow = db.prepare(
    'UPDATE organizations SET credit_balance = MAX(0, credit_balance - ?) WHERE id = ?',
  ).run(amount, organizationId);

  const newRow = db.prepare(
    'SELECT credit_balance FROM organizations WHERE id = ?',
  ).get(organizationId) as { credit_balance: number };

  // 记流水
  db.prepare(
    `INSERT INTO credit_transactions (id, organization_id, account_id, type, amount, balance_after, description, model, message_id, created_at)
     VALUES (?, ?, ?, 'consume', ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), organizationId, accountId,
    -amount, newRow.credit_balance,
    description, model || null, messageId || null,
    new Date().toISOString(),
  );

  return newRow.credit_balance;
}

// ── 管理员充值 ──────────────────────────────────────────────────

/** 管理员直接给组织充值积分 */
export function topUpCredits(
  organizationId: string,
  adminAccountId: string,
  amount: number,
  note?: string,
): { newBalance: number } {
  if (amount <= 0) throw new Error('充值金额必须大于 0');

  const db = getDB();
  db.prepare(
    'UPDATE organizations SET credit_balance = credit_balance + ? WHERE id = ?',
  ).run(amount, organizationId);

  const newRow = db.prepare(
    'SELECT credit_balance FROM organizations WHERE id = ?',
  ).get(organizationId) as { credit_balance: number };

  db.prepare(
    `INSERT INTO credit_transactions (id, organization_id, account_id, type, amount, balance_after, description, created_at)
     VALUES (?, ?, ?, 'topup', ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), organizationId, adminAccountId,
    amount, newRow.credit_balance,
    note || `管理员充值 ${amount} 积分`,
    new Date().toISOString(),
  );

  return { newBalance: newRow.credit_balance };
}

// ── 兑换码查询 ──────────────────────────────────────────────────

/** 查询兑换码列表 */
export function listRedeemCodes(
  organizationId: string,
  status?: 'active' | 'redeemed' | 'revoked',
): RedeemCodeInfo[] {
  const db = getDB();
  let rows: any[];
  if (status) {
    rows = db.prepare(
      'SELECT * FROM redeem_codes WHERE organization_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200',
    ).all(organizationId, status) as any[];
  } else {
    rows = db.prepare(
      'SELECT * FROM redeem_codes WHERE organization_id = ? ORDER BY created_at DESC LIMIT 200',
    ).all(organizationId) as any[];
  }

  return rows.map((r: any) => ({
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
  return (result as any).changes > 0;
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

/** 查询积分流水 */
export function listCreditTransactions(
  organizationId: string,
  limit: number = 50,
): CreditTransaction[] {
  const db = getDB();
  const rows = db.prepare(
    `SELECT ct.*, a.name as account_name
     FROM credit_transactions ct
     LEFT JOIN accounts a ON a.id = ct.account_id
     WHERE ct.organization_id = ?
     ORDER BY ct.created_at DESC
     LIMIT ?`,
  ).all(organizationId, limit) as any[];

  return rows.map((r: any) => ({
    id: r.id,
    type: r.type,
    amount: r.amount,
    balanceAfter: r.balance_after,
    description: r.description,
    accountName: r.account_name,
    createdAt: r.created_at,
  }));
}
