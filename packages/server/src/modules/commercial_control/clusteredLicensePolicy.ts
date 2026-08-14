/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  canonicalLicenseCapabilityId,
  type OrganizationFeatureKey,
} from '../../productModules.js';
import { createHash } from 'node:crypto';

import { canonicalJson, verifyEd25519Envelope } from './signedEnvelope.js';

export interface ClusteredStoredLicense {
  payload: Record<string, unknown>;
  version?: number;
  updatedAt?: string;
}

export interface ClusteredLicenseSeatAdmission {
  recordVersion: number;
  signature: string;
  claimsSha256: string;
  seatLimit: number;
}

export interface ClusteredLicenseSummary {
  id: string | null;
  status: 'missing' | 'invalid' | 'expired' | 'expiring' | 'active';
  plan: string;
  expiresAt: string;
  seatLimit: number;
  activeSeatCount: number;
  seatLimitExceeded: boolean;
  modules: string[];
  offline: boolean;
  enforce: true;
  updatedAt: string | null;
}

export type ClusteredLicenseDecision =
  | {
      allowed: true;
      summary: ClusteredLicenseSummary;
      seatAdmission: ClusteredLicenseSeatAdmission;
    }
  | {
      allowed: false;
      statusCode: 402;
      code:
        | 'deployment_license_inactive'
        | 'license_verification_unavailable'
        | 'deployment_seat_limit_exceeded'
        | 'commercial_module_not_entitled';
      error: string;
      feature?: OrganizationFeatureKey;
      summary: ClusteredLicenseSummary;
    };

interface SignedLicenseEnvelope {
  payload: Record<string, unknown>;
  signature: string;
  signingKeyId: string | null;
}

const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function envelope(value: unknown): SignedLicenseEnvelope | null {
  const candidate = record(value);
  const payload = record(candidate?.payload);
  const signature = candidate?.signature;
  const signingKeyId = candidate?.signingKeyId;
  if (
    !payload ||
    typeof signature !== 'string' ||
    (signingKeyId !== null && typeof signingKeyId !== 'string')
  ) {
    return null;
  }
  return { payload, signature, signingKeyId };
}

function unavailableSummary(
  status: ClusteredLicenseSummary['status'],
  activeSeatCount: number,
  updatedAt: string | null,
): ClusteredLicenseSummary {
  return {
    id: null,
    status,
    plan: 'unlicensed',
    expiresAt: '',
    seatLimit: 0,
    activeSeatCount,
    seatLimitExceeded: activeSeatCount > 0,
    modules: [],
    offline: true,
    enforce: true,
    updatedAt,
  };
}

function denied(
  summary: ClusteredLicenseSummary,
  code: Exclude<ClusteredLicenseDecision, { allowed: true }>['code'],
  error: string,
  feature?: OrganizationFeatureKey,
): ClusteredLicenseDecision {
  return {
    allowed: false,
    statusCode: 402,
    code,
    error,
    ...(feature ? { feature } : {}),
    summary,
  };
}

/**
 * Verifies the original signed claims on every business admission. The
 * normalized PostgreSQL columns are presentation data only and are never an
 * authorization authority.
 */
export function evaluateClusteredLicense(input: {
  stored: ClusteredStoredLicense | null;
  organizationId: string;
  deploymentId: string;
  activeSeatCount: number;
  requiredFeature?: OrganizationFeatureKey | null;
  allowSeatOverage?: boolean;
  publicKeys: readonly string[];
  nowMs?: number;
}): ClusteredLicenseDecision {
  const updatedAt = input.stored?.updatedAt ?? null;
  if (!input.stored) {
    return denied(
      unavailableSummary('missing', input.activeSeatCount, updatedAt),
      'deployment_license_inactive',
      'deployment license is not active',
    );
  }
  if (input.publicKeys.length === 0) {
    return denied(
      unavailableSummary('invalid', input.activeSeatCount, updatedAt),
      'license_verification_unavailable',
      'license verification keys are unavailable',
    );
  }
  const signed = envelope(input.stored.payload.signedEnvelope);
  if (!signed) {
    return denied(
      unavailableSummary('invalid', input.activeSeatCount, updatedAt),
      'deployment_license_inactive',
      'deployment license signature evidence is unavailable',
    );
  }
  const verification = verifyEd25519Envelope(
    signed.payload,
    signed.signature,
    input.publicKeys,
    signed.signingKeyId,
  );
  const claims = signed.payload;
  const expiresAtMs = Number(
    claims.expiresAtMs ?? Date.parse(String(claims.expiresAt ?? '')),
  );
  const seatLimit = Math.floor(Number(claims.seatLimit ?? 0));
  const rawModules = Array.isArray(claims.modules)
    ? claims.modules.filter((item): item is string => typeof item === 'string')
    : [];
  const modules = [
    ...new Set(
      rawModules
        .map((module) => canonicalLicenseCapabilityId(module))
        .filter((module): module is string => Boolean(module)),
    ),
  ];
  if (
    !verification.valid ||
    claims.deploymentId !== input.deploymentId ||
    claims.organizationId !== input.organizationId ||
    !Number.isFinite(expiresAtMs) ||
    seatLimit < 1 ||
    modules.length !== new Set(rawModules).size
  ) {
    return denied(
      unavailableSummary('invalid', input.activeSeatCount, updatedAt),
      'deployment_license_inactive',
      'deployment license is invalid',
    );
  }
  const nowMs = input.nowMs ?? Date.now();
  const expiresAt = new Date(expiresAtMs).toISOString();
  const status =
    expiresAtMs <= nowMs
      ? 'expired'
      : expiresAtMs - nowMs <= EXPIRING_WINDOW_MS
        ? 'expiring'
        : 'active';
  const summary: ClusteredLicenseSummary = {
    id: typeof claims.id === 'string' ? claims.id : null,
    status,
    plan: typeof claims.plan === 'string' ? claims.plan : 'enterprise',
    expiresAt,
    seatLimit,
    activeSeatCount: input.activeSeatCount,
    seatLimitExceeded: input.activeSeatCount > seatLimit,
    modules,
    offline: claims.offline !== false,
    enforce: true,
    updatedAt,
  };
  if (status === 'expired') {
    return denied(
      summary,
      'deployment_license_inactive',
      'deployment license is expired',
    );
  }
  if (summary.seatLimitExceeded && input.allowSeatOverage !== true) {
    return denied(
      summary,
      'deployment_seat_limit_exceeded',
      'deployment seat limit is exceeded',
    );
  }
  const feature = input.requiredFeature ?? null;
  if (feature && !modules.includes(feature)) {
    return denied(
      summary,
      'commercial_module_not_entitled',
      'commercial module is not entitled',
      feature,
    );
  }
  if (
    !Number.isSafeInteger(input.stored.version) ||
    input.stored.version! < 1
  ) {
    return denied(
      unavailableSummary('invalid', input.activeSeatCount, updatedAt),
      'deployment_license_inactive',
      'deployment license record version is invalid',
    );
  }
  return {
    allowed: true,
    summary,
    seatAdmission: {
      recordVersion: input.stored.version!,
      signature: signed.signature,
      claimsSha256: createHash('sha256')
        .update(canonicalJson(signed.payload))
        .digest('hex'),
      seatLimit,
    },
  };
}
