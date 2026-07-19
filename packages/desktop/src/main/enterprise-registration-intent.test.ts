/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  EnterpriseRegistrationIntentStore,
  parseEnterpriseRegistrationIntent,
} from './enterprise-registration-intent.js';

describe('enterprise registration link parsing', () => {
  it('accepts exact otto://enterprise/join links and normalizes invite codes', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=abcd-efgh',
    )).toEqual({
      inviteCode: 'ABCD-EFGH',
    });
  });

  it('accepts a single safe HTTPS enterprise server URL and normalizes it to origin', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=abcd-efgh&server=https%3A%2F%2Fenterprise.otto.test%2F',
    )).toEqual({
      inviteCode: 'ABCD-EFGH',
      serverUrl: 'https://enterprise.otto.test',
    });
  });

  it('allows HTTP loopback URLs for local integration', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=ABCD-EFGH&server=http%3A%2F%2F127.0.0.1%3A7777',
    )).toEqual({
      inviteCode: 'ABCD-EFGH',
      serverUrl: 'http://127.0.0.1:7777',
    });
  });

  it('preserves HTTPS reverse proxy path prefixes from otto links', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=ABCD-EFGH&server=https%3A%2F%2Fenterprise.otto.test%2Fcompany%2F',
    )).toEqual({
      inviteCode: 'ABCD-EFGH',
      serverUrl: 'https://enterprise.otto.test/company',
    });
  });

  it('accepts HTTPS enterprise invite page links', () => {
    expect(parseEnterpriseRegistrationIntent(
      'https://59.110.154.44:7777/enterprise/join/5re8-2rwa',
    )).toEqual({
      inviteCode: '5RE8-2RWA',
      serverUrl: 'https://59.110.154.44:7777',
    });
  });

  it('preserves HTTPS reverse proxy path prefixes from invite page links', () => {
    expect(parseEnterpriseRegistrationIntent(
      'https://enterprise.otto.test/company/enterprise/join/ABCD-EFGH',
    )).toEqual({
      inviteCode: 'ABCD-EFGH',
      serverUrl: 'https://enterprise.otto.test/company',
    });
  });

  it.each([
    'otto://enterprise/register?invite=ABCD-EFGH',
    'otto://other/join?invite=ABCD-EFGH',
    'otto://enterprise/join?token=signed&key=public',
    'https://enterprise.otto.test/enterprise/join/ABCD-EFGH?token=signed',
    'https://enterprise.otto.test/enterprise/join/ABCD-EFGH#fragment',
    'https://user:pass@enterprise.otto.test/enterprise/join/ABCD-EFGH',
    'http://enterprise.otto.test/enterprise/join/ABCD-EFGH',
    'otto://enterprise/join?invite=BAD',
    'otto://enterprise/join?invite=ABCI-EFGH',
    'otto://user:pass@enterprise/join?invite=ABCD-EFGH',
    'otto://enterprise:123/join?invite=ABCD-EFGH',
    'otto://enterprise/join?invite=ABCD-EFGH&server=http%3A%2F%2Fenterprise.otto.test',
    'otto://enterprise/join?invite=ABCD-EFGH&server=https%3A%2F%2Fuser%3Apass%40enterprise.otto.test',
    'otto://enterprise/join?invite=ABCD-EFGH&server=https%3A%2F%2Fenterprise.otto.test%3Fx%3D1',
    'otto://enterprise/join?invite=ABCD-EFGH&server=https%3A%2F%2Fenterprise.otto.test&server=https%3A%2F%2Fb.otto.test',
    'otto://enterprise/join?invite=ABCD-EFGH&extra=1',
    'otto://enterprise/join?invite=ABCD-EFGH&invite=WXYZ-2345',
    'otto://enterprise/join?invite=ABCD-EFGH#fragment',
  ])('rejects non-registration, legacy signed, or suspicious links: %s', (url) => {
    expect(parseEnterpriseRegistrationIntent(url)).toBeNull();
  });

  it('safely rejects invite page links containing malformed percent encoding', () => {
    expect(parseEnterpriseRegistrationIntent(
      'https://enterprise.otto.test/enterprise/join/%E0%A4%A',
    )).toBeNull();
  });
});

describe('enterprise registration intent store', () => {
  it('caches a valid cold-start argv link until the renderer consumes it once', () => {
    const store = new EnterpriseRegistrationIntentStore();
    expect(store.acceptArgv([
      '/Applications/Otto.app/Contents/MacOS/Otto',
      '--flag',
      'otto://enterprise/join?invite=ABCD-EFGH',
    ])).toBe(true);
    expect(store.take()).toEqual({
      inviteCode: 'ABCD-EFGH',
    });
    expect(store.take()).toBeNull();
  });

  it('does not let invalid second-instance args overwrite a cached valid intent', () => {
    const store = new EnterpriseRegistrationIntentStore();
    store.acceptUrl(
      'otto://enterprise/join?invite=ABCD-EFGH',
    );
    expect(store.acceptArgv(['otto://enterprise/join?token=signed&key=public'])).toBe(false);
    expect(store.take()?.inviteCode).toBe('ABCD-EFGH');
  });
});
