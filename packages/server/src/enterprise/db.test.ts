/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业 report 算法 + 成本口径单测。
 * 数据安全：绝不污染真实企业库。每个测试用独立临时 OTTO_ENTERPRISE_DIR，
 * 并 vi.resetModules() + 动态 import，让 db.ts 的模块级单例每次全新，互不串档。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../sqlite-compat.js';

type DbModule = typeof import('./db.js');

let tmpDir: string;
const prevEnv: Record<string, string | undefined> = {};

// 需要在测试里覆盖/还原的 env（隔离目录 + 估算参数）。
const ENV_KEYS = [
  'OTTO_ENTERPRISE_DIR',
  'OTTO_ESTIMATE_MANUAL_MULT',
  'OTTO_ESTIMATE_CNY_PER_HOUR',
  'OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP',
  'OTTO_ENTERPRISE_USAGE_DAILY_LIMIT',
] as const;

/** 设隔离目录 + 可选估算 env，然后拿到全新的 db 模块（单例已重置）。 */
async function freshDb(estimateEnv: Record<string, string> = {}): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  for (const [k, v] of Object.entries(estimateEnv)) process.env[k] = v;
  vi.resetModules();
  return import('./db.js');
}

beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ent-db-'));
});

afterEach(() => {
  // 还原所有被动过的 env，并清掉临时库，绝不留痕。
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('知识库旧库迁移', () => {
  it('为单组织旧表补齐 organization_id/source_id，保留历史知识并支持幂等写入', async () => {
    const legacy = new Database(path.join(tmpDir, 'data.db'));
    legacy.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        department TEXT,
        category TEXT,
        content TEXT NOT NULL,
        contributor TEXT,
        confidence REAL DEFAULT 0.5,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO knowledge (department, category, content, contributor, confidence)
      VALUES ('研发部', 'solution', '旧版知识仍需保留', '历史员工', 0.9);
    `);
    legacy.close();

    const db = await freshDb();
    const columns = db.getDB().prepare('PRAGMA table_info(knowledge)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['organization_id', 'source_id']),
    );
    expect(db.getKnowledge()).toEqual([
      expect.objectContaining({ content: '旧版知识仍需保留', contributor: '历史员工' }),
    ]);

    const entry = {
      sourceId: 'local-kb-1',
      department: '研发部',
      category: 'solution',
      content: '自动捕获的新知识',
      contributor: '当前员工',
      confidence: 0.85,
    };
    expect(db.addKnowledge(entry)).toBe(true);
    expect(db.addKnowledge(entry)).toBe(false);
  });
});

describe('数据库 readiness', () => {
  it('执行真实查询并返回当前 schema version', async () => {
    const db = await freshDb();
    expect(db.getDatabaseReadiness()).toEqual({
      ready: true,
      schemaVersion: 3,
    });
  });

  it('v3 账号生命周期迁移可重复初始化，同一数据库重启后不重复添加列', async () => {
    const first = await freshDb();
    first.getDB();
    first.closeEnterpriseDatabase();

    vi.resetModules();
    const reopened: DbModule = await import('./db.js');
    try {
      expect(reopened.getDatabaseReadiness()).toEqual({
        ready: true,
        schemaVersion: 3,
      });
      const organizationColumns = reopened.getDB()
        .prepare('PRAGMA table_info(organizations)')
        .all() as Array<{ name: string }>;
      const accountColumns = reopened.getDB()
        .prepare('PRAGMA table_info(accounts)')
        .all() as Array<{ name: string }>;
      expect(organizationColumns.filter((column) => column.name === 'credit_balance')).toHaveLength(1);
      expect(accountColumns.filter((column) => column.name === 'account_type')).toHaveLength(1);
      expect(accountColumns.filter((column) => column.name === 'deleted_at')).toHaveLength(1);
    } finally {
      reopened.closeEnterpriseDatabase();
    }
  });

  it('拒绝打开高于当前版本的未来 schema，且不降级或改写原库', async () => {
    const future = new Database(path.join(tmpDir, 'data.db'));
    future.exec(`
      CREATE TABLE future_only (id TEXT PRIMARY KEY);
      INSERT INTO future_only (id) VALUES ('preserve-me');
      PRAGMA user_version = 4;
    `);
    future.close();

    const db = await freshDb();
    expect(() => db.getDB()).toThrow(/schema version 4.*current version 3/i);

    const reopened = new Database(path.join(tmpDir, 'data.db'));
    try {
      expect(
        (reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(4);
      expect(
        (reopened.prepare('SELECT id FROM future_only').get() as { id: string }).id,
      ).toBe('preserve-me');
    } finally {
      reopened.close();
    }
  });
});

describe('企业 Token 用量时间窗口', () => {
  it('按 UTC datetime 比较完整 30 天边界，并把 SQLite 时间返回为带 Z 的 ISO', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    try {
      const db = await freshDb();
      const account = db.createAccount({
        username: 'usage-window',
        password: 'usage-window-password',
        name: '用量边界用户',
      });
      db.recordTokenUsage({
        accountId: account.id,
        sessionId: 'inside',
        messageId: 'inside-window',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      db.recordTokenUsage({
        accountId: account.id,
        sessionId: 'outside',
        messageId: 'outside-window',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
      db.getDB().prepare(
        'UPDATE account_token_usage SET created_at = ? WHERE message_id = ?',
      ).run('2026-06-16 13:00:00', 'inside-window');
      db.getDB().prepare(
        'UPDATE account_token_usage SET created_at = ? WHERE message_id = ?',
      ).run('2026-06-16 11:59:59', 'outside-window');

      const summary = db.getOrganizationUsageSummary(db.DEFAULT_ORGANIZATION_ID, 30);
      expect(summary).toMatchObject({
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalTokens: 15,
        requestCount: 1,
      });
      expect(summary.byAccount.find((row) => row.accountId === account.id)?.lastUsedAt)
        .toBe('2026-06-16T13:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('每账号每日记录数有硬上限，重复消息仍保持幂等且不消耗额外配额', async () => {
    const db = await freshDb({ OTTO_ENTERPRISE_USAGE_DAILY_LIMIT: '2' });
    const account = db.createAccount({
      username: 'usage-quota',
      password: 'usage-quota-password',
      name: '用量配额用户',
    });
    const record = (messageId: string) => db.recordTokenUsage({
      accountId: account.id,
      sessionId: 'quota-session',
      messageId,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

    expect(record('message-1')).toBe(true);
    expect(record('message-1')).toBe(false);
    expect(record('message-2')).toBe(true);
    expect(() => record('message-3')).toThrow('账号今日 Token 用量记录已达上限');
  });
});

describe('企业成员直聊', () => {
  it('只在同一企业的双方之间持久化、按时间读取并标记已读', async () => {
    const db = await freshDb();
    const alice = db.createAccount({ username: 'chat-alice', password: 'alice-password-123', name: 'Alice' });
    const bob = db.createAccount({ username: 'chat-bob', password: 'bob-password-123', name: 'Bob' });
    const message = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '  项目进展怎么样？  ',
    });
    expect(message).toMatchObject({
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '项目进展怎么样？',
      readAt: null,
    });
    expect(db.listDirectMessages({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: bob.id,
      peerAccountId: alice.id,
    })[0]).toMatchObject({ id: message.id, content: '项目进展怎么样？' });
    expect(db.listDirectMessages({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: alice.id,
      peerAccountId: bob.id,
    })[0].readAt).not.toBeNull();
  });

  it('拒绝给自己、跨企业或停用成员发送消息', async () => {
    const db = await freshDb();
    const alice = db.createAccount({ username: 'guard-alice', password: 'alice-password-123', name: 'Alice' });
    const otherOrg = db.createOrganization({ name: '另一企业' });
    const outsider = db.createAccount({ organizationId: otherOrg.id, username: 'outsider', password: 'outsider-password-123', name: 'Outsider' });
    expect(() => db.sendDirectMessage({ organizationId: db.DEFAULT_ORGANIZATION_ID, senderAccountId: alice.id, recipientAccountId: alice.id, content: 'self' })).toThrow('不能给自己');
    expect(() => db.sendDirectMessage({ organizationId: db.DEFAULT_ORGANIZATION_ID, senderAccountId: alice.id, recipientAccountId: outsider.id, content: 'cross tenant' })).toThrow('不存在或已停用');
  });

  it('A2A 收件箱只返回尚未由当前 Otto 回复的请求', async () => {
    const db = await freshDb();
    const alice = db.createAccount({ username: 'atoa-alice', password: 'alice-password-123', name: 'Alice' });
    const bob = db.createAccount({ username: 'atoa-bob', password: 'bob-password-123', name: 'Bob' });
    const request = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: 'OTTO_ATOA_REQUEST {"v":1,"id":"client-1","question":"方便开会吗？"}',
    });

    expect(db.listPendingAtoaRequests({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: bob.id,
      requestPrefix: 'OTTO_ATOA_REQUEST ',
      responsePrefix: 'OTTO_ATOA_RESPONSE ',
    })).toEqual([
      expect.objectContaining({
        id: request.id,
        peerAccountId: alice.id,
      }),
    ]);

    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: alice.id,
      content: `OTTO_ATOA_RESPONSE {"v":1,"requestId":"${request.id}","answer":"可以先约 15:00。"}`,
    });
    expect(db.listPendingAtoaRequests({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: bob.id,
      requestPrefix: 'OTTO_ATOA_REQUEST ',
      responsePrefix: 'OTTO_ATOA_RESPONSE ',
    })).toEqual([]);
  });
});

describe('企业邀请码原子更新', () => {
  it('审计写入失败时回滚新邀请码，并保持旧邀请码继续有效', async () => {
    const db = await freshDb();
    const oldInvite = db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, 1_000);
    const beforeCount = (db.getDB().prepare(
      'SELECT COUNT(*) AS count FROM organization_invites',
    ).get() as { count: number }).count;
    db.getDB().exec(`
      CREATE TRIGGER fail_invite_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.event = 'organization_invite_issue'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `);

    expect(() => db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, 2_000))
      .toThrow(/forced audit failure/);

    const afterCount = (db.getDB().prepare(
      'SELECT COUNT(*) AS count FROM organization_invites',
    ).get() as { count: number }).count;
    expect(afterCount).toBe(beforeCount);
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, 2_000)?.id)
      .toBe(oldInvite.id);
    expect(db.inspectOrganizationInvite(oldInvite.code, 2_000).status).toBe('active');
  });

  it('两个已签发短信挑战竞争单人邀请码时只允许一个账号落库', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    const firstChallenge = db.createSmsRegistrationChallenge(
      '13800138000',
      '123456',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    const secondChallenge = db.createSmsRegistrationChallenge(
      '13900139000',
      '654321',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    expect(firstChallenge.ok).toBe(true);
    expect(secondChallenge.ok).toBe(true);
    if (!firstChallenge.ok || !secondChallenge.ok) {
      throw new Error('registration challenges should be issued');
    }

    const firstVerified = db.verifySmsRegistrationChallenge(
      firstChallenge.challengeId,
      '123456',
      now + 1_000,
    );
    const secondVerified = db.verifySmsRegistrationChallenge(
      secondChallenge.challengeId,
      '654321',
      now + 1_000,
    );
    expect(firstVerified.ok).toBe(true);
    expect(secondVerified.ok).toBe(true);
    if (!firstVerified.ok || !secondVerified.ok) {
      throw new Error('registration challenges should verify');
    }

    const firstAccount = db.createSelfRegisteredAccount({
      organizationId: firstVerified.organizationId,
      phone: firstVerified.phone,
      name: '第一位员工',
      password: 'first-registered-password',
      organizationInviteId: firstVerified.organizationInviteId,
    });
    expect(firstAccount.phone).toBe('+8613800138000');

    expect(() => db.createSelfRegisteredAccount({
      organizationId: secondVerified.organizationId,
      phone: secondVerified.phone,
      name: '第二位员工',
      password: 'second-registered-password',
      organizationInviteId: secondVerified.organizationInviteId,
    })).toThrow('企业邀请码可用名额已用完，请联系管理员重新生成');

    expect(db.findAccountByPhone(secondVerified.phone)).toBeNull();
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, now + 1_000))
      .toMatchObject({ id: invite.id, maxUses: 1, usedCount: 1 });
  });

  it('短信挑战签发后邀请码被撤销时拒绝创建账号且不核销名额', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    const challenge = db.createSmsRegistrationChallenge(
      '13600136000',
      '123456',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) throw new Error('registration challenge should be issued');
    const verified = db.verifySmsRegistrationChallenge(
      challenge.challengeId,
      '123456',
      now + 200,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('registration challenge should verify');

    db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, now + 300);
    expect(db.inspectOrganizationInvite(invite.code, now + 300).status).toBe('revoked');

    expect(() => db.createSelfRegisteredAccount({
      organizationId: verified.organizationId,
      phone: verified.phone,
      name: '撤销后注册员工',
      password: 'registered-password',
      organizationInviteId: verified.organizationInviteId,
    })).toThrow('企业邀请码可用名额已用完，请联系管理员重新生成');

    expect(db.findAccountByPhone(verified.phone)).toBeNull();
    expect(db.getDB().prepare(
      'SELECT used_count AS usedCount FROM organization_invites WHERE id = ?',
    ).get(invite.id)).toMatchObject({ usedCount: 0 });
  });

  it('短信挑战签发后邀请码过期时拒绝创建账号且不核销名额', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    const challenge = db.createSmsRegistrationChallenge(
      '13500135000',
      '654321',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) throw new Error('registration challenge should be issued');
    const verified = db.verifySmsRegistrationChallenge(
      challenge.challengeId,
      '654321',
      now + 200,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('registration challenge should verify');

    db.getDB().prepare(
      'UPDATE organization_invites SET expires_at_ms = ? WHERE id = ?',
    ).run(Date.now() - 1, invite.id);
    expect(db.inspectOrganizationInvite(invite.code, Date.now()).status).toBe('expired');

    expect(() => db.createSelfRegisteredAccount({
      organizationId: verified.organizationId,
      phone: verified.phone,
      name: '过期后注册员工',
      password: 'registered-password',
      organizationInviteId: verified.organizationInviteId,
    })).toThrow('企业邀请码可用名额已用完，请联系管理员重新生成');

    expect(db.findAccountByPhone(verified.phone)).toBeNull();
    expect(db.getDB().prepare(
      'SELECT used_count AS usedCount FROM organization_invites WHERE id = ?',
    ).get(invite.id)).toMatchObject({ usedCount: 0 });
  });

  it('账号创建失败时回滚账号和已占用的邀请码名额', async () => {
    const db = await freshDb();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      2_000_000,
      null,
      { maxUses: 1 },
    );
    db.getDB().exec(`
      CREATE TRIGGER fail_self_registered_account_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.event = 'account_create'
      BEGIN
        SELECT RAISE(ABORT, 'forced account audit failure');
      END;
    `);

    expect(() => db.createSelfRegisteredAccount({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      phone: '13700137000',
      name: '失败员工',
      password: 'registered-password',
      organizationInviteId: invite.id,
    })).toThrow(/forced account audit failure/);

    expect(db.findAccountByPhone('13700137000')).toBeNull();
    expect(db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, 2_001_000))
      .toMatchObject({ id: invite.id, maxUses: 1, usedCount: 0 });
  });
});

describe('report 边界：0 任务不崩/不 NaN/不除零', () => {
  it('空库返回全 0，且所有数值字段有限（无 NaN/Infinity）', async () => {
    const db = await freshDb();
    const r = db.getReport(30);
    expect(r.totalTasks).toBe(0);
    expect(r.totalMinutes).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.timeSavedHours).toBe(0);
    expect(r.laborSavedCNY).toBe(0);
    expect(r.netBenefitCNY).toBe(0);
    expect(r.tokenCostCNY).toBe(0);
    // 除零口径：totalCost=0 时 laborPerToken 必须是 0，不是 NaN/Infinity。
    expect(r.laborPerTokenCNY).toBe(0);
    expect(r.laborPerTokenCapped).toBe(false);
    for (const v of [
      r.totalMinutes, r.totalTokens, r.timeSavedHours, r.laborSavedCNY,
      r.netBenefitCNY, r.tokenCostCNY, r.laborPerTokenCNY,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // 图表兜底：空数据下 trend/bottlenecks 不崩。
    expect(r.trend).toEqual([]);
    expect(r.bottlenecks).toEqual({ slowestTotal: null, mostFrequent: null, slowestAvg: null });
    expect(r.byType).toEqual([]);
  });
});

describe('timeSaved 口径：ottoMinutes × (mult − 1)，不双算', () => {
  function seedOneEmployeeTasks(db: DbModule, mins: number[]): void {
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    for (const m of mins) {
      db.logTask({ employee_id: 'e1', task_type: 'contract_review', duration_min: m });
    }
  }

  it('默认 mult=2：省时 = ottoMin × (2−1) = ottoMin', async () => {
    const db = await freshDb(); // 默认 mult=2
    seedOneEmployeeTasks(db, [30, 30]); // ottoMin=60
    const r = db.getReport(30);
    expect(r.totalMinutes).toBe(60);
    // savedMin = 60 × (2-1) = 60min = 1.0h
    expect(r.timeSavedHours).toBe(1);
  });

  it('mult 可配：改 OTTO_ESTIMATE_MANUAL_MULT=3 生效，省时 = ottoMin × 2', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_MANUAL_MULT: '3' });
    seedOneEmployeeTasks(db, [30, 30]); // ottoMin=60
    const r = db.getReport(30);
    expect(r.assumptions.manualTimeMultiplier).toBe(3);
    // savedMin = 60 × (3-1) = 120min = 2.0h（若双算成 ottoMin×mult=180min=3h 就错了）
    expect(r.timeSavedHours).toBe(2);
  });

  it('mult=1 时省时为 0（人工与 Otto 同速，无净节省）', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_MANUAL_MULT: '1' });
    seedOneEmployeeTasks(db, [60]);
    const r = db.getReport(30);
    expect(r.timeSavedHours).toBe(0);
    expect(r.laborSavedCNY).toBe(0);
  });
});

describe('trend 累积正确', () => {
  it('按任务逐条累积 cumTasks 与 cumSavedHours（同日数据也成立）', async () => {
    const db = await freshDb(); // mult=2 → 每分钟省 1 分钟
    db.createEmployee({ id: 'e1', name: '张三', department: 'ops' });
    db.logTask({ employee_id: 'e1', task_type: 'a', duration_min: 30 });
    db.logTask({ employee_id: 'e1', task_type: 'b', duration_min: 90 });
    const r = db.getReport(30);
    expect(r.trend.length).toBe(2);
    expect(r.trend[0].cumTasks).toBe(1);
    expect(r.trend[1].cumTasks).toBe(2);
    // 累计省时（小时）：第1点 30×1/60=0.5h；第2点 (30+90)×1/60=2.0h
    expect(r.trend[0].cumSavedHours).toBeCloseTo(0.5, 5);
    expect(r.trend[1].cumSavedHours).toBeCloseTo(2.0, 5);
    // 单调不减
    expect(r.trend[1].cumSavedHours).toBeGreaterThanOrEqual(r.trend[0].cumSavedHours);
  });
});

describe('bottlenecks 选取正确（最耗时/最频繁/单次最慢）', () => {
  it('三类分别挑对 task_type', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'ops' });
    // frequent: 3 次、总时长小、单次快
    for (let i = 0; i < 3; i++) db.logTask({ employee_id: 'e1', task_type: 'frequent', duration_min: 5 });
    // heavy: 2 次、总时长最大
    db.logTask({ employee_id: 'e1', task_type: 'heavy', duration_min: 40 });
    db.logTask({ employee_id: 'e1', task_type: 'heavy', duration_min: 40 }); // 总 80，单次均 40
    // slowSingle: 1 次、单次最慢
    db.logTask({ employee_id: 'e1', task_type: 'slowSingle', duration_min: 100 });
    const r = db.getReport(30);
    const b = r.bottlenecks;
    expect(b.slowestTotal?.taskType).toBe('slowSingle'); // 100 > 80 > 15
    expect(b.slowestTotal?.minutes).toBe(100);
    expect(b.mostFrequent?.taskType).toBe('frequent');
    expect(b.mostFrequent?.count).toBe(3);
    expect(b.slowestAvg?.taskType).toBe('slowSingle'); // 单次 100 最慢
    expect(b.slowestAvg?.avgMinutes).toBe(100);
  });
});

describe('P1 修复：laborPerToken 在 cost=0 场景不再爆表', () => {
  it('修复前会爆表的 2 任务场景（1 任务 cost=0、1 任务真实 cost）现在被兜底+封顶', async () => {
    // 复现 task 描述的实测场景：多数 cost=0、少数有真实 cost。
    const db = await freshDb(); // mult=2, cnyPerHour=50, cap=50
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 任务1：显式上报 cost_cny=0（旧口径会存 0）、耗时 60min
    db.logTask({ employee_id: 'e1', task_type: 't1', duration_min: 60, tokens_used: 3000, cost_cny: 0 });
    // 任务2：真实 cost 0.03、耗时 60min
    db.logTask({ employee_id: 'e1', task_type: 't2', duration_min: 60, tokens_used: 3000, cost_cny: 0.03 });
    const r = db.getReport(30);
    // 兜底后：totalCost = 0.028(兜底) + 0.03 = 0.058，而非旧口径的 0.03。
    // laborSaved = (120×1/60)×50 = 100 元。旧：100/0.03≈3333；新裸算 100/0.058≈1724 → 仍超 50，封顶到 50。
    expect(r.laborPerTokenCapped).toBe(true);
    expect(r.laborPerTokenCNY).toBe(50);
    // 关键断言：绝不再出现 ¥1000+/token 的天文数字。
    expect(r.laborPerTokenCNY).toBeLessThanOrEqual(50);
    expect(Number.isFinite(r.laborPerTokenCNY)).toBe(true);
  });

  it('正常成本区间不封顶，返回真实可解释倍率', async () => {
    // cnyPerHour 调低让 laborSaved 变小，落在封顶线以内。
    const db = await freshDb({ OTTO_ESTIMATE_CNY_PER_HOUR: '50', OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP: '50' });
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 耗时 12min、真实 cost 1 元 → laborSaved=(12×1/60)×50=10；10/1=10 ≤ 50，不封顶。
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 12, cost_cny: 1 });
    const r = db.getReport(30);
    expect(r.laborPerTokenCapped).toBe(false);
    expect(r.laborPerTokenCNY).toBe(10);
  });

  it('cap 可配：OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP 生效', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP: '20' });
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 造一个裸算远超 20 的场景：耗时 600min、cost 0.028 兜底 → laborSaved=(600×1/60)×50=500；500/0.028≈17857 → 封顶 20。
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 600, cost_cny: 0 });
    const r = db.getReport(30);
    expect(r.assumptions.laborPerTokenCap).toBe(20);
    expect(r.laborPerTokenCapped).toBe(true);
    expect(r.laborPerTokenCNY).toBe(20);
  });
});

describe('成本/token 归一化（normalizeCostCNY / normalizeTokens）', () => {
  it('非正/非法值回落默认，正值透传', async () => {
    const db = await freshDb();
    // cost
    expect(db.normalizeCostCNY(0)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(-5)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(undefined)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(NaN)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(0.05)).toBe(0.05);
    // tokens
    expect(db.normalizeTokens(0)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(-1)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(undefined)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(1234)).toBe(1234);
  });

  it('logTask 落库时 cost=0 被兜底为默认成本（totalCost 不再塌 0）', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 10, cost_cny: 0, tokens_used: 0 });
    const r = db.getReport(30);
    // 单任务 cost 兜底 0.028、tokens 兜底 2000。tokenCostCNY 经 round 到 2 位 → 0.03（关键：非 0）。
    expect(r.tokenCostCNY).toBe(0.03);
    expect(r.totalTokens).toBe(2000);
  });
});

describe('report 期窗与部门过滤', () => {
  it('periodDays 之外的任务不计入', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 30 });
    // 把这条改成 40 天前，落在 30 天窗外。
    db.getDB().prepare(
      "UPDATE task_logs SET created_at = datetime('now','-40 days') WHERE employee_id='e1'",
    ).run();
    const r = db.getReport(30);
    expect(r.totalTasks).toBe(0);
    // 放宽到 60 天窗则能看到。
    expect(db.getReport(60).totalTasks).toBe(1);
  });

  it('department 过滤只统计该部门任务', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.createEmployee({ id: 'e2', name: '李四', department: 'ops' });
    db.logTask({ employee_id: 'e1', task_type: 'a', duration_min: 10 });
    db.logTask({ employee_id: 'e2', task_type: 'b', duration_min: 10 });
    expect(db.getReport(30, 'legal').totalTasks).toBe(1);
    expect(db.getReport(30).totalTasks).toBe(2);
  });
});
