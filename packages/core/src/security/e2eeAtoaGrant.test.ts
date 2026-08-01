/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  E2EE_ATOA_GRANT_FORMAT,
  E2eeAtoaGrantLedger,
  e2eeAtoaGrantDigest,
  e2eeAtoaGrantPayload,
  e2eeAtoaRequestDigest,
  verifyE2eeAtoaOneTimeGrant,
  type E2eeAtoaOneTimeGrant,
} from './e2eeAtoaGrant.js';

function fixture(): {
  grant: E2eeAtoaOneTimeGrant;
  publicKey: string;
  expected: Parameters<typeof verifyE2eeAtoaOneTimeGrant>[0]['expected'];
} {
  const keys = generateKeyPairSync('ed25519');
  const expected = {
    issuerDeploymentId: 'dep_receiver',
    audienceDeploymentId: 'dep_requester',
    organizationId: 'org_1',
    issuerAccountId: 'account_receiver',
    requesterAccountId: 'account_requester',
    requestMessageId: 'message_1',
    requestDigest: e2eeAtoaRequestDigest({
      requestMessageId: 'message_1',
      requesterAccountId: 'account_requester',
      recipientAccountId: 'account_receiver',
      content: 'Can you check the approved schedule?',
    }),
  };
  const unsigned: E2eeAtoaOneTimeGrant = {
    format: E2EE_ATOA_GRANT_FORMAT,
    grantId: 'grant_1',
    ...expected,
    issuerDeviceId: 'device_receiver',
    allowedSources: ['current_chat', 'schedules'],
    authorizedMessageIds: ['chat_2', 'chat_1'],
    issuedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:03:00.000Z',
    nonce: 'nonce_1',
    signature: '',
  };
  return {
    grant: {
      ...unsigned,
      signature: sign(null, e2eeAtoaGrantPayload(unsigned), keys.privateKey).toString(
        'base64',
      ),
    },
    publicKey: keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    expected,
  };
}

describe('E2EE A2A one-time grant', () => {
  it('binds the signed grant to one request and exact local data selection', () => {
    const value = fixture();
    expect(
      verifyE2eeAtoaOneTimeGrant({
        grant: value.grant,
        issuerSigningPublicKey: value.publicKey,
        expected: value.expected,
        now: new Date('2026-08-01T00:01:00.000Z'),
      }),
    ).toMatchObject({
      allowedSources: ['current_chat', 'schedules'],
      authorizedMessageIds: ['chat_1', 'chat_2'],
    });
    expect(
      e2eeAtoaGrantDigest({
        ...value.grant,
        signature: `${value.grant.signature}\n`,
      }),
    ).toBe(e2eeAtoaGrantDigest(value.grant));
  });

  it('rejects replay, tampering, expiry, and cross-deployment reuse', () => {
    const value = fixture();
    const ledger = new E2eeAtoaGrantLedger();
    const input = {
      grant: value.grant,
      issuerSigningPublicKey: value.publicKey,
      expected: value.expected,
      now: new Date('2026-08-01T00:01:00.000Z'),
    };
    expect(() => ledger.consume(input)).not.toThrow();
    expect(() => ledger.consume(input)).toThrow('already consumed');
    expect(() =>
      verifyE2eeAtoaOneTimeGrant({
        ...input,
        expected: { ...value.expected, audienceDeploymentId: 'dep_attacker' },
      }),
    ).toThrow('audienceDeploymentId');
    expect(() =>
      verifyE2eeAtoaOneTimeGrant({
        ...input,
        grant: {
          ...value.grant,
          allowedSources: ['current_chat', 'work_logs'],
        },
      }),
    ).toThrow('signature');
    expect(() =>
      verifyE2eeAtoaOneTimeGrant({
        ...input,
        now: new Date('2026-08-01T00:04:00.000Z'),
      }),
    ).toThrow('not currently valid');
  });
});
