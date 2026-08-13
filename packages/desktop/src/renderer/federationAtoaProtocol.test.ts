/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildFederationAtoaDecision,
  displayFederationAtoaDecision,
  FEDERATION_ATOA_DECISION_PREFIX,
  parseFederationAtoaDecision,
} from './federationAtoaProtocol.js';

describe('renderer federation A2A protocol', () => {
  it('normalizes and displays an approved one-time grant', () => {
    const content = buildFederationAtoaDecision({
      status: 'approved',
      requestId: 'request-1',
      requestMessageId: 'message-1',
      grantId: 'grant-1',
      scope: 'work_logs.read',
      createdAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2026-08-13T00:05:00.000Z',
      grantedSources: ['work_logs', 'current_chat', 'work_logs'],
    });
    const decision = parseFederationAtoaDecision(content);

    expect(decision).toMatchObject({
      status: 'approved',
      grantId: 'grant-1',
      grantedSources: ['current_chat', 'work_logs'],
    });
    expect(decision && displayFederationAtoaDecision(decision)).toContain(
      'Otto',
    );
  });

  it('round-trips a denied decision without adding grant fields', () => {
    const content = buildFederationAtoaDecision({
      status: 'denied',
      requestId: 'request-2',
      requestMessageId: 'message-2',
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    const decision = parseFederationAtoaDecision(content);

    expect(decision).toEqual({
      v: 1,
      status: 'denied',
      requestId: 'request-2',
      requestMessageId: 'message-2',
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    expect(decision && displayFederationAtoaDecision(decision)).toContain(
      'Otto',
    );
  });

  it('rejects malformed, expired, and out-of-scope decisions', () => {
    const base = {
      v: 1,
      status: 'approved',
      requestId: 'request-1',
      requestMessageId: 'message-1',
      grantId: 'grant-1',
      scope: 'work_logs.read',
      grantedSources: ['work_logs'],
      createdAt: '2026-08-13T00:05:00.000Z',
      expiresAt: '2026-08-13T00:00:00.000Z',
    };
    const serialize = (payload: object): string =>
      FEDERATION_ATOA_DECISION_PREFIX + JSON.stringify(payload);

    expect(parseFederationAtoaDecision(serialize(base))).toBeNull();
    expect(
      parseFederationAtoaDecision(
        `${FEDERATION_ATOA_DECISION_PREFIX}{bad-json`,
      ),
    ).toBeNull();
    expect(parseFederationAtoaDecision('ordinary message')).toBeNull();
    expect(
      parseFederationAtoaDecision(
        serialize({
          ...base,
          expiresAt: '2026-08-13T00:10:00.000Z',
          grantedSources: ['all_files'],
        }),
      ),
    ).toBeNull();
  });
});
