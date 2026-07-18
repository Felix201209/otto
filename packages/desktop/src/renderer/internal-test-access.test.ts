/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  INTERNAL_TEST_ACCESS_ENABLED,
  INTERNAL_TEST_ACCOUNT,
} from './internal-test-access.js';

describe('v1.8.6 内部测试访问模式', () => {
  it('默认屏蔽登录页，直接使用本地测试身份', () => {
    expect(INTERNAL_TEST_ACCESS_ENABLED).toBe(true);
    expect(INTERNAL_TEST_ACCOUNT).toMatchObject({
      id: 'local_internal_test',
      username: 'internal-test',
      name: '内部测试',
      status: 'active',
    });
  });

  it('测试身份永远不是服务端管理员，不能露出账号和邀请码管理入口', () => {
    expect(INTERNAL_TEST_ACCOUNT.isAdmin).toBe(false);
    expect(INTERNAL_TEST_ACCOUNT.organizationId).toBe('local-internal-test');
    expect(INTERNAL_TEST_ACCOUNT.phone).toBeNull();
  });
});
