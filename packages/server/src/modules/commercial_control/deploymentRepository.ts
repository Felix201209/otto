/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import os from 'os';
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import {
  LICENSE_MODULE_FEATURES,
  licenseModuleCatalog,
} from './moduleUpdateManifest.js';
import {
  canonicalLicenseCapabilityId,
  type OrganizationFeatureKey,
} from '../../productModules.js';
import type {
  DeploymentLicenseStatus,
  DeploymentLicenseView,
  DeploymentTelemetrySettings,
  PrivateDeploymentStatus,
} from './deploymentTypes.js';
import { canonicalJson, verifyEd25519Envelope } from './signedEnvelope.js';
import {
  getBillingUsageQueueSummary,
  type BillingUsageRepositoryStore,
  type DeploymentBillingCredentials,
} from './billingUsageRepository.js';
import { getBillingAdmissionQueueSummary } from './billingAdmissionRepository.js';

export interface DeploymentRepositoryStore {
  db(): Database;
  readSetting(key: string): string | null;
  writeSetting(key: string, value: string): void;
  defaultOrganizationId: string;
  licenseEnforcementEnabled(): boolean;
  licenseVerificationPublicKeys(): readonly string[];
  telemetryEndpoint(): string | null;
  telemetryIngestSecret(): string;
  telemetryRetentionDays?(): number;
  fieldCipher?: EncryptedFieldCipher;
  databaseReadiness(): { ready: true; schemaVersion: number };
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

function dateFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

export function getDeploymentId(store: DeploymentRepositoryStore): string {
  const existing = store.readSetting('deployment_id');
  if (existing) return existing;
  const deploymentId = `dep_${randomUUID().replace(/-/g, '')}`;
  store.writeSetting('deployment_id', deploymentId);
  return deploymentId;
}

export function getMachineFingerprint(): string {
  const cpu = os.cpus()[0]?.model || 'unknown-cpu';
  return createHash('sha256')
    .update([os.hostname(), os.platform(), os.arch(), cpu].join('\0'))
    .digest('hex');
}

function safeJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const LICENSE_ENCRYPTED_SECRETS_FIELD = '_ottoEncryptedSecretsV1';
const LICENSE_SECRET_FIELDS = ['leaseToken', 'telemetryToken'] as const;

function licenseSecretContext(licenseId: string, field: string): string {
  return `deployment-license:${licenseId}:${field}`;
}

function encryptedFieldValue(value: unknown): EncryptedFieldValue {
  const object = safeJsonObject(value);
  return {
    ciphertext: String(object.ciphertext || ''),
    iv: String(object.iv || ''),
    authTag: String(object.authTag || ''),
    keyVersion: Number(object.keyVersion),
  };
}

function protectLicensePayload(
  store: DeploymentRepositoryStore,
  payload: Record<string, unknown>,
  licenseId: string,
): string {
  const protectedPayload = { ...payload };
  const encryptedSecrets: Record<string, EncryptedFieldValue> = {};
  for (const field of LICENSE_SECRET_FIELDS) {
    const secret = protectedPayload[field];
    if (typeof secret !== 'string' || secret.length === 0) continue;
    if (!store.fieldCipher) {
      throw new Error('license secret encryption is unavailable');
    }
    encryptedSecrets[field] = store.fieldCipher.encryptText(
      secret,
      licenseSecretContext(licenseId, field),
    );
    delete protectedPayload[field];
  }
  if (Object.keys(encryptedSecrets).length > 0) {
    protectedPayload[LICENSE_ENCRYPTED_SECRETS_FIELD] = encryptedSecrets;
  }
  return JSON.stringify(protectedPayload);
}

function restoreLicensePayload(
  store: DeploymentRepositoryStore,
  storedPayload: Record<string, unknown>,
  storedLicenseId?: string,
): Record<string, unknown> {
  const encryptedSecrets = safeJsonObject(
    storedPayload[LICENSE_ENCRYPTED_SECRETS_FIELD],
  );
  if (Object.keys(encryptedSecrets).length === 0) return storedPayload;
  if (!store.fieldCipher) {
    throw new Error('license secret decryption is unavailable');
  }
  const licenseId = storedLicenseId || String(storedPayload.id || '');
  if (!licenseId) throw new Error('encrypted license id is missing');
  const restored = { ...storedPayload };
  delete restored[LICENSE_ENCRYPTED_SECRETS_FIELD];
  for (const field of LICENSE_SECRET_FIELDS) {
    if (!(field in encryptedSecrets)) continue;
    restored[field] = store.fieldCipher.decryptText(
      encryptedFieldValue(encryptedSecrets[field]),
      licenseSecretContext(licenseId, field),
    );
  }
  return restored;
}

function parseModules(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const modules = parsed
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .map((item) => canonicalLicenseCapabilityId(item) ?? item);
    return [...new Set(modules)];
  } catch {
    return [];
  }
}

function verifyDeploymentLicensePayload(
  store: DeploymentRepositoryStore,
  payload: unknown,
  signature: string,
  expectedKeyId?: string | null,
): { valid: boolean; keyId: string | null } {
  return verifyEd25519Envelope(
    payload,
    signature,
    store.licenseVerificationPublicKeys(),
    expectedKeyId,
  );
}

