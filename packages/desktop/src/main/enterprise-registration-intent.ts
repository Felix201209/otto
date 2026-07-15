/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 中心企业注册链接的唯一解析入口。这里只接受短期企业邀请码；ProductWorkspace
 * 使用的 token+key Ed25519 链接属于另一条人工企业编排流程，故意不在这里兼容。
 */

export interface EnterpriseRegistrationIntent {
  inviteCode: string;
}

const ENTERPRISE_INVITE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

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
  if (keys.length !== 1 || keys[0] !== 'invite' || url.searchParams.getAll('invite').length !== 1) {
    return null;
  }
  const inviteCode = (url.searchParams.get('invite') || '').toLocaleUpperCase('en-US');
  if (!ENTERPRISE_INVITE_PATTERN.test(inviteCode)) return null;
  return { inviteCode };
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
