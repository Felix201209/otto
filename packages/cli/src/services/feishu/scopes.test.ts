/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  REQUIRED_APP_SCOPES,
  SENSITIVE_GROUP_MSG_SCOPE,
  buildScopeApplyUrl,
  buildPermissionPageUrl,
  buildEventSubUrl,
  missingScopes,
  openPlatformDomain,
} from './scopes.js';

describe('scopes/REQUIRED_APP_SCOPES', () => {
  it('contains the canonical core scopes for a otto bot', () => {
    // Smoke test: ensure the 4 most critical capabilities are listed.
    // If anyone removes one of these, the bot literally stops working.
    const list = [...REQUIRED_APP_SCOPES];
    expect(list).toContain('im:message:send_as_bot');
    expect(list).toContain('im:message.group_at_msg:readonly');
    expect(list).toContain('im:message.p2p_msg:readonly');
    expect(list).toContain('im:chat'); // create groups
  });

  it('does NOT contain the high-risk send_as_user scope', () => {
    // Mirrors openclaw-lark's HIGH_RISK_SCOPES policy. otto never sends
    // as a user, only as the bot, so this scope must NOT be requested.
    expect([...REQUIRED_APP_SCOPES]).not.toContain('im:message.send_as_user');
  });

  it('does NOT include the sensitive im:message.group_msg scope by default', () => {
    // im:message.group_msg is the "no-@-mention required" scope but it's
    // sensitive (needs human review at Feishu). It must be opt-in only,
    // never silently bundled into the default required list.
    expect([...REQUIRED_APP_SCOPES]).not.toContain(SENSITIVE_GROUP_MSG_SCOPE);
    expect([...REQUIRED_APP_SCOPES]).not.toContain('im:message.group_msg');
  });
});

describe('scopes/SENSITIVE_GROUP_MSG_SCOPE', () => {
  it('exposes the sensitive scope name as a separate constant', () => {
    expect(SENSITIVE_GROUP_MSG_SCOPE).toBe('im:message.group_msg');
  });
});

describe('scopes/openPlatformDomain', () => {
  it('returns feishu.cn for feishu (or default)', () => {
    expect(openPlatformDomain()).toBe('https://open.feishu.cn');
    expect(openPlatformDomain('feishu')).toBe('https://open.feishu.cn');
  });

  it('returns larksuite.com for lark', () => {
    expect(openPlatformDomain('lark')).toBe('https://open.larksuite.com');
  });
});

describe('scopes/buildScopeApplyUrl', () => {
  it('builds a tenant-token apply URL with q= when scopes < 20', () => {
    const url = buildScopeApplyUrl({
      appId: 'cli_xxx',
      scopes: ['im:message', 'im:chat'],
    });
    expect(url).toBe(
      'https://open.feishu.cn/app/cli_xxx/auth?q=im%3Amessage%2Cim%3Achat&op_from=otto&token_type=tenant',
    );
  });

  it('uses lark domain when brand=lark', () => {
    const url = buildScopeApplyUrl({
      appId: 'cli_yyy',
      scopes: ['im:message'],
      brand: 'lark',
    });
    expect(url.startsWith('https://open.larksuite.com/app/cli_yyy/auth?q=')).toBe(true);
  });

  it('falls back to no-q when scopes is empty (links to permission page)', () => {
    const url = buildScopeApplyUrl({ appId: 'cli_zzz', scopes: [] });
    // Empty scopes → degrade to a generic auth link without q=.
    expect(url).toBe(
      'https://open.feishu.cn/app/cli_zzz/auth?op_from=otto&token_type=tenant',
    );
  });

  it('falls back to no-q when scopes >= 20 (URL would be too long)', () => {
    const many = Array.from({ length: 25 }, (_, i) => `scope:${i}`);
    const url = buildScopeApplyUrl({ appId: 'cli_zzz', scopes: many });
    expect(url).not.toContain('q=');
  });

  it('honors token_type=user for user-level OAuth', () => {
    const url = buildScopeApplyUrl({
      appId: 'cli_xxx',
      scopes: ['offline_access'],
      tokenType: 'user',
    });
    expect(url).toContain('token_type=user');
  });
});

describe('scopes/buildPermissionPageUrl & buildEventSubUrl', () => {
  it('builds correct permission management URL', () => {
    expect(buildPermissionPageUrl({ appId: 'cli_a' })).toBe(
      'https://open.feishu.cn/app/cli_a/permission',
    );
  });

  it('builds correct event-sub URL', () => {
    expect(buildEventSubUrl({ appId: 'cli_a' })).toBe(
      'https://open.feishu.cn/app/cli_a/event-sub',
    );
  });

  it('handles lark brand for both URL kinds', () => {
    expect(buildPermissionPageUrl({ appId: 'cli_a', brand: 'lark' })).toContain(
      'larksuite.com',
    );
    expect(buildEventSubUrl({ appId: 'cli_a', brand: 'lark' })).toContain(
      'larksuite.com',
    );
  });
});

describe('scopes/missingScopes', () => {
  it('returns scopes in required that are not in granted', () => {
    expect(missingScopes(['a', 'b'], ['a', 'c', 'd'])).toEqual(['c', 'd']);
  });

  it('returns empty array when granted is a superset of required', () => {
    expect(missingScopes(['a', 'b', 'c'], ['a', 'b'])).toEqual([]);
  });

  it('returns required as-is when granted is empty', () => {
    expect(missingScopes([], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('preserves required order', () => {
    expect(missingScopes(['b'], ['c', 'a', 'b', 'd'])).toEqual(['c', 'a', 'd']);
  });
});
