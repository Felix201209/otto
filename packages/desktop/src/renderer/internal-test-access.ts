/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 可逆的内部测试通道。
 *
 * 这里只能在显式启用时绕过客户端登录页，不创建服务端会话，也不伪造管理员
 * 权限。交付版本默认关闭，使用真实账号密码 / 邀请码注册流程。
 */

import type { EnterpriseAccount } from '../preload/index.js';

export { INTERNAL_TEST_ACCESS_ENABLED } from '../main/internal-test-access.js';

declare const __OTTO_INTERNAL_TEST_ADMIN__: boolean | undefined;

/** 仅供显式内部构建展示企业管理员前端；不能代表服务端授权。 */
export const INTERNAL_TEST_ADMIN_ENABLED =
  typeof __OTTO_INTERNAL_TEST_ADMIN__ !== 'undefined'
  && __OTTO_INTERNAL_TEST_ADMIN__ === true;

export const INTERNAL_TEST_ACCOUNT: EnterpriseAccount = Object.freeze({
  id: 'local_internal_test',
  accountType: 'personal',
  organizationId: 'local-internal-test',
  organizationName: '本地',
  employeeId: null,
  username: 'internal-test',
  phone: null,
  name: '本地用户',
  role: '成员',
  department: '',
  positionId: null,
  positionTitle: null,
  isAdmin: false,
  status: 'active',
  tags: ['本地身份'],
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
});

export const INTERNAL_TEST_ADMIN_ACCOUNT: EnterpriseAccount = Object.freeze({
  ...INTERNAL_TEST_ACCOUNT,
  id: 'local_internal_admin_preview',
  accountType: 'enterprise',
  username: 'internal-admin-preview',
  name: '本地管理员',
  role: '企业管理员',
  isAdmin: true,
  tags: ['本地身份', '管理员 UI 预览'],
});

export type EnterpriseAccessMode =
  | 'booting'
  | 'internal-workspace'
  | 'registration'
  | 'login'
  | 'authenticated-workspace';

/**
 * “屏蔽登录”是一项可逆的内测入口策略，不是删除认证能力：
 * - 显式启用的内测包无真实会话时直接进入本地工作区；
 * - 邀请链接到达时进入注册；
 * - 已注册账号恢复真实会话并连接企业服务；
 * - 正式交付包保持原有强制登录门禁。
 */
export function resolveEnterpriseAccessMode(input: {
  internalTestAccessEnabled: boolean;
  authStatus: 'loading' | 'signed-out' | 'signed-in';
  hasAccount: boolean;
  hasRegistrationIntent: boolean;
}): EnterpriseAccessMode {
  if (input.hasAccount && input.authStatus === 'signed-in') {
    return 'authenticated-workspace';
  }
  if (input.hasRegistrationIntent) return 'registration';
  if (input.internalTestAccessEnabled) return 'internal-workspace';
  if (input.authStatus === 'loading') return 'booting';
  return 'login';
}

export function isAuthenticatedEnterpriseAccount(
  account: EnterpriseAccount | undefined,
): account is EnterpriseAccount {
  return Boolean(
    account
      && account.id !== INTERNAL_TEST_ACCOUNT.id
      && account.organizationId !== INTERNAL_TEST_ACCOUNT.organizationId,
  );
}
