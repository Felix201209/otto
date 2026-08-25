/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EnterpriseAtoaResponseLedger,
  hashEnterpriseAtoaRequest,
  type EnterpriseAtoaResponseKey,
} from './enterprise-atoa-response-ledger.js';

const protectionKey = Buffer.alloc(32, 19);

function protect(plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', protectionKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return JSON.stringify({
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function unprotect(value: string): string {
  const envelope = JSON.parse(value) as {
    nonce: string;
    ciphertext: string;
    tag: string;
  };
  const decipher = createDecipheriv(
    'aes-256-gcm',
    protectionKey,
    Buffer.from(envelope.nonce, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

const baseKey: EnterpriseAtoaResponseKey = {
  serverUrl: 'https://enterprise.otto.test/',
  accountId: 'account_one',
  scope: 'federation-a2a',
  contactId: 'contact_remote',
  requestMessageId: 'request_message_one',
};

describe('EnterpriseAtoaResponseLedger', () => {
  let directory: string;
  let clock: Date;

  beforeEach(() => {
    directory = mkdtempSync(
      path.join(os.tmpdir(), 'otto-a2a-response-ledger-'),
    );
    clock = new Date('2026-08-22T08:00:00.000Z');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function ledger(retentionMs = 60 * 60_000): EnterpriseAtoaResponseLedger {
    return new EnterpriseAtoaResponseLedger({
      directory,
      protect,
      unprotect,
      now: () => new Date(clock),
      submittedRetentionMs: retentionMs,
    });
  }

  it('atomically protects a generated result and reads it after restart', () => {
    const requestHash = hashEnterpriseAtoaRequest('signed request payload');
    const first = ledger();
    const staged = first.stageGenerated({
      ...baseKey,
      requestHash,
      answer: '原始模型回答，只能重发这一份。',
      grantedSources: ['schedules', 'enterprise_knowledge', 'schedules'],
    });

    expect(staged).toMatchObject({
      serverUrl: 'https://enterprise.otto.test',
      requestHash,
      answerHash: hashEnterpriseAtoaRequest('原始模型回答，只能重发这一份。'),
      grantedSources: ['enterprise_knowledge', 'schedules'],
      status: 'generated',
      attempts: 0,
    });
    const names = readdirSync(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}\.a2a-response$/u);
    expect(readFileSync(path.join(directory, names[0]!), 'utf8')).not.toContain(
      staged.answer,
    );
    expect(names.some((name) => name.endsWith('.tmp'))).toBe(false);

    const restarted = ledger();
    expect(restarted.load({ ...baseKey, requestHash })).toEqual(staged);
  });

  it('isolates every key dimension in the protected file name', () => {
    const requestHash = hashEnterpriseAtoaRequest('same request');
    const keys: EnterpriseAtoaResponseKey[] = [
      baseKey,
      { ...baseKey, serverUrl: 'https://second.otto.test' },
      { ...baseKey, accountId: 'account_two' },
      { ...baseKey, scope: 'another-scope' },
      { ...baseKey, contactId: 'contact_other' },
      { ...baseKey, requestMessageId: 'request_message_two' },
    ];
    const store = ledger();
    for (const key of keys) {
      store.stageGenerated({
        ...key,
        requestHash,
        answer: '同一个回答',
        grantedSources: [],
      });
    }

    expect(readdirSync(directory)).toHaveLength(keys.length);
    for (const key of keys) {
      expect(store.load({ ...key, requestHash })?.answer).toBe('同一个回答');
    }
  });

  it('fails closed when a key is reused with another request or result', () => {
    const requestHash = hashEnterpriseAtoaRequest('request version one');
    const store = ledger();
    const original = store.stageGenerated({
      ...baseKey,
      requestHash,
      answer: '唯一答案',
      grantedSources: ['work_logs'],
    });

    expect(() =>
      store.load({
        ...baseKey,
        requestHash: hashEnterpriseAtoaRequest('request version two'),
      }),
    ).toThrow('request hash mismatch');
    expect(() =>
      store.stageGenerated({
        ...baseKey,
        requestHash,
        answer: '重新生成的不同答案',
        grantedSources: ['work_logs'],
      }),
    ).toThrow('already bound to another result');
    expect(() =>
      store.stageGenerated({
        ...baseKey,
        requestHash,
        answer: '唯一答案',
        grantedSources: ['schedules'],
      }),
    ).toThrow('already bound to another result');
    expect(store.load({ ...baseKey, requestHash })).toEqual(original);
  });

  it('tracks submission attempts and preserves the original answer on failure', () => {
    const requestHash = hashEnterpriseAtoaRequest('request');
    const store = ledger();
    store.stageGenerated({
      ...baseKey,
      requestHash,
      answer: '需要重放的原始答案',
      grantedSources: ['current_chat'],
    });

    clock = new Date('2026-08-22T08:01:00.000Z');
    expect(store.markSubmitting({ ...baseKey, requestHash })).toMatchObject({
      status: 'submitting',
      attempts: 1,
      lastAttemptAt: clock.toISOString(),
      error: null,
    });
    clock = new Date('2026-08-22T08:02:00.000Z');
    expect(
      store.markSubmissionFailed({
        ...baseKey,
        requestHash,
        error: 'network response was lost',
      }),
    ).toMatchObject({
      status: 'generated',
      attempts: 1,
      error: 'network response was lost',
      answer: '需要重放的原始答案',
    });
    clock = new Date('2026-08-22T08:03:00.000Z');
    expect(store.markSubmitting({ ...baseKey, requestHash }).attempts).toBe(2);
    expect(store.markSubmitted({ ...baseKey, requestHash })).toMatchObject({
      status: 'submitted',
      attempts: 2,
      submittedAt: clock.toISOString(),
      error: null,
    });
  });

  it('rejects modified protected content instead of treating it as absent', () => {
    const requestHash = hashEnterpriseAtoaRequest('request');
    const store = ledger();
    store.stageGenerated({
      ...baseKey,
      requestHash,
      answer: '不可篡改答案',
      grantedSources: [],
    });
    const [name] = readdirSync(directory);
    const filePath = path.join(directory, name!);
    const envelope = JSON.parse(readFileSync(filePath, 'utf8')) as {
      ciphertext: string;
    };
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    ciphertext[0] = ciphertext[0]! ^ 1;
    envelope.ciphertext = ciphertext.toString('base64');
    writeFileSync(filePath, JSON.stringify(envelope), 'utf8');

    expect(() => store.load({ ...baseKey, requestHash })).toThrow(
      'ciphertext authentication failed',
    );
  });

  it('expires only old submitted results and never deletes pending work', () => {
    const store = ledger();
    const submittedHash = hashEnterpriseAtoaRequest('submitted request');
    const pendingHash = hashEnterpriseAtoaRequest('pending request');
    const recentHash = hashEnterpriseAtoaRequest('recent submitted request');
    const pendingKey = { ...baseKey, requestMessageId: 'pending_request' };
    const recentKey = { ...baseKey, requestMessageId: 'recent_request' };

    store.stageGenerated({
      ...baseKey,
      requestHash: submittedHash,
      answer: '已完成',
      grantedSources: [],
    });
    store.markSubmitting({ ...baseKey, requestHash: submittedHash });
    store.markSubmitted({ ...baseKey, requestHash: submittedHash });
    store.stageGenerated({
      ...pendingKey,
      requestHash: pendingHash,
      answer: '仍待提交',
      grantedSources: [],
    });

    clock = new Date('2026-08-22T10:00:00.000Z');
    store.stageGenerated({
      ...recentKey,
      requestHash: recentHash,
      answer: '刚完成',
      grantedSources: [],
    });
    store.markSubmitting({ ...recentKey, requestHash: recentHash });
    store.markSubmitted({ ...recentKey, requestHash: recentHash });

    expect(store.cleanupSubmitted()).toEqual({ removed: 1, retained: 2 });
    expect(store.load({ ...baseKey, requestHash: submittedHash })).toBeNull();
    expect(
      store.load({ ...pendingKey, requestHash: pendingHash }),
    ).toMatchObject({
      status: 'generated',
      answer: '仍待提交',
    });
    expect(store.load({ ...recentKey, requestHash: recentHash })).toMatchObject(
      {
        status: 'submitted',
        answer: '刚完成',
      },
    );
  });

  it('fails closed during cleanup if a ledger file cannot be authenticated', () => {
    const requestHash = hashEnterpriseAtoaRequest('request');
    const store = ledger();
    store.stageGenerated({
      ...baseKey,
      requestHash,
      answer: '答案',
      grantedSources: [],
    });
    const [name] = readdirSync(directory);
    writeFileSync(path.join(directory, name!), 'not protected data', 'utf8');

    expect(() => store.cleanupSubmitted()).toThrow('cleanup validation failed');
    expect(readdirSync(directory)).toEqual([name]);
  });
});
