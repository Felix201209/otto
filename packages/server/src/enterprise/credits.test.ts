/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业积分数据层契约。
 * 每个用例使用独立临时库，绝不接触真实企业数据。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DbModule = typeof import('./db.js');
type CreditsModule = typeof import('./credits.js');

let tmpDir: string;
let previousEnterpriseDir: string | undefined;
let previousTokenRate: string | undefined;
let openDbModule: DbModule | undefined;

async function freshModules(): Promise<{ db: DbModule; credits: CreditsModule }> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  vi.resetModules();
  const db = await import('./db.js');
  const credits = await import('./credits.js');
  openDbModule = db;
  return { db, credits };
}

function createAccount(
  db: DbModule,
  suffix: string,
  organizationId = db.DEFAULT_ORGANIZATION_ID,
  isAdmin = false,
) {
  return db.createAccount({
    organizationId,
    username: `credits-${suffix}`,
    password: `credits-${suffix}-password`,
    name: `积分用户 ${suffix}`,
    isAdmin,
  });
}

beforeEach(() => {
  previousEnterpriseDir = process.env.OTTO_ENTERPRISE_DIR;
  previousTokenRate = process.env.OTTO_CREDIT_TOKEN_RATE;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-credits-'));
});

afterEach(() => {
  openDbModule?.closeEnterpriseDatabase();
  openDbModule = undefined;
  if (previousEnterpriseDir === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
  else process.env.OTTO_ENTERPRISE_DIR = previousEnterpriseDir;
  if (previousTokenRate === undefined) delete process.env.OTTO_CREDIT_TOKEN_RATE;
  else process.env.OTTO_CREDIT_TOKEN_RATE = previousTokenRate;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('积分 schema 片段安全', () => {
  it('不携带不可重复执行的 ALTER TABLE，列迁移只由 db.ts 的幂等探测负责', async () => {
    const { credits } = await freshModules();
    expect(credits.CREDITS_TABLES_SQL.join('\n')).not.toMatch(/ALTER\s+TABLE/i);
  });
});

describe('兑换码租户边界与规范化', () => {
  it('接受小写、空格和无连字符输入，但拒绝跨企业账号兑换', async () => {
    const { db, credits } = await freshModules();
    const defaultAdmin = createAccount(db, 'default-admin', undefined, true);
    const defaultUser = createAccount(db, 'default-user');
    const otherOrganization = db.createOrganization({ name: '第二企业', slug: 'credits-second' });
    const otherUser = createAccount(db, 'other-user', otherOrganization.id);

    const [normalizedCode] = credits.createRedeemCodes(
      db.DEFAULT_ORGANIZATION_ID,
      defaultAdmin.id,
      25,
    );
    expect(
      credits.redeemCode(normalizedCode.code.toLowerCase().replaceAll('-', ' '), defaultUser.id),
    ).toEqual({ creditAmount: 25, newBalance: 25 });

    const [tenantCode] = credits.createRedeemCodes(
      db.DEFAULT_ORGANIZATION_ID,
      defaultAdmin.id,
      10,
    );
    expect(() => credits.redeemCode(tenantCode.code, otherUser.id))
      .toThrow(/当前企业|不属于/);
    expect(credits.listRedeemCodes(db.DEFAULT_ORGANIZATION_ID, 'active'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: tenantCode.id })]));
    expect(credits.getCreditBalance(otherOrganization.id).balance).toBe(0);
  });
});

describe('批量兑换码原子创建', () => {
  it('中途 INSERT 失败时回滚整批，不留下已插入的孤儿码', async () => {
    const { db, credits } = await freshModules();
    const admin = createAccount(db, 'batch-atomic-admin', undefined, true);
    const beforeCount = (db.getDB().prepare(
      'SELECT COUNT(*) AS count FROM redeem_codes WHERE organization_id = ?',
    ).get(db.DEFAULT_ORGANIZATION_ID) as { count: number }).count;
    db.getDB().exec(`
      CREATE TRIGGER fail_second_redeem_code
      BEFORE INSERT ON redeem_codes
      WHEN (
        SELECT COUNT(*)
        FROM redeem_codes
        WHERE organization_id = NEW.organization_id
      ) = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced batch redeem code failure');
      END;
    `);

    expect(() => credits.createRedeemCodes(
      db.DEFAULT_ORGANIZATION_ID,
      admin.id,
      10,
      3,
    )).toThrow(/forced batch redeem code failure/);

    const afterCount = (db.getDB().prepare(
      'SELECT COUNT(*) AS count FROM redeem_codes WHERE organization_id = ?',
    ).get(db.DEFAULT_ORGANIZATION_ID) as { count: number }).count;
    expect(afterCount).toBe(beforeCount);
    expect(credits.listRedeemCodes(db.DEFAULT_ORGANIZATION_ID)).toEqual([]);
  });
});

