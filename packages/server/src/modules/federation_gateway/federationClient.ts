/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type {
  ClaimedFederationEnvelope,
  FederationDirectoryEntry,
  FederationDirectoryKey,
  FederationEnvelope,
  FederationQueueInput,
  FederationSignedRequest,
  SignedFederationEnvelope,
} from './federationContracts.js';
import {
  federationPublicKeyId,
  verifyFederationEnvelopeSignature,
  type FederationPayloadSigner,
} from './federationCrypto.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SCOPE = /^[a-z][a-z0-9._:-]{1,63}$/u;
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60_000;
const MAXIMUM_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60_000;
const FEDERATION_MESSAGE_TYPE_SET = new Set([
  'chat.message',
  'chat.receipt',
  'a2a.request',
  'a2a.response',
]);
const OTTO_FEDERATION_CAPABILITIES = [
  'federation.v1',
  'chat.e2ee',
  'a2a.e2ee',
  'attachment.e2ee',
] as const;

export class FederationGatewayError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    status: number;
    code?: string | null;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = 'FederationGatewayError';
    this.status = input.status;
    this.code = input.code ?? null;
    this.retryable = input.retryable ?? (
      input.status === 408 || input.status === 409 || input.status === 425 ||
      input.status === 429 || input.status >= 500
    );
  }
}

