/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { EnterpriseAccount } from '../../preload/index.js';
import { resolveCentralEnterpriseIdentity } from './centralEnterpriseIdentity.js';

function account(overrides: Partial<EnterpriseAccount> = {}): EnterpriseAccount {
  return {
    id: 'account-1',
    organizationId: 'org-1',
    organizationName: '北辰科技',
    employeeId: 'E-001',
    username: 'felix',
    phone: null,
    name: 'Felix',
    role: 'CEO',
    department: '产品部',
    positionId: 'position-1',
    positionTitle: '产品经理',
    isAdmin: false,
    status: 'active',
    tags: ['超级管理员'],
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveCentralEnterpriseIdentity', () => {
  it('只由 isAdmin 决定管理员目录，管理员固定为 CEO + 8 个通用专家', () => {
    const view = resolveCentralEnterpriseIdentity(account({ isAdmin: true }));

    expect(view.edition).toBe('enterprise');
    expect(view.role).toBe('company_admin');
    expect(view.profiles).toHaveLength(9);
    expect(view.profiles[0]?.id).toBe('otto-enterprise-ceo');
  });

  it('忽略 role 和 tags 的自升权信息，普通成员固定为 work + 8 个通用专家', () => {
    const view = resolveCentralEnterpriseIdentity(account({
      isAdmin: false,
      role: 'company_owner',
      tags: ['admin', 'CEO'],
    }));

    expect(view.role).toBe('member');
    expect(view.profiles).toHaveLength(9);
    expect(view.profiles[0]?.id).toBe('otto-enterprise-work');
    expect(view.identityLabel).toBe('北辰科技 · 产品部 · 产品经理 · 企业成员');
    expect(view.identityLabel).not.toContain('CEO');
    expect(view.identityLabel).not.toContain('admin');
  });

  it('普通注册账号进入个人版目录，不显示企业成员身份或企业管理专家', () => {
    const view = resolveCentralEnterpriseIdentity(account({
      accountType: 'personal',
      organizationName: 'Felix的个人空间',
      isAdmin: false,
      role: '个人用户',
      department: null,
      positionTitle: null,
    }));

    expect(view.edition).toBe('personal');
    expect(view.profiles[0]?.id).toBe('otto-personal');
    expect(view.identityLabel).toBe('Felix · 个人空间');
    expect(view.identityLabel).not.toContain('企业成员');
  });
});
