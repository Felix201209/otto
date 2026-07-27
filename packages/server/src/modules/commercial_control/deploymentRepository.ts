/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import os from 'os';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../data_platform/index.js';
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

export interface DeploymentRepositoryStore {
  db(): Database;
  readSetting(key: string): string | null;
  writeSetting(key: string, value: string): void;
  defaultOrganizationId: string;
  licenseEnforcementEnabled(): boolean;
  licenseSigningSecret(): string;
  telemetryEndpoint(): string | null;
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

function signDeploymentPayload(
  store: DeploymentRepositoryStore,
  payload: unknown,
): string {
  const secret = store.licenseSigningSecret() || getDeploymentId(store);
  return createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('base64url');
}

function verifyDeploymentLicensePayload(
  store: DeploymentRepositoryStore,
  payload: unknown,
  signature: string,
): boolean {
  const secret = store.licenseSigningSecret();
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('base64url');
  return tokensEqual(expected, signature);
}

function tokensEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
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
  deployment_id: string;
  organization_id: string | null;
  customer_name: string;
  plan: string;
  expires_at_ms: number;
  seat_limit: number;
  modules_json: string;
  offline: number;
  telemetry_allowed: number;
  issued_at_ms: number;
  revoked_at_ms: number | null;
  signature: string;
  raw_json: string;
  updated_at: string;
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
      deploymentId: getDeploymentId(store),
      organizationId: null,
      customerName: 'Unlicensed deployment',
      plan: enforce ? 'locked' : 'development-open',
      expiresAt: dateFromMs(now + 365 * 24 * 60 * 60 * 1000),
      seatLimit: enforce ? 0 : Number.MAX_SAFE_INTEGER,
      activeSeatCount: activeSeats,
      seatLimitExceeded: false,
      modules,
      offline: true,
      telemetryAllowed: false,
      status: enforce ? 'missing' : 'active',
      enforce,
      updatedAt: dateFromMs(now),
    };
  }
  const modules = parseModules(row.modules_json);
  let status: DeploymentLicenseStatus = 'active';
  if (row.revoked_at_ms != null) status = 'revoked';
  else if (now >= row.expires_at_ms) status = 'expired';
  else if (row.expires_at_ms - now <= 14 * 24 * 60 * 60 * 1000)
    status = 'expiring';
  try {
    const payload = JSON.parse(row.raw_json);
    if (!verifyDeploymentLicensePayload(store, payload, row.signature))
      status = 'invalid';
  } catch {
    status = 'invalid';
  }
  const seats = activeSeatCount(store, row.organization_id);
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    organizationId: row.organization_id,
    customerName: row.customer_name,
    plan: row.plan,
    expiresAt: dateFromMs(row.expires_at_ms),
    seatLimit: row.seat_limit,
    activeSeatCount: seats,
    seatLimitExceeded: row.seat_limit > 0 && seats > row.seat_limit,
    modules,
    offline: row.offline === 1,
    telemetryAllowed: row.telemetry_allowed === 1,
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
  const payload = safeJsonObject(
    envelope.license ?? envelope.payload ?? envelope,
  );
  const signature =
    typeof envelope.signature === 'string'
      ? envelope.signature
      : typeof payload.signature === 'string'
        ? payload.signature
        : '';
  if (!verifyDeploymentLicensePayload(store, payload, signature))
    throw new Error('license signature invalid');
  const deploymentId = String(payload.deploymentId || getDeploymentId(store));
  if (deploymentId !== getDeploymentId(store))
    throw new Error('license deploymentId mismatch');
  const modules = Array.isArray(payload.modules)
    ? [...new Set(payload.modules
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map((item) => canonicalLicenseCapabilityId(item) ?? item))]
    : [];
  const expiresAtMs = Number(
    payload.expiresAtMs ?? Date.parse(String(payload.expiresAt || '')),
  );
  const parsedIssuedAtMs = Date.parse(String(payload.issuedAt || ''));
  const issuedAtMs = Number(
    payload.issuedAtMs ??
      (Number.isFinite(parsedIssuedAtMs) ? parsedIssuedAtMs : Date.now()),
  );
  const seatLimit = Math.max(0, Math.floor(Number(payload.seatLimit ?? 0)));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0)
    throw new Error('license expiresAt invalid');
  if (modules.length === 0) throw new Error('license modules required');
  const id = String(payload.id || `lic_${randomUUID().replace(/-/g, '')}`);
  store.db()
    .prepare(
      `INSERT INTO deployment_license
       (id, deployment_id, organization_id, customer_name, plan, expires_at_ms, seat_limit,
        modules_json, offline, telemetry_allowed, issued_at_ms, revoked_at_ms, signature, raw_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       deployment_id = excluded.deployment_id,
       organization_id = excluded.organization_id,
       customer_name = excluded.customer_name,
       plan = excluded.plan,
       expires_at_ms = excluded.expires_at_ms,
       seat_limit = excluded.seat_limit,
       modules_json = excluded.modules_json,
       offline = excluded.offline,
       telemetry_allowed = excluded.telemetry_allowed,
       issued_at_ms = excluded.issued_at_ms,
       revoked_at_ms = excluded.revoked_at_ms,
       signature = excluded.signature,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`,
    )
    .run(
      id,
      deploymentId,
      typeof payload.organizationId === 'string'
        ? payload.organizationId
        : null,
      String(payload.customerName || 'Private customer'),
      String(payload.plan || 'enterprise'),
      expiresAtMs,
      seatLimit,
      JSON.stringify(modules),
      payload.offline === false ? 0 : 1,
      payload.telemetryAllowed === false ? 0 : 1,
      issuedAtMs,
      payload.revokedAtMs == null ? null : Number(payload.revokedAtMs),
      signature,
      JSON.stringify(payload),
    );
  store.audit(
    'deployment_license_import',
    null,
    `License imported: ${id}`,
    store.defaultOrganizationId,
  );
  return getDeploymentLicense(store);
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
      signDeploymentPayload(store, payload),
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
  if (!license.enforce && license.status === 'active') return true;
  if (
    !['active', 'expiring'].includes(license.status) ||
    license.seatLimitExceeded
  )
    return false;
  for (const moduleName of license.modules) {
    if (LICENSE_MODULE_FEATURES[moduleName]?.includes(feature)) return true;
  }
  return false;
}

export function isLicenseRestricted(store: DeploymentRepositoryStore): boolean {
  const license = getDeploymentLicense(store);
  return (
    license.enforce &&
    (!['active', 'expiring'].includes(license.status) ||
      license.seatLimitExceeded)
  );
}
