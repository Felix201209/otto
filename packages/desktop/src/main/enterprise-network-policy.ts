/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export function createEnterpriseNetworkFetch(
  fetchImpl: typeof fetch,
  internalTestAccessEnabled: boolean,
): typeof fetch {
  if (!internalTestAccessEnabled) return fetchImpl;
  return (async () => {
    throw new Error('内部测试模式已停用企业网络访问');
  }) as typeof fetch;
}

/**
 * 内测包只忽略磁盘上的旧 token，不删除 enterprise-auth.json。
 * 关闭总开关后，真实登录会话仍可按原逻辑恢复。
 */
export function internalTestEnterpriseSession(
  defaultServerUrl: string,
  internalTestAccessEnabled: boolean,
): { serverUrl: string; token: null } | null {
  return internalTestAccessEnabled
    ? { serverUrl: defaultServerUrl, token: null }
    : null;
}
