/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnterpriseAtoaResponseLedger } from './enterprise-atoa-response-ledger.js';
import { createEnterpriseAtoaResponseLedgerCommandHandler } from './enterprise-atoa-response-ledger-ipc.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function handler(
  identity: () => { serverUrl: string; accountId: string } | null,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'otto-a2a-ipc-'));
  directories.push(directory);
  const ledger = new EnterpriseAtoaResponseLedger({
    directory,
    protect: (value) => Buffer.from(value).toString('base64'),
    unprotect: (value) => Buffer.from(value, 'base64').toString('utf8'),
  });
  return createEnterpriseAtoaResponseLedgerCommandHandler({
    ledger,
    identity,
    normalizeSources: (value) => {
      if (!Array.isArray(value)) throw new Error('invalid sources');
      return value as never;
    },
  });
}

const key = {
  scope: 'enterprise-federation-atoa-v1',
  contactId: 'contact-1',
  requestMessageId: 'message-1',
  requestMaterial: 'authenticated request payload',
};

describe('enterprise A2A response ledger IPC boundary', () => {
  it('derives server/account identity in main and never accepts it from renderer', () => {
    let accountId = 'account-a';
    const execute = handler(() => ({
      serverUrl: 'https://enterprise.otto.test',
      accountId,
    }));
    execute({
      action: 'stage_generated',
      key,
      answer: 'account A answer',
      grantedSources: [],
      accountId: 'forged-account',
    });
    accountId = 'account-b';
    expect(execute({ action: 'load', key })).toBeNull();
  });

  it('fails closed while logged out and rejects unknown scope/action', () => {
    const execute = handler(() => null);
    expect(() => execute({ action: 'load', key })).toThrow('企业登录已失效');
    const authenticated = handler(() => ({
      serverUrl: 'https://enterprise.otto.test',
      accountId: 'account-a',
    }));
    expect(() =>
      authenticated({
        action: 'delete',
        key,
      }),
    ).toThrow('A2A 回复账本请求无效');
    expect(() =>
      authenticated({
        action: 'load',
        key: { ...key, scope: 'arbitrary-scope' },
      }),
    ).toThrow('A2A 回复账本请求无效');
  });
});