function telemetryIntegrityHash(payload: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('base64url')}`;
}

const TELEMETRY_REQUEST_SIGNATURE_PREFIX = 'hmac-sha256:';
const TELEMETRY_REQUEST_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface TelemetryRequestAuthentication {
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
}

export function signTelemetryRequest(input: {
  token: string;
  timestamp: number;
  nonce: string;
  body: unknown;
}): string {
  const message = `${input.timestamp}\n${input.nonce}\n${canonicalJson(input.body)}`;
  return TELEMETRY_REQUEST_SIGNATURE_PREFIX + createHmac('sha256', input.token)
    .update(message, 'utf8')
    .digest('base64url');
}

function activeSeatCount(
  store: DeploymentRepositoryStore,
  organizationId: string | null,
): number {
  const row = store.db()
    .prepare(
      `SELECT COUNT(*) AS count FROM accounts
     WHERE deleted_at IS NULL AND status = 'active'
       AND account_type = 'enterprise'
       AND (? IS NULL OR organization_id = ?)`,
    )
    .get(organizationId, organizationId) as { count: number };
  return row.count;
}

interface DeploymentLicenseRow {
  id: string;
  revision: number;
  deployment_id: string;
  organization_id: string | null;
  machine_fingerprint: string | null;
  customer_name: string;
  plan: string;
  expires_at_ms: number;
  seat_limit: number;
  grace_period_ms: number;
  seat_enforcement: 'monitor' | 'enforce';
  modules_json: string;
  offline: number;
  telemetry_allowed: number;
  issued_at_ms: number;
  revoked_at_ms: number | null;
  signature: string;
  signature_algorithm: string;
  signing_key_id: string | null;
  lease_endpoint: string | null;
  raw_json: string;
  updated_at: string;
}

interface DeploymentLicenseLeaseRow {
  license_id: string;
  lease_id: string;
  deployment_id: string;
  machine_fingerprint: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  signature: string;
  signature_algorithm: string;
  signing_key_id: string | null;
  raw_json: string;
  last_refresh_at_ms: number;
  last_error: string | null;
}

function getLicenseLeaseRow(
  store: DeploymentRepositoryStore,
  licenseId: string,
): DeploymentLicenseLeaseRow | null {
  return (
    (store.db()
      .prepare('SELECT * FROM deployment_license_leases WHERE license_id = ?')
      .get(licenseId) as DeploymentLicenseLeaseRow | undefined) ?? null
  );
}

function toDeploymentLicenseView(
  store: DeploymentRepositoryStore,
  row: DeploymentLicenseRow | null,
  now = Date.now(),
): DeploymentLicenseView {
  const enforce = store.licenseEnforcementEnabled();
  if (!row) {
    const modules = licenseModuleCatalog().map((entry) => entry.module);
    const activeSeats = activeSeatCount(store, null);
    return {
      id: 'unlicensed',
      revision: 0,
      deploymentId: getDeploymentId(store),
      organizationId: null,
      machineFingerprint: null,
      customerName: 'Unlicensed deployment',
      plan: enforce ? 'locked' : 'development-open',
      expiresAt: dateFromMs(now + 365 * 24 * 60 * 60 * 1000),
      seatLimit: enforce ? 0 : Number.MAX_SAFE_INTEGER,
      gracePeriodMs: 0,
      seatEnforcement: 'monitor',
      billingEnforcement: 'disabled',
      activeSeatCount: activeSeats,
      seatLimitExceeded: false,
      modules,
      offline: true,
      telemetryAllowed: false,
      signatureAlgorithm: 'none',
      signingKeyId: null,
      lease: {
        required: false,
        status: 'not_required',
        endpoint: null,
        expiresAt: null,
        lastRefreshAt: null,
        lastError: null,
        activeSeatCount: null,
        seatStatus: null,
        graceReasons: [],
        graceExpiresAt: null,
      },
      status: enforce ? 'missing' : 'active',
      enforce,
      updatedAt: dateFromMs(now),
    };
  }
  const modules = parseModules(row.modules_json);
  let billingEnforcement: DeploymentLicenseView['billingEnforcement'] = 'disabled';
  let status: DeploymentLicenseStatus = 'active';
  let signingKeyId = row.signing_key_id;
  if (row.revoked_at_ms != null) status = 'revoked';
  else if (now >= row.expires_at_ms + row.grace_period_ms) status = 'expired';
  else if (now >= row.expires_at_ms) status = 'grace';
  else if (row.expires_at_ms - now <= 14 * 24 * 60 * 60 * 1000)
    status = 'expiring';
  try {
    const payload = restoreLicensePayload(
      store,
      safeJsonObject(JSON.parse(row.raw_json)),
      row.id,
    );
    billingEnforcement = payload.billingEnforcement === 'enforce'
      ? 'enforce'
      : 'disabled';
    const verification = verifyDeploymentLicensePayload(
      store,
      payload,
      row.signature,
      row.signing_key_id,
    );
    signingKeyId = verification.keyId;
    if (
      !verification.valid ||
      row.signature_algorithm !== 'ed25519' ||
      row.deployment_id !== getDeploymentId(store) ||
      row.machine_fingerprint !== getMachineFingerprint() ||
      typeof payload.organizationId !== 'string' ||
      payload.organizationId !== row.organization_id
    ) {
      status = 'invalid';
    }
  } catch {
    status = 'invalid';
  }
  const leaseRow = row.offline === 1 ? null : getLicenseLeaseRow(store, row.id);
  let leaseStatus: DeploymentLicenseView['lease']['status'] =
    row.offline === 1 ? 'not_required' : 'missing';
  let leaseActiveSeatCount: number | null = null;
  let leaseSeatStatus: DeploymentLicenseView['lease']['seatStatus'] = null;
  let leaseGraceReasons: DeploymentLicenseView['lease']['graceReasons'] = [];
  let leaseGraceExpiresAt: string | null = null;
  if (leaseRow) {
    let leaseValid = false;
    try {
      const leasePayload = safeJsonObject(JSON.parse(leaseRow.raw_json));
      leaseValid =
        verifyDeploymentLicensePayload(
          store,
          leasePayload,
          leaseRow.signature,
          leaseRow.signing_key_id,
        ).valid &&
        leaseRow.signature_algorithm === 'ed25519' &&
        leaseRow.license_id === row.id &&
        leaseRow.deployment_id === row.deployment_id &&
        leaseRow.machine_fingerprint === row.machine_fingerprint;
      if (leaseValid) {
        const reportedSeats = Number(leasePayload.activeSeatCount);
        leaseActiveSeatCount = Number.isInteger(reportedSeats) && reportedSeats >= 0
          ? reportedSeats
          : null;
        const reportedStatus = String(leasePayload.seatStatus || '');
        leaseSeatStatus = [
          'unreported',
          'within_limit',
          'over_limit_monitor',
          'overage_grace',
          'blocked',
        ].includes(reportedStatus)
          ? reportedStatus as NonNullable<DeploymentLicenseView['lease']['seatStatus']>
          : null;
        leaseGraceReasons = Array.isArray(leasePayload.graceReasons)
          ? leasePayload.graceReasons.filter(
              (reason): reason is 'expiration' | 'seat_overage' =>
                reason === 'expiration' || reason === 'seat_overage',
            )
          : [];
        const graceExpiresAtMs = Number(leasePayload.graceExpiresAtMs);
        leaseGraceExpiresAt = Number.isFinite(graceExpiresAtMs) && graceExpiresAtMs > 0
          ? dateFromMs(graceExpiresAtMs)
          : null;
      }
    } catch {
      leaseValid = false;
    }
    if (!leaseValid) leaseStatus = 'revoked';
    else if (leaseRow.revoked_at_ms != null) leaseStatus = 'revoked';
    else if (now >= leaseRow.expires_at_ms) leaseStatus = 'expired';
    else leaseStatus = 'active';
  }
  if (status === 'active' || status === 'expiring' || status === 'grace') {
    if (leaseStatus === 'missing') status = 'lease_missing';
    if (leaseStatus === 'expired') status = 'lease_expired';
    if (leaseStatus === 'revoked') status = 'revoked';
  }
  const seats = activeSeatCount(store, row.organization_id);
  return {
    id: row.id,
    revision: row.revision,
    deploymentId: row.deployment_id,
    organizationId: row.organization_id,
    machineFingerprint: row.machine_fingerprint,
    customerName: row.customer_name,
    plan: row.plan,
    expiresAt: dateFromMs(row.expires_at_ms),
    seatLimit: row.seat_limit,
    gracePeriodMs: row.grace_period_ms,
    seatEnforcement: row.seat_enforcement,
    billingEnforcement,
    activeSeatCount: seats,
    seatLimitExceeded: row.seat_limit > 0 && seats > row.seat_limit,
    modules,
    offline: row.offline === 1,
    telemetryAllowed: row.telemetry_allowed === 1,
    signatureAlgorithm: 'ed25519',
    signingKeyId,
    lease: {
      required: row.offline !== 1,
      status: leaseStatus,
      endpoint: row.lease_endpoint,
      expiresAt: leaseRow ? dateFromMs(leaseRow.expires_at_ms) : null,
      lastRefreshAt: leaseRow
        ? dateFromMs(leaseRow.last_refresh_at_ms)
        : null,
      lastError:
        leaseRow?.last_error ||
        store.readSetting('license_lease_last_error') ||
        null,
      activeSeatCount: leaseActiveSeatCount,
      seatStatus: leaseSeatStatus,
      graceReasons: leaseGraceReasons,
      graceExpiresAt: leaseGraceExpiresAt,
    },
    status,
    enforce,
    updatedAt: row.updated_at,
  };
}

export function getDeploymentLicense(
  store: DeploymentRepositoryStore,
): DeploymentLicenseView {
  const row = store.db()
    .prepare(
      'SELECT * FROM deployment_license ORDER BY updated_at DESC LIMIT 1',
    )
    .get() as DeploymentLicenseRow | undefined;
  return toDeploymentLicenseView(store, row ?? null);
}

export function importDeploymentLicense(
  store: DeploymentRepositoryStore,
  raw: unknown,
): DeploymentLicenseView {
  const envelope = safeJsonObject(raw);
  const payload = safeJsonObject(envelope.license ?? envelope.payload);
  if (LICENSE_ENCRYPTED_SECRETS_FIELD in payload) {
    throw new Error('license payload contains a reserved field');
  }
  const signature =
    typeof envelope.signature === 'string' ? envelope.signature : '';
  const declaredSigningKeyId = typeof envelope.signingKeyId === 'string'
    ? envelope.signingKeyId
    : null;
  const verification = verifyDeploymentLicensePayload(
    store,
    payload,
    signature,
    declaredSigningKeyId,
  );
  if (!verification.valid)
    throw new Error('license signature invalid');
  const deploymentId = String(payload.deploymentId || '');
  if (deploymentId !== getDeploymentId(store))
    throw new Error('license deploymentId mismatch');
  const machineFingerprint = String(payload.machineFingerprint || '');
  if (machineFingerprint !== getMachineFingerprint())
    throw new Error('license machineFingerprint mismatch');
  const organizationId = String(payload.organizationId || '');
  if (!organizationId) throw new Error('license organizationId required');
  const organization = store.db()
    .prepare('SELECT id FROM organizations WHERE id = ?')
    .get(organizationId) as { id: string } | undefined;
  if (!organization) throw new Error('license organizationId mismatch');
  const modules = Array.isArray(payload.modules)
    ? [...new Set(payload.modules
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map((item) => canonicalLicenseCapabilityId(item) ?? item))]
    : [];
  const knownModules = new Set(
    licenseModuleCatalog().map((entry) => entry.module),
  );
  const unknownModule = modules.find((moduleName) => !knownModules.has(moduleName));
  if (unknownModule) throw new Error(`license module unknown: ${unknownModule}`);
  const expiresAtMs = Number(
    payload.expiresAtMs ?? Date.parse(String(payload.expiresAt || '')),
  );
  const parsedIssuedAtMs = Date.parse(String(payload.issuedAt || ''));
  const issuedAtMs = Number(
    payload.issuedAtMs ??
      (Number.isFinite(parsedIssuedAtMs) ? parsedIssuedAtMs : Date.now()),
  );
  const seatLimit = Math.max(0, Math.floor(Number(payload.seatLimit ?? 0)));
  const revision = Math.max(1, Math.floor(Number(payload.revision ?? 1)));
  const gracePeriodMs = Math.max(0, Math.floor(Number(payload.gracePeriodMs ?? 0)));
  const seatEnforcement = payload.seatEnforcement === 'enforce' ? 'enforce' : 'monitor';
  const offline = payload.offline !== false;
  const billingEnforcement = payload.billingEnforcement === 'enforce'
    ? 'enforce'
    : 'disabled';
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0)
    throw new Error('license expiresAt invalid');
  if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0)
    throw new Error('license issuedAt invalid');
  if (issuedAtMs > Date.now() + 5 * 60 * 1000)
    throw new Error('license issuedAt is in the future');
  if (expiresAtMs <= issuedAtMs)
    throw new Error('license expiresAt must be after issuedAt');
  if (seatLimit <= 0) throw new Error('license seatLimit must be positive');
  if (!Number.isFinite(revision)) throw new Error('license revision invalid');
  if (!Number.isFinite(gracePeriodMs) || gracePeriodMs > 30 * 24 * 60 * 60 * 1000)
    throw new Error('license gracePeriodMs invalid');
  if (offline && seatEnforcement === 'enforce')
    throw new Error('offline license cannot enforce real-time seat usage');
  if (offline && billingEnforcement === 'enforce')
    throw new Error('offline license cannot enforce real-time billing');
  if (modules.length === 0) throw new Error('license modules required');
  const id = String(payload.id || `lic_${randomUUID().replace(/-/g, '')}`);
  const telemetryAllowed = payload.telemetryAllowed !== false;
  if (
    telemetryAllowed &&
    (typeof payload.telemetryToken !== 'string' ||
      payload.telemetryToken.length < 32)
  ) {
    throw new Error('license telemetryToken required');
  }
  const leaseEndpoint =
    typeof payload.leaseEndpoint === 'string'
      ? payload.leaseEndpoint.trim()
      : '';
  if (!offline) {
    let parsedLeaseEndpoint: URL;
    try {
      parsedLeaseEndpoint = new URL(leaseEndpoint);
    } catch {
      throw new Error('online license leaseEndpoint invalid');
    }
    if (parsedLeaseEndpoint.protocol !== 'https:')
      throw new Error('online license leaseEndpoint must use HTTPS');
    if (
      typeof payload.leaseToken !== 'string' ||
      payload.leaseToken.length < 32
    ) {
      throw new Error('online license leaseToken required');
    }
    if (billingEnforcement === 'enforce') {
      let billingHoldEndpoint: URL;
      try {
        billingHoldEndpoint = typeof payload.billingHoldEndpoint === 'string'
          ? new URL(payload.billingHoldEndpoint)
          : new URL('/v1/billing/holds', parsedLeaseEndpoint);
      } catch {
        throw new Error('online license billingHoldEndpoint invalid');
      }
      if (billingHoldEndpoint.protocol !== 'https:') {
        throw new Error('online license billingHoldEndpoint must use HTTPS');
      }
    }
  }
  store.db()
    .prepare(
      `INSERT INTO deployment_license
       (id, revision, deployment_id, organization_id, machine_fingerprint, customer_name, plan,
        expires_at_ms, seat_limit, grace_period_ms, seat_enforcement, modules_json,
        offline, telemetry_allowed, issued_at_ms,
        revoked_at_ms, signature, signature_algorithm, signing_key_id, lease_endpoint,
        raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ed25519', ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       revision = excluded.revision,
       deployment_id = excluded.deployment_id,
       organization_id = excluded.organization_id,
       machine_fingerprint = excluded.machine_fingerprint,
       customer_name = excluded.customer_name,
       plan = excluded.plan,
       expires_at_ms = excluded.expires_at_ms,
       seat_limit = excluded.seat_limit,
       grace_period_ms = excluded.grace_period_ms,
       seat_enforcement = excluded.seat_enforcement,
       modules_json = excluded.modules_json,
       offline = excluded.offline,
       telemetry_allowed = excluded.telemetry_allowed,
       issued_at_ms = excluded.issued_at_ms,
       revoked_at_ms = excluded.revoked_at_ms,
       signature = excluded.signature,
       signature_algorithm = excluded.signature_algorithm,
       signing_key_id = excluded.signing_key_id,
       lease_endpoint = excluded.lease_endpoint,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    )
    .run(
      id,
      revision,
      deploymentId,
      organizationId,
      machineFingerprint,
      String(payload.customerName || 'Private customer'),
      String(payload.plan || 'enterprise'),
      expiresAtMs,
      seatLimit,
      gracePeriodMs,
      seatEnforcement,
      JSON.stringify(modules),
      offline ? 1 : 0,
      telemetryAllowed ? 1 : 0,
      issuedAtMs,
      payload.revokedAtMs == null ? null : Number(payload.revokedAtMs),
      signature,
      verification.keyId,
      offline ? null : leaseEndpoint,
      protectLicensePayload(store, payload, id),
    );
  store.db()
    .prepare('DELETE FROM deployment_license_leases WHERE license_id = ?')
    .run(id);
  store.audit(
    'deployment_license_import',
    null,
    `License imported: ${id}`,
    store.defaultOrganizationId,
  );
  return getDeploymentLicense(store);
}

