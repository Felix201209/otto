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

  it('只接受正确密码和 active 账号，错误时不区分账号不存在或密码错误', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'it01',
      password: 'correct-horse-123',
      name: 'IT 一号',
      tags: ['IT', '报修'],
    });

    expect(db.authenticateAccount('IT01', 'correct-horse-123')?.id).toBe(account.id);
    expect(db.authenticateAccount('it01', 'wrong-password')).toBeNull();
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
