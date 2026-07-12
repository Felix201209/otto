/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CREDIT_ECONOMICS,
  Ed25519InviteService,
  ModelCreditCatalog,
  ScheduleBook,
  applyCompanyLinkRedemption,
  buildManagerWorkspace,
  createEnterpriseContext,
  createPersonalContext,
  creditsToDeepSeekBudgetFen,
  purchaseCreditsFromFen,
  type SignedInvitePayload,
} from './productWorkspace.js';

describe('product context', () => {
  it('personal context only exposes the base Otto, BYOK and self-learning skills', () => {
    const context = createPersonalContext({ userId: 'u-personal', displayName: 'Felix' });

    expect(context).toMatchObject({
      edition: 'personal',
      role: 'personal',
      userId: 'u-personal',
      displayName: 'Felix',
    });
    expect(context.companyId).toBeUndefined();
    expect(context.capabilities).toEqual(
      expect.arrayContaining(['agent:base', 'model:byok', 'skill:built-in', 'skill:auto-create']),
    );
    expect(context.capabilities).not.toContain('organization:read');
  });

  it('enterprise UI context still uses BYOK during internal testing', () => {
    const owner = createEnterpriseContext({
      userId: 'u-owner',
      displayName: '王总',
      companyId: 'company-a',
      role: 'company_owner',
    });
    const member = createEnterpriseContext({
      userId: 'u-member',
      displayName: '小李',
      companyId: 'company-a',
      role: 'member',
      departmentId: 'dept-rd',
      positionId: 'pos-fe',
    });

    expect(owner.capabilities).toEqual(
      expect.arrayContaining(['model:byok', 'organization:read', 'organization:manage', 'invite:issue']),
    );
    expect(owner.capabilities).not.toContain('model:otto');
    expect(member).toMatchObject({
      edition: 'enterprise',
      companyId: 'company-a',
      departmentId: 'dept-rd',
      positionId: 'pos-fe',
    });
    expect(member.capabilities).toContain('organization:read');
    expect(member.capabilities).not.toContain('organization:manage');
  });
});

describe('manager profile and organization framework', () => {
  it('creates a company, four basic departments and an occupied CEO position', () => {
    const workspace = buildManagerWorkspace({
      managerId: 'manager-1',
      managerName: '陈总',
      companyName: '星海科技',
      industry: '企业服务',
      employeeScale: '20-99',
    });

    expect(workspace.context).toMatchObject({
      edition: 'enterprise',
      role: 'company_owner',
      userId: 'manager-1',
      companyId: workspace.organization.rootCompanyId,
    });
    expect(workspace.profile).toMatchObject({
      managerId: 'manager-1',
      managerName: '陈总',
      companyName: '星海科技',
      industry: '企业服务',
      employeeScale: '20-99',
    });
    expect(workspace.organization.companies).toHaveLength(1);
    expect(workspace.organization.departments).toHaveLength(4);
    expect(new Set(workspace.organization.departments.map((d) => d.id)).size).toBe(4);

    const ceo = workspace.organization.positions.find((p) => p.title === 'CEO');
    expect(ceo).toMatchObject({
      companyId: workspace.organization.rootCompanyId,
      incumbentUserId: 'manager-1',
    });
    expect(workspace.context.positionId).toBe(ceo?.id);
  });

  it('accepts explicit department names without duplicating blanks', () => {
    const workspace = buildManagerWorkspace({
      managerId: 'manager-2',
      managerName: '周总',
      companyName: '远山设计',
      departmentNames: ['设计部', '客户部', '设计部', '  '],
    });

    expect(workspace.organization.departments.map((d) => d.name)).toEqual([
      '管理层',
      '设计部',
      '客户部',
    ]);
  });
});

