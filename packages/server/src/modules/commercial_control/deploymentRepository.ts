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
  getBillingExecutionReceiptKey,
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
  return toDeploymentLicenseView(store,ïw¶‰žËkºwµç@€€¹ÁÉ•Á…É” 1QI=4Ñ•±•µ•ÑÉå}•Ù•¹ÑÌ]!IÉ•…Ñ•‘}…Ñ}µÌ€ð€üœ¤(€€€€¹ÉÕ¸¡¹½Ü€´É•Ñ•¹Ñ¥½¹…åÌ€¨€ÈÐ€¨€ØÀ€¨€ØÀ€¨€ÄÀÀÀ¤ì(€½¹ÍÐÍ•ÑÑ¥¹Ì€ô•ÑQ•±•µ•ÑÉåM•ÑÑ¥¹Ì¡ÍÑ½É”¤ì(€½¹ÍÐ±¥•¹Í”€ô•Ñ•Á±½åµ•¹Ñ1¥•¹Í”¡ÍÑ½É”¤ì(€¥˜€ …Í•ÑÑ¥¹Ì¹•¹…‰±•¤É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°Í­¥ÁÁ•‘I•…Í½¸è€‘¥Í…‰±•œôì(€¥˜€ …±¥•¹Í”¹Ñ•±•µ•ÑÉå±±½Ý•¤(€€€É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°Í­¥ÁÁ•‘I•…Í½¸è€±¥•¹Í•}‘¥Í…±±½ÝÍ}Ñ•±•µ•ÑÉäœôì(€¥˜€ …Í•ÑÑ¥¹Ì¹•¹‘Á½¥¹Ð¤(€€€É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°Í­¥ÁÁ•‘I•…Í½¸è€•¹‘Á½¥¹Ñ}µ¥ÍÍ¥¹œœôì(€±•Ð•¹‘Á½¥¹ÐèUI0ì(€ÑÉäì(€€€•¹‘Á½¥¹Ð€ô¹•ÜUI0¡Í•ÑÑ¥¹Ì¹•¹‘Á½¥¹Ð¤ì(€ô…Ñ ì(€€€É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°Í­¥ÁÁ•‘I•…Í½¸è€•¹‘Á½¥¹Ñ}¥¹Ù…±¥œôì(€ô(€¥˜€¡•¹‘Á½¥¹Ð¹ÁÉ½Ñ½½°€„ôô€¡ÑÑÁÌèœ¤(€€€É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°Í­¥ÁÁ•‘I•…Í½¸è€•¹‘Á½¥¹Ñ}É•ÅÕ¥É•Í}¡ÑÑÁÌœôì(€½¹ÍÐÑ•±•µ•ÑÉåQ½­•¸€ô±…Ñ•ÍÑ1¥•¹Í•A…å±½…¡ÍÑ½É”¤¹Ñ•±•µ•ÑÉåQ½­•¸ì(€¥˜€¡ÑåÁ•½˜Ñ•±•µ•ÑÉåQ½­•¸€„ôô€ÍÑÉ¥¹œœñðÑ•±•µ•ÑÉåQ½­•¸¹±•¹Ñ €ð€ÌÈ¤ì(€€€É•ÑÕÉ¸ì€¸¸¹É•ÍÕ±Ð°Í­¥ÁÁ•‘I•…Í½¸è€Ñ•±•µ•ÑÉå}Ñ½­•¹}µ¥ÍÍ¥¹œœôì(€ô(€½¹ÍÐÉ½ÝÌ€ôÍÑ½É”¹‘ˆ ¤(€€€€¹ÁÉ•Á…É” (€€€€€M1P¥°‘•Á±½åµ•¹Ñ}¥°½É…¹¥é…Ñ¥½¹}¥°•Ù•¹Ñ}ÑåÁ”°Á…å±½…‘}©Í½¸°(€€€€€€€€€€€€€Í¥¹…ÑÕÉ”°…ÑÑ•µÁÑÌ°É•…Ñ•‘}…Ñ}µÌ(€€€€€€I=4Ñ•±•µ•ÑÉå}•Ù•¹ÑÌ(€€€€€€]!IÍÑ…ÑÕÌ%8€ ÅÕ•Õ•œ°€™…¥±•œ¤(€€€€€€€€9€¡¹•áÑ}…ÑÑ•µÁÑ}…Ñ}µÌ%L9U10=H¹•áÑ}…ÑÑ•µÁÑ}…Ñ}µÌ€ðô€ü¤(€€€€€€=IH	dÉ•…Ñ•‘}…Ñ}µÌM(€€€€€€1%5%P€ÔÁ€°(€€€€¤(€€€€¹…±°¡¹½Ü¤…ÌQ•±•µ•ÑÉåEÕ•Õ•I½Ýmtì(€¥˜€¡É½ÝÌ¹±•¹Ñ €ôôô€À¤É•ÑÕÉ¸É•ÍÕ±Ðì(€É•ÍÕ±Ð¹…ÑÑ•µÁÑ•€ôÉ½ÝÌ¹±•¹Ñ ì(€½¹ÍÐ•Ù•¹ÑÌèÉÉ…äñI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½Ý¸øø€ômtì(€½¹ÍÐÙ…±¥‘I½ÝÌèQ•±•µ•ÑÉåEÕ•Õ•I½Ýmt€ômtì(€™½È€¡½¹ÍÐÉ½Ü½˜É½ÝÌ¤ì(€€€ÑÉäì(€€€€€½¹ÍÐÁ…å±½…€ô)M=8¹Á…ÉÍ”¡É½Ü¹Á…å±½…‘}©Í½¸¤ì(€€€€€¥˜€¡Ñ•±•µ•ÑÉå%¹Ñ•É¥Ñå!…Í ¡Á…å±½…¤€„ôôÉ½Ü¹Í¥¹…ÑÕÉ”¤ì(€€€€€€€ÍÑ½É”¹‘ˆ ¤(€€€€€€€€€€¹ÁÉ•Á…É” (€€€€€€€€€€€UAQÑ•±•µ•ÑÉå}•Ù•¹ÑÌ(€€€€€€€€€€€€MPÍÑ…ÑÕÌ€ô€‘¥Í…É‘•œ°±…ÍÑ}•ÉÉ½È€ô€ü°ÕÁ‘…Ñ•‘}…Ð€ô‘…Ñ•Ñ¥µ” ¹½Üœ¤(€€€€€€€€€€€€]!I¥€ô€ý€°(€€€€€€€€€€¤(€€€€€€€€€€¹ÉÕ¸ ±½…°Ñ•±•µ•ÑÉä¥¹Ñ•É¥Ñäµ¥Íµ…Ñ œ°É½Ü¹¥¤ì(€€€€€€€É•ÍÕ±Ð¹‘¥Í…É‘•€¬ô€Äì(€€€€€€€½¹Ñ¥¹Õ”ì(€€€€€ô(€€€€€•Ù•¹ÑÌ¹ÁÕÍ ¡ì(€€€€€€€¥èÉ½Ü¹¥°(€€€€€€€½É…¹¥é…Ñ¥½¹%èÉ½Ü¹½É…¹¥é…Ñ¥½¹}¥°(€€€€€€€•Ù•¹ÑQåÁ”èÉ½Ü¹•Ù•¹Ñ}ÑåÁ”°(€€€€€€€É•…Ñ•‘Ñ5ÌèÉ½Ü¹É•…Ñ•‘}…Ñ}µÌ°(€€€€€€€Á…å±½…°(€€€€€€€¥¹Ñ•É¥ÑäèÉ½Ü¹Í¥¹…ÑÕÉ”°(€€€€€ô¤ì(€€€€€Ù…±¥‘I½ÝÌ¹ÁÕÍ ¡É½Ü¤ì(€€€ô…Ñ ì(€€€€€ÍÑ½É”¹‘ˆ ¤(€€€€€€€€¹ÁÉ•Á…É” (€€€€€€€€€UAQÑ•±•µ•ÑÉå}•Ù•¹ÑÌ(€€€€€€€€€€MPÍÑ…ÑÕÌ€ô€‘¥Í…É‘•œ°±…ÍÑ}•ÉÉ½È€ô€ü°ÕÁ‘…Ñ•‘}…Ð€ô‘…Ñ•Ñ¥µ” ¹½Üœ¤(€€€€€€€€€€]!I¥€ô€ý€°(€€€€€€€€¤(€€€€€€€€¹ÉÕ¸ ±½…°Ñ•±•µ•ÑÉäÁ…å±½…¥¹Ù…±¥œ°É½Ü¹¥¤ì(€€€€€É•ÍÕ±Ð¹‘¥Í…É‘•€¬ô€Äì(€€€ô(€ô(€¥˜€¡•Ù•¹ÑÌ¹±•¹Ñ €ôôô€À¤É•ÑÕÉ¸É•ÍÕ±Ðì(€ÑÉäì(€€€½¹ÍÐÉ•ÅÕ•ÍÑ	½‘ä€ôì(€€€€€Ù•ÉÍ¥½¸è€Ä°(€€€€€‘•Á±½åµ•¹Ñ%è•Ñ•Á±½åµ•¹Ñ%¡ÍÑ½É”¤°(€€€€€µ…¡¥¹•¥¹•ÉÁÉ¥¹Ðè•Ñ5…¡¥¹•¥¹•ÉÁÉ¥¹Ð ¤°(€€€€€±¥•¹Í•%è±¥•¹Í”¹¥°(€€€€€•Ù•¹ÑÌ°(€€€ôì(€€€½¹ÍÐÉ•ÅÕ•ÍÑQ¥µ•ÍÑ…µÀ€ô¹½Üì(€€€½¹ÍÐÉ•ÅÕ•ÍÑ9½¹”€ôÉ…¹‘½µUU% ¤ì(€€€½¹ÍÐÉ•ÍÁ½¹Í”€ô…Ý…¥Ð™•Ñ¡%µÁ°¡•¹‘Á½¥¹Ð°ì(€€€€€µ•Ñ¡½è€A=MPœ°(€€€€€¡•…‘•ÉÌèì(€€€€€€€…ÕÑ¡½É¥é…Ñ¥½¸è	•…É•È€‘íÑ•±•µ•ÑÉåQ½­•¹õ€°(€€€€€€€€½¹Ñ•¹ÐµÑåÁ”œè€…ÁÁ±¥…Ñ¥½¸½©Í½¸œ°(€€€€€€€€ÕÍ•Èµ…•¹Ðœè€=ÑÑ¼µAÉ¥Ù…Ñ”µ•Á±½åµ•¹Ð¼Äœ°(€€€€€€€€àµ½ÑÑ¼µÑ¥µ•ÍÑ…µÀœèMÑÉ¥¹œ¡É•ÅÕ•ÍÑQ¥µ•ÍÑ…µÀ¤°(€€€€€€€€àµ½ÑÑ¼µ¹½¹”œèÉ•ÅÕ•ÍÑ9½¹”°(€€€€€€€€àµ½ÑÑ¼µÍ¥¹…ÑÕÉ”œèÍ¥¹Q•±•µ•ÑÉåI•ÅÕ•ÍÐ¡ì(€€€€€€€€€Ñ½­•¸èÑ•±•µ•ÑÉåQ½­•¸°(€€€€€€€€€Ñ¥µ•ÍÑ…µÀèÉ•ÅÕ•ÍÑQ¥µ•ÍÑ…µÀ°(€€€€€€€€€¹½¹”èÉ•ÅÕ•ÍÑ9½¹”°(€€€€€€€€€‰½‘äèÉ•ÅÕ•ÍÑ	½‘ä°(€€€€€€€ô¤°(€€€€€ô°(€€€€€‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡É•ÅÕ•ÍÑ	½‘ä¤°(€€€€€Í¥¹…°è‰½ÉÑM¥¹…°¹Ñ¥µ•½ÕÐ ÄÕ|ÀÀÀ¤°(€€€ô¤ì(€€€¥˜€ …É•ÍÁ½¹Í”¹½¬¤Ñ¡É½Ü¹•ÜÉÉ½È¡Ñ•±•µ•ÑÉä•¹‘Á½¥¹ÐÉ•ÑÕÉ¹•€‘íÉ•ÍÁ½¹Í”¹ÍÑ…ÑÕÍõ€¤ì(€€€ÉÕ¹%¹QÉ…¹Í…Ñ¥½¸¡ÍÑ½É”¹‘ˆ ¤°€ ¤€ôøì(€€€€€½¹ÍÐÍÑ…Ñ•µ•¹Ð€ôÍÑ½É”¹‘ˆ ¤¹ÁÉ•Á…É” (€€€€€€€UAQÑ•±•µ•ÑÉå}•Ù•¹ÑÌ(€€€€€€€€MPÍÑ…ÑÕÌ€ô€Í•¹Ðœ°Í•¹Ñ}…Ñ}µÌ€ô€ü°¹•áÑ}…ÑÑ•µÁÑ}…Ñ}µÌ€ô9U10°(€€€€€€€€€€€€±…ÍÑ}•ÉÉ½È€ô9U10°ÕÁ‘…Ñ•‘}…Ð€ô‘…Ñ•Ñ¥µ” ¹½Üœ¤(€€€€€€€€]!I¥€ô€ý€°(€€€€€€¤ì(€€€€€™½È€¡½¹ÍÐÉ½Ü½˜Ù…±¥‘I½ÝÌ¤ÍÑ…Ñ•µ•¹Ð¹ÉÕ¸¡¹½Ü°É½Ü¹¥¤ì(€€€ô¤ì(€€€É•ÍÕ±Ð¹Í•¹Ð€ôÙ…±¥‘I½ÝÌ¹±•¹Ñ ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹ÍÐµ•ÍÍ…”€ôÍ…™•ÉÉ½É5•ÍÍ…”¡•ÉÉ½È¤ì(€€€ÉÕ¹%¹QÉ…¹Í…Ñ¥½¸¡ÍÑ½É”¹‘ˆ ¤°€ ¤€ôøì(€€€€€½¹ÍÐÍÑ…Ñ•µ•¹Ð€ôÍÑ½É”¹‘ˆ ¤¹ÁÉ•Á…É” (€€€€€€€UAQÑ•±•µ•ÑÉå}•Ù•¹ÑÌ(€€€€€€€€MPÍÑ…ÑÕÌ€ô€™…¥±•œ°…ÑÑ•µÁÑÌ€ô…ÑÑ•µÁÑÌ€¬€Ä°(€€€€€€€€€€€€¹•áÑ}…ÑÑ•µÁÑ}…Ñ}µÌ€ô€ü°±…ÍÑ}•ÉÉ½È€ô€ü°ÕÁ‘…Ñ•‘}…Ð€ô‘…Ñ•Ñ¥µ” ¹½Üœ¤(€€€€€€€€]!I¥€ô€ý€°(€€€€€€¤ì(€€€€€™½È€¡½¹ÍÐÉ½Ü½˜Ù…±¥‘I½ÝÌ¤ì(€€€€€€€ÍÑ…Ñ•µ•¹Ð¹ÉÕ¸ (€€€€€€€€€¹½Ü€¬Ñ•±•µ•ÑÉåI•ÑÉå•±…å5Ì¡É½Ü¹…ÑÑ•µÁÑÌ€¬€Ä¤°(€€€€€€€€€µ•ÍÍ…”°(€€€€€€€€€É½Ü¹¥°(€€€€€€€€¤ì(€€€€€ô(€€€ô¤ì(€€€É•ÍÕ±Ð¹™…¥±•€ôÙ…±¥‘I½ÝÌ¹±•¹Ñ ì(€ô(€É•ÑÕÉ¸É•ÍÕ±Ðì)ô()½¹ÍÐ=I	%9}Q15QIe}-eL€ô¹•ÜM•Ð¡l(€€µ•ÍÍ…”œ°(€€µ•ÍÍ…•Ìœ°(€€½¹Ñ•¹Ðœ°(€€™¥±”œ°(€€™¥±•Ìœ°(€€…ÑÑ…¡µ•¹Ðœ°(€€…ÑÑ…¡µ•¹ÑÌœ°(€€…Õ‘¥¼œ°(€€µ••Ñ¥¹…Õ‘¥¼œ°(€€ÑÉ…¹ÍÉ¥ÁÐœ°(€€ÁÉ½µÁÐœ°(€€½µÁ±•Ñ¥½¸œ°(€€‘½Õµ•¹Ðœ°(€€‘½Õµ•¹ÑÌœ°)t¤ì()™Õ¹Ñ¥½¸Ñ•±•µ•ÑÉå½¹Ñ…¥¹Í½¹Ñ•¹Ð¡Ù…±Õ”èÕ¹­¹½Ý¸°‘•ÁÑ €ô€À¤è‰½½±•…¸ì(€¥˜€¡‘•ÁÑ €ø€à¤É•ÑÕÉ¸ÑÉÕ”ì(€¥˜€¡ÉÉ…ä¹¥ÍÉÉ…ä¡Ù…±Õ”¤¤(€€€É•ÑÕÉ¸Ù…±Õ”¹Í½µ” ¡¥Ñ•´¤€ôøÑ•±•µ•ÑÉå½¹Ñ…¥¹Í½¹Ñ•¹Ð¡¥Ñ•´°‘•ÁÑ €¬€Ä¤¤ì(€¥˜€ …Ù…±Õ”ñðÑåÁ•½˜Ù…±Õ”€„ôô€½‰©•Ðœ¤É•ÑÕÉ¸™…±Í”ì(€É•ÑÕÉ¸=‰©•Ð¹•¹ÑÉ¥•Ì¡Ù…±Õ”…ÌI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½Ý¸ø¤¹Í½µ” (€€€€¡m­•ä°¥Ñ•µt¤€ôø(€€€€€=I	%9}Q15QIe}-eL¹¡…Ì¡­•ä¹Ñ½1½Ý•É…Í” ¤¹É•Á±…” ½m|µt½œ°€œœ¤¤ñð(€€€€€Ñ•±•µ•ÑÉå½¹Ñ…¥¹Í½¹Ñ•¹Ð¡¥Ñ•´°‘•ÁÑ €¬€Ä¤°(€€¤ì)ô()™Õ¹Ñ¥½¸‰•…É•ÉQ½­•¸¡…ÕÑ¡½É¥é…Ñ¥½¸èÍÑÉ¥¹œðÕ¹‘•™¥¹•¤èÍÑÉ¥¹œì(€½¹ÍÐµ…Ñ €ô€½y	•…É•ÉqÌ¬ ¸¬¤½¤¹•á•Œ¡…ÕÑ¡½É¥é…Ñ¥½¸ü¹ÑÉ¥´ ¤ñð€œœ¤ì(€É•ÑÕÉ¸µ…Ñ ü¹lÅtñð€œœì)ô()™Õ¹Ñ¥½¸•ÅÕ…±M•É•Ð¡±•™ÐèÍÑÉ¥¹œ°É¥¡ÐèÍÑÉ¥¹œ¤è‰½½±•…¸ì(€¥˜€ …±•™Ðñð±•™Ð¹±•¹Ñ €„ôôÉ¥¡Ð¹±•¹Ñ ¤É•ÑÕÉ¸™…±Í”ì(€É•ÑÕÉ¸Ñ¥µ¥¹M…™•ÅÕ…°¡	Õ™™•È¹™É½´¡±•™Ð¤°	Õ™™•È¹™É½´¡É¥¡Ð¤¤ì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸¥¹•ÍÑQ•±•µ•ÑÉå	…Ñ  (€ÍÑ½É”è•Á±½åµ•¹ÑI•Á½Í¥Ñ½ÉåMÑ½É”°(€É…ÜèÕ¹­¹½Ý¸°(€…ÕÑ¡½É¥é…Ñ¥½¸èÍÑÉ¥¹œðÕ¹‘•™¥¹•°(€…ÕÑ¡•¹Ñ¥…Ñ¥½¸èQ•±•µ•ÑÉåI•ÅÕ•ÍÑÕÑ¡•¹Ñ¥…Ñ¥½¸°(€¹½Ü€ô…Ñ”¹¹½Ü ¤°(¤èì…•ÁÑ•è¹Õµ‰•Èì‘ÕÁ±¥…Ñ•Ìè¹Õµ‰•Èôì(€½¹ÍÐÍ•É•Ð€ôÍÑ½É”¹Ñ•±•µ•ÑÉå%¹•ÍÑM•É•Ð ¤ì(€¥˜€¡Í•É•Ð¹±•¹Ñ €ð€ÌÈ¤Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä¥¹•ÍÐ¥Ì¹½Ð½¹™¥ÕÉ•œ¤ì(€½¹ÍÐ‰½‘ä€ôÍ…™•)Í½¹=‰©•Ð¡É…Ü¤ì(€½¹ÍÐ‘•Á±½åµ•¹Ñ%€ôMÑÉ¥¹œ¡‰½‘ä¹‘•Á±½åµ•¹Ñ%ñð€œœ¤ì(€¥˜€ „½y‘•Á}m„µèÀ´åuìÄØ°ØÑô½¤¹Ñ•ÍÐ¡‘•Á±½åµ•¹Ñ%¤¤(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä‘•Á±½åµ•¹Ñ%¥¹Ù…±¥œ¤ì(€½¹ÍÐ•áÁ•Ñ•‘Q½­•¸€ôÉ•…Ñ•!µ…Œ Í¡„ÈÔØœ°Í•É•Ð¤(€€€€¹ÕÁ‘…Ñ”¡‘•Á±½åµ•¹Ñ%¤(€€€€¹‘¥•ÍÐ ‰…Í”ØÑÕÉ°œ¤ì(€¥˜€ …•ÅÕ…±M•É•Ð¡‰•…É•ÉQ½­•¸¡…ÕÑ¡½É¥é…Ñ¥½¸¤°•áÁ•Ñ•‘Q½­•¸¤¤(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä…ÕÑ¡½É¥é…Ñ¥½¸¥¹Ù…±¥œ¤ì(€½¹ÍÐÑ¥µ•ÍÑ…µÀ€ô9Õµ‰•È¡…ÕÑ¡•¹Ñ¥…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ¤ì(€½¹ÍÐ¹½¹”€ô…ÕÑ¡•¹Ñ¥…Ñ¥½¸¹¹½¹”ü¹ÑÉ¥´ ¤ñð€œœì(€½¹ÍÐÍ¥¹…ÑÕÉ”€ô…ÕÑ¡•¹Ñ¥…Ñ¥½¸¹Í¥¹…ÑÕÉ”ü¹ÑÉ¥´ ¤ñð€œœì(€¥˜€ (€€€€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡Ñ¥µ•ÍÑ…µÀ¤ñð(€€€5…Ñ ¹…‰Ì¡¹½Ü€´Ñ¥µ•ÍÑ…µÀ¤€øQ15QIe}IEUMQ}5a}1=-}M-]}5L(€€¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉäÉ•ÅÕ•ÍÐÑ¥µ•ÍÑ…µÀ¥¹Ù…±¥œ¤ì(€ô(€¥˜€ „½ym„µéµhÀ´ä¹|èµuìÄØ°ÄÈáô¼¹Ñ•ÍÐ¡¹½¹”¤¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉäÉ•ÅÕ•ÍÐ¹½¹”¥¹Ù…±¥œ¤ì(€ô(€½¹ÍÐ•áÁ•Ñ•‘M¥¹…ÑÕÉ”€ôÍ¥¹Q•±•µ•ÑÉåI•ÅÕ•ÍÐ¡ì(€€€Ñ½­•¸è•áÁ•Ñ•‘Q½­•¸°(€€€Ñ¥µ•ÍÑ…µÀ°(€€€¹½¹”°(€€€‰½‘ä°(€ô¤ì(€¥˜€ …•ÅÕ…±M•É•Ð¡Í¥¹…ÑÕÉ”°•áÁ•Ñ•‘M¥¹…ÑÕÉ”¤¤ì(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉäÉ•ÅÕ•ÍÐÍ¥¹…ÑÕÉ”¥¹Ù…±¥œ¤ì(€ô(€¥˜€ …ÉÉ…ä¹¥ÍÉÉ…ä¡‰½‘ä¹•Ù•¹ÑÌ¤ñð‰½‘ä¹•Ù•¹ÑÌ¹±•¹Ñ €ôôô€Àñð‰½‘ä¹•Ù•¹ÑÌ¹±•¹Ñ €ø€ÄÀÀ¤(€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä•Ù•¹ÑÌ¥¹Ù…±¥œ¤ì(€±•Ð…•ÁÑ•€ô€Àì(€±•Ð‘ÕÁ±¥…Ñ•Ì€ô€Àì(€½¹ÍÐ¥¹Í•ÉÐ€ôÍÑ½É”¹‘ˆ ¤¹ÁÉ•Á…É” (€€€%9MIP=H%9=I%9Q<Ñ•±•µ•ÑÉå}¥¹•ÍÑ}•Ù•¹ÑÌ(€€€€€¡‘•Á±½åµ•¹Ñ}¥°•Ù•¹Ñ}¥°½É…¹¥é…Ñ¥½¹}¥°•Ù•¹Ñ}ÑåÁ”°Á…å±½…‘}©Í½¸°(€€€€€¥¹Ñ•É¥Ñä°Í½ÕÉ•}É•…Ñ•‘}…Ñ}µÌ°É••¥Ù•‘}…Ñ}µÌ¤(€€€€Y1UL€ ü°€ü°€ü°€ü°€ü°€ü°€ü°€ü¥€°(€€¤ì(€ÉÕ¹%¹QÉ…¹Í…Ñ¥½¸¡ÍÑ½É”¹‘ˆ ¤°€ ¤€ôøì(€€€ÍÑ½É”¹‘ˆ ¤¹ÁÉ•Á…É” (€€€€€€1QI=4Ñ•±•µ•ÑÉå}¥¹•ÍÑ}¹½¹•Ì]!IÉ••¥Ù•‘}…Ñ}µÌ€ð€üœ°(€€€€¤¹ÉÕ¸¡¹½Ü€´Q15QIe}IEUMQ}5a}1=-}M-]}5L€¨€È¤ì(€€€ÑÉäì(€€€€€ÍÑ½É”¹‘ˆ ¤¹ÁÉ•Á…É” (€€€€€€€%9MIP%9Q<Ñ•±•µ•ÑÉå}¥¹•ÍÑ}¹½¹•Ì(€€€€€€€€€¡‘•Á±½åµ•¹Ñ}¥°¹½¹”°É••¥Ù•‘}…Ñ}µÌ¤Y1UL€ ü°€ü°€ü¥€°(€€€€€€¤¹ÉÕ¸¡‘•Á±½åµ•¹Ñ%°¹½¹”°¹½Ü¤ì(€€€ô…Ñ €¡•ÉÉ½È¤ì(€€€€€¥˜€ ½U9%EU½¹ÍÑÉ…¥¹Ð™…¥±•èÑ•±•µ•ÑÉå}¥¹•ÍÑ}¹½¹•Íp¸½¤¹Ñ•ÍÐ (€€€€€€€Í…™•ÉÉ½É5•ÍÍ…”¡•ÉÉ½È¤°(€€€€€€¤¤ì(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉäÉ•ÅÕ•ÍÐÉ•Á±…ä‘•Ñ•Ñ•œ¤ì(€€€€€ô(€€€€€Ñ¡É½Ü•ÉÉ½Èì(€€€ô(€€€™½È€¡½¹ÍÐ¥Ñ•´½˜‰½‘ä¹•Ù•¹ÑÌ…ÌÕ¹­¹½Ý¹mt¤ì(€€€€€½¹ÍÐ•Ù•¹Ð€ôÍ…™•)Í½¹=‰©•Ð¡¥Ñ•´¤ì(€€€€€½¹ÍÐ¥€ôMÑÉ¥¹œ¡•Ù•¹Ð¹¥ñð€œœ¤ì(€€€€€½¹ÍÐ•Ù•¹ÑQåÁ”€ôMÑÉ¥¹œ¡•Ù•¹Ð¹•Ù•¹ÑQåÁ”ñð€œœ¤ì(€€€€€½¹ÍÐÉ•…Ñ•‘Ñ5Ì€ô9Õµ‰•È¡•Ù•¹Ð¹É•…Ñ•‘Ñ5Ì¤ì(€€€€€½¹ÍÐ¥¹Ñ•É¥Ñä€ôMÑÉ¥¹œ¡•Ù•¹Ð¹¥¹Ñ•É¥Ñäñð€œœ¤ì(€€€€€¥˜€ „½yÑ•±}m„µèÀ´åuìÄØ°ØÑô½¤¹Ñ•ÍÐ¡¥¤ñð€„½ym„µèÀ´å|¸èµuìÈ°àÁô½¤¹Ñ•ÍÐ¡•Ù•¹ÑQåÁ”¤¤(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä•Ù•¹Ð¥‘•¹Ñ¥Ñä¥¹Ù…±¥œ¤ì(€€€€€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡É•…Ñ•‘Ñ5Ì¤ñðÉ•…Ñ•‘Ñ5Ì€ðô€ÀñðÉ•…Ñ•‘Ñ5Ì€ø¹½Ü€¬€Ô€¨€ØÀ€¨€ÄÀÀÀ¤(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä•Ù•¹ÐÑ¥µ•ÍÑ…µÀ¥¹Ù…±¥œ¤ì(€€€€€¥˜€¡Ñ•±•µ•ÑÉå½¹Ñ…¥¹Í½¹Ñ•¹Ð¡•Ù•¹Ð¹Á…å±½…¤¤(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä½¹Ñ•¹ÐÁ…å±½…™½É‰¥‘‘•¸œ¤ì(€€€€€¥˜€¡Ñ•±•µ•ÑÉå%¹Ñ•É¥Ñå!…Í ¡•Ù•¹Ð¹Á…å±½…¤€„ôô¥¹Ñ•É¥Ñä¤(€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È Ñ•±•µ•ÑÉä•Ù•¹Ð¥¹Ñ•É¥Ñä¥¹Ù…±¥œ¤ì(€€€€€½¹ÍÐ¥¹™¼€ô¥¹Í•ÉÐ¹ÉÕ¸ (€€€€€€€‘•Á±½åµ•¹Ñ%°(€€€€€€€¥°(€€€€€€€ÑåÁ•½˜•Ù•¹Ð¹½É…¹¥é…Ñ¥½¹%€ôôô€ÍÑÉ¥¹œœ€ü•Ù•¹Ð¹½É…¹¥é…Ñ¥½¹%€è¹Õ±°°(€€€€€€€•Ù•¹ÑQåÁ”°(€€€€€€€)M=8¹ÍÑÉ¥¹¥™ä¡•Ù•¹Ð¹Á…å±½…¤°(€€€€€€€¥¹Ñ•É¥Ñä°(€€€€€€€É•…Ñ•‘Ñ5Ì°(€€€€€€€¹½Ü°(€€€€€€¤ì(€€€€€¥˜€¡¥¹™¼¹¡…¹•Ì€ôôô€Ä¤…•ÁÑ•€¬ô€Äì(€€€€€•±Í”‘ÕÁ±¥…Ñ•Ì€¬ô€Äì(€€€ô(€ô¤ì(€É•ÑÕÉ¸ì…•ÁÑ•°‘ÕÁ±¥…Ñ•Ìôì)ô()™Õ¹Ñ¥½¸•Ñ•Á±½åµ•¹ÑIÕ¹Ñ¥µ•!•…±Ñ  (€ÍÑ½É”è•Á±½åµ•¹ÑI•Á½Í¥Ñ½ÉåMÑ½É”°(¤èAÉ¥Ù…Ñ••Á±½åµ•¹ÑMÑ…ÑÕÍlÉÕ¹Ñ¥µ•!•…±Ñ tì(€½¹ÍÐ‘…Ñ…‰…Í”€ôÍÑ½É”¹‘ˆ ¤ì(€½¹ÍÐµ•µ½Éä€ôÁÉ½•ÍÌ¹µ•µ½ÉåUÍ…” ¤ì(€½¹ÍÐÁÔ€ôÁÉ½•ÍÌ¹ÁÕUÍ…” ¤ì(€½¹ÍÐ½É…¹¥é…Ñ¥½¹Ì€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” (€€€€€€‰M1P=U9P ¨¤L½Õ¹ÐI=4½É…¹¥é…Ñ¥½¹Ì]!IÍÑ…ÑÕÌ€ô€…Ñ¥Ù”œˆ°(€€€€¤(€€€€¹•Ð ¤…Ìì½Õ¹Ðè¹Õµ‰•Èôì(€½¹ÍÐ…½Õ¹ÑÌ€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” (€€€€€€‰M1P=U9P ¨¤L½Õ¹ÐI=4…½Õ¹ÑÌ]!I‘•±•Ñ•‘}…Ð%L9U109ÍÑ…ÑÕÌ€ô€…Ñ¥Ù”œˆ°(€€€€¤(€€€€¹•Ð ¤…Ìì½Õ¹Ðè¹Õµ‰•Èôì(€½¹ÍÐ…Õ‘¥Ð€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” (€€€€€M1P(€€€€€€MU4¡M]!8±½Ý•È¡•Ù•¹Ð¤1%-€œ••ÉÉ½È”œ=H±½Ý•È¡•Ù•¹Ð¤1%-€œ•™…¥°”œ(€€€€€€€€€€€€=H±½Ý•È¡=1M¡‘•Ñ…¥°°€œœ¤¤1%-€œ••ÉÉ½È”œ=H±½Ý•È¡=1M¡‘•Ñ…¥°°€œœ¤¤1%-€œ•™…¥°”œ(€€€€€€€€€€Q!8€Ä1M€À9¤L•ÉÉ½É½Õ¹Ð°(€€€€€€MU4¡M]!8±½Ý•È¡•Ù•¹Ð¤1%-€œ•É…Í ”œ=H±½Ý•È¡•Ù•¹Ð¤1%-€œ•Õ¹…Õ¡Ð”œ(€€€€€€€€€€€€=H±½Ý•È¡=1M¡‘•Ñ…¥°°€œœ¤¤1%-€œ•É…Í ”œ=H±½Ý•È¡=1M¡‘•Ñ…¥°°€œœ¤¤1%-€œ•Õ¹…Õ¡Ð”œ(€€€€€€€€€€Q!8€Ä1M€À9¤LÉ…Í¡½Õ¹Ð(€€€€I=4…Õ‘¥Ñ}±½Í€°(€€€€¤(€€€€¹•Ð ¤…Ìì•ÉÉ½É½Õ¹Ðè¹Õµ‰•Èð¹Õ±°ìÉ…Í¡½Õ¹Ðè¹Õµ‰•Èð¹Õ±°ôì(€½¹ÍÐÕÍ…”€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” (€€€€€€M1P=U9P ¨¤L…±±½Õ¹Ð°=1M¡MU4¡Ñ½Ñ…±}Ñ½­•¹Ì¤°€À¤LÑ½­•¹Q½Ñ…°I=4…½Õ¹Ñ}Ñ½­•¹}ÕÍ…”œ°(€€€€¤(€€€€¹•Ð ¤…Ìì…±±½Õ¹Ðè¹Õµ‰•ÈìÑ½­•¹Q½Ñ…°è¹Õµ‰•Èôì(€É•ÑÕÉ¸ì(€€€ÕÁÑ¥µ•M•Œè5…Ñ ¹É½Õ¹¡ÁÉ½•ÍÌ¹ÕÁÑ¥µ” ¤¤°(€€€¹½‘•Y•ÉÍ¥½¸èÁÉ½•ÍÌ¹Ù•ÉÍ¥½¸°(€€€µ•µ½ÉåIÍÍ5ˆè5…Ñ ¹É½Õ¹¡µ•µ½Éä¹ÉÍÌ€¼€ÄÀÈÐ€¼€ÄÀÈÐ¤°(€€€µ•µ½Éå!•…ÁUÍ•‘5ˆè5…Ñ ¹É½Õ¹¡µ•µ½Éä¹¡•…ÁUÍ•€¼€ÄÀÈÐ€¼€ÄÀÈÐ¤°(€€€ÁÕUÍ•É5Ìè5…Ñ ¹É½Õ¹¡ÁÔ¹ÕÍ•È€¼€ÄÀÀÀ¤°(€€€ÁÕMåÍÑ•µ5Ìè5…Ñ ¹É½Õ¹¡ÁÔ¹ÍåÍÑ•´€¼€ÄÀÀÀ¤°(€€€…Ñ¥Ù•=É…¹¥é…Ñ¥½¹Ìè½É…¹¥é…Ñ¥½¹Ì¹½Õ¹Ð°(€€€…Ñ¥Ù•½Õ¹ÑÌè…½Õ¹ÑÌ¹½Õ¹Ð°(€€€…Õ‘¥ÑÉÉ½É½Õ¹Ðè…Õ‘¥Ð¹•ÉÉ½É½Õ¹Ð€üü€À°(€€€…Õ‘¥ÑÉ…Í¡½Õ¹Ðè…Õ‘¥Ð¹É…Í¡½Õ¹Ð€üü€À°(€€€…•¹Ñ…±±½Õ¹ÐèÕÍ…”¹…±±½Õ¹Ð°(€€€Ñ½­•¹Q½Ñ…°èÕÍ…”¹Ñ½­•¹Q½Ñ…°°(€€€ÍÕ•ÍÍI…Ñ”è¹Õ±°°(€€€…Ù1…Ñ•¹å5Ìè¹Õ±°°(€ôì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸•ÑAÉ¥Ù…Ñ••Á±½åµ•¹ÑMÑ…ÑÕÌ (€ÍÑ½É”è•Á±½åµ•¹ÑI•Á½Í¥Ñ½ÉåMÑ½É”°(¤èAÉ¥Ù…Ñ••Á±½åµ•¹ÑMÑ…ÑÕÌì(€½¹ÍÐÑ•±•µ•ÑÉä€ô•ÑQ•±•µ•ÑÉåM•ÑÑ¥¹Ì¡ÍÑ½É”¤ì(€½¹ÍÐ‰¥±±¥¹MÑ½É”€ôÉ•…Ñ••Á±½åµ•¹Ñ	¥±±¥¹UÍ…•MÑ½É”¡ÍÑ½É”¤ì(€½¹ÍÐ‰¥±±¥¹MÕµµ…Éä€ô•Ñ	¥±±¥¹UÍ…•EÕ•Õ•MÕµµ…Éä¡‰¥±±¥¹MÑ½É”¤ì(€±•ÐÉ••¥ÁÑ-•äèAÉ¥Ù…Ñ••Á±½åµ•¹ÑMÑ…ÑÕÍl‰¥±±¥¹œul•á•ÕÑ¥½¹I••¥ÁÐul­•ät€ô¹Õ±°ì(€±•ÐÉ••¥ÁÑ-•åÉÉ½ÈèÍÑÉ¥¹œð¹Õ±°€ô¹Õ±°ì(€ÑÉäì(€€€É••¥ÁÑ-•ä€ô•Ñ	¥±±¥¹á•ÕÑ¥½¹I••¥ÁÑ-•ä¡‰¥±±¥¹MÑ½É”¤ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€É••¥ÁÑ-•åÉÉ½È€ôÍ…™•ÉÉ½É5•ÍÍ…”¡•ÉÉ½È¤ì(€ô(€É•ÑÕÉ¸ì(€€€‘•Á±½åµ•¹Ñ%è•Ñ•Á±½åµ•¹Ñ%¡ÍÑ½É”¤°(€€€µ…¡¥¹•¥¹•ÉÁÉ¥¹Ðè•Ñ5…¡¥¹•¥¹•ÉÁÉ¥¹Ð ¤°(€€€±¥•¹Í”è•Ñ•Á±½åµ•¹Ñ1¥•¹Í”¡ÍÑ½É”¤°(€€€Ñ•±•µ•ÑÉäèì€¸¸¹Ñ•±•µ•ÑÉä°€¸¸¹•ÑQ•±•µ•ÑÉåEÕ•Õ•MÕµµ…Éä¡ÍÑ½É”¤ô°(€€€‰¥±±¥¹œèì(€€€€€€¸¸¹‰¥±±¥¹MÕµµ…Éä°(€€€€€…‘µ¥ÍÍ¥½¸è•Ñ	¥±±¥¹‘µ¥ÍÍ¥½¹EÕ•Õ•MÕµµ…Éä (€€€€€€€‰¥±±¥¹MÑ½É”°(€€€€€€¤°(€€€€€•á•ÕÑ¥½¹I••¥ÁÐèì(€€€€€€€ÁÉ½Ñ½½°è€•á•ÕÑ¥½¹}É••¥ÁÑ}ØÈœ°(€€€€€€€­•äèÉ••¥ÁÑ-•ä°(€€€€€€€É•¥ÍÑÉ…Ñ¥½¹I•ÅÕ¥É•è‰¥±±¥¹MÕµµ…Éä¹Í•¹Ð€ôôô€À°(€€€€€€€•ÉÉ½ÈèÉ••¥ÁÑ-•åÉÉ½È°(€€€€€ô°(€€€€€•Ù¥‘•¹•QÉÕÍÐè€Í¥¹•‘}•á•ÕÑ¥½¹}É••¥ÁÑ}ØÈœ°(€€€ô°(€€€‘…Ñ…	½Õ¹‘…Éäèì(€€€€€ÕÁ±½…‘Í½¹Ñ•¹Ñ	å•™…Õ±Ðè™…±Í”°(€€€€€¥¹±Õ‘•ÍUÍ•É5•ÍÍ…•Ìè™…±Í”°(€€€€€¥¹±Õ‘•Í¥±•Ìè™…±Í”°(€€€€€¥¹±Õ‘•Í5••Ñ¥¹Õ‘¥¼è™…±Í”°(€€€€€‘•™…Õ±ÑA…å±½…èl(€€€€€€€€±¥•¹Í”ÍÑ…ÑÕÌœ°(€€€€€€€€Ù•ÉÍ¥½¸œ°(€€€€€€€€µ½‘Õ±”ÕÍ…”½Õ¹Ñ•ÉÌœ°(€€€€€€€€•ÉÉ½È½‘•Ìœ°(€€€€€€€€ÉÕ¹Ñ¥µ”¡•…±Ñ œ°(€€€€€t°(€€€ô°(€€€µ½‘Õ±•…Ñ…±½œè±¥•¹Í•5½‘Õ±•…Ñ…±½œ ¤°(€€€ÉÕ¹Ñ¥µ•!•…±Ñ è•Ñ•Á±½åµ•¹ÑIÕ¹Ñ¥µ•!•…±Ñ ¡ÍÑ½É”¤°(€ôì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸•áÁ½ÉÑ•Á±½åµ•¹Ñ¥…¹½ÍÑ¥Ì (€ÍÑ½É”è•Á±½åµ•¹ÑI•Á½Í¥Ñ½ÉåMÑ½É”°(€¥¹ÁÕÐèì¥¹±Õ‘•I•‘…Ñ•‘M…µÁ±•Ìüè‰½½±•…¸ô€ôíô°(¤èI•½ÉñÍÑÉ¥¹œ°Õ¹­¹½Ý¸øì(€½¹ÍÐ‘…Ñ…‰…Í”€ôÍÑ½É”¹‘ˆ ¤ì(€½¹ÍÐ½ÉÌ€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” M1P=U9P ¨¤L½Õ¹ÐI=4½É…¹¥é…Ñ¥½¹Ìœ¤(€€€€¹•Ð ¤…Ìì½Õ¹Ðè¹Õµ‰•Èôì(€½¹ÍÐ…½Õ¹ÑÌ€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” (€€€€€€‰M1P=U9P ¨¤L½Õ¹ÐI=4…½Õ¹ÑÌ]!I‘•±•Ñ•‘}…Ð%L9U109ÍÑ…ÑÕÌ€ô€…Ñ¥Ù”œˆ°(€€€€¤(€€€€¹•Ð ¤…Ìì½Õ¹Ðè¹Õµ‰•Èôì(€½¹ÍÐÑ¥­•ÑÌ€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” M1PÍÑ…ÑÕÌ°=U9P ¨¤L½Õ¹ÐI=4¥Ñ}Ñ¥­•ÑÌI=U@	dÍÑ…ÑÕÌœ¤(€€€€¹…±° ¤ì(€½¹ÍÐÉ••¹ÑÉÉ½ÉÌ€ô‘…Ñ…‰…Í”(€€€€¹ÁÉ•Á…É” (€€€€€M1P•Ù•¹Ð°‘•Ñ…¥°°É•…Ñ•‘}…ÐI=4…Õ‘¥Ñ}±½Ì(€€€€]!I±½Ý•È¡•Ù•¹Ð¤1%-€œ••ÉÉ½È”œ=H±½Ý•È¡•Ù•¹Ð¤1%-€œ•™…¥°”œ(€€€€=IH	dÉ•…Ñ•‘}…ÐM1%5%P€ÈÁ€°(€€€€¤(€€€€¹…±° ¤ì(€É•ÑÕÉ¸ì(€€€•¹•É…Ñ•‘Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°(€€€‘•Á±½åµ•¹Ðè•ÑAÉ¥Ù…Ñ••Á±½åµ•¹ÑMÑ…ÑÕÌ¡ÍÑ½É”¤°(€€€‘…Ñ…‰…Í”èÍÑ½É”¹‘…Ñ…‰…Í•I•…‘¥¹•ÍÌ ¤°(€€€½Õ¹ÑÌèì½É…¹¥é…Ñ¥½¹Ìè½ÉÌ¹½Õ¹Ð°…Ñ¥Ù•½Õ¹ÑÌè…½Õ¹ÑÌ¹½Õ¹Ðô°(€€€Ñ¥­•ÑÌ°(€€€É••¹ÑÉÉ½ÉÌ°(€€€É•‘…Ñ•‘M…µÁ±•Í%¹±Õ‘•è¥¹ÁÕÐ¹¥¹±Õ‘•I•‘…Ñ•‘M…µÁ±•Ì€ôôôÑÉÕ”°(€€€ÁÉ¥Ù…äè(€€€€€€9¼¡…Ð½¹Ñ•¹Ð°™¥±”‰½‘ä°µ••Ñ¥¹œ…Õ‘¥¼°½ÈÉ…ÜÕÁ±½…‘•‘½Õµ•¹Ð¥Ì¥¹±Õ‘•‰ä‘•™…Õ±Ð¸œ°(€ôì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸¥Í1¥•¹Í•UÍ…‰±•½É=É…¹¥é…Ñ¥½¹•…ÑÕÉ” (€ÍÑ½É”è•Á±½åµ•¹ÑI•Á½Í¥Ñ½ÉåMÑ½É”°(€™•…ÑÕÉ”è=É…¹¥é…Ñ¥½¹•…ÑÕÉ•-•ä°(¤è‰½½±•…¸ì(€½¹ÍÐ±¥•¹Í”€ô•Ñ•Á±½åµ•¹Ñ1¥•¹Í”¡ÍÑ½É”¤ì(€¥˜€ …±¥•¹Í”¹•¹™½É”€˜˜l…Ñ¥Ù”œ°€•áÁ¥É¥¹œœ°€É…”t¹¥¹±Õ‘•Ì¡±¥•¹Í”¹ÍÑ…ÑÕÌ¤¤É•ÑÕÉ¸ÑÉÕ”ì(€¥˜€ …l…Ñ¥Ù”œ°€•áÁ¥É¥¹œœ°€É…”t¹¥¹±Õ‘•Ì¡±¥•¹Í”¹ÍÑ…ÑÕÌ¤¤É•ÑÕÉ¸™…±Í”ì(€™½È€¡½¹ÍÐµ½‘Õ±•9…µ”½˜±¥•¹Í”¹µ½‘Õ±•Ì¤ì(€€€¥˜€¡1%9M}5=U1}QUIMmµ½‘Õ±•9…µ•tü¹¥¹±Õ‘•Ì¡™•…ÑÕÉ”¤¤É•ÑÕÉ¸ÑÉÕ”ì(€ô(€É•ÑÕÉ¸™…±Í”ì)ô()•áÁ½ÉÐ™Õ¹Ñ¥½¸¥Í1¥•¹Í•I•ÍÑÉ¥Ñ•¡ÍÑ½É”è•Á±½åµ•¹ÑI•Á½Í¥Ñ½ÉåMÑ½É”¤è‰½½±•…¸ì(€½¹ÍÐ±¥•¹Í”€ô•Ñ•Á±½åµ•¹Ñ1¥•¹Í”¡ÍÑ½É”¤ì(€É•ÑÕÉ¸€ (€€€±¥•¹Í”¹•¹™½É”€˜˜(€€€€…l…Ñ¥Ù”œ°€•áÁ¥É¥¹œœ°€É…”t¹¥¹±Õ‘•Ì¡±¥•¹Í”¹ÍÑ…ÑÕÌ¤(€€¤ì)ô(