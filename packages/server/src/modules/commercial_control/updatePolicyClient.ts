/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { DeploymentUpdatePolicyCredentials } from './deploymentRepository.js';
import { canonicalJson, verifyEd25519Envelope } from './signedEnvelope.js';

const DISTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/u;
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;
const POLICY_MAX_LIFETIME_MS = 60 * 60 * 1000;

export type DeploymentUpdateChannel = 'canary' | 'stable' | 'required';

export interface DeploymentUpdateManifestReference {
  url: string;
  sha256: string;
}
export interface DeploymentResolvedUpdatePolicy {
  version: 1;
  deploymentId: string;
  distributionId: string;
  currentVersion: string;
  decision: 'update' | 'none';
  reason: 'update_available' | 'up_to_date' | 'outside_rollout' | 'no_active_release';
  release: {
    id: string;
    version: string;
    sourceCommit: string;
    channel: DeploymentUpdateChannel;
    mandatory: boolean;
    rolloutPercent: number;
    notes: string;
    fullManifest: DeploymentUpdateManifestReference | null;
    incrementalManifest: DeploymentUpdateManifestReference | null;
    publishedAt: string;
  } | null;
  issuedAtMs: number;
  expiresAtMs: number;
}

export type DeploymentUpdatePolicyResult =
  | {
      status: 'resolved';
      policy: DeploymentResolvedUpdatePolicy;
      verifiedKeyId: string;
    }
  | {
      status: 'not_configured';
      reason: 'online_license_required' | 'verification_key_missing';
    }
  | { status: 'unavailable'; error: string };

export interface ResolveDeploymentUpdatePolicyOptions {
  credentials: DeploymentUpdatePolicyCredentials | null;
  verificationPublicKeys: readonly string[];
  distributionId: string;
  currentVersion: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/gu, ' ').slice(0, 300) || 'update policy unavailable';
}

function controlEndpoint(leaseEndpoint: string): string {
  const endpoint = new URL(leaseEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new Error('License control endpoint must use HTTPS without credentials');
  }
  return new URL('/v1/update-policy/resolve', endpoint).toString();
}

function requestSignature(
  token: string,
  timestamp: number,
  nonce: string,
  body: unknown,
): string {
  return 'hmac-sha256:' + createHmac('sha256', token)
    .update(`${timestamp}\n${nonce}\n${canonicalJson(body)}`, 'utf8')
    .digest('base64url');
}

function manifestReference(value: unknown): DeploymentUpdateManifestReference | null {
  if (value === null) return null;
  if (!isObject(value) || typeof value.url !== 'string' || typeof value.sha256 !== 'string') {
    throw new Error('signed update policy contains an invalid manifest reference');
  }
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('signed update policy manifest must use HTTPS without credentials');
  }
  if (!SHA256_PATTERN.test(value.sha256)) {
    throw new Error('signed update policy manifest SHA-256 is invalid');
  }
  return { url: url.toString(), sha256: value.sha256 };
}