export function importDeploymentLicenseLease(
  store: DeploymentRepositoryStore,
  raw: unknown,
): DeploymentLicenseView {
  const license = getDeploymentLicense(store);
  if (license.id === 'unlicensed' || license.offline)
    throw new Error('online license required');
  const envelope = safeJsonObject(raw);
  const payload = safeJsonObject(envelope.lease ?? envelope.payload);
  const signature =
    typeof envelope.signature === 'string' ? envelope.signature : '';
  const declaredSigningKeyId = typeof envelope.signingKeyId === 'string'
    ? envelope.signingKeyId
    : null;
  const verification = verifyDeploymentLicensePayload(
    store,
    payload,
    signature,
    declaredSigningKeyId,
  );
  if (!verification.valid) throw new Error('license lease signature invalid');
  if (String(payload.licenseId || '') !== license.id)
    throw new Error('license lease licenseId mismatch');
  if (String(payload.deploymentId || '') !== license.deploymentId)
    throw new Error('license lease deploymentId mismatch');
  if (String(payload.machineFingerprint || '') !== getMachineFingerprint())
    throw new Error('license lease machineFingerprint mismatch');
  const issuedAtMs = Number(payload.issuedAtMs);
  const expiresAtMs = Number(payload.expiresAtMs);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs))
    throw new Error('license lease timestamps invalid');
  if (issuedAtMs > Date.now() + 5 * 60 * 1000 || expiresAtMs <= Date.now())
    throw new Error('license lease is not active');
  if (expiresAtMs - issuedAtMs > 24 * 60 * 60 * 1000)
    throw new Error('license lease duration exceeds 24 hours');
  const leaseId = String(payload.id || '');
  if (!leaseId) throw new Error('license lease id required');
  const refreshedAtMs = Date.now();
  store.db()
    .prepare(
      `INSERT INTO deployment_license_leases
       (license_id, lease_id, deployment_id, machine_fingerprint, issued_at_ms,
        expires_at_ms, revoked_at_ms, signature, signature_algorithm, signing_key_id,
        raw_json, last_refresh_at_ms, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ed25519', ?, ?, ?, NULL, datetime('now'))
       ON CONFLICT(license_id) DO UPDATE SET
         lease_id = excluded.lease_id,
         deployment_id = excluded.deployment_id,
         machine_fingerprint = excluded.machine_fingerprint,
         issued_at_ms = excluded.issued_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         revoked_at_ms = excluded.revoked_at_ms,
         signature = excluded.signature,
         signature_algorithm = excluded.signature_algorithm,
         signing_key_id = excluded.signing_key_id,
         raw_json = excluded.raw_json,
         last_refresh_at_ms = excluded.last_refresh_at_ms,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(
      license.id,
      leaseId,
      license.deploymentId,
      getMachineFingerprint(),
      issuedAtMs,
      expiresAtMs,
      payload.revokedAtMs == null ? null : Number(payload.revokedAtMs),
      signature,
      verification.keyId,
      JSON.stringify(payload),
      refreshedAtMs,
    );
  store.audit(
    'deployment_license_lease_import',
    null,
    `License lease imported: ${leaseId}`,
    store.defaultOrganizationId,
  );
  return getDeploymentLicense(store);
}

export async function refreshDeploymentLicenseLease(
  store: DeploymentRepositoryStore,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshed: boolean; skippedReason: string | null; error: string | null }> {
  const license = getDeploymentLicense(store);
  if (license.id === 'unlicensed')
    return { refreshed: false, skippedReason: 'license_missing', error: null };
  if (license.offline)
    return { refreshed: false, skippedReason: 'offline_license', error: null };
  if (!license.lease.endpoint)
    return { refreshed: false, skippedReason: 'lease_endpoint_missing', error: null };
  const payload = latestLicensePayload(store);
  const leaseToken = payload.leaseToken;
  if (typeof leaseToken !== 'string' || leaseToken.length < 32) {
    return { refreshed: false, skippedReason: 'lease_token_missing', error: null };
  }
  try {
    const response = await fetchImpl(license.lease.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${leaseToken}`,
        'content-type': 'application/json',
        'user-agent': 'Otto-Private-Deployment/1',
      },
      body: JSON.stringify({
        version: 1,
        licenseId: license.id,
        deploymentId: license.deploymentId,
        organizationId: license.organizationId,
        machineFingerprint: getMachineFingerprint(),
        nonce: randomUUID(),
        activeSeatCount: activeSeatCount(store, license.organizationId),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`license endpoint returned ${response.status}`);
    const envelope = safeJsonObject(await response.json());
    if (envelope.licenseEnvelope) {
      importDeploymentLicense(store, envelope.licenseEnvelope);
    }
    importDeploymentLicenseLease(store, envelope);
    store.writeSetting('license_lease_last_error', '');
    return { refreshed: true, skippedReason: null, error: null };
  } catch (error) {
    const message = safeErrorMessage(error);
    store.writeSetting('license_lease_last_error', message);
    store.db()
      .prepare(
        `UPDATE deployment_license_leases
         SET last_error = ?, updated_at = datetime('now')
         WHERE license_id = ?`,
      )
      .run(message, license.id);
    return { refreshed: false, skippedReason: null, error: message };
  }
}

