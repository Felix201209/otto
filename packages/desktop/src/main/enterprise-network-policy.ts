/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export function createEnterpriseNetworkFetch(
  fetchImpl: typeof fetch,
  _internalTestAccessEnabled: boolean,
): typeof fetch {
  // “内测免登录”只决定默认显示哪个界面，不能切断用户显式发起的企业认证。
  // 未登录的 EnterpriseClient 不会发送用量、知识或组织请求；真正的邀请码
  // 注册成功后则必须保留真实传输，才能建立 Bearer 会话并读取组织树。
  return fetchImpl;
}

/**
 * 内测免登录不覆盖磁盘上的真实企业会话。默认无会话时由 renderer 使用本地
 * 测试身份；一旦用户通过邀请完成认证，重启后仍应恢复该真实会话。
 */
export function internalTestEnterpriseSession(
  _defaultServerUrl: string,
  _internalTestAccessEnabled: boolean,
): null {
  return null;
}
