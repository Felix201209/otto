/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * B2B 多租户数据边界：企业、轮换邀请码、账号隔离与真实 Token 用量。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DbModule = typeof import('./db.js');

let tmpDir: string;
let previousDir: string | undefined;
let previousPublicUrl: string | undefined;

async function freshDb(): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  process.env.OTTO_ENTERPRISE_PUBLIC_URL = 'https://join.otto.example';
  vi.resetModules();
  return import('./db.js');
}

beforeEach(() => {
  previousDir = process.env.OTTO_ENTERPRISE_DIR;
  previousPublicUrl = process.env.OTTO_ENTERPRISE_PUBLIC_URL;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-tenant-db-'));
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.OTTO_ENTERPRISE_DIR;
  else process.env.OTTO_ENTERPRISE_DIR = previousDir;
  if (previousPublicUrl === undefined) delete process.env.OTTO_ENTERPRISE_PUBLIC_URL;
  else process.env.OTTO_ENTERPRISE_PUBLIC_URL = previousPublicUrl;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('企业与 7 天有效邀请码', () => {
  it('管理员生成邀请码后 7 天失效，后台重新生成时旧码立即作废', async () => {
    const db = await freshDb();
    const epoch = Date.UTC(2026, 6, 14, 0, 0, 0);
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha', now: epoch });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta', now: epoch });

    const alphaInvite = db.issueOrganizationInvite(alpha.id, epoch);
    expect(alphaInvite.link)
      .toBe(`https://join.otto.example/enterprise/join/${alphaInvite.code}`);
    const sameWindow = db.getOrganizationInvite(alpha.id, epoch + 6 * 24 * 60 * 60 * 1_000);
    const betaInvite = db.issueOrganizationInvite(beta.id, epoch);

    expect(alphaInvite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(sameWindow?.code).toBe(alphaInvite.code);
    expect(betaInvite.code).not.toBe(alphaInvite.code);
    expect(alphaInvite.validHours).toBe(168);
    expect(db.resolveOrganizationInvite(alphaInvite.code, epoch + 6 * 24 * 60 * 60 * 1_000)?.id)
      .toBe(alpha.id);

    const expiredAt = epoch + 7 * 24 * 60 * 60 * 1_000;
    expect(db.resolveOrganizationInvite(alphaInvite.code, expiredAt)).toBeNull();
    expect(db.getOrganizationInvite(alpha.id, expiredAt)).toMatchObject({
      code: alphaInvite.code,
      status: 'expired',
    });

    const nextWindow = db.issueOrganizationInvite(alpha.id, expiredAt);
    expect(nextWindow.code).not.toBe(alphaInvite.code);
    expect(db.resolveOrganizationInvite(alphaInvite.code, expiredAt)).toBeNull();
    expect(db.resolveOrganizationInvite(nextWindow.code, expiredAt)?.id)
      .toBe(alpha.id);
  });
});

describe('企业账号与工单严格隔离', () => {
  it('管理员只能列出和修改本企业账号，标签工单不会投递到另一企业', async () => {
    const db = await freshDb();
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });
    const alphaStaff = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.staff', password: 'alpha-password', name: 'Alpha 员工',
    });
    const alphaIt = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.it', password: 'alpha-it-password', name: 'Alpha IT', tags: ['IT', '报修'],
    });
    const betaIt = db.createAccount({
      organizationId: beta.id,
      username: 'beta.it', password: 'beta-it-password', name: 'Beta IT', tags: ['IT', '报修'],
    });

    expect(db.listAccounts(alpha.id).map((account) => account.id).sort())
      .toEqual([alphaStaff.id, alphaIt.id].sort());
    expect(db.listAccounts(beta.id).map((account) => account.id)).toEqual([betaIt.id]);
    expect(() => db.updateAccount(betaIt.id, { name: '越权修改' }, alpha.id)).toThrow(/Account not found/);

    const ticket = db.createTicket({
      createdByAccountId: alphaStaff.id,
      title: '网络故障',
      description: '无法访问内网',
      targetTags: ['IT', '报修'],
    });
    expect(ticket.recipients.map((account) => account.id)).toEqual([alphaIt.id]);
    expect(db.listTicketInbox(betaIt.id)).toHaveLength(0);
  });
});