export function getTelemetrySettings(
  store: DeploymentRepositoryStore,
): DeploymentTelemetrySettings {
  return {
    enabled: store.readSetting('telemetry_enabled') !== 'false',
    contentMode:
      store.readSetting('telemetry_content_mode') === 'diagnostic_redacted'
        ? 'diagnostic_redacted'
        : 'operational_only',
    endpoint:
      store.readSetting('telemetry_endpoint') ||
      store.telemetryEndpoint() ||
      null,
  };
}

export function updateTelemetrySettings(
  store: DeploymentRepositoryStore,
  patch: Partial<DeploymentTelemetrySettings>,
): DeploymentTelemetrySettings {
  if (typeof patch.enabled === 'boolean')
    store.writeSetting('telemetry_enabled', patch.enabled ? 'true' : 'false');
  if (
    patch.contentMode === 'operational_only' ||
    patch.contentMode === 'diagnostic_redacted'
  ) {
    store.writeSetting('telemetry_content_mode', patch.contentMode);
  }
  if (typeof patch.endpoint === 'string')
    store.writeSetting('telemetry_endpoint', patch.endpoint.trim());
  store.audit(
    'deployment_telemetry_update',
    null,
    'Telemetry settings updated',
    store.defaultOrganizationId,
  );
  return getTelemetrySettings(store);
}

