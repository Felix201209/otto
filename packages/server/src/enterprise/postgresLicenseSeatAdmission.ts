/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../modules/commercial_control/signedEnvelope.js';
import type { PostgresClientLike } from '../modules/data_platform/postgresDatabaseLifecycle.js';

export interface PostgresLicenseSeatAdmission {
  recordVersion: number;
  signature: string;
  claimsSha256: string;
  seatLimit: number;
}

export class PostgresEnterpriseSeatLimitError extends Error {
  constructor() {
    super('enterprise seat limit exceeded');
    this.name = 'PostgresEnterpriseSeatLimitError';
  }
}

export class PostgresEnterpriseLicenseAdmissionError extends Error {
  constructor() {
    super('deployment license changed during seat admission');
    this.name = 'PostgresEnterpriseLicenseAdmissionError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Serializes all seat-producing writes for one tenant and pins the transaction
 * to the exact signed License record verified by the HTTP execution layer.
 */
export async function enforcePostgresEnterpriseSeatAdmission(
  database: PostgresClientLike,
  organizationId: string,
  admission: PostgresLicenseSeatAdmission,
  nowMs = Date.now(),
): Promise<void> {
  if (
    !Number.isSafeInteger(admission.recordVersion) ||
    admission.recordVersion < 1 ||
    !Number.isSafeInteger(admission.seatLimit) ||
    admission.seatLimit < 1 ||
    !admission.signature ||
    !/^[a-f0-9]{64}$/u.test(admission.claimsSha256)
  ) {
    throw new PostgresEnterpriseLicenseAdmissionError();
  }
  await database.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`license-seats:${organizationId}`],
  );
  const licenseResult = await database.query<
    { version: number | string; payload: unknown } & Record<string, unknown>
  >(
    `SELECT version, payload FROM enterprise_business_records
     WHERE organization_id = $1 AND domain = 'commercial_control'
       AND resource_type = 'license' AND resource_id = 'current'
       AND status = 'active' FOR SHARE`,
    [organizationId],
  );
  const license = licenseResult.rows[0];
  const payload = record(license?.payload);
  const signedEnvelope = record(payload?.signedEnvelope);
  const claims = record(signedEnvelope?.payload);
  const expiresAtMs = Number(
    claims?.expiresAtMs ?? Date.parse(String(claims?.expiresAt ?? '')),
  );
  const claimsSha256 = claims
    ? createHash('sha256').update(canonicalJson(claims)).digest('hex')
    : '';
  if (
    Number(license?.version ?? 0) !== admission.recordVersion ||
    signedEnvelope?.signature !== admission.signature ||
    claimsSha256 !== admission.claimsSha256 ||
    claims?.organizationId !== organizationId ||
    Math.floor(Number(claims?.seatLimit ?? 0)) !== admission.seatLimit ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs
  ) {
    throw new PostgresEnterpriseLicenseAdmissionError();
  }
  const countResult = await database.query<
    { count: number | string } & Record<string, unknown>
  >(
    `SELECT count(*)::integer AS count FROM accounts
     WHERE organization_id = $1 AND account_type = 'enterprise'
       AND status = 'active' AND deleted_at IS NULL`,
    [organizationId],
  );
  if (Number(countResult.rows[0]?.count ?? 0) >= admission.seatLimit) {
    throw new PostgresEnterpriseSeatLimitError();
  }
}
