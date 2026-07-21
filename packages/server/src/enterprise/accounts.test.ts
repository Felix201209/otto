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

describe('个人注册与账号删除', () => {
  it('无企业邀请码注册时创建独立个人空间，不与其他个人账号共享组织数据', async () => {
    const db = await freshDb();
    const first = db.createPersonalRegisteredAccount({
      phone: '13800138000',
      name: '个人用户一',
      password: 'personal-password-1',
    });
    const second = db.createPersonalRegisteredAccount({
      phone: '13900139000',
      name: '个人用户二',
      password: 'personal-password-2',
    });

    expect(first).toMatchObject({
      accountType: 'personal',
      name: '个人用户一',
      isAdmin: false,
    });
    expect(second.accountType).toBe('personal');
    expect(first.organizationId).not.toBe(second.organizationId);
    expect(db.listAccounts(first.organizationId).map((account) => account.id)).toEqual([first.id]);
    expect(db.listAccounts(second.organizationId).map((account) => account.id)).toEqual([second.id]);
  });

  it('逻辑删除账号后立刻撤销会话、移出目录并释放手机号，同时保留审计所需墓碑', async () => {
    const db = await freshDb();
    const admin = db.createAccount({
      username: 'delete-admin',
      password: 'delete-admin-password',
      name: '删除管理员',
      isAdmin: true,
    });
    const staff = db.createAccount({
      username: 'delete-staff',
      password: 'delete-staff-password',
      name: '待删除员工',
      phone: '13800138000',
      feishuOpenId: 'ou_deleted_staff',
    });
    const worker = db.createAccount({
      username: 'delete-ticket-worker',
      password: 'delete-ticket-worker-password',
      name: '历史工单处理人',
      tags: ['IT', '报修'],
    });
    const historicalTicket = db.createTicket({
      createdByAccountId: staff.id,
      serviceId: 'it',
      title: '删除前创建的工单',
      description: '账号删除后仍需保留历史',
      targetTags: ['IT', '报修'],
    });
    const session = db.createAuthSession(staff.id);

    expect(db.deleteAccount(staff.id, admin.organizationId, admin.id)).toMatchObject({
      id: staff.id,
      deleted: true,
    });
    expect(db.getAccount(staff.id, admin.organizationId)).toBeNull();
    expect(db.listAccounts(admin.organizationId).map((account) => account.id)).not.toContain(staff.id);
    expect(db.getAccountBySession(session.token)).toBeNull();
    expect(db.findAccountByPhone('13800138000')).toBeNull();

    const tombstone = db.getDB().prepare(
      'SELECT username, phone, feishu_open_id, name, is_admin, status, deleted_at FROM accounts WHERE id = ?',
    ).get(staff.id) as Record<string, unknown>;
    expect(tombstone).toMatchObject({
      phone: null,
      feishu_open_id: null,
      name: '已删除账号',
      is_admin: 0,
      status: 'disabled',
    });
    expect(tombstone.username).toBe(`deleted_${staff.id}`);
    expect(tombstone.deleted_at).toEqual(expect.any(String));
    expect(db.listTicketInbox(worker.id)).toContainEqual(expect.objectContaining({
      id: historicalTicket.id,
      creator: { id: staff.id, name: '已删除账号', username: '已删除账号' },
    }));
    expect(db.listTicketsForAccount(admin.id).map((ticket) => ticket.id))
      .toContain(historicalTicket.id);
  });

  it('拒绝管理员删除自己、跨企业账号或企业最后一名可登录管理员', async () => {
    const db = await freshDb();
    const admin = db.createAccount({
      username: 'sole-admin',
      password: 'sole-admin-password',
      name: '唯一管理员',
      isAdmin: true,
    });
    const otherOrganization = db.createOrganization({ name: '其他企业' });
    const outsider = db.createAccount({
      organizationId: otherOrganization.id,
      username: 'other-staff',
      password: 'other-staff-password',
      name: '其他企业员工',
    });

    expect(() => db.deleteAccount(admin.id, admin.organizationId, admin.id))
      .toThrow('不能删除当前登录账号');
    expect(() => db.deleteAccount(outsider.id, admin.organizationId, admin.id))
      .toThrow('Account not found');

    const platformActor = 'platform-admin';
    expect(() => db.deleteAccount(admin.id, admin.organizationId, platformActor))
      .toThrow('企业至少需要保留一名可登录管理员');
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

  it('已加入园区且关闭园区服务时，IT 工单仍只投递给本企业 IT', async () => {
    const db = await freshDb();
    const parkOrganization = db.createOrganization({ name: '园区运营方', slug: 'it-route-park' });
    const parkAdmin = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'it-route-park-admin',
      password: 'park-admin-password',
      name: '园区管理员',
      isAdmin: true,
    });
    const tenantOrganization = db.createOrganization({ name: '园区入驻企业', slug: 'it-route-tenant' });
    const tenantAdmin = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'it-route-tenant-admin',
      password: 'tenant-admin-password',
      name: '企业管理员',
      isAdmin: true,
    });
    const requester = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'it-route-requester',
      password: 'requester-password',
      name: '报修员工',
    });
    const localIt = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'it-route-local-it',
      password: 'local-it-password',
      name: '本企业 IT',
      tags: ['IT', '报修'],
    });
    const park = db.createPark({
      adminOrganizationId: parkOrganization.id,
      actorAccountId: parkAdmin.id,
      name: '测试园区',
    });
    const invite = db.issueParkInvite({
      parkId: park.id,
      actorAccountId: parkAdmin.id,
    });
    db.joinOrganizationToPark({
      organizationId: tenantOrganization.id,
      actorAccountId: tenantAdmin.id,
      code: invite.code,
    });
    db.updateOrganizationFeatures(tenantOrganization.id, { park_service: false });

    const ticket = db.createTicket({
      createdByAccountId: requester.id,
      serviceId: 'it',
      title: '电脑无法开机',
      description: '按下电源键没有反应',
      targetTags: ['IT', '报修'],
    });

    expect(ticket.parkId).toBeNull();
    expect(ticket.recipients).toEqual([{ id: localIt.id, name: '本企业 IT' }]);
    expect(db.listTicketInbox(localIt.id).map((item) => item.id)).toContain(ticket.id);
    expect(db.listTicketInbox(parkAdmin.id).map((item) => item.id)).not.toContain(ticket.id);
  });
});