function parsePolicy(
  value: unknown,
  expected: {
    deploymentId: string;
    distributionId: string;
    currentVersion: string;
    now: number;
  },
): DeploymentResolvedUpdatePolicy {
  if (!isObject(value) || value.version !== 1) {
    throw new Error('signed update policy version is invalid');
  }
  if (
    value.deploymentId !== expected.deploymentId
    || value.distributionId !== expected.distributionId
    || value.currentVersion !== expected.currentVersion
  ) {
    throw new Error('signed update policy binding mismatch');
  }
  if (value.decision !== 'update' && value.decision !== 'none') {
    throw new Error('signed update policy decision is invalid');
  }
  if (!['update_available', 'up_to_date', 'outside_rollout', 'no_active_release'].includes(
    String(value.reason),
  )) {
    throw new Error('signed update policy reason is invalid');
  }
  const issuedAtMs = Number(value.issuedAtMs);
  const expiresAtMs = Number(value.expiresAtMs);
  if (
    !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || issuedAtMs > expected.now + 5 * 60 * 1000
    || expiresAtMs <= expected.now
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > POLICY_MAX_LIFETIME_MS
  ) {
    throw new Error('signed update policy lifetime is invalid');
  }
  let release: DeploymentResolvedUpdatePolicy['release'] = null;
  if (value.release !== null) {
    if (!isObject(value.release)) throw new Error('signed update release is invalid');
    const channel = String(value.release.channel) as DeploymentUpdateChannel;
    const rolloutPercent = Number(value.release.rolloutPercent);
    if (
      typeof value.release.id !== 'string'
      || typeof value.release.version !== 'string'
      || !SEMVER_PATTERN.test(value.release.version)
      || typeof value.release.sourceCommit !== 'string'
      || !SOURCE_COMMIT_PATTERN.test(value.release.sourceCommit)
      || !['canary', 'stable', 'required'].includes(channel)
      || !Number.isInteger(rolloutPercent)
      || rolloutPercent < 1
      || rolloutPercent > 100
      || typeof value.release.notes !== 'string'
      || typeof value.release.publishedAt !== 'string'
      || Number.isNaN(Date.parse(value.release.publishedAt))
    ) {
      throw new Error('signed update release metadata is invalid');
    }
    const fullManifest = manifestReference(value.release.fullManifest);
    const incrementalManifest = manifestReference(value.release.incrementalManifest);
    if (!fullManifest && !incrementalManifest) {
      throw new Error('signed update release has no manifest');
    }
    if (value.release.mandatory !== (channel === 'required')) {
      throw new Error('signed update release mandatory flag is invalid');
    }
    release = {
      id: value.release.id,
      version: value.release.version,
      sourceCommit: value.release.sourceCommit,
      channel,
      mandatory: value.release.mandatory,
      rolloutPercent,
      notes: value.release.notes,
      fullManifest,
      incrementalManifest,
      publishedAt: value.release.publishedAt,
    };
  }
  if ((value.decision === 'update') !== Boolean(release)) {
    throw new Error('signed update policy decision and release disagree');
  }
  return {
    version: 1,
    deploymentId: expected.deploymentId,
    distributionId: expected.distributionId,
    currentVersion: expected.currentVersion,
    decision: value.decision,
    reason: value.reason as DeploymentResolvedUpdatePolicy['reason'],
    release,
    issuedAtMs,
    expiresAtMs,
  };
}

export async function resolveDeploymentUpdatePolicy(
  options: ResolveDeploymentUpdatePolicyOptions,
): Promise<DeploymentUpdatePolicyResult> {
  if (!DISTRIBUTION_ID_PATTERN.test(options.distributionId)) {
    return { status: 'unavailable', error: 'update distribution id is invalid' };
  }
  if (!SEMVER_PATTERN.test(options.currentVersion)) {
    return { status: 'unavailable', error: 'current app version is invalid' };
  }
  if (!options.credentials) {
    return { status: 'not_configured', reason: 'online_license_required' };
  }
  if (options.verificationPublicKeys.length === 0) {
    return { status: 'not_configured', reason: 'verification_key_missing' };
  }
  const now = options.now?.() ?? Date.now();
  const body = {
    version: 1,
    licenseId: options.credentials.licenseId,
    deploymentId: options.credentials.deploymentId,
    machineFingerprint: options.credentials.machineFingerprint,
    distributionId: options.distributionId,
    currentVersion: options.currentVersion.replace(/^v/u, ''),
  };
  const timestamp = now;
  const nonce = randomUUID();
  try {
    const response = await (options.fetchImpl ?? fetch)(
      controlEndpoint(options.credentials.leaseEndpoint),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.credentials.leaseToken}`,
          'content-type': 'application/json',
          'user-agent': 'Otto-Private-Deployment/1',
          'x-otto-timestamp': String(timestamp),
          'x-otto-nonce': nonce,
          'x-otto-signature': requestSignature(
            options.credentials.leaseToken,
            timestamp,
            nonce,
            body,
          ),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) throw new Error(`control endpoint returned ${response.status}`);
    const envelope = await response.json() as unknown;
    if (!isObject(envelope) || typeof envelope.signature !== 'string') {
      throw new Error('control endpoint returned an invalid signed envelope');
    }
    const verification = verifyEd25519Envelope(
      envelope.policy,
      envelope.signature,
      options.verificationPublicKeys,
      typeof envelope.signingKeyId === 'string' ? envelope.signingKeyId : null,
    );
    if (!verification.valid || !verification.keyId) {
      throw new Error('control update policy signature is invalid');
    }
    return {
      status: 'resolved',
      policy: parsePolicy(envelope.policy, {
        deploymentId: options.credentials.deploymentId,
        distributionId: options.distributionId,
        currentVersion: body.currentVersion,
        now,
      }),
      verifiedKeyId: verification.keyId,
    };
  } catch (error) {
    return { status: 'unavailable', error: safeError(error) };
  }
}
