/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 中心企业注册链接的唯一解析入口。这里只接受短期企业邀请码；ProductWorkspace
 * 使用的 token+key Ed25519 链接属于另一条人工企业编排流程，故意不在这里兼容。
 */

export interface EnterpriseRegistrationIntent {
  inviteCode: string;
  /** 企业服务器地址（可选，从邀请链接的 server 参数提取） */
  serverUrl?: string;
}

const ENTERPRISE_INVITE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const ENTERPRISE_JOIN_PATH_PATTERN = /^(.*)\/enterprise\/join\/([^/]+)$/;

function normalizeEnterpriseServerUrl(input: string): string | null {
  let server: URL;
  try {
    server = new URL(input);
  } catch {
    return null;
  }

  if (server.username
    || server.password
    || server.search
    || server.hash) {
    return null;
  }

  const isHttps = server.protocol === 'https:';
  const isLoopbackHttp = server.protocol === 'http:'
    && (server.hostname === '127.0.0.1'
      || server.hostname === 'localhost'
      || server.hostname === '[::1]');
  if (!isHttps && !isLoopbackHttp) return null;

  const pathPrefix = server.pathname === '/'
    ? ''
    : server.pathname.replace(/\/+$/, '');
  return `${server.origin}${pathPrefix}`;
}

export function parseEnterpriseRegistrationIntent(
  input: string,
): EnterpriseRegistrationIntent | null {
  if (!input || input.trim() !== input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return parseEnterpriseJoinPageIntent(url);
  }

  if (url.protocol !== 'otto:'
    || url.host !== 'enterprise'
    || url.hostname !== 'enterprise'
    || url.port
    || url.username
    || url.password
    || url.pathname !== '/join'
    || url.hash) {
    return null;
  }

  const keys = [...url.searchParams.keys()];
  const validKeys = keys.filter(k => k === 'invite' || k === 'server');
  if (validKeys.length !== keys.length) return null;
  if (!keys.includes('invite') || url.searchParams.getAll('invite').length !== 1) {
    return null;
  }
  if (url.searchParams.getAll('server').length > 1) return null;
  const inviteCode = (url.searchParams.get('invite') || '').toLocaleUpperCase('en-US');
  if (!ENTERPRISE_INVITE_PATTERN.test(inviteCode)) return null;
  const serverInput = url.searchParams.get('server');
  if (serverInput === null) return { inviteCode };
  const serverUrl = normalizeEnterpriseServerUrl(serverInput);
  if (!serverUrl) return null;
  return { inviteCode, serverUrl };
}

function parseEnterpriseJoinPageIntent(
  url: URL,
): EnterpriseRegistrationIntent | null {
  if (url.username || url.password || url.search || url.hash) return null;
  const match = url.pathname.match(ENTERPRISE_JOIN_PATH_PATTERN);
  if (!match) return null;

  const inviteCode = decodeURIComponent(match[2] || '').toLocaleUpperCase('en-US');
  if (!ENTERPRISE_INVITE_PATTERN.test(inviteCode)) return null;

  const serverPath = match[1] || '';
  const serverUrl = normalizeEnterpriseServerUrl(`${url.origin}${serverPath || '/'}`);
  if (!serverUrl) return null;
  return { inviteCode, serverUrl };
}

/**
 * Electron ready 前、macOS open-url 与 second-instance 共用的一格内存邮箱。
 * 无效链接永不覆盖有效 intent；take 由 renderer 首次 IPC 读取时一次性消费。
 */
export class EnterpriseRegistrationIntentStore {
  private pending: EnterpriseRegistrationIntent | null = null;

  acceptUrl(input: string): boolean {
    const intent = parseEnterpriseRegistrationIntent(input);
    if (!intent) return false;
    this.pending = intent;
    return true;
  }

  acceptArgv(argv: readonly string[]): boolean {
    for (const arg of argv) {
      if (this.acceptUrl(arg)) return true;
    }
    return false;
  }

  take(): EnterpriseRegistrationIntent | null {
    const intent = this.pending;
    this.pending = null;
    return intent;
  }
}
