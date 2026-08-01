/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * A2A grants are deliberately short-lived and single-use. They authorize one
 * local Otto invocation; they are not bearer tokens for server APIs.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';

import {
  ATOA_CONTEXT_SOURCES,
  type AtoaContextSource,
} from '../a2a/atoaProtocol.js';
import { canonicalE2eeBytes } from './e2eeTrustV2.js';

export const E2EE_ATOA_GRANT_FORMAT = 1 as const;
export const E2EE_ATOA_GRANT_MAX_LIFETIME_MS = 5 * 60 * 1000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export interface E2eeAtoaOneTimeGrant {
  format: 1;
  grantId: string;
  issuerDeploymentId: string;
  audienceDeploymentId: string;
  organizationId: string;
  issuerAccountId: string;
  issuerDeviceId: string;
  requesterAccountId: string;
  requestMessageId: string;
  requestDigest: string;
  allowedSources: AtoaContextSource[];
  authorizedMessageIds: string[];
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface E2eeAtoaGrantExpectation {
  issuerDeploymentId: string;
  audienceDeploymentId: string;
  organizationId: string;
  issuerAccountId: string;
  requesterAccountId: string;
  requestMessageId: string;
  requestDigest: string;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function isoDate(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return new Date(milliseconds).toISOString();
}

function digest(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizedGrant(
  input: E2eeAtoaOneTimeGrant,
): Omit<E2eeAtoaOneTimeGrant, 'signature'> {
  const issuedAt = isoDate(input.issuedAt, 'A2A grant issue time');
  const expiresAt = isoDate(input.expiresAt, 'A2A grant expiry');
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > E2EE_ATOA_GRANT_MAX_LIFETIME_MS) {
    throw new Error('A2A grant lifetime is invalid');
  }
  if (!Array.isArray(input.allowedSources)) {
    throw new Error('A2A grant sources are invalid');
  }
  const allowedSources = ATOA_CONTEXT_SOURCES.filter((source) =>
    input.allowedSources.includes(source),
  );
  if (
    allowedSources.length !== new Set(input.allowedSources).size ||
    allowedSources.length !== input.allowedSources.length
  ) {
    throw new Error('A2A grant sources are invalid');
  }
  if (
    !Array.isArray(input.authorizedMessageIds) ||
    input.authorizedMessageIds.length > 40
  ) {
    throw new Error('A2A grant message selection is invalid');
  }
  const authorizedMessageIds = [
    ...new Set(
      input.authorizedMessageIds.map((value) =>
        identifier(value, 'A2A authorized message id'),
      ),
    ),
  ].sort();
  if (authorizedMessageIds.length !== input.authorizedMessageIds.length) {
    throw new Error('A2A grant message selection is invalid');
  }
  if (
    authorizedMessageIds.length > 0 &&
    !allowedSources.includes('current_chat')
  ) {
    throw new Error('A2A chat messages require current_chat authorization');
  }
  return {
    format: E2EE_ATOA_GRANT_FORMAT,
    grantId: identifier(input.grantId, 'A2A grant id'),
    issuerDeploymentId: identifier(
      input.issuerDeploymentId,
      'A2A issuer deployment id',
    ),
    audienceDeploymentId: identifier(
      input.audienceDeploymentId,
      'A2A audience deployment id',
    ),
    organizationId: identifier(input.organizationId, 'organization id'),
    issuerAccountId: identifier(input.issuerAccountId, 'issuer account id'),
    issuerDeviceId: identifier(input.issuerDeviceId, 'issuer device id'),
    requesterAccountId: identifier(
      input.requesterAccountId,
      'requester account id',
    ),
    requestMessageId: identifier(input.requestMessageId, 'request message id'),
    requestDigest: digest(input.requestDigest, 'request digest'),
    allowedSources,
    authorizedMessageIds,
    issuedAt,
    expiresAt,
    nonce: identifier(input.nonce, 'A2A grant nonce'),
  };
}

export function e2eeAtoaGrantPayload(input: E2eeAtoaOneTimeGrant): Buffer {
  return canonicalE2eeBytes(
    'otto:e2ee-atoa-one-time-grant:v1',
    normalizedGrant(input),
  );
}

export function e2eeAtoaRequestDigest(input: {
  requestMessageId: string;
  requesterAccountId: string;
  recipientAccountId: string;
  content: string;
}): string {
  return createHash('sha256')
    .update(
      canonicalE2eeBytes('otto:e2ee-atoa-request:v1', {
        requestMessageId: identifier(
          input.requestMessageId,
          'request message id',
        ),
        requesterAccountId: identifier(
          input.requesterAccountId,
          'requester account id',
        ),
        recipientAccountId: identifier(
          input.recipientAccountId,
          'recipient account id',
        ),
        content: input.content,
      }),
    )
    .digest('hex');
}

export function e2eeAtoaGrantDigest(input: E2eeAtoaOneTimeGrant): string {
  const signature = Buffer.from(input.signature, 'base64');
  if (signature.length !== 64) throw new Error('A2A grant signature is invalid');
  return createHash('sha256')
    .update(
      canonicalE2eeBytes(
        'otto:e2ee-atoa-one-time-grant-signed:v1',
        normalizedGrant(input),
      ),
    )
    .update(signature)
    .digest('hex');
}

export function verifyE2eeAtoaOneTimeGrant(input: {
  grant: E2eeAtoaOneTimeGrant;
  issuerSigningPublicKey: string;
  expected: E2eeAtoaGrantExpectation;
  now?: Date;
}): Omit<E2eeAtoaOneTimeGrant, 'signature'> {
  const normalized = normalizedGrant(input.grant);
  const signature = Buffer.from(input.grant.signature, 'base64');
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      canonicalE2eeBytes('otto:e2ee-atoa-one-time-grant:v1', normalized),
      createPublicKey(input.issuerSigningPublicKey),
      signature,
    )
  ) {
    throw new Error('A2A grant signature is invalid');
  }
  const expected = input.expected;
  for (const field of [
    'issuerDeploymentId',
    'audienceDeploymentId',
    'organizationId',
    'issuerAccountId',
    'requesterAccountId',
    'requestMessageId',
    'requestDigest',
  ] as const) {
    if (normalized[field] !== expected[field]) {
      throw new Error(`A2A grant ${field} does not match the request`);
    }
  }
  const now = (input.now ?? new Date()).getTime();
  if (now < Date.parse(normalized.issuedAt) - 30_000 || now >= Date.parse(normalized.expiresAt)) {
    throw new Error('A2A grant is not currently valid');
  }
  return normalized;
}

export class E2eeAtoaGrantLedger {
  private readonly consumed = new Set<string>();

  consume(input: {
    grant: E2eeAtoaOneTimeGrant;
    issuerSigningPublicKey: string;
    expected: E2eeAtoaGrantExpectation;
    now?: Date;
  }): Omit<E2eeAtoaOneTimeGrant, 'signature'> {
    const normalized = verifyE2eeAtoaOneTimeGrant(input);
    const replayKey = `${normalized.issuerDeploymentId}:${normalized.organizationId}:${normalized.issuerAccountId}:${normalized.requestMessageId}:${normalized.nonce}`;
    if (this.consumed.has(replayKey)) {
      throw new Error('A2A grant was already consumed');
    }
    this.consumed.add(replayKey);
    return normalized;
  }
}
