/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedFieldValue,
} from '../data_platform/index.js';
import {
  publicKeyId,
  signEd25519Envelope,
} from './signedEnvelope.js';

export const DEPLOYMENT_BILLING_MODULES = [
  'model_gateway',
  'meeting_agent',
  'park_service',
  'atoa',
  'feishu',
  'enterprise_knowledge',
  'skill_market',
  'data_visualization',
  'document_generation',
] as const;

export type DeploymentBillingModule =
  (typeof DEPLOYMENT_BILLING_MODULES)[number];

export interface DeploymentBillingCredentials {
  licenseId: string;
  deploymentId: string;
  organizationId: string;
  machineFingerprint: string;
  endpoint: string;
  holdEndpoint: string;
  enforcement: 'disabled' | 'enforce';
  leaseToken: string;
}

export interface BillingUsageRepositoryStore {
  db(): Database;
  deploymentId(): string;
  credentials(): DeploymentBillingCredentials | null;
  fieldCipher?: EncryptedFieldCipher;
}

export interface BillingUsageFlushResult {
  attempted: number;
  sent: number;
  discarded: number;
  failed: number;
  skippedReason: string | null;
}

export interface BillingExecutionReceiptKeyView {
  version: 2;
  keyId: string;
  publicKeyPem: string;
  policyVersion: 'commercial-v2';
  privateKeyLocation: 'customer-server-encrypted';
}

interface ExecutionReceiptV2Payload {
  version: 2;
  receiptId: string;
  deploymentId: string;
  organizationId: string;
  taskId: string;
  moduleId: DeploymentBillingModule;
  units: number;
  model: string | null;
  issuedAtMs: number;
  expiresAtMs: number;
  sequence: number;
  policyVersion: 'commercial-v2';
}

interface BillingUsageQueueRow {
  id: string;
  deployment_id: string;
  organization_id: string;
  module: DeploymentBillingModule;
  units: number;
  model: string | null;
  reference_id: string;
  idempotency_key: string;
  receipt_version: number | null;
  receipt_id: string | null;
  task_id: string | null;
  issued_at_ms: number | null;
  expires_at_ms: number | null;
  sequence: number | null;
  policy_version: string | null;
  signing_key_id: string | null;
  receipt_signature: string | null;
  attempts: number;
  created_at_ms: number;
  next_attempt_at_ms: number | null;
}

interface BillingReceiptKeyRow {
  deployment_id: string;
  key_id: string;
  public_key_pem: string;
  private_key_ciphertext: string;
  private_key_iv: string;
  private_key_auth_tag: string;
  private_key_version: number;
}

interface BillingReceiptSigner extends BillingExecutionReceiptKeyView {
  privateKeyPem: string;
}

const RECEIPT_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_POLICY_VERSION = 'commercial-v2' as const;
const MAX_MODEL_LENGTH = 160;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/u;

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 10));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function dateFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function encryptedPrivateKey(row: BillingReceiptKeyRow): EncryptedFieldValue {
  return {
    ciphertext: row.private_key_ciphertext,
    iv: row.private_key_iv,
    authTag: row.private_key_auth_tag,
    keyVersion: row.private_key_version,
  };
}

function privateKeyContext(deploymentId: string, keyId: string): string {
  return `billing-execution-receipt:${deploymentId}:${keyId}`;
}