describe('积分整数边界', () => {
  it('兑换、充值、扣费只接受有限的正安全整数，生成数量也必须是 1 到 100 的整数', async () => {
    const { db, credits } = await freshModules();
    const admin = createAccount(db, 'integer-admin', undefined, true);
    const invalidAmounts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];

    for (const amount of invalidAmounts) {
      expect(() => credits.createRedeemCodes(db.DEFAULT_ORGANIZATION_ID, admin.id, amount))
        .toThrow(/正整数/);
      expect(() => credits.topUpCredits(db.DEFAULT_ORGANIZATION_ID, admin.id, amount))
        .toThrow(/正整数/);
      expect(() => credits.deductCredits(db.DEFAULT_ORGANIZATION_ID, admin.id, amount, 'invalid'))
        .toThrow(/正整数/);
    }
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101]) {
      expect(() => credits.createRedeemCodes(db.DEFAULT_ORGANIZATION_ID, admin.id, 1, count))
        .toThrow(/1 到 100/);
    }
  });

  it('token 估算拒绝非法输入和非法费率，绝不返回 NaN 后放行', async () => {
    const { db, credits } = await freshModules();
    const account = createAccount(db, 'estimate');

    expect(() => credits.checkAndReserveCredits(
      db.DEFAULT_ORGANIZATION_ID,
      account.id,
      Number.NaN,
    )).toThrow(/token/i);

    process.env.OTTO_CREDIT_TOKEN_RATE = 'not-a-number';
    expect(() => credits.checkAndReserveCredits(
      db.DEFAULT_ORGANIZATION_ID,
      account.id,
      1_000,
    )).toThrow(/OTTO_CREDIT_TOKEN_RATE/);
  });
});

describe('积分写入原子性', () => {
  it('兑换流水写入失败时回滚兑换码状态和余额', async () => {
    const { db, credits } = await freshModules();
    const admin = createAccount(db, 'redeem-admin', undefined, true);
    const user = createAccount(db, 'redeem-user');
    const [code] = credits.createRedeemCodes(db.DEFAULT_ORGANIZATION_ID, admin.id, 30);
    db.getDB().exec(`
      CREATE TRIGGER fail_redeem_transaction
      BEFORE INSERT ON credit_transactions
      WHEN NEW.type = 'redeem'
      BEGIN
        SELECT RAISE(ABORT, 'forced redeem transaction failure');
      END;
    `);

    expect(() => credits.redeemCode(code.code, user.id))
      .toThrow(/forced redeem transaction failure/);
    expect(credits.getCreditBalance(db.DEFAULT_ORGANIZATION_ID).balance).toBe(0);
    expect(credits.listRedeemCodes(db.DEFAULT_ORGANIZATION_ID, 'active'))
      .toEqual([expect.objectContaining({ id: code.id, status: 'active' })]);
    expect(credits.listCreditTransactions(db.DEFAULT_ORGANIZATION_ID)).toEqual([]);
  });

  it('充值或扣费流水写入失败时回滚余额', async () => {
    const { db, credits } = await freshModules();
    const admin = createAccount(db, 'atomic-admin', undefined, true);
    db.getDB().exec(`
      CREATE TRIGGER fail_topup_transaction
      BEFORE INSERT ON credit_transactions
      WHEN NEW.type = 'topup'
      BEGIN
        SELECT RAISE(ABORT, 'forced topup transaction failure');
      END;
    `);

    expect(() => credits.topUpCredits(db.DEFAULT_ORGANIZATION_ID, admin.id, 10))
      .toThrow(/forced topup transaction failure/);
    expect(credits.getCreditBalance(db.DEFAULT_ORGANIZATION_ID).balance).toBe(0);

    db.getDB().exec('DROP TRIGGER fail_topup_transaction');
    db.getDB().prepare(
      'UPDATE organizations SET credit_balance = ? WHERE id = ?',
    ).run(10, db.DEFAULT_ORGANIZATION_ID);
    db.getDB().exec(`
      CREATE TRIGGER fail_consume_transaction
      BEFORE INSERT ON credit_transactions
      WHEN NEW.type = 'consume'
      BEGIN
        SELECT RAISE(ABORT, 'forced consume transaction failure');
      END;
    `);

    expect(() => credits.deductCredits(
      db.DEFAULT_ORGANIZATION_ID,
      admin.id,
      4,
      '原子扣费',
      'otto:test',
      'message-atomic',
    )).toThrow(/forced consume transaction failure/);
    expect(credits.getCreditBalance(db.DEFAULT_ORGANIZATION_ID).balance).toBe(10);
  });
});