export interface FederationClientOptions {
  baseUrl: string;
  deploymentId: string;
  signer: FederationPayloadSigner;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
  now?: () => number;
  allowInsecureLoopback?: boolean;
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function exactIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'string' || value.length > 64) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must use canonical UTC ISO format`);
  }
  return parsed;
}

function validateClaimedEnvelope(
  raw: unknown,
  recipientDeploymentId: string,
  now: number,
): SignedFederationEnvelope & { claimToken: string } {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gateway returned an invalid federation envelope');
  }
  const signed = raw as Partial<SignedFederationEnvelope> & {
    claimToken?: unknown;
  };
  if (!signed.envelope || typeof signed.envelope !== 'object') {
    throw new Error('gateway returned an invalid federation envelope');
  }
  const envelope = signed.envelope as FederationEnvelope;
  if (
    envelope.version !== 1 ||
    !FEDERATION_MESSAGE_TYPE_SET.has(envelope.type)
  ) {
    throw new Error('gateway returned an unsupported federation envelope');
  }
  exactIdentifier(envelope.messageId, 'message id');
  exactIdentifier(envelope.senderDeploymentId, 'sender deployment id');
  exactIdentifier(envelope.recipientDeploymentId, 'recipient deployment id');
  if (
    envelope.recipientDeploymentId !== recipientDeploymentId ||
    envelope.senderDeploymentId === envelope.recipientDeploymentId
  ) {
    throw new Error('gateway returned a federation envelope for an invalid route');
  }
  const issuedAt = canonicalTimestamp(envelope.issuedAt, 'issued at');
  const expiresAt = canonicalTimestamp(envelope.expiresAt, 'expires at');
  if (
    issuedAt > now + MAXIMUM_CLOCK_SKEW_MS ||
    expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAXIMUM_ENVELOPE_TTL_MS
  ) {
    throw new Error('gateway returned an expired or invalid federation envelope');
  }
  if (typeof envelope.nonce !== 'string' || !NONCE.test(envelope.nonce)) {
    throw new Error('gateway returned an invalid federation nonce');
  }
  if (envelope.contentType !== 'application/otto-e2ee+json') {
    throw new Error('gateway returned an invalid federation content type');
  }
  if (
    typeof envelope.ciphertext !== 'string' ||
    !BASE64URL.test(envelope.ciphertext) ||
    Buffer.byteLength(envelope.ciphertext, 'utf8') > 1024 * 1024
  ) {
    throw new Error('gateway returned an invalid federation ciphertext');
  }
  if (!envelope.routing || typeof envelope.routing !== 'object') {
    throw new Error('gateway returned invalid federation routing metadata');
  }
  exactIdentifier(envelope.routing.conversationId, 'conversation id');
  exactIdentifier(envelope.routing.senderPrincipalId, 'sender principal id');
  exactIdentifier(envelope.routing.recipientPrincipalId, 'recipient principal id');
  if (envelope.routing.inReplyTo !== undefined) {
    exactIdentifier(envelope.routing.inReplyTo, 'reply message id');
  }
  if (envelope.routing.a2aGrantId !== undefined) {
    exactIdentifier(envelope.routing.a2aGrantId, 'A2A grant id');
  }
  if (
    envelope.routing.a2aScope !== undefined &&
    !SCOPE.test(envelope.routing.a2aScope)
  ) {
    throw new Error('gateway returned an invalid A2A scope');
  }
  if (envelope.routing.attachmentIds !== undefined) {
    if (
      !Array.isArray(envelope.routing.attachmentIds) ||
      envelope.routing.attachmentIds.length > 6 ||
      new Set(envelope.routing.attachmentIds).size !==
        envelope.routing.attachmentIds.length
    ) {
      throw new Error('gateway returned invalid federation attachments');
    }
    for (const attachmentId of envelope.routing.attachmentIds) {
      exactIdentifier(attachmentId, 'attachment id');
    }
  }
  if (
    envelope.type === 'a2a.request' &&
    (!envelope.routing.a2aGrantId || !envelope.routing.a2aScope)
  ) {
    throw new Error('gateway returned an unscoped A2A request');
  }
  if (
    (envelope.type === 'a2a.response' || envelope.type === 'chat.receipt') &&
    !envelope.routing.inReplyTo
  ) {
    throw new Error('gateway returned an uncorrelated federation response');
  }
  exactIdentifier(signed.signingKeyId, 'signing key id');
  if (
    typeof signed.signature !== 'string' || signed.signature.length > 256 ||
    typeof signed.claimToken !== 'string' || !signed.claimToken ||
    signed.claimToken.length > 256
  ) {
    throw new Error('gateway returned invalid federation delivery credentials');
  }
  return signed as SignedFederationEnvelope & { claimToken: string };
}

function normalizedGatewayOrigin(
  value: string,
  allowInsecureLoopback: boolean,
): string {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(allowInsecureLoopback && loopback && url.protocol === 'http:')
  ) {
    throw new Error('federation gateway URL must use HTTPS');
  }
  if (
    url.username || url.password || url.search || url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'federation gateway URL must be an origin without credentials or path',
    );
  }
  return url.origin;
}

function requestNonce(): string {
  return `nonce_${randomBytes(24).toString('base64url')}`;
}

async function signedPayload(
  signer: FederationPayloadSigner,
  request: unknown,
): Promise<{ signingKeyId: string; signature: string }> {
  return {
    signingKeyId: signer.keyId,
    signature: await signer.sign(request),
  };
}

export class FederationGatewayClient {
  readonly #baseUrl: string;
  readonly #deploymentId: string;
  readonly #signer: FederationPayloadSigner;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #now: () => number;

  constructor(options: FederationClientOptions) {
    this.#baseUrl = normalizedGatewayOrigin(
      options.baseUrl,
      options.allowInsecureLoopback ?? false,
    );
    this.#deploymentId = identifier(options.deploymentId, 'deployment id');
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 16 * 1024 * 1024;
    this.#now = options.now ?? Date.now;
    if (this.#timeoutMs < 500 || this.#timeoutMs > 30_000) {
      throw new Error('federation timeout must be between 500 and 30000 ms');
    }
    if (
      this.#maximumResponseBytes < 64 * 1024 ||
      this.#maximumResponseBytes > 128 * 1024 * 1024
    ) {
      throw new Error('federation response limit is invalid');
    }
  }

  get capabilities(): readonly string[] {
    return OTTO_FEDERATION_CAPABILITIES;
  }

  get deploymentId(): string {
    return this.#deploymentId;
  }

  get gatewayOrigin(): string {
    return this.#baseUrl;
  }

  async createSignedEnvelope(
    input: FederationQueueInput,
  ): Promise<SignedFederationEnvelope> {
    const now = this.#now();
    const expiresInMs = input.expiresInMs ?? 24 * 60 * 60_000;
    if (expiresInMs < 60_000 || expiresInMs > 7 * 24 * 60 * 60_000) {
      throw new Error('federation message lifetime must be 1 minute to 7 days');
    }
    if (
      !input.ciphertext || !BASE64URL.test(input.ciphertext) ||
      Buffer.byteLength(input.ciphertext, 'utf8') > 1024 * 1024
    ) {
      throw new Error('federation ciphertext must be between 1 byte and 1 MiB');
    }
    if (!FEDERATION_MESSAGE_TYPE_SET.has(input.type)) {
      throw new Error('federation message type is invalid');
    }
    const routing = {
      conversationId: identifier(input.routing.conversationId, 'conversation id'),
      senderPrincipalId: identifier(input.routing.senderPrincipalId, 'sender principal id'),
      recipientPrincipalId: identifier(
        input.routing.recipientPrincipalId,
        'recipient principal id',
      ),
      ...(input.routing.inReplyTo === undefined ? {} : {
        inReplyTo: identifier(input.routing.inReplyTo, 'reply message id'),
      }),
      ...(input.routing.a2aGrantId === undefined ? {} : {
        a2aGrantId: identifier(input.routing.a2aGrantId, 'A2A grant id'),
      }),
      ...(input.routing.a2aScope === undefined ? {} : {
        a2aScope: input.routing.a2aScope,
      }),
      ...(input.routing.attachmentIds === undefined ? {} : {
        attachmentIds: [...new Set(input.routing.attachmentIds.map(
          (attachmentId) => identifier(attachmentId, 'attachment id'),
        ))],
      }),
    };
    if ((routing.attachmentIds?.length ?? 0) > 6) {
      throw new Error('federation message supports at most 6 attachments');
    }
    if (routing.a2aScope !== undefined && !SCOPE.test(routing.a2aScope)) {
      throw new Error('A2A scope is invalid');
    }
    if (
      input.type === 'a2a.request' &&
      (!routing.a2aGrantId || !routing.a2aScope)
    ) {
      throw new Error('A2A request requires a scoped one-time grant');
    }
    if (
      (input.type === 'a2a.response' || input.type === 'chat.receipt') &&
      !routing.inReplyTo
    ) {
      throw new Error('federation response requires a referenced message');
    }
    const recipientDeploymentId = identifier(
      input.recipientDeploymentId,
      'recipient deployment id',
    );
    if (recipientDeploymentId === this.#deploymentId) {
      throw new Error('federation messages must cross deployment boundaries');
    }
    const envelope: FederationEnvelope = {
      version: 1,
      messageId: input.messageId
        ? identifier(input.messageId, 'message id')
        : `fmsg_${randomUUID().replaceAll('-', '')}`,
      type: input.type,
      senderDeploymentId: this.#deploymentId,
      recipientDeploymentId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      nonce: requestNonce(),
      contentType: 'application/otto-e2ee+json',
      ciphertext: input.ciphertext,
      routing,
    };
    return {
      envelope,
      ...await signedPayload(this.#signer, envelope),
    };
  }

  async sendSignedEnvelope(signed: SignedFederationEnvelope): Promise<{
    accepted: boolean;
    duplicate: boolean;
    messageId: string;
    status: string;
  }> {
    if (signed.envelope.senderDeploymentId !== this.#deploymentId) {
      throw new Error('cannot send an envelope for another deployment');
    }
    return this.#request('/v1/federation/envelopes', signed);
  }

  async directoryEntry(deploymentId: string): Promise<FederationDirectoryEntry> {
    return this.#request(
      `/v1/federation/directory/${encodeURIComponent(identifier(deploymentId, 'deployment id'))}`,
      undefined,
      'GET',
    );
  }

  async directoryKey(
    deploymentId: string,
    keyId: string,
  ): Promise<FederationDirectoryKey> {
    return this.#request(
      `/v1/federation/directory/${encodeURIComponent(identifier(deploymentId, 'deployment id'))}` +
      `/keys/${encodeURIComponent(identifier(keyId, 'key id'))}`,
      undefined,
      'GET',
    );
  }

  async claim(limit = 20): Promise<ClaimedFederationEnvelope[]> {
    const response = await this.#request<{
      messages: unknown;
    }>(
      '/v1/federation/inbox/claim',
      await this.#signedRequest({ limit }),
    );
    if (!Array.isArray(response.messages) || response.messages.length > 100) {
      throw new Error('gateway returned an invalid federation claim batch');
    }
    const claimed: ClaimedFederationEnvelope[] = [];
    for (const raw of response.messages) {
      const item = validateClaimedEnvelope(raw, this.#deploymentId, this.#now());
      const key = await this.directoryKey(
        item.envelope.senderDeploymentId,
        item.signingKeyId,
      );
      if (
        key.deploymentId !== item.envelope.senderDeploymentId ||
        key.keyId !== item.signingKeyId ||
        federationPublicKeyId(key.publicKeyPem) !== key.keyId
      ) {
        throw new Error('federation directory returned a mismatched key');
      }
      const issuedAt = Date.parse(item.envelope.issuedAt);
      const notBefore = Date.parse(key.notBefore);
      const expiresAt = key.expiresAt === null ? null : Date.parse(key.expiresAt);
      if (
        !Number.isFinite(issuedAt) || !Number.isFinite(notBefore) ||
        (expiresAt !== null && !Number.isFinite(expiresAt)) ||
        issuedAt < notBefore || (expiresAt !== null && issuedAt >= expiresAt)
      ) {
        throw new Error('federation envelope key was outside its validity window');
      }
      verifyFederationEnvelopeSignature({
        payload: item.envelope,
        signature: item.signature,
        publicKeyPem: key.publicKeyPem,
      });
      claimed.push({
        signed: {
          envelope: item.envelope,
          signingKeyId: item.signingKeyId,
          signature: item.signature,
        },
        claimToken: item.claimToken,
      });
    }
    return claimed;
  }

  async acknowledge(messageId: string, claimToken: string): Promise<void> {
    await this.#request(
      '/v1/federation/inbox/ack',
      await this.#signedRequest({
        messageId: identifier(messageId, 'message id'),
        claimToken,
      }),
    );
  }

  async createA2aGrant(input: {
    requesterDeploymentId: string;
    ownerPrincipalId: string;
    requesterPrincipalId: string;
    scopes: string[];
    expiresInMs?: number;
    grantId?: string;
  }): Promise<{ id: string; expiresAt: string; maxUses: number; usedCount: number }> {
    const expiresInMs = input.expiresInMs ?? 10 * 60_000;
    if (expiresInMs < 60_000 || expiresInMs > 24 * 60 * 60_000) {
      throw new Error('A2A grant lifetime must be 1 minute to 24 hours');
    }
    return this.#request(
      '/v1/federation/a2a/grants',
      await this.#signedRequest({
        grantId: input.grantId,
        requesterDeploymentId: input.requesterDeploymentId,
        ownerPrincipalId: input.ownerPrincipalId,
        requesterPrincipalId: input.requesterPrincipalId,
        scopes: input.scopes,
        maxUses: 1,
        grantExpiresAt: new Date(this.#now() + expiresInMs).toISOString(),
      }),
    );
  }

  async revokeA2aGrant(grantId: string): Promise<void> {
    await this.#request(
      '/v1/federation/a2a/grants/revoke',
      await this.#signedRequest({ grantId: identifier(grantId, 'grant id') }),
    );
  }

  async createAttachmentUpload(input: {
    recipientDeploymentId: string;
    attachmentId: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
    expiresInMs?: number;
  }): Promise<{
    attachment: Record<string, unknown>;
    duplicate: boolean;
    upload: {
      method: 'PUT';
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
    } | null;
  }> {
    const expiresInMs = input.expiresInMs ?? 24 * 60 * 60_000;
    if (expiresInMs < 60_000 || expiresInMs > MAXIMUM_ENVELOPE_TTL_MS) {
      throw new Error('federation attachment lifetime must be 1 minute to 7 days');
    }
    return this.#request(
      '/v1/federation/attachments/uploads',
      await this.#signedRequest({
        recipientDeploymentId: identifier(
          input.recipientDeploymentId,
          'recipient deployment id',
        ),
        attachmentId: identifier(input.attachmentId, 'attachment id'),
        ciphertextBytes: input.ciphertextBytes,
        ciphertextSha256: input.ciphertextSha256,
        attachmentExpiresAt: new Date(this.#now() + expiresInMs).toISOString(),
      }),
    );
  }

  async completeAttachmentUpload(
    attachmentId: string,
  ): Promise<{ attachment: Record<string, unknown> }> {
    return this.#request(
      '/v1/federation/attachments/complete',
      await this.#signedRequest({
        attachmentId: identifier(attachmentId, 'attachment id'),
      }),
    );
  }

  async createAttachmentDownload(attachmentId: string): Promise<{
    attachment: Record<string, unknown>;
    download: {
      method: 'GET';
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
    };
  }> {
    return this.#request(
      '/v1/federation/attachments/download',
      await this.#signedRequest({
        attachmentId: identifier(attachmentId, 'attachment id'),
      }),
    );
  }

  async status(): Promise<Record<string, unknown>> {
    return this.#request('/v1/federation/status', undefined, 'GET');
  }

  async #signedRequest<T extends Record<string, unknown>>(
    fields: T,
  ): Promise<FederationSignedRequest<T>> {
    const now = this.#now();
    const request = {
      version: 1 as const,
      deploymentId: this.#deploymentId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      nonce: requestNonce(),
      ...fields,
    };
    return { request, ...await signedPayload(this.#signer, request) };
  }

  async #request<T>(
    path: string,
    body?: unknown,
    method = 'POST',
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new FederationGatewayError({
        status: 0,
        retryable: true,
        message: error instanceof Error
          ? `federation gateway is unavailable: ${error.message}`
          : 'federation gateway is unavailable',
      });
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel();
      throw new FederationGatewayError({
        status: response.status,
        message: 'federation gateway returned an unexpected content type',
      });
    }
    const text = await this.#boundedResponseText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new FederationGatewayError({
        status: response.status,
        message: 'federation gateway returned invalid JSON',
      });
    }
    if (!response.ok) {
      const errorPayload = payload && typeof payload === 'object' &&
        'error' in payload && payload.error && typeof payload.error === 'object'
        ? payload.error as Record<string, unknown>
        : {};
      throw new FederationGatewayError({
        status: response.status,
        code: typeof errorPayload.code === 'string' ? errorPayload.code : null,
        message: typeof errorPayload.message === 'string'
          ? errorPayload.message
          : `federation request failed (${response.status})`,
      });
    }
    return payload as T;
  }

  async #boundedResponseText(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > this.#maximumResponseBytes
    ) {
      await response.body?.cancel();
      throw new FederationGatewayError({
        status: response.status,
        message: 'federation gateway response is too large',
      });
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.#maximumResponseBytes) {
        await reader.cancel();
        throw new FederationGatewayError({
          status: response.status,
          message: 'federation gateway response is too large',
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
