/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_TEST_ACCESS_ENABLED,
  INTERNAL_TEST_ACCOUNT,
  isAuthenticatedEnterpriseAccount,
  resolveEnterpriseAccessMode,
} from './internal-test-access.js';

describe('v1.8.7 企业认证访问模式', () => {
  it('交付版默认恢复真实登录，同时保留可逆的本地测试身份', () => {
    expect(INTERNAL_TEST_ACCESS_ENABLED).toBe(false);
    expect(INTERNAL_TEST_ACCOUNT).toMatchObject({
      id: 'local_internal_test',
      username: 'internal-test',
      name: '本地用户',
      status: 'active',
    });
  });

  it('测试身份永远不是服务端管理员，不能露出账号和邀请码管理入口', () => {
    expect(INTERNAL_TEST_ACCOUNT.isAdmin).toBe(false);
    expect(INTERNAL_TEST_ACCOUNT.organizationId).toBe('local-internal-test');
    expect(INTERNAL_TEST_ACCOUNT.phone).toBeNull();
  });

  it('关闭内测开关后按加载、登录、邀请注册和真实会话完整分流', () => {
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'loading',
      hasAccount: false,
      hasRegistrationIntent: false,
    })).toBe('booting');
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'signed-out',
      hasAccount: false,
      hasRegistrationIntent: false,
    })).toBe('login');
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'signed-out',
      hasAccount: false,
      hasRegistrationIntent: true,
    })).toBe('registration');
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: false,
      authStatus: 'signed-in',
      hasAccount: true,
      hasRegistrationIntent: false,
    })).toBe('authenticated-workspace');
  });

  it('需要时仍可显式启用免登录内测通道', () => {
    expect(resolveEnterpriseAccessMode({
      internalTestAccessEnabled: true,
      authStatus: 'loading',
      hasAccount: false,
      hasRegistrationIntent: false,
    })).toBe('internal-workspace');
  });

  it('合成本地身份永远不能冒充真实企业账号', () => {
    expect(isAuthenticatedEnterpriseAccount(INTERNAL_TEST_ACCOUNT)).toBe(false);
  });
});
