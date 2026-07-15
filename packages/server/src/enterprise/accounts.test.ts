/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 预设账号、标签、会话与 IT 工单投递的数据层契约。
 * 每个用例使用独立临时库，绝不接触真实企业数据。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DbModule = typeof import('./db.js');

let tmpDir: string;
let previousDir: string | undefined;

async function freshDb(): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  vi.resetModules();
  return import('./db.js');
}

beforeEach(() => {
  previousDir = process.env.OTTO_ENTERPRISE_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-account-db-'));
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
  else process.env.OTTO_ENTERPRISE_DIR = previousDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('预设账号与密码', () => {
  it('创建账号时规范化用户名、保存标签，且任何读取结果都不泄露密码哈希', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: '  Felix.IT  ',
      password: 'correct-horse-123',
      name: 'Felix',
      role: '技术支持',
      department: 'IT',
      tags: ['普通员工', 'IT', '报修', 'IT'],
      isAdmin: true,
    });

    expect(account.username).toBe('felix.it');
    expect(account.tags).toEqual(['IT', '报修', '普通员工']);
    expect(account.isAdmin).toBe(true);
    expect(account).not.toHaveProperty('password_hash');
    expect(JSON.stringify(db.listAccounts())).not.toContain('correct-horse-123');
    expect(JSON.stringify(db.listAccounts())).not.toContain('password_hash');
  });

  it('用户名或已绑定手机号都能配合正确密码登录，错误时不泄露账号状态', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'it01',
      password: 'correct-horse-123',
      name: 'IT 一号',
      phone: '13800138000',
      tags: ['IT', '报修'],
    });

    expect(db.authenticateAccount('IT01', 'correct-horse-123')?.id).toBe(account.id);
    expect(db.authenticateAccount('138 0013 8000', 'correct-horse-123')?.id).toBe(account.id);
    expect(db.authenticateAccount('+8613800138000', 'correct-horse-123')?.id).toBe(account.id);
    expect(db.authenticateAccount('it01', 'wrong-password')).toBeNull();
    expect(db.authenticateAccount('13800138000', 'wrong-password')).toBeNull();
    expect(db.authenticateAccount('missing', 'correct-horse-123')).toBeNull();

    db.updateAccount(account.id, { status: 'disabled' });
    expect(db.authenticateAccount('it01', 'correct-horse-123')).toBeNull();
  });

  it('管理员可修改账号资料、标签和密码', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'employee01',
      password: 'before-password',
      name: '旧名字',
      tags: ['普通员工'],
    });

    const updated = db.updateAccount(account.id, {
      name: '新名字',
      role: '桌面支持',
      tags: ['IT', '报修'],
      password: 'after-password',
      isAdmin: true,
    });

    expect(updated.name).toBe('新名字');
    expect(updated.role).toBe('桌面支持');
    expect(updated.tags).toEqual(['IT', '报修']);
    expect(updated.isAdmin).toBe(true);
    expect(db.authenticateAccount('employee01', 'before-password')).toBeNull();
    expect(db.authenticateAccount('employee01', 'after-password')?.id).toBe(account.id);
  });

  it('手机号统一规范成中国大陆 E.164，且不能绑定给两个账号', async () => {
    const db = await freshDb();
    const first = db.createAccount({
      username: 'phone01',
      password: 'phone-password-1',
      name: '手机用户一',
      phone: '138 0013 8000',
    });

    expect(first.phone).toBe('+8613800138000');
    expect(db.findActiveAccountByPhone('86-138-0013-8000')?.id).toBe(first.id);
    expect(() => db.createAccount({
      username: 'phone02',
      password: 'phone-password-2',
      name: '手机用户二',
      phone: '+86 13800138000',
    })).toThrow(/手机号/);
  });
});

describe('会话', () => {
  it('登录令牌只在创建时返回，数据库可解析并可注销', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'staff01',
      password: 'staff-password',
      name: '员工一号',
      tags: ['普通员工'],
    });
    const session = db.createAuthSession(account.id, 60_000);

    expect(session.token.length).toBeGreaterThan(30);
    expect(db.getAccountBySession(session.token)?.id).toBe(account.id);
    expect(JSON.stringify(db.getDB().prepare('SELECT * FROM auth_sessions').all())).not.toContain(session.token);

    db.revokeAuthSession(session.token);
    expect(db.getAccountBySession(session.token)).toBeNull();
  });

  it('默认会话至少保持 30 天，重开桌面 App 时可继续自动登录', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'remember-me', password: 'remember-password', name: '保持登录用户',
    });
    const before = Date.now();
    const session = db.createAuthSession(account.id);
    expect(new Date(session.expiresAt).getTime() - before).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000);
  });
});

