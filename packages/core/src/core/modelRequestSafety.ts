/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

export const MODEL_REQUEST_ID_PREFIX = 'otto-model-';
export const EDGE_REQUEST_STATE_HEADER = 'x-otto-provider-request-state';
export const PROVIDER_REQUEST_ID_HEADER = 'x-otto-provider-request-id';

const MODEL_REQUEST_ID_PATTERN =
  /^otto-model-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFINITELY_NOT_CONNECTED_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
]);

export type ModelRequestState = 'not_sent' | 'unknown_outcome';

export type ModelTransportFailureKind =
  | 'connection_not_established'
  | 'http_error'
  | 'network_error'
  | 'other'
  | 'response_lost'
  | 'slow_stream'
  | 'socket_reset'
  | 'stream_interrupted'
  | 'timeout';

export interface HeaderReader {
  get(name: string): string | null;
}

export type ModelSafetyHeaders =
  | HeaderReader
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface ClassifyModelRequestFailureInput {
  requestId: string;
  message: string;
  kind: ModelTransportFailureKind;
  cause?: unknown;
  edgeRequestState?: string | null;
  headers?: ModelSafetyHeaders;
  httpStatus?: number;
  providerRequestId?: string | null;
  receivedResponseHeaders?: boolean;
  receivedStreamData?: boolean;
}

export interface ModelProviderSwitchRiskPrompt {
  kind: 'model_provider_switch_unknown_outcome';
  riskCode: 'POSSIBLE_DUPLICATE_CHARGE_AND_DATA_DISCLOSURE';
  requestId: string;
  providerRequestId?: string;
  targetProviderName?: string;
  requiresExplicitConfirmation: true;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

/**
 * An error safe to pass between Core, Edge clients and UI boundaries.
 * `confirmedNotSent` is deliberately redundant: consumers can fail closed
 * without inferring retry safety from message text or an HTTP status.
 */
export class ModelRequestSafetyError extends Error {
  readonly requestId: string;
  readonly requestState: ModelRequestState;
  readonly providerRequestId?: string;
  readonly confirmedNotSent: boolean;

  constructor(input: {
    message: string;
    requestId: string;
    requestState: ModelRequestState;
    providerRequestId?: string;
    cause?: unknown;
  }) {
    assertValidModelRequestId(input.requestId);
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'ModelRequestSafetyError';
    this.requestId = input.requestId;
    this.requestState = input.requestState;
    this.providerRequestId = input.providerRequestId;
    this.confirmedNotSent = input.requestState === 'not_sent';
  }
}

export function isValidModelRequestId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_REQUEST_ID_PATTERN.test(value);
}

export function assertValidModelRequestId(value: unknown): asserts value is string {
  if (!isValidModelRequestId(value)) {
    throw new Error('model request id must be a canonical Otto UUID request id');
  }
}

export function generateModelRequestId(
  uuidFactory: () => string = randomUUID,
): string {
  const requestId = `${MODEL_REQUEST_ID_PREFIX}${uuidFactory().toLowerCase()}`;
  assertValidModelRequestId(requestId);
  return requestId;
}

function headerValue(
  headers: ModelSafetyHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    return headers.get(name)?.trim() || undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    const scalar = Array.isArray(value) ? value[0] : value;
    return scalar?.trim() || undefined;
  }
  return undefined;
}

function safeProviderRequestId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 200 || Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    return undefined;
  }
  return normalized;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  if (typeof code === 'string') return code.toUpperCase();
  return errorCode(Reflect.get(error, 'cause'));
}

function edgeExplicitlyConfirmedNotSent(
  input: ClassifyModelRequestFailureInput,
): boolean {
  const state = input.edgeRequestState?.trim().toLowerCase()
    ?? headerValue(input.headers, EDGE_REQUEST_STATE_HEADER)?.toLowerCase();
  return state === 'not_sent';
}

function isIntrinsicallyUnknown(input: ClassifyModelRequestFailureInput): boolean {
  if (input.receivedStreamData) return true;
  if (input.httpStatus === 429 || (input.httpStatus !== undefined && input.httpStatus >= 500)) {
    return true;
  }
  return new Set<ModelTransportFailureKind>([
    'response_lost',
    'slow_stream',
    'socket_reset',
    'stream_interrupted',
    'timeout',
  ]).has(input.kind);
}

/**
 * Classifies transport failures without guessing from human-readable messages.
 * Intrinsically ambiguous failures and partial streams remain unknown even when
 * a conflicting `not_sent` marker is present.
 */
export function classifyModelRequestFailure(
  input: ClassifyModelRequestFailureInput,
): ModelRequestSafetyError {
  assertValidModelRequestId(input.requestId);
  const providerRequestId = safeProviderRequestId(
    input.providerRequestId
      ?? headerValue(input.headers, PROVIDER_REQUEST_ID_HEADER),
  );
  const definitelyNotConnected =
    input.kind === 'connection_not_established'
    && DEFINITELY_NOT_CONNECTED_CODES.has(errorCode(input.cause) ?? '')
    && !input.receivedResponseHeaders
    && !input.receivedStreamData;
  const confirmedNotSent =
    !isIntrinsicallyUnknown(input)
    && (edgeExplicitlyConfirmedNotSent(input) || definitelyNotConnected);

  return new ModelRequestSafetyError({
    message: input.message,
    requestId: input.requestId,
    requestState: confirmedNotSent ? 'not_sent' : 'unknown_outcome',
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

export function canAutomaticallyRetryModelRequest(
  error: ModelRequestSafetyError,
): boolean {
  return error.requestState === 'not_sent' && error.confirmedNotSent;
}

/**
 * Builds a stable UI contract for the only safe action after an ambiguous
 * outcome: explain duplicate cost/data exposure and require an explicit click.
 */
export function buildProviderSwitchRiskPrompt(
  error: ModelRequestSafetyError,
  targetProviderName?: string,
): ModelProviderSwitchRiskPrompt {
  if (canAutomaticallyRetryModelRequest(error)) {
    throw new Error('a confirmed not-sent request does not require a provider switch warning');
  }
  const provider = targetProviderName?.trim().slice(0, 100) || undefined;
  return {
    kind: 'model_provider_switch_unknown_outcome',
    riskCode: 'POSSIBLE_DUPLICATE_CHARGE_AND_DATA_DISCLOSURE',
    requestId: error.requestId,
    ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}),
    ...(provider ? { targetProviderName: provider } : {}),
    requiresExplicitConfirmation: true,
    title: '上一次模型请求结果未知',
    message:
      '上一家模型供应商可能已经收到请求并产生费用。切换供应商会再次发送本次内容，可能造成重复计费，并让另一家供应商接触相同数据。请确认是否继续。',
    confirmLabel: '仍然切换并重试',
    cancelLabel: '取消',
  };
}