export function recordTelemetryEvent(
  store: DeploymentRepositoryStore,
  input: {
    organizationId?: string | null;
    eventType: string;
    payload: Record<string, unknown>;
  },
): void {
  const license = getDeploymentLicense(store);
  const settings = getTelemetrySettings(store);
  if (!settings.enabled || !license.telemetryAllowed) return;
  const payload = {
    deploymentId: getDeploymentId(store),
    organizationId: input.organizationId ?? null,
    eventType: input.eventType,
    createdAtMs: Date.now(),
    payload: input.payload,
  };
  store.db()
    .prepare(
      `INSERT INTO telemetry_events
       (id, deployment_id, organization_id, event_type, payload_json, signature, status, attempts, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
    )
    .run(
      `tel_${randomUUID().replace(/-/g, '')}`,
      payload.deploymentId,
      payload.organizationId,
      input.eventType,
      JSON.stringify(payload),
      telemetryIntegrityHash(payload),
      payload.createdAtMs,
    );
}

export function getTelemetryQueueSummary(store: DeploymentRepositoryStore): {
  queued: number;
  failed: number;
  sent: number;
  lastQueuedAt: string | null;
} {
  const rows = store.db()
    .prepare(
      `SELECT status, COUNT(*) AS count, MAX(created_at_ms) AS lastQueuedAt
     FROM telemetry_events GROUP BY status`,
    )
    .all() as Array<{
    status: string;
    count: number;
    lastQueuedAt: number | null;
  }>;
  const summary = {
    queued: 0,
    failed: 0,
    sent: 0,
    lastQueuedAt: null as string | null,
  };
  for (const row of rows) {
    if (row.status === 'queued') summary.queued = row.count;
    if (row.status === 'failed') summary.failed = row.count;
    if (row.status === 'sent') summary.sent = row.count;
    if (row.status === 'queued' && row.lastQueuedAt)
      summary.lastQueuedAt = dateFromMs(row.lastQueuedAt);
  }
  return summary;
}

interface TelemetryQueueRow {
  id: string;
  deployment_id: string;
  organization_id: string | null;
  event_type: string;
  payload_json: string;
  signature: string;
  attempts: number;
  created_at_ms: number;
}

export interface TelemetryFlushResult {
  attempted: number;
  sent: number;
  discarded: number;
  failed: number;
  skippedReason: string | null;
}

function latestLicensePayload(
  store: DeploymentRepositoryStore,
): Record<string, unknown> {
  const row = store.db()
    .prepare('SELECT id, raw_json FROM deployment_license ORDER BY updated_at DESC LIMIT 1')
    .get() as { id: string; raw_json: string } | undefined;
  if (!row) return {};
  try {
    return restoreLicensePayload(
      store,
      safeJsonObject(JSON.parse(row.raw_json)),
      row.id,
    );
  } catch {
    return {};
  }
}

export interface DeploymentUpdatePolicyCredentials {
  licenseId: string;
  deploymentId: string;
  machineFingerprint: string;
  leaseEndpoint: string;
  leaseToken: string;
}

/** Returns decrypted credentials only to the in-process commercial control composition. */
export function getDeploymentUpdatePolicyCredentials(
  store: DeploymentRepositoryStore,
): DeploymentUpdatePolicyCredentials | null {
  const license = getDeploymentLicense(store);
  if (license.id === 'unlicensed' || license.offline || !license.lease.endpoint) {
    return null;
  }
  const payload = latestLicensePayload(store);
  const leaseToken = payload.leaseToken;
  if (typeof leaseToken !== 'string' || leaseToken.length < 32) return null;
  return {
    licenseId: license.id,
    deploymentId: license.deploymentId,
    machineFingerprint: getMachineFingerprint(),
    leaseEndpoint: license.lease.endpoint,
    leaseToken,
  };
}

export function getDeploymentBillingCredentials(
  store: DeploymentRepositoryStore,
): DeploymentBillingCredentials | null {
  const license = getDeploymentLicense(store);
  if (
    license.id === 'unlicensed' || license.offline ||
    !license.lease.endpoint || !license.organizationId ||
    ['missing', 'invalid', 'revoked', 'expired'].includes(license.status)
  ) return null;
  const payload = latestLicensePayload(store);
  const leaseToken = payload.leaseToken;
  if (typeof leaseToken !== 'string' || leaseToken.length < 32) return null;
  let endpoint: URL;
  let holdEndpoint: URL;
  try {
    endpoint = typeof payload.billingEndpoint === 'string'
      ? new URL(payload.billingEndpoint)
      : new URL('/v1/billing/usage/consume', license.lease.endpoint);
    holdEndpoint = typeof payload.billingHoldEndpoint === 'string'
      ? new URL(payload.billingHoldEndpoint)
      : new URL('/v1/billing/holds', license.lease.endpoint);
  } catch {
    return null;
  }
  if (endpoint.protocol !== 'https:' || holdEndpoint.protocol !== 'https:') return null;
  return {
    licenseId: license.id,
    deploymentId: license.deploymentId,
    organizationId: license.organizationId,
    machineFingerprint: getMachineFingerprint(),
    endpoint: endpoint.toString(),
    holdEndpoint: holdEndpoint.toString(),
    enforcement: license.billingEnforcement,
    leaseToken,
  };
}

export function createDeploymentBillingUsageStore(
  store: DeploymentRepositoryStore,
): BillingUsageRepositoryStore {
  return {
    db: store.db,
    credentials: () => getDeploymentBillingCredentials(store),
  };
}

/** Migrates legacy plaintext lease and telemetry tokens before accepting traffic. */
export function ensureDeploymentLicenseSecretsEncrypted(
  store: DeploymentRepositoryStore,
): number {
  const rows = store.db()
    .prepare('SELECT id, raw_json FROM deployment_license')
    .all() as Array<{ id: string; raw_json: string }>;
  let migrated = 0;
  runInTransaction(store.db(), () => {
    const update = store.db().prepare(
      `UPDATE deployment_license
       SET raw_json = ?, updated_at = datetime('now')
       WHERE id = ?`,
    );
    for (const row of rows) {
      const payload = safeJsonObject(JSON.parse(row.raw_json));
      if (LICENSE_ENCRYPTED_SECRETS_FIELD in payload) {
        restoreLicensePayload(store, payload, row.id);
        continue;
      }
      const hasSecret = LICENSE_SECRET_FIELDS.some(
        (field) => typeof payload[field] === 'string' && payload[field] !== '',
      );
      if (!hasSecret) continue;
      update.run(protectLicensePayload(store, payload, row.id), row.id);
      migrated += 1;
    }
  });
  return migrated;
}

function telemetryRetryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 10));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function runInTransaction<T>(database: Database, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export async function flushTelemetryQueue(
  store: DeploymentRepositoryStore,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<TelemetryFlushResult> {
  const result: TelemetryFlushResult = {
    attempted: 0,
    sent: 0,
    discarded: 0,
    failed: 0,
    skippedReason: null,
  };
  const configuredRetentionDays = store.telemetryRetentionDays?.() ?? 90;
  const retentionDays = Number.isFinite(configuredRetentionDays)
    ? Math.max(1, Math.min(3650, Math.floor(configuredRetentionDays)))
    : 90;
  store.db()
    .prepare('DELETE FROM telemetry_events WHERE created_at_ms < ?')
    .run(now - retentionDays * 24 * 60 * 60 * 1000);
  const settings = getTelemetrySettings(store);
  const license = getDeploymentLicense(store);
  if (!settings.enabled) return { ...result, skippedReason: 'disabled' };
  if (!license.telemetryAllowed)
    return { ...result, skippedReason: 'license_disallows_telemetry' };
  if (!settings.endpoint)
    return { ...result, skippedReason: 'endpoint_missing' };
  let endpoint: URL;
  try {
    endpoint = new URL(settings.endpoint);
  } catch {
    return { ...result, skippedReason: 'endpoint_invalid' };
  }
  if (endpoint.protocol !== 'https:')
    return { ...result, skippedReason: 'endpoint_requires_https' };
  const telemetryToken = latestLicensePayload(store).telemetryToken;
  if (typeof telemetryToken !== 'string' || telemetryToken.length < 32) {
    return { ...result, skippedReason: 'telemetry_token_missing' };
  }
  const rows = store.db()
    .prepare(
      `SELECT id, deployment_id, organization_id, event_type, payload_json,
              signature, attempts, created_at_ms
       FROM telemetry_events
       WHERE status IN ('queued', 'failed')
         AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= ?)
       ORDER BY created_at_ms ASC
       LIMIT 50`,
    )
    .all(now) as TelemetryQueueRow[];
  if (rows.length === 0) return result;
  result.attempted = rows.length;
  const events: Array<Record<string, unknown>> = [];
  const validRows: TelemetryQueueRow[] = [];
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json);
      if (telemetryIntegrityHash(payload) !== row.signature) {
        store.db()
          .prepare(
            `UPDATE telemetry_events
             SET status = 'discarded', last_error = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run('local telemetry integrity mismatch', row.id);
        result.discarded += 1;
        continue;
      }
      events.push({
        id: row.id,
        organizationId: row.organization_id,
        eventType: row.event_type,
        createdAtMs: row.created_at_ms,
        payload,
        integrity: row.signature,
      });
      validRows.push(row);
    } catch {
      store.db()
        .prepare(
          `UPDATE telemetry_events
           SET status = 'discarded', last_error = ?, updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run('local telemetry payload invalid', row.id);
      result.discarded += 1;
    }
  }
  if (events.length === 0) return result;
  try {
    const requestBody = {
      version: 1,
      deploymentId: getDeploymentId(store),
      machineFingerprint: getMachineFingerprint(),
      licenseId: license.id,
      events,
    };
    const requestTimestamp = now;
    const requestNonce = randomUUID();
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${telemetryToken}`,
        'content-type': 'application/json',
        'user-agent': 'Otto-Private-Deployment/1',
        'x-otto-timestamp': String(requestTimestamp),
        'x-otto-nonce': requestNonce,
        'x-otto-signature': signTelemetryRequest({
          token: telemetryToken,
          timestamp: requestTimestamp,
          nonce: requestNonce,
          body: requestBody,
        }),
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`telemetry endpoint returned ${response.status}`);
    runInTransaction(store.db(), () => {
      const statement = store.db().prepare(
        `UPDATE telemetry_events
         SET status = 'sent', sent_at_ms = ?, next_attempt_at_ms = NULL,
             last_error = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      );
      for (const row of validRows) statement.run(now, row.id);
    });
    result.sent = validRows.length;
  } catch (error) {
    const message = safeErrorMessage(error);
    runInTransaction(store.db(), () => {
      const statement = store.db().prepare(
        `UPDATE telemetry_events
         SET status = 'failed', attempts = attempts + 1,
             next_attempt_at_ms = ?, last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      );
      for (const row of validRows) {
        statement.run(
          now + telemetryRetryDelayMs(row.attempts + 1),
          message,
          row.id,
        );
      }
    });
    result.failed = validRows.length;
  }
  return result;
}

