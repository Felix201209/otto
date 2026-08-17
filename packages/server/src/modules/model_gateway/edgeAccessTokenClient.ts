/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomUUID } from 'node:crypto';
import { canonicalJson } from '../commercial_control/signedEnvelope.js';

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u;
const NONCE_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/u;
const SIGNATURE_PATTERN = /^ed25519:[a-zA-Z0-9_-]{86}$/u;
const MAX_MODELS = 64;
const MAX_MODEL_LENGTH = 160;
const MAX_TOKEN_DURATION_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface EdgeGatewayDeploymentCredentials {
  licenseId: string;
  deploymentId: string;
  organizationId: string;
  machineFingerprint: string;
  leaseToken: string;
  leaseEndpoint: string;
  edgeGatewayUrl: string;
}

export interface EdgeGatewayAccessGrant {
  baseUrl: string;
  accessToken: string;
  expiresAtMs: number;
  allowedModels: string[];
}

export interface RequestEdgeGatewayAccessTokenOptions {
  credentials: EdgeGatewayDeploymentCredentials;
  subjectId: string;
  allowedModels: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
}

export class EdgeGatewayAccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeGatewayAccessTokenError';
  }
}

function fail(message: string): never {
  throw new EdgeGatewayAccessTokenError(message);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], name: string): void {
  const expected = new Set(fields);
  if (Object.keys(value).length !== expected.size
    || Object.keys(value).some((field) => !expected.has(field))) {
    fail(`${name} is invalid`);
  }
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function leaseToken(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16_384 || /\s/u.test(value)) {
    fail('License lease token is invalid');
  }
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function secureUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} is invalid`);
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname)))
  ) {
    fail(`${name} must use HTTPS without credentials, query, or fragment`);
  }
  return parsed;
}

function edgeOrigin(value: string): string {
  const parsed = secureUrl(value, 'Edge gateway URL');
  if (parsed.pathname !== '/') {
    fail('Edge gateway URL must be an origin without a path');
  }
  return parsed.origin;
}

function controlAccessTokenEndpoint(value: string): string {
  const parsed = secureUrl(value, 'License control endpoint');
  return new URL('/v1/edge-gateway/access-tokens', parsed.origin).toString();
}

function normalizedModels(value: readonly string[]): string[] {
  if (value.length < 1 || value.length > MAX_MODELS) {
    fail('Allowed models are invalid');
  }
  const models = value.map((model) => {
    if (typeof model !== 'string') fail('Allowed models are invalid');
    const normalized = model.trim();
    if (!normalized || normalized.length > MAX_MODEL_LENGTH) {
      fail('Allowed models are invalid');
    }
    return normalized;
  });
  if (new Set(models).size !== models.length) {
    fail('Allowed models must be unique');
  }
  return models;
}

function requestSignature(token: string, timestamp: number, nonce: string, body: unknown): string {
  return 'hmac-sha256:' + createHmac('sha256', token)
    .update(`${timestamp}\n${nonce}\n${canonicalJson(body)}`, 'utf8')
    .digest('base64url');
}

interface ParsedAccessToken {
  envelope: Record<string, unknown>;
  token: Record<string, unknown>;
  encodedToken: string;
}

function decodeEnvelope(encodedToken: string): unknown {
  if (!/^[a-zA-Z0-9_-]{1,16384}$/u.test(encodedToken)) {
    fail('Control access token is malformed');
  }
  try {
    const bytes = Buffer.from(encodedToken, 'base64url');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(json) as unknown;
  } catch {
    fail('Control access token is malformed');
  }
}

function parseResponse(value: unknown): ParsedAccessToken {
  const response = objectValue(value, 'Control access token response');
  exactFields(response, ['envelope', 'encodedToken'], 'Control access token response');
  if (typeof response.encodedToken !== 'string') {
    fail('Control access token is malformed');
  }
  const envelope = objectValue(response.envelope, 'Control access token envelope');
  exactFields(
    envelope,
    ['token', 'signingKeyId', 'signature'],
    'Control access token envelope',
  );
  identifier(envelope.signingKeyId, 'Control signing key id');
  if (typeof envelope.signature !== 'string' || !SIGNATURE_PATTERN.test(envelope.signature)) {
    fail('Control access token signature is malformed');
  }
  const token = objectValue(envelope.token, 'Control access token');
  exactFields(token, [
    'version',
    'tokenId',
    'deploymentId',
    'organizationId',
    'subjectId',
    'scope',
    'policyVersion',
    'allowedModels',
    'issuedAtMs',
    'expiresAtMs',
  ], 'Control access token');
  const decoded = decodeEnvelope(response.encodedToken);
  if (canonicalJson(decoded) !== canonicalJson(envelope)) {
    fail('Encoded Control access token does not match its envelope');
  }
  return { envelope, token, encodedToken: response.encodedToken };
}

function validateToken(
  parsed: ParsedAccessToken,
  expected: {
    deploymentId: string;
    organizationId: string;
    subjectId: string;
    allowedModels: readonly string[];
    now: number;
  },
): EdgeGatewayAccessGrant {
  const token = parsed.token;
  if (token.version !== 1 || token.scope !== 'model_gateway') {
    fail('Control access token contract is invalid');
  }
  identifier(token.tokenId, 'Control access token id');
  identifier(token.policyVersion, 'Control edge policy version');
  if (
    token.deploymentId !== expected.deploymentId
    || token.organizationId !== expected.organizationId
    || token.subjectId !== expected.subjectId
  ) {
    fail('Control access token binding mismatch');
  }
  if (!Array.isArray(token.allowedModels)) {
    fail('Control access token model binding is invalid');
  }
  const tokenModels = normalizedModels(token.allowedModels as string[]);
  const requestedModels = new Set(expected.allowedModels);
  if (tokenModels.some((model) => !requestedModels.has(model))) {
    fail('Control access token model binding mismatch');
  }
  const issuedAtMs = Number(token.issuedAtMs);
  const expiresAtMs = Number(token.expiresAtMs);
  if (
    !Number.isSafeInteger(issuedAtMs)
    || !Number.isSafeInteger(expiresAtMs)
    || issuedAtMs < 1
    || expiresAtMs <= expected.now
    || issuedAtMs > expected.now + MAX_CLOCK_SKEW_MS
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MAX_TOKEN_DURATION_MS
  ) {
    fail('Control access token lifetime is invalid');
  }
  return {
    baseUrl: '',
    accessToken: parsed.encodedToken,
    expiresAtMs,
    allowedModels: tokenModels,
  };
}

export async function requestEdgeGatewayAccessToken(
  options: RequestEdgeGatewayAccessTokenOptions,
): Promise<EdgeGatewayAccessGrant> {
  const credentials = options.credentials;
  const edgeGatewayOrigin = edgeOrigin(credentials.edgeGatewayUrl);
  const endpoint = controlAccessTokenEndpoint(credentials.leaseEndpoint);
  const token = leaseToken(credentials.leaseToken);
  const licenseId = identifier(credentials.licenseId, 'License id');
  const deploymentId = identifier(credentials.deploymentId, 'Deployment id');
  const organizationId = identifier(credentials.organizationId, 'Organization id');
  const machineFingerprint = identifier(
    credentials.machineFingerprint,
    'Machine fingerprint',
  );
  const subjectId = identifier(options.subjectId, 'Subject id');
  const allowedModels = normalizedModels(options.allowedModels);
  const timestamp = options.now?.() ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) fail('Request timestamp is invalid');
  const nonce = options.nonce?.() ?? randomUUID();
  if (!NONCE_PATTERN.test(nonce)) fail('Request nonce is invalid');
  const body = {
    licenseId,
    deploymentId,
    organizationId,
    machineFingerprint,
    subjectId,
    allowedModels,
  };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'Otto-Private-Deployment/1',
        'x-otto-timestamp': String(timestamp),
        'x-otto-nonce': nonce,
        'x-otto-signature': requestSignature(token, timestamp, nonce, body),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('Control access token request failed');
  }
  if (response.status !== 201) {
    fail(`Control access token request was rejected (${response.status})`);
  }

  let raw: unknown;
  try {
    raw = await response.json() as unknown;
  } catch {
    fail('Control access token response is malformed');
  }
  const grant = validateToken(parseResponse(raw), {
    deploymentId,
    organizationId,
    subjectId,
    allowedModels,
    now: timestamp,
  });
  return {
    ...grant,
    baseUrl: `${edgeGatewayOrigin}/v1`,
  };
}
