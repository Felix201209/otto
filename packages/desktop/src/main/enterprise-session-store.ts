/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业登录态的纯序列化层。token 必须先由 Electron safeStorage 加密，
 * 本模块只负责稳定地写入和恢复，便于对“重开 App 自动登录”做回归测试。
 */

export interface EnterpriseSessionSnapshot {
  serverUrl: string;
  token: string | null;
}

export function encodeEnterpriseSession(
  snapshot: EnterpriseSessionSnapshot,
  encryptToken: (token: string) => string,
): string {
  const encryptedToken = snapshot.token ? encryptToken(snapshot.token) : undefined;
  return JSON.stringify({ serverUrl: snapshot.serverUrl, encryptedToken }, null, 2);
}

export function decodeEnterpriseSession(
  raw: string,
  defaultServerUrl: string,
  decryptToken: (encryptedToken: string) => string,
  migrateServerUrl: (serverUrl: string) => string = (serverUrl) => serverUrl,
): EnterpriseSessionSnapshot {
  try {
    const parsed = JSON.parse(raw) as { serverUrl?: unknown; encryptedToken?: unknown };
    const serverUrl = typeof parsed.serverUrl === 'string' && parsed.serverUrl
      ? migrateServerUrl(parsed.serverUrl)
      : defaultServerUrl;
    let token: string | null = null;
    if (typeof parsed.encryptedToken === 'string' && parsed.encryptedToken) {
      try {
        token = decryptToken(parsed.encryptedToken) || null;
      } catch {
        token = null;
      }
    }
    return { serverUrl, token };
  } catch {
    return { serverUrl: defaultServerUrl, token: null };
  }
}