function normalizePrivateKey(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('execution receipt signing key must be Ed25519');
  }
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function loadOrCreateReceiptSigner(
  store: BillingUsageRepositoryStore,
  now = Date.now(),
): BillingReceiptSigner {
  if (!store.fieldCipher) {
    throw new Error('execution receipt key encryption is not configured');
  }
  const deploymentId = store.deploymentId();
  const row = store.db().prepare(
    `SELECT deployment_id, key_id, public_key_pem, private_key_ciphertext,
            private_key_iv, private_key_auth_tag, private_key_version
     FROM billing_execution_receipt_keys
     WHERE deployment_id = ? AND status = 'active'
     ORDER BY created_at_ms DESC LIMIT 1`,
  ).get(deploymentId) as BillingReceiptKeyRow | undefined;
  if (row) {
    const privateKeyPem = normalizePrivateKey(store.fieldCipher.decryptText(
      encryptedPrivateKey(row),
      privateKeyContext(row.deployment_id, row.key_id),
    ));
    const publicKeyPem = createPublicKey(privateKeyPem)
      .export({ format: 'pem', type: 'spki' })
      .toString();
    if (publicKeyId(publicKeyPem) !== row.key_id || publicKeyPem !== row.public_key_pem) {
      throw new Error('execution receipt signing key integrity check failed');
    }
    return {
      version: 2,
      keyId: row.key_id,
      publicKeyPem,
      privateKeyPem,
      policyVersion: RECEIPT_POLICY_VERSION,
      privateKeyLocation: 'customer-server-encrypted',
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const publicKeyPem = publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const keyId = publicKeyId(publicKeyPem);
  const encrypted = store.fieldCipher.encryptText(
    privateKeyPem,
    privateKeyContext(deploymentId, keyId),
  );
  store.db().prepare(
    `INSERT INTO billing_execution_receipt_keys
      (deployment_id, key_id, public_key_pem, private_key_ciphertext,
       private_key_iv, private_key_auth_tag, private_key_version, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deploymentId,
    keyId,
    publicKeyPem,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.authTag,
    encrypted.keyVersion,
    now,
  );
  return {
    version: 2,
    keyId,
    publicKeyPem,
    privateKeyPem,
    policyVersion: RECEIPT_POLICY_VERSION,
    privateKeyLocation: 'customer-server-encrypted',
  };
}

export function getBillingExecutionReceiptKey(
  store: BillingUsageRepositoryStore,
): BillingExecutionReceiptKeyView {
  const { privateKeyPem: _privateKeyPem, ...view } = loadOrCreateReceiptSigner(store);
  return view;
}

function nextSequence(store: BillingUsageRepositoryStore, deploymentId: string): number {
  store.db().prepare(
    `INSERT OR IGNORE INTO billing_execution_receipt_sequences
      (deployment_id, last_sequence)
     SELECT ?, COALESCE(MAX(sequence), 0) FROM billing_usage_outbox
     WHERE deployment_id = ?`,
  ).run(deploymentId, deploymentId);
  const state = store.db().prepare(
    `SELECT last_sequence FROM billing_execution_receipt_sequences
     WHERE deployment_id = ?`,
  ).get(deploymentId) as { last_sequence: number };
  const sequence = state.last_sequence + 1;
  store.db().prepare(
    `UPDATE billing_execution_receipt_sequences
     SET last_sequence = ?, updated_at = datetime('now')
     WHERE deployment_id = ?`,
  ).run(sequence, deploymentId);
  return sequence;
}

function receiptId(deploymentId: string, idempotencyKey: string): string {
  return `exec_${createHash('sha256')
    .update(`${deploymentId}\0${idempotencyKey}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function createReceipt(input: {
  signer: BillingReceiptSigner;
  deploymentId: string;
  organizationId: string;
  taskId: string;
  module: DeploymentBillingModule;
  units: number;
  model: string | null;
  idempotencyKey: string;
  sequence: number;
  now: number;
}): { payload: ExecutionReceiptV2Payload; signature: string } {
  const payload: ExecutionReceiptV2Payload = {
    version: 2,
    receiptId: receiptId(input.deploymentId, input.idempotencyKey),
    deploymentId: input.deploymentId,
    organizationId: input.organizationId,
    taskId: input.taskId,
    moduleId: input.module,
    units: input.units,
    model: input.model,
    issuedAtMs: input.now,
    expiresAtMs: input.now + RECEIPT_VALIDITY_MS,
    sequence: input.sequence,
    policyVersion: RECEIPT_POLICY_VERSION,
  };
  return {
    payload,
    signature: signEd25519Envelope(payload, input.signer.privateKeyPem),
  };
}

function migrateUnsignedRows(
  store: BillingUsageRepositoryStore,
  signer: BillingReceiptSigner,
  credentials: DeploymentBillingCredentials,
  now: number,
): number {
  const rows = store.db().prepare(
    `SELECT id, deployment_id, organization_id, module, units, model,
            reference_id, idempotency_key, created_at_ms
     FROM billing_usage_outbox
     WHERE deployment_id = ? AND receipt_id IS NULL
       AND status = 'queued' AND attempts = 0
     ORDER BY created_at_ms ASC, id ASC`,
  ).all(credentials.deploymentId) as Array<{
    id: string;
    deployment_id: string;
    organization_id: string;
    module: DeploymentBillingModule;
    units: number;
    model: string | null;
    reference_id: string;
    idempotency_key: string;
    created_at_ms: number;
  }>;
  const update = store.db().prepare(
    `UPDATE billing_usage_outbox
     SET receipt_version = 2, receipt_id = ?, task_id = ?, issued_at_ms = ?,
         expires_at_ms = ?, sequence = ?, policy_version = ?, signing_key_id = ?,
         receipt_signature = ?, next_attempt_at_ms = NULL,
         last_error = NULL, updated_at = datetime('now')
     WHERE id = ? AND receipt_id IS NULL`,
  );
  for (const row of rows) {
    if (
      row.deployment_id !== credentials.deploymentId ||
      row.organization_id !== credentials.organizationId ||
      !DEPLOYMENT_BILLING_MODULES.includes(row.module) ||
      !IDENTIFIER.test(row.reference_id)
    ) {
      throw new Error('legacy billing usage cannot be bound to execution receipt');
    }
    const receipt = createReceipt({
      signer,
      deploymentId: row.deployment_id,
      organizationId: row.organization_id,
      taskId: row.reference_id,
      module: row.module,
      units: row.units,
      model: row.model,
      idempotencyKey: row.idempotency_key,
      sequence: nextSequence(store, row.deployment_id),
      now,
    });
    update.run(
      receipt.payload.receiptId,
      receipt.payload.taskId,
      receipt.payload.issuedAtMs,
      receipt.payload.expiresAtMs,
      receipt.payload.sequence,
      receipt.payload.policyVersion,
      signer.keyId,
      receipt.signature,
      row.id,
    );
  }
  return rows.length;
}

function withTransaction<T>(database: Database, action: () => T): T {
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    if (ownsTransaction) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function queueBillingUsage(
  store: BillingUsageRepositoryStore,
  input: {
    organizationId: string;
    module: DeploymentBillingModule;
    units: number;
    model?: string | null;
    referenceId: string;
    idempotencyKey: string;
  },
  now = Date.now(),
): boolean {
  const credentials = store.credentials();
  if (!credentials || credentials.organizationId !== input.organizationId) {
    return false;
  }
  if (credentials.enforcement !== 'enforce') return false;
  if (!DEPLOYMENT_BILLING_MODULES.includes(input.module)) {
    throw new Error('unsupported billing module');
  }
  if (!Number.isSafeInteger(input.units) || input.units < 1) {
    throw new Error('billing units must be a positive safe integer');
  }
  if (!IDENTIFIER.test(input.idempotencyKey)) {
    throw new Error('billing idempotency key is invalid');
  }
  if (!IDENTIFIER.test(input.referenceId)) {
    throw new Error('billing reference is invalid');
  }
  const model = input.model?.trim() || null;
  if (model && model.length > MAX_MODEL_LENGTH) {
    throw new Error('billing model is invalid');
  }
  return withTransaction(store.db(), () => {
    const duplicate = store.db().prepare(
      'SELECT 1 AS found FROM billing_usage_outbox WHERE idempotency_key = ?',
    ).get(input.idempotencyKey) as { found?: number } | undefined;
    if (duplicate?.found === 1) return false;
    const signer = loadOrCreateReceiptSigner(store, now);
    migrateUnsignedRows(store, signer, credentials, now);
    const receipt = createReceipt({
      signer,
      deploymentId: credentials.deploymentId,
      organizationId: input.organizationId,
      taskId: input.referenceId,
      module: input.module,
      units: input.units,
      model,
      idempotencyKey: input.idempotencyKey,
      sequence: nextSequence(store, credentials.deploymentId),
      now,
    });
    const id = `bil_${createHash('sha256')
      .update(`${credentials.deploymentId}\0${input.idempotencyKey}`, 'utf8')
      .digest('hex')}`;
    const result = store.db().prepare(
      `INSERT OR IGNORE INTO billing_usage_outbox
        (id, deployment_id, organization_id, module, units, model, reference_id,
         idempotency_key, receipt_version, receipt_id, task_id, issued_at_ms,
         expires_at_ms, sequence, policy_version, signing_key_id,
         receipt_signature, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      id,
      credentials.deploymentId,
      input.organizationId,
      input.module,
      input.units,
      model,
      input.referenceId,
      input.idempotencyKey,
      receipt.payload.receiptId,
      receipt.payload.taskId,
      receipt.payload.issuedAtMs,
      receipt.payload.expiresAtMs,
      receipt.payload.sequence,
      receipt.payload.policyVersion,
      signer.keyId,
      receipt.signature,
      now,
    );
    return Number(result.changes ?? 0) > 0;
  });
}

export function getBillingUsageQueueSummary(
  store: BillingUsageRepositoryStore,
): {
  queued: number;
  failed: number;
  sent: number;
  discarded: number;
  lastQueuedAt: string | null;
  lastError: string | null;
} {
  const rows = store.db().prepare(
    `SELECT status, COUNT(*) AS count, MAX(created_at_ms) AS last_created_at_ms
     FROM billing_usage_outbox GROUP BY status`,
  ).all() as Array<{
    status: 'queued' | 'sent' | 'failed' | 'discarded';
    count: number;
    last_created_at_ms: number | null;
  }>;
  const latestFailure = store.db().prepare(
    `SELECT last_error FROM billing_usage_outbox
     WHERE status = 'failed' AND last_error IS NOT NULL
     ORDER BY sequence ASC, created_at_ms ASC LIMIT 1`,
  ).get() as { last_error: string } | undefined;
  const summary = {
    queued: 0,
    failed: 0,
    sent: 0,
    discarded: 0,
    lastQueuedAt: null as string | null,
    lastError: latestFailure?.last_error ?? null,
  };
  for (const row of rows) {
    summary[row.status] = row.count;
    if (row.status === 'queued' && row.last_created_at_ms) {
      summary.lastQueuedAt = dateFromMs(row.last_created_at_ms);
    }
  }
  return summary;
}

function receiptPayload(row: BillingUsageQueueRow): ExecutionReceiptV2Payload | null {
  if (
    row.receipt_version !== 2 || !row.receipt_id || !row.task_id ||
    !row.issued_at_ms || !row.expires_at_ms || !row.sequence ||
    row.policy_version !== RECEIPT_POLICY_VERSION || !row.signing_key_id ||
    !row.receipt_signature
  ) return null;
  return {
    version: 2,
    receiptId: row.receipt_id,
    deploymentId: row.deployment_id,
    organizationId: row.organization_id,
    taskId: row.task_id,
    moduleId: row.module,
    units: row.units,
    model: row.model,
    issuedAtMs: row.issued_at_ms,
    expiresAtMs: row.expires_at_ms,
    sequence: row.sequence,
    policyVersion: RECEIPT_POLICY_VERSION,
  };
}

export async function flushBillingUsageQueue(
  store: BillingUsageRepositoryStore,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<BillingUsageFlushResult> {
  const result: BillingUsageFlushResult = {
    attempted: 0,
    sent: 0,
    discarded: 0,
    failed: 0,
    skippedReason: null,
  };
  store.db().prepare(
    `DELETE FROM billing_usage_outbox
     WHERE status IN ('sent', 'discarded') AND created_at_ms < ?`,
  ).run(now - 90 * 24 * 60 * 60 * 1000);
  const credentials = store.credentials();
  if (!credentials) return { ...result, skippedReason: 'billing_credentials_missing' };
  if (credentials.enforcement !== 'enforce') {
    return { ...result, skippedReason: 'billing_enforcement_disabled' };
  }
  try {
    withTransaction(store.db(), () => {
      const signer = loadOrCreateReceiptSigner(store, now);
      migrateUnsignedRows(store, signer, credentials, now);
    });
  } catch (error) {
    return {
      ...result,
      failed: 1,
      skippedReason: safeErrorMessage(error),
    };
  }

  for (let index = 0; index < 50; index += 1) {
    const row = store.db().prepare(
      `SELECT id, deployment_id, organization_id, module, units, model,
              reference_id, idempotency_key, receipt_version, receipt_id,
              task_id, issued_at_ms, expires_at_ms, sequence, policy_version,
              signing_key_id, receipt_signature, attempts, created_at_ms,
              next_attempt_at_ms
       FROM billing_usage_outbox
       WHERE status IN ('queued', 'failed')
       ORDER BY sequence ASC, created_at_ms ASC LIMIT 1`,
    ).get() as BillingUsageQueueRow | undefined;
    if (!row) break;
    if (row.next_attempt_at_ms && row.next_attempt_at_ms > now) {
      result.skippedReason = 'execution_receipt_head_backoff';
      break;
    }
    result.attempted += 1;
    const receipt = receiptPayload(row);
    if (
      !receipt || row.deployment_id !== credentials.deploymentId ||
      row.organization_id !== credentials.organizationId ||
      !DEPLOYMENT_BILLING_MODULES.includes(row.module) ||
      !Number.isSafeInteger(row.units) || row.units < 1
    ) {
      store.db().prepare(
        `UPDATE billing_usage_outbox
         SET status = 'failed', attempts = attempts + 1, next_attempt_at_ms = ?,
             last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(
        now + retryDelayMs(row.attempts + 1),
        row.receipt_id
          ? 'signed execution receipt binding is invalid'
          : 'legacy attempted usage requires operator reconciliation before v2 delivery',
        row.id,
      );
      result.failed += 1;
      break;
    }
    try {
      const response = await fetchImpl(credentials.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.leaseToken}`,
          'content-type': 'application/json',
          'user-agent': 'Otto-Private-Deployment/2',
        },
        body: JSON.stringify({
          licenseId: credentials.licenseId,
          machineFingerprint: credentials.machineFingerprint,
          envelope: {
            receipt,
            signingKeyId: row.signing_key_id,
            signature: row.receipt_signature,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`execution receipt endpoint returned ${response.status}`);
      }
      store.db().prepare(
        `UPDATE billing_usage_outbox
         SET status = 'sent', sent_at_ms = ?, next_attempt_at_ms = NULL,
             last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(now, row.id);
      result.sent += 1;
    } catch (error) {
      store.db().prepare(
        `UPDATE billing_usage_outbox
         SET status = 'failed', attempts = attempts + 1,
             next_attempt_at_ms = ?, last_error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        now + retryDelayMs(row.attempts + 1),
        safeErrorMessage(error),
        row.id,
      );
      result.failed += 1;
      break;
    }
  }
  return result;
}