describe('短信验证码登录挑战', () => {
  it('验证码只存哈希；正确验证码仅能使用一次', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'sms01', password: 'sms-password-1', name: '短信用户', phone: '13800138000',
    });
    const issued = db.createSmsLoginChallenge(account.id, '042731', { now: 1_000_000 });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error('challenge should be issued');

    const stored = db.getDB().prepare('SELECT * FROM sms_login_challenges').get() as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain('042731');
    expect(db.verifySmsLoginChallenge(issued.challengeId, '042731', 1_001_000)).toMatchObject({
      ok: true,
      account: { id: account.id },
    });
    expect(db.verifySmsLoginChallenge(issued.challengeId, '042731', 1_002_000)).toMatchObject({
      ok: false,
      reason: 'used',
    });
  });

  it('5 分钟过期、连续输错 5 次锁定，并执行 60 秒/每小时 5 次发送限流', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'sms02', password: 'sms-password-2', name: '短信用户二', phone: '13900139000',
    });
    const expired = db.createSmsLoginChallenge(account.id, '111111', { now: 2_000_000 });
    expect(expired.ok).toBe(true);
    if (!expired.ok) throw new Error('challenge should be issued');
    expect(db.verifySmsLoginChallenge(expired.challengeId, '111111', 2_300_001)).toMatchObject({
      ok: false,
      reason: 'expired',
    });

    const challenge = db.createSmsLoginChallenge(account.id, '222222', { now: 2_360_001 });
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) throw new Error('challenge should be issued');
    for (let attempt = 4; attempt >= 0; attempt -= 1) {
      expect(db.verifySmsLoginChallenge(challenge.challengeId, '000000', 2_361_000)).toMatchObject({
        ok: false,
        reason: attempt === 0 ? 'locked' : 'invalid',
        attemptsRemaining: attempt,
      });
    }
    expect(db.verifySmsLoginChallenge(challenge.challengeId, '222222', 2_362_000)).toMatchObject({
      ok: false,
      reason: 'locked',
    });

    const cooldown = db.createSmsLoginChallenge(account.id, '333333', { now: 2_370_000 });
    expect(cooldown).toMatchObject({ ok: false, reason: 'cooldown' });
    for (const now of [2_421_000, 2_482_000, 2_543_000]) {
      expect(db.createSmsLoginChallenge(account.id, '333333', { now }).ok).toBe(true);
    }
    expect(db.createSmsLoginChallenge(account.id, '444444', { now: 2_604_000 })).toMatchObject({
      ok: false,
      reason: 'hourly_limit',
    });
  });
});

describe('IT 工单按标签真实投递', () => {
  it('只给同时具备 IT 与报修标签的 active 账号生成收件记录', async () => {
    const db = await freshDb();
    const requester = db.createAccount({
      username: 'staff01', password: 'staff-password', name: '员工一号', tags: ['普通员工'],
    });
    const itRepair = db.createAccount({
      username: 'it01', password: 'it-password-1', name: 'IT 一号', tags: ['IT', '报修'],
    });
    db.createAccount({
      username: 'it02', password: 'it-password-2', name: 'IT 二号', tags: ['IT'],
    });
    const disabled = db.createAccount({
      username: 'it03', password: 'it-password-3', name: '离职 IT', tags: ['IT', '报修'],
    });
    db.updateAccount(disabled.id, { status: 'disabled' });

    const ticket = db.createTicket({
      createdByAccountId: requester.id,
      title: '电脑无法联网',
      description: '办公 Wi-Fi 一直断开',
      targetTags: ['IT', '报修'],
    });

    expect(ticket.recipientCount).toBe(1);
    expect(ticket.recipients.map((item) => item.id)).toEqual([itRepair.id]);
    expect(db.listTicketInbox(itRepair.id).map((item) => item.title)).toEqual(['电脑无法联网']);
    expect(db.listTicketInbox(requester.id)).toEqual([]);
  });
});