describe('首次注册与企业绑定', () => {
  it('短信挑战固化企业归属，验证码完成后账号自动进入该企业', async () => {
    const db = await freshDb();
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const issued = db.createSmsRegistrationChallenge('13800138000', '123456', alpha.id, {
      now: 1_000_000,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error('challenge should be issued');

    const verified = db.verifySmsRegistrationChallenge(issued.challengeId, '123456', 1_001_000);
    expect(verified).toEqual({ ok: true, phone: '+8613800138000', organizationId: alpha.id });
    if (!verified.ok) throw new Error('challenge should verify');
    const account = db.createSelfRegisteredAccount({
      organizationId: verified.organizationId,
      phone: verified.phone,
      name: '新员工',
      password: 'registered-password',
    });
    expect(account.organizationId).toBe(alpha.id);
    expect(account.organizationName).toBe('Alpha 科技');
    expect(db.listAccounts(alpha.id).map((item) => item.id)).toContain(account.id);
  });
});

describe('企业与用户 Token 用量', () => {
  it('真实用量按账号和企业汇总，同一消息重复上报不会重复计费', async () => {
    const db = await freshDb();
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });
    const a1 = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.one', password: 'alpha-one-password', name: 'Alpha 一号',
    });
    const a2 = db.createAccount({
      organizationId: alpha.id,
      username: 'alpha.two', password: 'alpha-two-password', name: 'Alpha 二号',
    });
    const b1 = db.createAccount({
      organizationId: beta.id,
      username: 'beta.one', password: 'beta-one-password', name: 'Beta 一号',
    });

    expect(db.recordTokenUsage({
      accountId: a1.id, sessionId: 'session-a', messageId: 'message-1', model: 'gpt-5.5',
      inputTokens: 120, outputTokens: 30, totalTokens: 150,
    })).toBe(true);
    expect(db.recordTokenUsage({
      accountId: a1.id, sessionId: 'session-a', messageId: 'message-1', model: 'gpt-5.5',
      inputTokens: 120, outputTokens: 30, totalTokens: 150,
    })).toBe(false);
    db.recordTokenUsage({
      accountId: a2.id, sessionId: 'session-b', messageId: 'message-2', model: 'deepseek-v4-pro',
      inputTokens: 50, outputTokens: 25, totalTokens: 75,
    });
    db.recordTokenUsage({
      accountId: b1.id, sessionId: 'session-c', messageId: 'message-3', model: 'gpt-5.5',
      inputTokens: 999, outputTokens: 1, totalTokens: 1_000,
    });

    const summary = db.getOrganizationUsageSummary(alpha.id, 30);
    expect(summary).toMatchObject({
      organizationId: alpha.id,
      totalInputTokens: 170,
      totalOutputTokens: 55,
      totalTokens: 225,
      requestCount: 2,
    });
    expect(summary.byAccount).toEqual([
      expect.objectContaining({ accountId: a1.id, totalTokens: 150, requestCount: 1 }),
      expect.objectContaining({ accountId: a2.id, totalTokens: 75, requestCount: 1 }),
    ]);
    expect(JSON.stringify(summary)).not.toContain(b1.id);
    expect(JSON.stringify(summary)).not.toContain('1000');
  });
});

describe('旧企业能力也必须遵守租户边界', () => {
  it('员工、任务、知识、报表与导出只返回指定企业的数据', async () => {
    const db = await freshDb();
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });

    db.createEmployee({ id: 'alpha-employee', organizationId: alpha.id, name: 'Alpha 员工', department: '研发部' });
    db.createEmployee({ id: 'beta-employee', organizationId: beta.id, name: 'Beta 员工', department: '研发部' });
    db.logTask({ employee_id: 'alpha-employee', task_type: 'alpha-task', duration_min: 10 });
    db.logTask({ employee_id: 'beta-employee', task_type: 'beta-task', duration_min: 20 });
    db.addKnowledge({ organizationId: alpha.id, department: '研发部', category: 'alpha', content: 'Alpha 私有知识' });
    db.addKnowledge({ organizationId: beta.id, department: '研发部', category: 'beta', content: 'Beta 私有知识' });

    expect(db.listEmployees(undefined, alpha.id).map((employee) => employee.id))
      .toEqual(['alpha-employee']);
    expect(db.getEmployee('beta-employee', alpha.id)).toBeNull();
    expect(db.getTaskHistory('alpha-employee', 20, alpha.id)).toHaveLength(1);
    expect(db.getTaskHistory('beta-employee', 20, alpha.id)).toHaveLength(0);
    expect(db.getKnowledge(undefined, undefined, alpha.id).map((item) => item.content))
      .toEqual(['Alpha 私有知识']);
    expect(db.searchKnowledge('私有知识', undefined, alpha.id).map((item) => item.content))
      .toEqual(['Alpha 私有知识']);
    expect(db.getReport(30, undefined, alpha.id)).toMatchObject({ totalTasks: 1, activeEmployees: 1 });

    const exported = db.exportAll(alpha.id);
    expect(exported.employees.map((employee: any) => employee.id)).toEqual(['alpha-employee']);
    expect(exported.taskLogs.map((task: any) => task.task_type)).toEqual(['alpha-task']);
    expect(exported.knowledge.map((item: any) => item.content)).toEqual(['Alpha 私有知识']);
    expect(JSON.stringify(exported)).not.toContain('Beta');
    expect(JSON.stringify(exported)).not.toContain('beta-');
  });

  it('部门邀请码与离职操作不能跨企业使用员工 ID', async () => {
    const db = await freshDb();
    const alpha = db.createOrganization({ name: 'Alpha 科技', slug: 'alpha' });
    const beta = db.createOrganization({ name: 'Beta 制造', slug: 'beta' });
    db.createEmployee({ id: 'beta-employee', organizationId: beta.id, name: 'Beta 员工' });

    const invite = db.createInviteCode('研发部', 'alpha-admin', 1, alpha.id);
    expect(db.validateInviteCode(invite, alpha.id)).toMatchObject({
      valid: true,
      department: '研发部',
      organizationId: alpha.id,
    });
    expect(db.offboardEmployee('beta-employee', alpha.id)).toBe(false);
    expect(db.getEmployee('beta-employee', beta.id)?.status).toBe('active');
  });
});
