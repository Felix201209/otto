/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * v1.8.6 内部测试通道。
 *
 * 这里只绕过客户端登录页，不创建服务端会话，也不伪造管理员权限。等新企业
 * Microservice 提供 HTTPS、版本化健康检查和稳定协议后，将此常量改为 false
 * 即可恢复原有账号密码 / 邀请码注册流程。
 */

import type { EnterpriseAccount } from '../preload/index.js';

export { INTERNAL_TEST_ACCESS_ENABLED } from '../main/internal-test-access.js';

export const INTERNAL_TEST_ACCOUNT: EnterpriseAccount = Object.freeze({
  id: 'local_internal_test',
  organizationId: 'local-internal-test',
  organizationName: '内部测试',
  employeeId: null,
  username: 'internal-test',
  phone: null,
  name: '内部测试',
  role: '测试成员',
  department: '内部测试',
  isAdmin: false,
  status: 'active',
  tags: ['本地身份', '内部测试'],
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
});