describe('Ed25519 compact invites', () => {
  const keys = generateKeyPairSync('ed25519');
  const clock = () => new Date('2026-07-11T12:00:00.000Z');
  const verifier = new Ed25519InviteService({ publicKey: keys.publicKey, now: clock });

  function expectCompact(invite: SignedInvitePayload): void {
    expect(invite.token).toBe(`${invite.payload}.${invite.signature}`);
    expect(invite.payload.length).toBeLessThan(420);
    const raw = JSON.parse(Buffer.from(invite.payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty('organization');
    expect(raw).not.toHaveProperty('departments');
    expect(raw).not.toHaveProperty('members');
    expect(raw).not.toHaveProperty('companyName');
  }

  it('issues verifiable position, company and parent-child company payloads containing only references', () => {
    const ids = ['invite-position', 'invite-company', 'invite-link'];
    const signer = new Ed25519InviteService({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      now: clock,
      idFactory: () => ids.shift() ?? 'invite-extra',
    });
    const position = signer.issuePositionInvite({
      issuerUserId: 'manager-1',
      companyId: 'company-a',
      departmentId: 'dept-rd',
      positionId: 'position-fe',
      expiresInSeconds: 3600,
    });
    const company = signer.issueCompanyInvite({
      issuerUserId: 'manager-1',
      companyId: 'company-a',
      role: 'member',
      expiresInSeconds: 3600,
    });
    const companyLink = signer.issueCompanyLinkInvite({
      issuerUserId: 'manager-1',
      companyId: 'company-a',
      direction: 'parent_invites_child',
      expiresInSeconds: 3600,
    });

    for (const invite of [position, company, companyLink]) expectCompact(invite);
    expect(verifier.verify(position.token)).toMatchObject({
      id: 'invite-position',
      kind: 'position',
      issuerUserId: 'manager-1',
      companyId: 'company-a',
      departmentId: 'dept-rd',
      positionId: 'position-fe',
    });
    expect(verifier.verify(company.token)).toMatchObject({
      id: 'invite-company',
      kind: 'company',
      companyId: 'company-a',
      role: 'member',
    });
    expect(verifier.verify(companyLink.token)).toMatchObject({
      id: 'invite-link',
      kind: 'company_link',
      companyId: 'company-a',
      direction: 'parent_invites_child',
    });
  });

  it('rejects tampering and expiration, and produces a route-ready redemption receipt', () => {
    const signer = new Ed25519InviteService({
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      now: clock,
      idFactory: () => 'invite-redeem',
    });
    const invite = signer.issueCompanyInvite({
      issuerUserId: 'manager-1',
      companyId: 'company-a',
      expiresInSeconds: 60,
    });
    const [payload, signature] = invite.token.split('.');
    expect(() => verifier.verify(`${payload}x.${signature}`)).toThrow(/签名/);
    expect(() =>
      verifier.verify(invite.token, new Date('2026-07-11T12:01:01.000Z')),
    ).toThrow(/过期/);

    const receipt = verifier.createRedemption(invite.token, 'new-member');
    expect(receipt).toMatchObject({
      inviteId: 'invite-redeem',
      redeemerUserId: 'new-member',
      companyId: 'company-a',
      kind: 'company',
    });
    expect(receipt.redeemedAt).toBe(clock().toISOString());
  });
});

describe('parent and subsidiary organization links', () => {
  const organization = buildManagerWorkspace({
    managerId: 'owner-local',
    managerName: '陈总',
    companyName: '本地公司',
  }).organization;
  const localCompanyId = organization.rootCompanyId;

  it('总公司邀请被子公司接受后，本地公司挂到总公司下并更新根节点', () => {
    const linked = applyCompanyLinkRedemption(organization, localCompanyId, {
      inviteId: 'link-parent',
      issuerUserId: 'owner-parent',
      redeemerUserId: 'owner-local',
      kind: 'company_link',
      companyId: 'company-parent',
      direction: 'parent_invites_child',
      redeemedAt: '2026-07-11T12:00:00.000Z',
    });

    expect(linked.rootCompanyId).toBe('company-parent');
    expect(linked.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'company-parent', ownerUserId: 'owner-parent' }),
      expect.objectContaining({ id: localCompanyId, parentCompanyId: 'company-parent' }),
    ]));
    expect(organization.companies).toHaveLength(1);
  });

  it('子公司请求被总公司接受后，子公司挂到本地公司下', () => {
    const linked = applyCompanyLinkRedemption(organization, localCompanyId, {
      inviteId: 'link-child',
      issuerUserId: 'owner-child',
      redeemerUserId: 'owner-local',
      kind: 'company_link',
      companyId: 'company-child',
      direction: 'child_requests_parent',
      redeemedAt: '2026-07-11T12:00:00.000Z',
    });

    expect(linked.rootCompanyId).toBe(localCompanyId);
    expect(linked.companies).toContainEqual(expect.objectContaining({
      id: 'company-child',
      ownerUserId: 'owner-child',
      parentCompanyId: localCompanyId,
    }));
  });

  it('拒绝非父子公司用途、目标不匹配、自关联和重复关联', () => {
    const base = {
      inviteId: 'link-invalid',
      issuerUserId: 'owner-parent',
      redeemerUserId: 'owner-local',
      kind: 'company_link' as const,
      companyId: 'company-parent',
      direction: 'parent_invites_child' as const,
      redeemedAt: '2026-07-11T12:00:00.000Z',
    };
    expect(() => applyCompanyLinkRedemption(organization, localCompanyId, {
      ...base,
      kind: 'company',
    })).toThrow(/用途|类型/);
    expect(() => applyCompanyLinkRedemption(organization, localCompanyId, {
      ...base,
      targetCompanyId: 'another-company',
    })).toThrow(/目标企业/);
    expect(() => applyCompanyLinkRedemption(organization, localCompanyId, {
      ...base,
      companyId: localCompanyId,
    })).toThrow(/自己|自关联/);

    const linked = applyCompanyLinkRedemption(organization, localCompanyId, base);
    expect(() => applyCompanyLinkRedemption(linked, localCompanyId, {
      ...base,
      inviteId: 'link-second',
    })).toThrow(/已关联|已有总公司/);
  });
});

