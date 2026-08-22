/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  EDGE_REQUEST_STATE_HEADER,
  PROVIDER_REQUEST_ID_HEADER,
  ModelRequestSafetyError,
  buildProviderSwitchRiskPrompt,
  canAutomaticallyRetryModelRequest,
  classifyModelRequestFailure,
  generateModelRequestId,
  isValidModelRequestId,
} from './modelRequestSafety.js';

const requestId = 'otto-model-123e4567-e89b-42d3-a456-426614174000';

function failure(
  overrides: Partial<Parameters<typeof classifyModelRequestFailure>[0]> = {},
) {
  return classifyModelRequestFailure({
    requestId,
    message: 'model request failed',
    kind: 'other',
    ...overrides,
  });
}

describe('model request identity', () => {
  it('generates a canonical request id from a UUID source', () => {
    expect(generateModelRequestId(
      () => '123E4567-E89B-42D3-A456-426614174000',
    )).toBe(requestId);
    expect(isValidModelRequestId(requestId)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    '123e4567-e89b-42d3-a456-426614174000',
    'otto-model-123E4567-E89B-42D3-A456-426614174000',
    'otto-model-123e4567-e89b-02d3-a456-426614174000',
    `${requestId} `,
  ])('rejects a non-canonical request id: %s', (value) => {
    expect(isValidModelRequestId(value)).toBe(false);
  });

  it('fails closed when the UUID source is malformed', () => {
    expect(() => generateModelRequestId(() => 'not-a-uuid')).toThrow(
      'canonical Otto UUID',
    );
  });
});

describe('model request outcome classification', () => {
  it.each([
    [{ [EDGE_REQUEST_STATE_HEADER]: 'not_sent' }],
    [{ [EDGE_REQUEST_STATE_HEADER.toUpperCase()]: ' NOT_SENT ' }],
    [{ get: (name: string) => name === EDGE_REQUEST_STATE_HEADER ? 'not_sent' : null }],
  ])('allows automatic retry only for an explicit Edge not_sent header', (headers) => {
    const error = failure({
      kind: 'connection_not_established',
      headers,
    });
    expect(error).toMatchObject({
      requestId,
      requestState: 'not_sent',
      confirmedNotSent: true,
    });
    expect(canAutomaticallyRetryModelRequest(error)).toBe(true);
  });

  it('accepts a structured Edge not_sent state and carries a bounded provider id', () => {
    const error = failure({
      kind: 'connection_not_established',
      edgeRequestState: 'not_sent',
      headers: { [PROVIDER_REQUEST_ID_HEADER]: ' provider-42 ' },
    });
    expect(error.requestState).toBe('not_sent');
    expect(error.providerRequestId).toBe('provider-42');
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])(
    'allows retry for a coded connection-not-established failure: %s',
    (code) => {
      const error = failure({
        kind: 'connection_not_established',
        cause: { cause: { code } },
      });
      expect(error.requestState).toBe('not_sent');
      expect(canAutomaticallyRetryModelRequest(error)).toBe(true);
    },
  );

  it('does not trust a connection error phrase without a coded failure', () => {
    const error = failure({
      kind: 'connection_not_established',
      cause: new Error('ECONNREFUSED while connecting'),
    });
    expect(error.requestState).toBe('unknown_outcome');
    expect(canAutomaticallyRetryModelRequest(error)).toBe(false);
  });

  it.each([
    ['timeout', undefined],
    ['response_lost', undefined],
    ['socket_reset', undefined],
    ['slow_stream', undefined],
    ['stream_interrupted', undefined],
    ['http_error', 429],
    ['http_error', 500],
    ['http_error', 502],
    ['http_error', 503],
    ['http_error', 504],
  ] as const)('treats %s/%s as an unknown outcome', (kind, httpStatus) => {
    const error = failure({
      kind,
      httpStatus,
      edgeRequestState: 'not_sent',
    });
    expect(error.requestState).toBe('unknown_outcome');
    expect(error.confirmedNotSent).toBe(false);
    expect(canAutomaticallyRetryModelRequest(error)).toBe(false);
  });

  it.each([
    { receivedStreamData: true },
    { receivedResponseHeaders: true, receivedStreamData: true },
  ])('partial stream activity overrides a conflicting not_sent claim: %o', (activity) => {
    const error = failure({
      kind: 'connection_not_established',
      edgeRequestState: 'not_sent',
      ...activity,
    });
    expect(error.requestState).toBe('unknown_outcome');
  });

  it('trusts an Edge not_sent response for an ordinary rejected request', () => {
    const error = failure({
      kind: 'http_error',
      httpStatus: 400,
      receivedResponseHeaders: true,
      edgeRequestState: 'not_sent',
    });
    expect(error.requestState).toBe('not_sent');
    expect(canAutomaticallyRetryModelRequest(error)).toBe(true);
  });

  it('keeps an ordinary HTTP rejection unknown without an Edge not_sent marker', () => {
    const error = failure({
      kind: 'http_error',
      httpStatus: 400,
      receivedResponseHeaders: true,
    });
    expect(error.requestState).toBe('unknown_outcome');
    expect(canAutomaticallyRetryModelRequest(error)).toBe(false);
  });

  it('drops unsafe provider request ids instead of copying control characters', () => {
    const error = failure({
      providerRequestId: `provider\nforged`,
    });
    expect(error.providerRequestId).toBeUndefined();
  });

  it('rejects an invalid request id before classifying the failure', () => {
    expect(() => failure({ requestId: 'invalid' })).toThrow(
      'canonical Otto UUID',
    );
  });
});

describe('provider switch confirmation contract', () => {
  it('warns about duplicate charges and additional data disclosure', () => {
    const error = failure({
      kind: 'response_lost',
      providerRequestId: 'upstream-123',
    });
    const prompt = buildProviderSwitchRiskPrompt(error, ' Backup Provider ');
    expect(prompt).toMatchObject({
      kind: 'model_provider_switch_unknown_outcome',
      riskCode: 'POSSIBLE_DUPLICATE_CHARGE_AND_DATA_DISCLOSURE',
      requestId,
      providerRequestId: 'upstream-123',
      targetProviderName: 'Backup Provider',
      requiresExplicitConfirmation: true,
    });
    expect(prompt.message).toContain('重复计费');
    expect(prompt.message).toContain('另一家供应商');
  });

  it('refuses to build a warning for a request confirmed not sent', () => {
    const error = failure({
      kind: 'connection_not_established',
      edgeRequestState: 'not_sent',
    });
    expect(() => buildProviderSwitchRiskPrompt(error)).toThrow(
      'does not require a provider switch warning',
    );
  });

  it('keeps error metadata stable and sets the original cause', () => {
    const cause = new Error('response disappeared');
    const error = failure({ kind: 'response_lost', cause });
    expect(error).toBeInstanceOf(ModelRequestSafetyError);
    expect(error.name).toBe('ModelRequestSafetyError');
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('model request failed');
  });
});
