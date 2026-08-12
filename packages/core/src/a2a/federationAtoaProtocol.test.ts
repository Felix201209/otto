/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildFederationAtoaDecision,
  parseFederationAtoaDecision,
} from './federationAtoaProtocol.js';

describe('federated A2A decision protocol', () => {
  it('round-trips an approved one-time grant', () => {
    const content = buildFederationAtoaDecision({
      status: 'approved',
      requestId: 'request_one',
      requestMessageId: 'message_one',
      grantId: 'grant_one',
      scope: 'otto.a2a.0123456789abcdef',
      expiresAt: '2026-08-12T12:10:00.000Z',
      grantedSources: ['enterprise_knowledge', 'schedules'],
      createdAt: '2026-08-12T12:00:00.000Z',
    });

    expect(parseFederationAtoaDecision(content)).toEqual({
      v: 1,
      status: 'approved',
      requestId: 'request_one',
      requestMessageId: 'message_one',
      grantId: 'grant_one',
      scope: 'otto.a2a.0123456789abcdef',
      expiresAt: '2026-08-12T12:10:00.000Z',
      grantedSources: ['enterprise_knowledge', 'schedules'],
      createdAt: '2026-08-12T12:00:00.000Z',
    });
  });

  it('round-trips denial without a grant', () => {
    const content = buildFederationAtoaDecision({
      status: 'denied',
      requestId: 'request_two',
      requestMessageId: 'message_two',
      createdAt: '2026-08-12T12:00:00.000Z',
    });

    expect(parseFederationAtoaDecision(content)).toMatchObject({
      status: 'denied',
      requestId: 'request_two',
      requestMessageId: 'message_two',
    });
  });

  it('rejects malformed, expired-at-creation and unknown-source decisions', () => {
    expect(parseFederationAtoaDecision('ordinary message')).toBeNull();
    expect(parseFederationAtoaDecision(
      'OTTO_FEDERATION_ATOA_DECISION {bad-json',
    )).toBeNull();
    expect(parseFederationAtoaDecision(
      'OTTO_FEDERATION_ATOA_DECISION ' + JSON.stringify({
        v: 1,
        status: 'approved',
        requestId: 'request_three',
        requestMessageId: 'message_three',
        grantId: 'grant_three',
        scope: 'otto.a2a.scope',
        expiresAt: '2026-08-12T11:59:00.000Z',
        createdAt: '2026-08-12T12:00:00.000Z',
        grantedSources: ['filesystem'],
      }),
    )).toBeNull();
  });
});
