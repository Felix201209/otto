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
      'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY',
    )).toEqual({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
    });
  });

  it('accepts a single safe HTTPS enterprise server URL and normalizes it to origin', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=https%3A%2F%2Fenterprise.otto.test%2F',
    )).toEqual({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
      serverUrl: 'https://enterprise.otto.test',
    });
  });

  it('allows HTTP loopback URLs for local integration', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=http%3A%2F%2F127.0.0.1%3A7777',
    )).toEqual({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
      serverUrl: 'http://127.0.0.1:7777',
    });
  });

  it('preserves HTTPS reverse proxy path prefixes from otto links', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=https%3A%2F%2Fenterprise.otto.test%2Fcompany%2F',
    )).toEqual({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
      serverUrl: 'https://enterprise.otto.test/company',
    });
  });

  it('accepts HTTPS enterprise invite page links', () => {
    expect(parseEnterpriseRegistrationIntent(
      'https://59.110.154.44:7777/enterprise/join/F5e8-R2wA-Q9pB',
    )).toEqual({
      inviteCode: 'F5e8-R2wA-Q9pB',
      serverUrl: 'https://59.110.154.44:7777',
    });
  });

  it('preserves HTTPS reverse proxy path prefixes from invite page links', () => {
    expect(parseEnterpriseRegistrationIntent(
      'https://enterprise.otto.test/company/enterprise/join/Ab3D-k9Pq-Z7xY',
    )).toEqual({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
      serverUrl: 'https://enterprise.otto.test/company',
    });
  });

  it.each([
    'otto://enterprise/register?invite=Ab3D-k9Pq-Z7xY',
    'otto://other/join?invite=Ab3D-k9Pq-Z7xY',
    'otto://enterprise/join?token=signed&key=public',
    'https://enterprise.otto.test/enterprise/join/Ab3D-k9Pq-Z7xY?token=signed',
    'https://enterprise.otto.test/enterprise/join/Ab3D-k9Pq-Z7xY#fragment',
    'https://user:pass@enterprise.otto.test/enterprise/join/Ab3D-k9Pq-Z7xY',
    'http://enterprise.otto.test/enterprise/join/Ab3D-k9Pq-Z7xY',
    'otto://enterprise/join?invite=BAD',
    'otto://enterprise/join?invite=ABCI-EFGH',
    'otto://user:pass@enterprise/join?invite=Ab3D-k9Pq-Z7xY',
    'otto://enterprise:123/join?invite=Ab3D-k9Pq-Z7xY',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=http%3A%2F%2Fenterprise.otto.test',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=https%3A%2F%2Fuser%3Apass%40enterprise.otto.test',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=https%3A%2F%2Fenterprise.otto.test%3Fx%3D1',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&server=https%3A%2F%2Fenterprise.otto.test&server=https%3A%2F%2Fb.otto.test',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&extra=1',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY&invite=Wz8Y-m3Na-Q5pB',
    'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY#fragment',
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
      'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY',
    ])).toBe(true);
    expect(store.take()).toEqual({
      inviteCode: 'Ab3D-k9Pq-Z7xY',
    });
    expect(store.take()).toBeNull();
  });

  it('does not let invalid second-instance args overwrite a cached valid intent', () => {
    const store = new EnterpriseRegistrationIntentStore();
    store.acceptUrl(
      'otto://enterprise/join?invite=Ab3D-k9Pq-Z7xY',
    );
    expect(store.acceptArgv(['otto://enterprise/join?token=signed&key=public'])).toBe(false);
    expect(store.take()?.inviteCode).toBe('Ab3D-k9Pq-Z7xY');
  });
});