describe('schedule book', () => {
  it('adds, sorts, queries by owner/date and deletes only within the owner context', () => {
    let nextId = 0;
    const book = new ScheduleBook({ idFactory: () => `event-${++nextId}` });
    const felix = createPersonalContext({ userId: 'felix' });
    const teammate = createPersonalContext({ userId: 'teammate' });

    const afternoon = book.add(felix, {
      date: '2026-07-12',
      title: '产品评审',
      startTime: '15:00',
      endTime: '16:00',
    });
    const morning = book.add(felix, {
      date: '2026-07-12',
      title: '晨会',
      startTime: '09:30',
    });
    book.add(teammate, { date: '2026-07-12', title: '销售拜访', startTime: '10:00' });
    book.add(felix, { date: '2026-07-13', title: '写周报' });

    expect(book.listByDate(felix, '2026-07-12').map((event) => event.id)).toEqual([
      morning.id,
      afternoon.id,
    ]);
    expect(book.remove(teammate, afternoon.id)).toBe(false);
    expect(book.remove(felix, afternoon.id)).toBe(true);
    expect(book.listByDate(felix, '2026-07-12').map((event) => event.title)).toEqual(['晨会']);
  });

  it('rejects malformed dates and reversed time ranges', () => {
    const book = new ScheduleBook();
    const context = createPersonalContext({ userId: 'felix' });

    expect(() => book.add(context, { date: '2026-7-1', title: '错误日期' })).toThrow(/日期/);
    expect(() =>
      book.add(context, {
        date: '2026-07-12',
        title: '错误时段',
        startTime: '18:00',
        endTime: '17:00',
      }),
    ).toThrow(/结束时间/);
  });
});

describe('credit economics and model multiplier display', () => {
  it('¥100 grants 10,000 credits backed by ¥90 of DeepSeek budget', () => {
    expect(CREDIT_ECONOMICS.creditsPerCny).toBe(100);
    expect(purchaseCreditsFromFen(10_000)).toBe(10_000);
    expect(creditsToDeepSeekBudgetFen(10_000)).toBe(9_000);
    expect(() => purchaseCreditsFromFen(0)).toThrow(/金额/);
  });

  it('stores multiplier precisely enough for display and rounds charges up to a whole credit', () => {
    const catalog = new ModelCreditCatalog([
      { modelId: 'deepseek-chat', displayName: 'DeepSeek Chat', creditMultiplier: 1 },
      { modelId: 'premium-reasoner', displayName: '高端推理模型', creditMultiplier: 4.5 },
    ]);

    expect(catalog.list()).toEqual([
      expect.objectContaining({ modelId: 'deepseek-chat', multiplierLabel: '1× 积分' }),
      expect.objectContaining({ modelId: 'premium-reasoner', multiplierLabel: '4.5× 积分' }),
    ]);
    expect(catalog.charge('deepseek-chat', 101)).toBe(101);
    expect(catalog.charge('premium-reasoner', 101)).toBe(455);
    expect(() => catalog.charge('missing', 100)).toThrow(/模型/);
  });
});