const FORBIDDEN_TELEMETRY_KEYS = new Set([
  'message',
  'messages',
  'content',
  'file',
  'files',
  'attachment',
  'attachments',
  'audio',
  'meetingaudio',
  'transcript',
  'prompt',
  'completion',
  'document',
  'documents',
]);

function telemetryContainsContent(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value))
    return value.some((item) => telemetryContainsContent(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) =>
      FORBIDDEN_TELEMETRY_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')) ||
      telemetryContainsContent(item, depth + 1),
  );
}

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() || '');
  return match?.[1] || '';
}

function equalSecret(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function ingestTelemetryBatch(
  store: DeploymentRepositoryStore,
  raw: unknown,
  authorization: string | undefined,
  authentication: TelemetryRequestAuthentication,
  now = Date.now(),
): { accepted: number; duplicates: number } {
  const secret = store.telemetryIngestSecret();
  if (secret.length < 32) throw new Error('telemetry ingest is not configured');
  const body = safeJsonObject(raw);
  const deploymentId = String(body.deploymentId || '');
  if (!/^dep_[a-z0-9]{16,64}$/i.test(deploymentId))
    throw new Error('telemetry deploymentId invalid');
  const expectedToken = createHmac('sha256', secret)
    .update(deploymentId)
    .digest('base64url');
  if (!equalSecret(bearerToken(authorization), expectedToken))
    throw new Error('telemetry authorization invalid');
  const timestamp = Number(authentication.timestamp);
  const nonce = authentication.nonce?.trim() || '';
  const signature = authentication.signature?.trim() || '';
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now - timestamp) > TELEMETRY_REQUEST_MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('telemetry request timestamp invalid');
  }
  if (!/^[a-zA-Z0-9._:-]{16,128}$/.test(nonce)) {
    throw new Error('telemetry request nonce invalid');
  }
  const expectedSignature = signTelemetryRequest({
    token: expectedToken,
    timestamp,
    nonce,
    body,
  });
  if (!equalSecret(signature, expectedSignature)) {
    throw new Error('telemetry request signature invalid');
  }
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > 100)
    throw new Error('telemetry events invalid');
  let accepted = 0;
  let duplicates = 0;
  const insert = store.db().prepare(
    `INSERT OR IGNORE INTO telemetry_ingest_events
     (deployment_id, event_id, organization_id, event_type, payload_json,
      integrity, source_created_at_ms, received_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  runInTransaction(store.db(), () => {
    store.db().prepare(
      'DELETE FROM telemetry_ingest_nonces WHERE received_at_ms < ?',
    ).run(now - TELEMETRY_REQUEST_MAX_CLOCK_SKEW_MS * 2);
    try {
      store.db().prepare(
        `INSERT INTO telemetry_ingest_nonces
         (deployment_id, nonce, received_at_ms) VALUES (?, ?, ?)`,
      ).run(deploymentId, nonce, now);
    } catch (error) {
      if (/UNIQUE constraint failed: telemetry_ingest_nonces\./i.test(
        safeErrorMessage(error),
      )) {
        throw new Error('telemetry request replay detected');
      }
      throw error;
    }
    for (const item of body.events as unknown[]) {
      const event = safeJsonObject(item);
      const id = String(event.id || '');
      const eventType = String(event.eventType || '');
      const createdAtMs = Number(event.createdAtMs);
      const integrity = String(event.integrity || '');
      if (!/^tel_[a-z0-9]{16,64}$/i.test(id) || !/^[a-z0-9_.:-]{2,80}$/i.test(eventType))
        throw new Error('telemetry event identity invalid');
      if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || createdAtMs > now + 5 * 60 * 1000)
        throw new Error('telemetry event timestamp invalid');
      if (telemetryContainsContent(event.payload))
        throw new Error('telemetry content payload forbidden');
      if (telemetryIntegrityHash(event.payload) !== integrity)
        throw new Error('telemetry event integrity invalid');
      const info = insert.run(
        deploymentId,
        id,
        typeof event.organizationId === 'string' ? event.organizationId : null,
        eventType,
        JSON.stringify(event.payload),
        integrity,
        createdAtMs,
        now,
      );
      if (info.changes === 1) accepted += 1;
      else duplicates += 1;
    }
  });
  return { accepted, duplicates };
}

function getDeploymentRuntimeHealth(
  store: DeploymentRepositoryStore,
): PrivateDeploymentStatus['runtimeHealth'] {
  const database = store.db();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const organizations = database
    .prepare(
      "SELECT COUNT(*) AS count FROM organizations WHERE status = 'active'",
    )
    .get() as { count: number };
  const accounts = database
    .prepare(
      "SELECT COUNT(*) AS count FROM accounts WHERE deleted_at IS NULL AND status = 'active'",
    )
    .get() as { count: number };
  const audit = database
    .prepare(
      `SELECT
       SUM(CASE WHEN lower(event) LIKE '%error%' OR lower(event) LIKE '%fail%'
             OR lower(COALESCE(detail, '')) LIKE '%error%' OR lower(COALESCE(detail, '')) LIKE '%fail%'
           THEN 1 ELSE 0 END) AS errorCount,
       SUM(CASE WHEN lower(event) LIKE '%crash%' OR lower(event) LIKE '%uncaught%'
             OR lower(COALESCE(detail, '')) LIKE '%crash%' OR lower(COALESCE(detail, '')) LIKE '%uncaught%'
           THEN 1 ELSE 0 END) AS crashCount
     FROM audit_logs`,
    )
    .get() as { errorCount: number | null; crashCount: number | null };
  const usage = database
    .prepare(
      'SELECT COUNT(*) AS callCount, COALESCE(SUM(total_tokens), 0) AS tokenTotal FROM account_token_usage',
    )
    .get() as { callCount: number; tokenTotal: number };
  return {
    uptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    memoryRssMb: Math.round(memory.rss / 1024 / 1024),
    memoryHeapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    activeOrganizations: organizations.count,
    activeAccounts: accounts.count,
    auditErrorCount: audit.errorCount ?? 0,
    auditCrashCount: audit.crashCount ?? 0,
    agentCallCount: usage.callCount,
    tokenTotal: usage.tokenTotal,
    successRate: null,
    avgLatencyMs: null,
  };
}

export function getPrivateDeploymentStatus(
  store: DeploymentRepositoryStore,
): PrivateDeploymentStatus {
  const telemetry = getTelemetrySettings(store);
  return {
    deploymentId: getDeploymentId(store),
    machineFingerprint: getMachineFingerprint(),
    license: getDeploymentLicense(store),
    telemetry: { ...telemetry, ...getTelemetryQueueSummary(store) },
    billing: {
      ...getBillingUsageQueueSummary(createDeploymentBillingUsageStore(store)),
      admission: getBillingAdmissionQueueSummary(
        createDeploymentBillingUsageStore(store),
      ),
      evidenceTrust: 'customer_server_reported',
    },
    dataBoundary: {
      uploadsContentByDefault: false,
      includesUserMessages: false,
      includesFiles: false,
      includesMeetingAudio: false,
      defaultPayload: [
        'license status',
        'version',
        'module usage counters',
        'error codes',
        'runtime health',
      ],
    },
    moduleCatalog: licenseModuleCatalog(),
    runtimeHealth: getDeploymentRuntimeHealth(store),
  };
}

export function exportDeploymentDiagnostics(
  store: DeploymentRepositoryStore,
  input: { includeRedactedSamples?: boolean } = {},
): Record<string, unknown> {
  const database = store.db();
  const orgs = database
    .prepare('SELECT COUNT(*) AS count FROM organizations')
    .get() as { count: number };
  const accounts = database
    .prepare(
      "SELECT COUNT(*) AS count FROM accounts WHERE deleted_at IS NULL AND status = 'active'",
    )
    .get() as { count: number };
  const tickets = database
    .prepare('SELECT status, COUNT(*) AS count FROM it_tickets GROUP BY status')
    .all();
  const recentErrors = database
    .prepare(
      `SELECT event, detail, created_at FROM audit_logs
     WHERE lower(event) LIKE '%error%' OR lower(event) LIKE '%fail%'
     ORDER BY created_at DESC LIMIT 20`,
    )
    .all();
  return {
    generatedAt: new Date().toISOString(),
    deployment: getPrivateDeploymentStatus(store),
    database: store.databaseReadiness(),
    counts: { organizations: orgs.count, activeAccounts: accounts.count },
    tickets,
    recentErrors,
    redactedSamplesIncluded: input.includeRedactedSamples === true,
    privacy:
      'No chat content, file body, meeting audio, or raw uploaded document is included by default.',
  };
}

export function isLicenseUsableForOrganizationFeature(
  store: DeploymentRepositoryStore,
  feature: OrganizationFeatureKey,
): boolean {
  const license = getDeploymentLicense(store);
  if (!license.enforce && ['active', 'expiring', 'grace'].includes(license.status)) return true;
  if (!['active', 'expiring', 'grace'].includes(license.status)) return false;
  for (const moduleName of license.modules) {
    if (LICENSE_MODULE_FEATURES[moduleName]?.includes(feature)) return true;
  }
  return false;
}

export function isLicenseRestricted(store: DeploymentRepositoryStore): boolean {
  const license = getDeploymentLicense(store);
  return (
    license.enforce &&
    !['active', 'expiring', 'grace'].includes(license.status)
  );
}