describe('园区服务服务器流程', () => {
  it('未加入产业园或任一侧关闭园区服务时拒绝新建园区工单', async () => {
    const db = await freshDb();
    const standalone = db.createAccount({
      username: 'standalone-park-user',
      password: 'standalone-password',
      name: '未入园员工',
    });
    expect(() => db.createTicket({
      createdByAccountId: standalone.id,
      serviceId: 'repair',
      title: '空调报修',
      description: '未入园请求',
    })).toThrow('企业尚未加入产业园');

    const parkOrganization = db.createOrganization({ name: '开关园区方', slug: 'create-guard-park' });
    const parkAdmin = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'create-guard-park-admin',
      password: 'park-admin-password',
      name: '园区管理员',
      isAdmin: true,
    });
    const tenantOrganization = db.createOrganization({ name: '开关入驻方', slug: 'create-guard-tenant' });
    const tenantAdmin = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'create-guard-tenant-admin',
      password: 'tenant-admin-password',
      name: '企业管理员',
      isAdmin: true,
    });
    const tenantMember = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'create-guard-tenant-member',
      password: 'tenant-member-password',
      name: '企业员工',
    });
    const park = db.createPark({
      adminOrganizationId: parkOrganization.id,
      actorAccountId: parkAdmin.id,
      name: '开关测试园区',
    });
    const invite = db.issueParkInvite({ parkId: park.id, actorAccountId: parkAdmin.id });
    db.joinOrganizationToPark({
      organizationId: tenantOrganization.id,
      actorAccountId: tenantAdmin.id,
      code: invite.code,
    });
    db.updateOrganizationFeatures(parkOrganization.id, { park_service: false });

    expect(() => db.createTicket({
      createdByAccountId: tenantMember.id,
      serviceId: 'repair',
      title: '空调报修',
      description: '园区管理方已关闭服务',
    })).toThrow('园区服务功能已由管理员关闭');
  });

  it('园区邀请码可让整个企业加入，并把跨企业报修投递给园区专员', async () => {
    const db = await freshDb();
    const parkOrganization = db.createOrganization({ name: '宏创园区运营方', slug: 'hongchuang-park' });
    const parkAdmin = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'park-owner-admin',
      password: 'park-owner-password',
      name: '园区管理员',
      isAdmin: true,
    });
    const specialist = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'park-repair-specialist',
      password: 'park-repair-password',
      name: '园区维修专员',
    });
    const tenantOrganization = db.createOrganization({ name: '入驻企业', slug: 'tenant-company' });
    const tenantAdmin = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'tenant-admin',
      password: 'tenant-admin-password',
      name: '企业管理员',
      isAdmin: true,
    });
    const tenantMember = db.createAccount({
      organizationId: tenantOrganization.id,
      username: 'tenant-member',
      password: 'tenant-member-password',
      name: '报修员工',
    });

    const park = db.createPark({
      adminOrganizationId: parkOrganization.id,
      actorAccountId: parkAdmin.id,
      name: '宏创园区',
      brandName: '宏创园区服务',
    });
    expect(db.listParkServices(park.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'repair', name: '物业报修', enabled: true }),
      expect.objectContaining({ id: 'meeting-room', name: '会议室预约', enabled: true }),
    ]));
    const invite = db.issueParkInvite({
      parkId: park.id,
      actorAccountId: parkAdmin.id,
      maxUses: 3,
    });
    expect(db.joinOrganizationToPark({
      organizationId: tenantOrganization.id,
      actorAccountId: tenantAdmin.id,
      code: invite.code,
    }).id).toBe(park.id);
    const fallbackTicket = db.createTicket({
      createdByAccountId: tenantMember.id,
      serviceId: 'meeting-room',
      title: '会议室预约',
      description: '需要预约明天下午会议室',
      targetTags: ['客服人员'],
    });
    expect(fallbackTicket.recipients).toEqual([{ id: parkAdmin.id, name: '园区管理员' }]);
    expect(db.listTicketInbox(parkAdmin.id).map((item) => item.id)).toContain(fallbackTicket.id);
    db.setParkServiceSpecialist({
      parkId: park.id,
      actorAccountId: parkAdmin.id,
      serviceId: 'repair',
      accountId: specialist.id,
    });

    const ticket = db.createTicket({
      createdByAccountId: tenantMember.id,
      serviceId: 'repair',
      title: '空调无法启动',
      description: 'A 座 3 层空调无响应',
      targetTags: ['维修工作人员'],
    });
    expect(ticket.recipients).toEqual([{ id: specialist.id, name: '园区维修专员' }]);
    expect(db.listTicketInbox(specialist.id)[0]).toMatchObject({ id: ticket.id, isRecipient: true });
    expect(db.updateTicket({ ticketId: ticket.id, accountId: specialist.id, action: 'accept' }).status)
      .toBe('维修中');
  });

  it('六类申请可投递给多名客服，并只向有权限的人返回最少必要资料', async () => {
    const db = await freshDb();
    const admin = db.createAccount({
      username: 'park-admin', password: 'park-admin-password', name: '园区管理员', isAdmin: true,
    });
    const requester = db.createAccount({
      username: 'park-user', password: 'park-user-password', name: '申请人', tags: ['普通成员'],
    });
    const first = db.createAccount({
      username: 'service-1', password: 'service-password-1', name: '客服一号',
      phone: '13800138001', feishuOpenId: 'ou_service_1', tags: ['客服人员'],
    });
    const second = db.createAccount({
      username: 'service-2', password: 'service-password-2', name: '客服二号',
      phone: '13800138002', feishuOpenId: 'ou_service_2', tags: ['客服人员'],
    });
    const park = db.createPark({
      adminOrganizationId: admin.organizationId,
      actorAccountId: admin.id,
      name: '自营园区',
    });
    for (const specialist of [first, second]) {
      db.setParkServiceSpecialist({
        parkId: park.id,
        actorAccountId: admin.id,
        serviceId: 'renovation',
        accountId: specialist.id,
      });
    }
    const ticket = db.createTicket({
      createdByAccountId: requester.id,
      serviceId: 'renovation',
      title: '装修管理 · A 座 1203 室',
      description: '装修区域：A 座 1203 室',
      targetTags: ['客服人员'],
      formData: { area: 'A 座 1203 室', content: '办公室装修' },
    });

    expect(ticket).toMatchObject({
      serviceId: 'renovation',
      recipientCount: 2,
      formData: { area: 'A 座 1203 室', content: '办公室装修' },
    });
    expect(ticket.recipients.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(ticket.recipients[0]).not.toHaveProperty('phone');
    expect(ticket.creator).not.toHaveProperty('phone');

    const workerView = db.getTicketForAccount(ticket.id, first.id)!;
    expect(workerView.isRecipient).toBe(true);
    expect(workerView.recipients).toEqual([]);
    expect(workerView.notifications).toEqual([]);

    const deliveryAccounts = db.getTicketNotificationRecipients(ticket.id);
    expect(deliveryAccounts.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(deliveryAccounts.find((item) => item.id === first.id)).toMatchObject({
      phone: '+8613800138001', feishuOpenId: 'ou_service_1',
    });

    db.recordTicketNotification({
      ticketId: ticket.id,
      recipientAccountId: first.id,
      channel: 'feishu',
      event: 'ticket_created',
      status: 'sent',
    });
    expect(db.getTicketForAccount(ticket.id, requester.id)!.notifications).toEqual([]);
    expect(db.getTicketForAccount(ticket.id, admin.id)!.notifications).toHaveLength(1);
  });

  it('非报修申请使用“处理中”，完成后由提交人确认', async () => {
    const db = await freshDb();
    const admin = db.createAccount({
      username: 'meeting-admin', password: 'meeting-admin-password', name: '园区管理员', isAdmin: true,
    });
    const requester = db.createAccount({
      username: 'meeting-user', password: 'meeting-user-password', name: '会议申请人',
    });
    const worker = db.createAccount({
      username: 'meeting-service', password: 'meeting-service-password', name: '园区客服', tags: ['客服人员'],
    });
    const park = db.createPark({
      adminOrganizationId: admin.organizationId,
      actorAccountId: admin.id,
      name: '会议园区',
    });
    db.setParkServiceSpecialist({
      parkId: park.id,
      actorAccountId: admin.id,
      serviceId: 'meeting-room',
      accountId: worker.id,
    });
    const ticket = db.createTicket({
      createdByAccountId: requester.id,
      serviceId: 'meeting-room',
      title: '会议室预约 · 7 月 21 日',
      description: '14:00 至 16:00，10 人',
      targetTags: ['客服人员'],
      formData: { date: '2026-07-21', time: '14:00–16:00', attendees: '10' },
    });

    expect(db.updateTicket({ ticketId: ticket.id, accountId: worker.id, action: 'accept' }).status)
      .toBe('处理中');
    expect(db.updateTicket({ ticketId: ticket.id, accountId: worker.id, action: 'complete' }).status)
      .toBe('待验收');
    expect(db.updateTicket({ ticketId: ticket.id, accountId: requester.id, action: 'confirm' }).status)
      .toBe('已完成');
  });

  it('公告可发给全部成员，实名问卷每人只能提交一次且不能修改', async () => {
    const db = await freshDb();
    const admin = db.createAccount({
      username: 'survey-admin', password: 'survey-admin-password', name: '园区管理员', isAdmin: true,
    });
    const user = db.createAccount({
      username: 'survey-user', password: 'survey-user-password', name: '实名员工',
    });
    const other = db.createAccount({
      username: 'survey-other', password: 'survey-other-password', name: '其他员工',
    });

    const announcement = db.createParkPublication({
      createdByAccountId: admin.id,
      kind: 'announcement',
      title: '下午临时停水通知',
      body: '今天 14:00–16:00 园区停水，请提前准备。',
    });
    expect(announcement.recipientCount).toBe(3);
    expect(db.listParkPublications(user.id)[0]).toMatchObject({
      title: '下午临时停水通知', readAt: null,
    });
    expect(db.markParkPublicationRead(announcement.publication.id, user.id).readAt).toBeTruthy();

    const survey = db.createParkPublication({
      createdByAccountId: admin.id,
      kind: 'satisfaction',
      title: '第三季度满意度调查',
      body: '请评价本季度园区服务。',
      recipientAccountId: user.id,
    });
    expect(survey.recipientCount).toBe(1);
    expect(db.listParkPublications(other.id).some((item) => item.id === survey.publication.id)).toBe(false);
    const submitted = db.submitParkSurvey(survey.publication.id, user.id, {
      score: '4', focus: '网络响应', feedback: '希望加强巡检', submittedBy: '试图冒用别人的姓名',
    });
    expect(submitted).toMatchObject({
      submittedAt: expect.any(String),
      responseData: { score: '4', focus: '网络响应', feedback: '希望加强巡检', submittedBy: '实名员工' },
    });
    expect(db.listParkSurveyResults(admin.id)[0]).toMatchObject({
      recipientCount: 1,
      submittedCount: 1,
      responses: [expect.objectContaining({
        accountName: '实名员工',
        responseData: expect.objectContaining({ submittedBy: '实名员工' }),
      })],
    });
    expect(() => db.submitParkSurvey(survey.publication.id, user.id, {
      score: '5', feedback: '尝试修改', submittedBy: user.name,
    })).toThrow(/已经提交|不能重复修改/);
  });
});
