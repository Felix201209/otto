/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildAtoaResponse,
  buildFederationAtoaDecision,
  parseAtoaRequest,
  parseFederationAtoaDecision,
} from './federation-atoa-protocol.js';

describe('federation A2A main-process protocol', () => {
  it('strictly parses the existing A2A request wire format', () => {
    const content = 'OTTO_ATOA_REQUEST ' + JSON.stringify({
      v: 1,
      id: 'request_one',
      question: '对方今天是否方便开会？',
      createdAt: '2026-08-12T12:00:00.000Z',
      mode: 'answer',
      requestedSources: ['schedules'],
    });

    expect(parseAtoaRequest(content)).toMatchObject({
      id: 'request_one',
      mode: 'answer',
      requestedSources: ['schedules'],
    });
  });

  it('rejects unknown sources and oversized questions', () => {
    for (const payload of [
      {
        v: 1,
        id: 'request_bad_source',
        question: 'test',
        createdAt: '2026-08-12T12:00:00.000Z',
        mode: 'answer',
        requestedSources: ['filesystem'],
      },
      {
        v: 1,
        id: 'request_oversized',
        question: 'x'.repeat(1201),
        createdAt: '2026-08-12T12:00:00.000Z',
        mode: 'answer',
        requestedSources: [],
      },
    ]) {
      expect(parseAtoaRequest(
        'OTTO_ATOA_REQUEST ' + JSON.stringify(payload),
      )).toBeNull();
    }
  });

  it('keeps decisions and replies bounded for the encrypted conversation', () => {
    const decision = buildFederationAtoaDecision({
      status: 'approved',
      requestId: 'request_one',
      requestMessageId: 'message_one',
      grantId: 'grant_one',
      scope: 'otto.a2a.0123456789abcdef',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      grantedSources: ['enterprise_knowledge'],
    });
    expect(parseFederationAtoaDecision(decision)).toMatchObject({
      status: 'approved',
      grantId: 'grant_one',
    });

    const response = buildAtoaResponse({
      requestId: 'request_one',
      question: 'question',
      answer: '答'.repeat(4000),
      mode: 'answer',
      grantedSources: ['enterprise_knowledge'],
    });
    expect(Buffer.byteLength(response, 'utf8')).toBeLessThanOrEqual(4000);
  });
});
