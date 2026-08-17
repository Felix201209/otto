/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ENTERPRISE_IDENTITY_RECOVERING_MESSAGE,
  ProductWorkspaceStore,
  type AuthenticatedEnterpriseAccount,
} from './productWorkspaceStore.js';

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-product-workspace-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('ProductWorkspaceStore', () => {
  const authenticatedAccount = (
    patch: Partial<AuthenticatedEnterpriseAccount> = {},
  ): AuthenticatedEnterpriseAccount => ({
    id: 'central-account-1',
    organizationId: 'central-org-1',
    organizationName: '北辰中心企业',
    name: '林一',
    isAdmin: false,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    role: 'company_owner',
    tags: ['CEO', '超级管理员'],
    positionId: 'position-1',
    ...patch,
  });

  it('首次启动默认为个人版，并跨实例保留同一个用户身份', () => {
    const first = new ProductWorkspaceStore({ rootDir });
    const initial = first.snapshot();
    const reopened = new ProductWorkspaceStore({ rootDir }).snapshot();

    expect(initial.context).toMatchObject({ edition: 'personal', role: 'personal' });
    expect(initial.context.capabilities).toContain('model:byok');
    expect(initial.context.capabilities).not.toContain('organization:read');
    expect(reopened.context.userId).toBe(initial.context.userId);
  });

  it('管理者建档后持久化六部门框架和 CEO 身份', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const snapshot = store.configureManager({
      managerName: '陈晨',
      companyName: '北辰科技',
      industry: '企业软件',
      employeeScale: '51-200人',
    });

    expect(snapshot.context).toMatchObject({ edition: 'enterprise', role: 'company_owner' });
    expect(snapshot.managerWorkspace?.profile).toMatchObject({
      managerName: '陈晨',
      companyName: '北辰科技',
    });
    expect(snapshot.managerWorkspace?.organization.departments.map((item) => item.name)).toEqual([
      'CEO 办公室',
      '产品与研发部',
      '市场部',
      '销售与客户成功部',
      '财务部',
      '人力与行政部',
    ]);
    expect(new ProductWorkspaceStore({ rootDir }).snapshot()).toEqual(snapshot);
  });

  it('职位链接签名可验证、只能本地核销一次，并让成员进入指定岗位', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const owner = store.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    const department = owner.managerWorkspace!.organization.departments[1];
    const position = owner.managerWorkspace!.organization.positions.find(
      (item) => item.departmentId === department.id,
    )!;
    const invite = store.issueInvite({
      kind: 'position',
      departmentId: department.id,
      positionId: position.id,
      expiresInSeconds: 3600,
    });

    expect(invite.link.startsWith('otto://enterprise/join?')).toBe(true);
    expect(invite.link).not.toContain('北辰科技');
    const joined = store.acceptInvite(invite.link, {
      userId: 'member-1',
      displayName: '林一',
    });
    expect(joined.context).toMatchObject({
      edition: 'enterprise',
      role: 'member',
      companyId: owner.context.companyId,
      departmentId: department.id,
      positionId: position.id,
    });
    expect(() =>
      store.acceptInvite(invite.link, { userId: 'member-2', displayName: '林二' }),
    ).toThrow(/已使用/);
  });

  it('renderer 快照不包含邀请私钥，企业成员不能签发链接', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const snapshot = store.snapshot();
    const onDisk = fs.readFileSync(path.join(rootDir, 'product-workspace.json'), 'utf8');

    expect(JSON.stringify(snapshot)).not.toMatch(/privateKey|BEGIN PRIVATE KEY/);
    expect(onDisk).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(() => store.issueInvite({ kind: 'company' })).toThrow(/权限/);
  });

  it('个人和企业可以来回切换，个人 API 配置不会被删除', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const personalUserId = store.snapshot().context.userId;
    store.configureManager({ managerName: '陈晨', companyName: '北辰科技' });
    const personal = store.switchToPersonal();

    expect(personal.context).toMatchObject({
      edition: 'personal',
      role: 'personal',
      userId: personalUserId,
    });
    expect(personal.managerWorkspace?.profile.companyName).toBe('北辰科技');
  });

  it('中心认证身份只按 isAdmin 映射权限，并以内存覆盖返回当前组织与成员', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const local = store.configureManager({
      managerName: '本机 CEO',
      companyName: '本机企业',
    });

    const member = store.setAuthenticatedEnterpriseAccount(authenticatedAccount());
    expect(member.context).toMatchObject({
      edition: 'enterprise',
      role: 'member',
      userId: 'central-account-1',
      displayName: '林一',
      companyId: 'central-org-1',
      positionId: 'position-1',
    });
    expect(member.context.capabilities).not.toContain('organization:manage');
    expect(member.context.capabilities).not.toContain('invite:issue');
    expect(member.managerWorkspace).toBeUndefined();
    expect(member.members).toEqual([
      expect.objectContaining({
        userId: 'central-account-1',
        displayName: '林一',
        companyId: 'central-org-1',
        role: 'member',
      }),
    ]);
    expect(member.authenticatedOrganization).toEqual({
      id: 'central-org-1',
      name: '北辰中心企业',
    });

    const admin = store.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({ isAdmin: true, role: 'member', tags: [] }),
    );
    expect(admin.context.role).toBe('company_admin');
    expect(admin.context.capabilities).toContain('organization:manage');

    store.setAuthenticatedEnterpriseAccount(null);
    expect(store.snapshot()).toEqual(local);
    expect(new ProductWorkspaceStore({ rootDir }).snapshot()).toEqual(local);
  });

  it('中心认证快照包含 active 同事目录，且当前账号字段始终以认证账号为准', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const snapshot = store.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({
        department: '产品与研发部',
        positionTitle: '研发工程师',
        organizationMembers: [
          {
            id: 'central-account-1',
            username: 'stale-self',
            name: '目录中的旧姓名',
            role: 'member',
            department: '旧部门',
            positionId: 'old-position',
            positionTitle: '旧职位',
            isAdmin: true,
            status: 'active',
          },
          {
            id: 'central-account-2',
            username: 'staff02',
            name: '周二',
            role: 'member',
            department: '销售部',
            positionId: 'position-sales',
            positionTitle: '销售经理',
            isAdmin: false,
            status: 'active',
          },
          {
            id: 'central-account-disabled',
            username: 'disabled',
            name: '停用员工',
            role: 'member',
            department: null,
            positionId: null,
            positionTitle: null,
            isAdmin: false,
            status: 'disabled',
          },
        ],
      }),
    );

    expect(snapshot.members).toEqual([
      expect.objectContaining({
        userId: 'central-account-1',
        displayName: '林一',
        departmentName: '产品与研发部',
        positionTitle: '研发工程师',
        role: 'member',
      }),
      expect.objectContaining({
        userId: 'central-account-2',
        username: 'staff02',
        displayName: '周二',
        departmentName: '销售部',
        positionTitle: '销售经理',
        role: 'member',
      }),
    ]);
    expect(snapshot.members).toHaveLength(2);
  });

  it('中心身份指纹包含目录，目录成员变化会触发运行时身份刷新', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    store.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({ organizationMembers: [] }),
    );
    const first = store.enterpriseIdentityState().fingerprint;

    store.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({
        organizationMembers: [
          {
            id: 'central-account-2',
            username: 'staff02',
            name: '周二',
            role: 'member',
            department: '销售部',
            positionId: null,
            positionTitle: '销售经理',
            isAdmin: false,
            status: 'active',
          },
        ],
      }),
    );

    expect(store.enterpriseIdentityState().fingerprint).not.toBe(first);
  });

  it('短期模型网关凭据只保存在内存且不会进入 renderer 或磁盘快照', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const accessToken = 'edge-short-token-at-least-thirty-two-characters';
    store.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({
        managedModelGateway: {
          baseUrl: 'https://edge.otto.test/v1/',
          accessToken,
          expiresAt: '2099-01-01T00:05:00.000Z',
          allowedModels: ['otto:deepseek', 'otto:qwen'],
        },
      }),
    );

    expect(store.enterpriseIdentityState()).toMatchObject({
      status: 'active',
      account: {
        managedModelGateway: {
          baseUrl: 'https://edge.otto.test/v1',
          accessToken,
          allowedModels: ['otto:deepseek', 'otto:qwen'],
        },
      },
    });
    expect(JSON.stringify(store.snapshot())).not.toContain(accessToken);
    expect(
      fs.readFileSync(path.join(rootDir, 'product-workspace.json'), 'utf8'),
    ).not.toContain(accessToken);
  });

  it('拒绝过期、非 HTTPS 或越界的模型网关凭据', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    const validToken = 'edge-short-token-at-least-thirty-two-characters';

    expect(() =>
      store.setAuthenticatedEnterpriseAccount(
        authenticatedAccount({
          managedModelGateway: {
            baseUrl: 'http://edge.otto.test/v1',
            accessToken: validToken,
            expiresAt: '2099-01-01T00:05:00.000Z',
            allowedModels: ['otto:deepseek'],
          },
        }),
      ),
    ).toThrow(/安全要求/);
    expect(() =>
      store.setAuthenticatedEnterpriseAccount(
        authenticatedAccount({
          managedModelGateway: {
            baseUrl: 'https://edge.otto.test/v1',
            accessToken: validToken,
            expiresAt: '2000-01-01T00:00:00.000Z',
            allowedModels: ['otto:deepseek'],
          },
        }),
      ),
    ).toThrow(/已过期/);
    expect(() =>
      store.setAuthenticatedEnterpriseAccount(
        authenticatedAccount({
          managedModelGateway: {
            baseUrl: 'https://edge.otto.test/v1',
            accessToken: validToken,
            expiresAt: '2099-01-01T00:05:00.000Z',
            allowedModels: ['custom:openai:attacker'],
          },
        }),
      ),
    ).toThrow(/无效/);
  });

  it('中心认证身份存在时拒绝所有本机企业身份变更', () => {
    const store = new ProductWorkspaceStore({ rootDir });
    store.setAuthenticatedEnterpriseAccount(authenticatedAccount());

    expect(() =>
      store.configureManager({ managerName: '伪造 CEO', companyName: '伪造企业' }),
    ).toThrow(/中心认证身份/);
    expect(() => store.switchToPersonal()).toThrow(/中心认证身份/);
    expect(() =>
      store.acceptInvite('otto://enterprise/join', {
        userId: 'attacker',
        displayName: '攻击者',
      }),
    ).toThrow(/中心认证身份/);
    expect(() => store.acceptCompanyLink('otto://enterprise/join')).toThrow(
      /中心认证身份/,
    );
    expect(() => store.issueInvite({ kind: 'company' })).toThrow(/中心认证身份/);
  });

  it('中心身份租约必须有效，过期后快照与本机身份变更都 fail closed', () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    const store = new ProductWorkspaceStore({
      rootDir,
      now: () => now,
    });

    expect(() =>
      store.setAuthenticatedEnterpriseAccount(
        authenticatedAccount({ leaseExpiresAt: 'not-a-date' }),
      ),
    ).toThrow(/租约/);
    expect(() =>
      store.setAuthenticatedEnterpriseAccount(
        authenticatedAccount({ leaseExpiresAt: now.toISOString() }),
      ),
    ).toThrow(/租约/);

    store.setAuthenticatedEnterpriseAccount(
      authenticatedAccount({ leaseExpiresAt: '2026-07-19T00:01:00.000Z' }),
    );
    expect(store.enterpriseIdentityState()).toMatchObject({
      status: 'active',
      account: {
        id: 'central-account-1',
        organizationId: 'central-org-1',
      },
    });

    now = new Date('2026-07-19T00:01:00.001Z');
    expect(store.enterpriseIdentityState().status).toBe('expired');
    expect(() => store.snapshot()).toThrow(ENTERPRISE_IDENTITY_RECOVERING_MESSAGE);
    expect(() =>
      store.configureManager({ managerName: '攻击者', companyName: '伪造企业' }),
    ).toThrow(ENTERPRISE_IDENTITY_RECOVERING_MESSAGE);

    store.setAuthenticatedEnterpriseAccount(null);
    expect(store.snapshot().context.edition).toBe('personal');
  });

  it('总公司签发引入子公司链接，子公司输入后持久化父子关系且不改变自身 CEO 身份', () => {
    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-parent-workspace-'));
    const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-child-workspace-'));
    try {
      const parent = new ProductWorkspaceStore({ rootDir: parentRoot });
      const child = new ProductWorkspaceStore({ rootDir: childRoot });
      const parentState = parent.configureManager({ managerName: '总公司 CEO', companyName: '北辰集团' });
      const childState = child.configureManager({ managerName: '子公司 CEO', companyName: '星海科技' });
      const link = parent.issueInvite({
        kind: 'company_link',
        direction: 'parent_invites_child',
        targetCompanyId: childState.context.companyId,
        expiresInSeconds: 3600,
      });

      const accepted = child.acceptCompanyLink(link.link);
      expect(accepted.context).toMatchObject({
        role: 'company_owner',
        companyId: childState.context.companyId,
      });
      expect(accepted.managerWorkspace?.organization.rootCompanyId).toBe(parentState.context.companyId);
      expect(accepted.managerWorkspace?.organization.companies).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: parentState.context.companyId }),
        expect.objectContaining({
          id: childState.context.companyId,
          parentCompanyId: parentState.context.companyId,
        }),
      ]));
      expect(new ProductWorkspaceStore({ rootDir: childRoot }).snapshot()).toEqual(accepted);
      expect(() => child.acceptCompanyLink(link.link)).toThrow(/已使用/);
    } finally {
      fs.rmSync(parentRoot, { recursive: true, force: true });
      fs.rmSync(childRoot, { recursive: true, force: true });
    }
  });

  it('子公司签发接入总公司请求，总公司输入后将子公司挂到自己下方', () => {
    const parentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-parent-workspace-'));
    const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-child-workspace-'));
    try {
      const parent = new ProductWorkspaceStore({ rootDir: parentRoot });
      const child = new ProductWorkspaceStore({ rootDir: childRoot });
      const parentState = parent.configureManager({ managerName: '总公司 CEO', companyName: '北辰集团' });
      const childState = child.configureManager({ managerName: '子公司 CEO', companyName: '星海科技' });
      const link = child.issueInvite({
        kind: 'company_link',
        direction: 'child_requests_parent',
        targetCompanyId: parentState.context.companyId,
      });

      const accepted = parent.acceptCompanyLink(link.link);
      expect(accepted.managerWorkspace?.organization.rootCompanyId).toBe(parentState.context.companyId);
      expect(accepted.managerWorkspace?.organization.companies).toContainEqual(
        expect.objectContaining({
          id: childState.context.companyId,
          parentCompanyId: parentState.context.companyId,
        }),
      );
    } finally {
      fs.rmSync(parentRoot, { recursive: true, force: true });
      fs.rmSync(childRoot, { recursive: true, force: true });
    }
  });

  it('父子公司接入只允许 CEO，并校验用途、签名、过期时间和目标企业', () => {
    let current = new Date('2026-07-11T12:00:00.000Z');
    const issuerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-issuer-workspace-'));
    const receiverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-receiver-workspace-'));
    const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-wrong-workspace-'));
    try {
      const issuer = new ProductWorkspaceStore({ rootDir: issuerRoot, now: () => current });
      const receiver = new ProductWorkspaceStore({ rootDir: receiverRoot, now: () => current });
      const wrong = new ProductWorkspaceStore({ rootDir: wrongRoot, now: () => current });
      issuer.configureManager({ managerName: '签发人', companyName: '签发企业' });
      const receiverState = receiver.configureManager({ managerName: '接收人', companyName: '接收企业' });
      wrong.configureManager({ managerName: '其他人', companyName: '其他企业' });

      const companyInvite = issuer.issueInvite({ kind: 'company' });
      expect(() => receiver.acceptCompanyLink(companyInvite.link)).toThrow(/用途|类型/);

      const targeted = issuer.issueInvite({
        kind: 'company_link',
        direction: 'parent_invites_child',
        targetCompanyId: receiverState.context.companyId,
      });
      expect(() => wrong.acceptCompanyLink(targeted.link)).toThrow(/目标企业/);

      const tampered = new URL(targeted.link);
      const token = tampered.searchParams.get('token')!;
      tampered.searchParams.set('token', `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`);
      expect(() => receiver.acceptCompanyLink(tampered.toString())).toThrow(/签名/);

      const expiring = issuer.issueInvite({
        kind: 'company_link',
        direction: 'parent_invites_child',
        targetCompanyId: receiverState.context.companyId,
        expiresInSeconds: 1,
      });
      current = new Date('2026-07-11T12:00:02.000Z');
      expect(() => receiver.acceptCompanyLink(expiring.link)).toThrow(/过期/);

      receiver.switchToPersonal();
      expect(() => receiver.acceptCompanyLink(targeted.link)).toThrow(/CEO|企业管理者/);
    } finally {
      fs.rmSync(issuerRoot, { recursive: true, force: true });
      fs.rmSync(receiverRoot, { recursive: true, force: true });
      fs.rmSync(wrongRoot, { recursive: true, force: true });
    }
  });
});