describe('扣费安全与幂等', () => {
  it('余额不足时拒绝扣费，余额和流水都不变化', async () => {
    const { db, credits } = await freshModules();
    const account = createAccount(db, 'insufficient');
    db.getDB().prepare(
      'UPDATE organizations SET credit_balance = ? WHERE id = ?',
    ).run(3, db.DEFAULT_ORGANIZATION_ID);

    expect(() => credits.deductCredits(
      db.DEFAULT_ORGANIZATION_ID,
      account.id,
      5,
      '余额不足',
      null,
      'message-insufficient',
    )).toThrow(/余额不足/);
    expect(credits.getCreditBalance(db.DEFAULT_ORGANIZATION_ID).balance).toBe(3);
    expect(credits.listCreditTransactions(db.DEFAULT_ORGANIZATION_ID)).toEqual([]);
  });

  it('同一企业、账号和 messageId 的重试只扣费并记账一次', async () => {
    const { db, credits } = await freshModules();
    const account = createAccount(db, 'idempotent');
    db.getDB().prepare(
      'UPDATE organizations SET credit_balance = ? WHERE id = ?',
    ).run(10, db.DEFAULT_ORGANIZATION_ID);

    expect(credits.deductCredits(
      db.DEFAULT_ORGANIZATION_ID,
      account.id,
      4,
      '首次扣费',
      'otto:test',
      ' message-1 ',
    )).toBe(6);
    expect(credits.deductCredits(
      db.DEFAULT_ORGANIZATION_ID,
      account.id,
      2,
      '后续扣费',
      'otto:test',
      'message-2',
    )).toBe(4);
    expect(credits.deductCredits(
      db.DEFAULT_ORGANIZATION_ID,
      account.id,
      4,
      '重试扣费',
      'otto:test',
      'message-1',
    )).toBe(4);
    expect(credits.listCreditTransactions(db.DEFAULT_ORGANIZATION_ID))
      .toEqual([
        expect.objectContaining({ type: 'consume', amount: -2, balanceAfter: 4 }),
        expect.objectContaining({ type: 'consume', amount: -4, balanceAfter: 6 }),
      ]);
  });
});

describe('查询边界', () => {
  it('交易 limit 限定为 1 到 200 的整数，兑换码 status 只接受已知值', async () => {
    const { db, credits } = await freshModules();
    const admin = createAccount(db, 'query-admin', undefined, true);
    credits.topUpCredits(db.DEFAULT_ORGANIZATION_ID, admin.id, 1, 'one');
    credits.topUpCredits(db.DEFAULT_ORGANIZATION_ID, admin.id, 1, 'two');
    credits.topUpCredits(db.DEFAULT_ORGANIZATION_ID, admin.id, 1, 'three');

    expect(credits.listCreditTransactions(db.DEFAULT_ORGANIZATION_ID, 2)).toHaveLength(2);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 201]) {
      expect(() => credits.listCreditTransactions(db.DEFAULT_ORGANIZATION_ID, limit))
        .toThrow(/1 到 200/);
    }
    expect(() => credits.listRedeemCodes(
      db.DEFAULT_ORGANIZATION_ID,
      'unknown' as 'active',
    )).toThrow(/状态/);
  });
});
