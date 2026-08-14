/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Resumable preparation of verified SQLite E2EE attachments for atomic
 * PostgreSQL promotion. S3 becomes authoritative only during promotion.
 */

import { createHash } from 'node:crypto';

import type { AttachmentObjectStore } from '../modules/data_platform/attachmentObjectStore.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';
import {
  loadVerifiedSqliteImportTable,
  type DecodedSqliteImportRow,
} from './postgresImportStaging.js';

const ATTACHMENT_IMPORT_LOCK_KEY = 0x4f545441;
const MAX_E2EE_PLAINTEXT_BYTES = 10 * 1024 * 1024;

interface ImportRunRow extends Record<string, unknown> {
  id: string;
  state: string;
}

interface PreparedAttachmentRow extends Record<string, unknown> {
  attachment_id: string;
  state: string;
  ciphertext_bytes: number | string;
  ciphertext_sha256: string;
  s3_storage_key: string | null;
}

interface AttachmentPlan {
  id: string;
  messageId: string;
  organizationId: string;
  senderAccountId: string;
  recipientAccountId: string;
  ordinal: number;
  plaintextBytes: number;
  nonce: string;
  sourceBackend: 'sqlite' | 'encrypted-filesystem';
  sourceStorageKey: string | null;
  inlineCiphertext: Buffer | null;
  createdAt: string;
}

export interface SqliteAttachmentImportResult {
  runId: string;
  state: 'planned' | 'prepared';
  total: number;
  alreadyPrepared: number;
  prepared: number;
  pending: number;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)
  ) {
    throw new Error(`SQLite attachment import ${label} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`SQLite attachment import ${label} is invalid`);
  }
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`SQLite attachment import ${label} is invalid`);
  }
  const normalized =
    value.endsWith('Z') || /[+-]\d\d:\d\d$/u.test(value)
      ? value
      : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`SQLite attachment import ${label} is invalid`);
  }
  return parsed.toISOString();
}

function canonicalNonce(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('SQLite attachment import E2EE nonce is invalid');
  }
  const normalized = value.trim();
  const decoded = Buffer.from(normalized, 'base64');
  if (
    decoded.length !== 12 ||
    decoded.toString('base64').replace(/=+$/u, '') !==
      normalized.replace(/=+$/u, '')
  ) {
    throw new Error('SQLite attachment import E2EE nonce is invalid');
  }
  return decoded.toString('base64');
}

function sourceBackend(
  value: unknown,
): 'sqlite' | 'encrypted-filesystem' {
  if (value !== 'sqlite' && value !== 'encrypted-filesystem') {
    throw new Error('SQLite attachment import source backend is unsupported');
  }
  return value;
}

function messageIndex(rows: DecodedSqliteImportRow[]) {
  const messages = new Map<
    string,
    {
      organizationId: string;
      senderAccountId: string;
      recipientAccountId: string;
    }
  >();
  for (const row of rows) {
    const id = identifier(row.id, 'message id');
    if (messages.has(id)) {
      throw new Error('SQLite attachment import contains duplicate messages');
    }
    if (Number(row.e2ee_protocol_version) !== 1) {
      continue;
    }
    messages.set(id, {
      organizationId: identifier(row.organization_id, 'organization id'),
      senderAccountId: identifier(row.sender_account_id, 'sender account id'),
      recipientAccountId: identifier(
        row.recipient_account_id,
        'recipient account id',
      ),
    });
  }
  return messages;
}

function attachmentPlans(input: {
  attachmentRows: DecodedSqliteImportRow[];
  messageRows: DecodedSqliteImportRow[];
}): AttachmentPlan[] {
  const messages = messageIndex(input.messageRows);
  const ids = new Set<string>();
  const positions = new Set<string>();
  return input.attachmentRows.map((row) => {
    const id = identifier(row.id, 'attachment id');
    const messageId = identifier(row.message_id, 'message id');
    const organizationId = identifier(row.organization_id, 'organization id');
    const message = messages.get(messageId);
    if (!message) {
      throw new Error(
        'SQLite attachment import only supports attachments from E2EE messages',
      );
    }
    if (message.organizationId !== organizationId) {
      throw new Error('SQLite attachment import tenant metadata is inconsistent');
    }
    const ordinal = integer(row.ordinal, 'attachment ordinal', 0, 5);
    if (ids.has(id) || positions.has(`${messageId}\0${ordinal}`)) {
      throw new Error('SQLite attachment import contains duplicate attachments');
    }
    ids.add(id);
    positions.add(`${messageId}\0${ordinal}`);
    const plaintextBytes = integer(
      row.byte_size,
      'attachment byte size',
      1,
      MAX_E2EE_PLAINTEXT_BYTES,
    );
    const backend = sourceBackend(row.storage_backend);
    const storageKey =
      typeof row.storage_key === 'string' && row.storage_key.trim()
        ? row.storage_key.trim()
        : null;
    if (backend === 'encrypted-filesystem' && !storageKey) {
      throw new Error('SQLite attachment import source object key is missing');
    }
    const inlineCiphertext = Buffer.isBuffer(row.content)
      ? Buffer.from(row.content)
      : row.content instanceof Uint8Array
        ? Buffer.from(row.content)
        : null;
    if (backend === 'sqlite' && !inlineCiphertext) {
      throw new Error('SQLite attachment import inline ciphertext is missing');
    }
    return {
      id,
      messageId,
      organizationId,
      senderAccountId: message.senderAccountId,
      recipientAccountId: message.recipientAccountId,
      ordinal,
      plaintextBytes,
      nonce: canonicalNonce(row.e2ee_nonce),
      sourceBackend: backend,
      sourceStorageKey: backend === 'encrypted-filesystem' ? storageKey : null,
      inlineCiphertext: backend === 'sqlite' ? inlineCiphertext : null,
      createdAt: timestamp(row.created_at, 'attachment created_at'),
    };
  });
}

function sha256(ciphertext: Buffer): string {
  return createHash('sha256').update(ciphertext).digest('hex');
}

function assertCiphertext(plan: AttachmentPlan, ciphertext: Buffer): string {
  if (ciphertext.length !== plan.plaintextBytes + 16) {
    throw new Error('SQLite attachment import ciphertext size is inconsistent');
  }
  return sha256(ciphertext);
}

async function verifyS3Object(input: {
  store: AttachmentObjectStore;
  key: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
}): Promise<void> {
  const head = await input.store.headObject(input.key);
  if (
    head.backend !== 's3' ||
    head.ciphertextBytes !== input.ciphertextBytes ||
    head.ciphertextSha256 !== input.ciphertextSha256
  ) {
    throw new Error('SQLite attachment import S3 metadata verification failed');
  }
  const downloaded = await input.store.getCiphertext(input.key);
  if (
    downloaded.length !== input.ciphertextBytes ||
    sha256(downloaded) !== input.ciphertextSha256
  ) {
    throw new Error('SQLite attachment import S3 ciphertext verification failed');
  }
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/source|inline|ciphertext size/i.test(message)) return 'source_invalid';
  if (/verification|checksum|metadata/i.test(message)) {
    return 'integrity_verification_failed';
  }
  return 'object_store_failed';
}

async function recordPreparation(input: {
  client: PostgresClientLike;
  runId: string;
  plan: AttachmentPlan;
  ciphertextBytes: number;
  ciphertextSha256: string;
  s3StorageKey: string | null;
  state: 'verified' | 'failed';
  failureCode: string | null;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO otto_sqlite_import_attachment_objects
      (run_id, attachment_id, message_id, organization_id, sender_account_id,
       recipient_account_id, ordinal, ciphertext_bytes, ciphertext_sha256,
       e2ee_nonce, source_backend, source_storage_key, s3_storage_key, state,
       failure_code, source_created_at, prepared_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16::timestamptz, CURRENT_TIMESTAMP)
     ON CONFLICT (run_id, attachment_id) DO UPDATE SET
       message_id = EXCLUDED.message_id,
       organization_id = EXCLUDED.organization_id,
       sender_account_id = EXCLUDED.sender_account_id,
       recipient_account_id = EXCLUDED.recipient_account_id,
       ordinal = EXCLUDED.ordinal,
       ciphertext_bytes = EXCLUDED.ciphertext_bytes,
       ciphertext_sha256 = EXCLUDED.ciphertext_sha256,
       e2ee_nonce = EXCLUDED.e2ee_nonce,
       source_backend = EXCLUDED.source_backend,
       source_storage_key = EXCLUDED.source_storage_key,
       s3_storage_key = EXCLUDED.s3_storage_key,
       state = EXCLUDED.state,
       failure_code = EXCLUDED.failure_code,
       source_created_at = EXCLUDED.source_created_at,
       prepared_at = CURRENT_TIMESTAMP`,
    [
      input.runId,
      input.plan.id,
      input.plan.messageId,
      input.plan.organizationId,
      input.plan.senderAccountId,
      input.plan.recipientAccountId,
      input.plan.ordinal,
      input.ciphertextBytes,
      input.ciphertextSha256,
      input.plan.nonce,
      input.plan.sourceBackend,
      input.plan.sourceStorageKey,
      input.s3StorageKey,
      input.state,
      input.failureCode,
      input.plan.createdAt,
    ],
  );
}

export async function prepareSqliteAttachmentImport(input: {
  pool: PostgresPoolLike;
  runId: string;
  objectStore: AttachmentObjectStore;
  dryRun?: boolean;
  readLegacyCiphertext?: (key: string) => Promise<Buffer>;
}): Promise<SqliteAttachmentImportResult> {
  const runId = identifier(input.runId, 'run id');
  if (input.objectStore.backend !== 's3') {
    throw new Error('SQLite attachment import requires an S3 object store');
  }
  const client = await input.pool.connect();
  let locked = false;
  try {
    const run = await client.query<ImportRunRow>(
      'SELECT id, state FROM otto_sqlite_import_runs WHERE id = $1',
      [runId],
    );
    if (!run.rows[0] || run.rows[0].state !== 'verified') {
      throw new Error('SQLite attachment import run is missing or not verified');
    }
    if (!input.dryRun) {
      await client.query('SELECT pg_advisory_lock($1::bigint)', [
        ATTACHMENT_IMPORT_LOCK_KEY,
      ]);
      locked = true;
    }
    const [attachmentRows, messageRows, preparedResult] = await Promise.all([
      loadVerifiedSqliteImportTable(
        client,
        runId,
        'direct_message_attachments',
      ),
      loadVerifiedSqliteImportTable(client, runId, 'direct_messages'),
      client.query<PreparedAttachmentRow>(
        `SELECT attachment_id, state, ciphertext_bytes, ciphertext_sha256,
                s3_storage_key
         FROM otto_sqlite_import_attachment_objects
         WHERE run_id = $1`,
        [runId],
      ),
    ]);
    const plans = attachmentPlans({ attachmentRows, messageRows });
    const planIds = new Set(plans.map((plan) => plan.id));
    if (
      preparedResult.rows.some((row) => !planIds.has(row.attachment_id))
    ) {
      throw new Error(
        'SQLite attachment import preparation contains an unknown attachment',
      );
    }
    const preparedById = new Map(
      preparedResult.rows.map((row) => [row.attachment_id, row] as const),
    );
    const plannedPrepared = plans.filter(
      (plan) => preparedById.get(plan.id)?.state === 'verified',
    ).length;
    if (input.dryRun) {
      return {
        runId,
        state: 'planned',
        total: plans.length,
        alreadyPrepared: plannedPrepared,
        prepared: 0,
        pending: plans.length - plannedPrepared,
      };
    }

    let alreadyPrepared = 0;
    let prepared = 0;
    for (const plan of plans) {
      const previous = preparedById.get(plan.id);
      if (
        previous?.state === 'verified' &&
        previous.s3_storage_key &&
        Number(previous.ciphertext_bytes) === plan.plaintextBytes + 16
      ) {
        try {
          await verifyS3Object({
            store: input.objectStore,
            key: previous.s3_storage_key,
            ciphertextBytes: Number(previous.ciphertext_bytes),
            ciphertextSha256: previous.ciphertext_sha256,
          });
          alreadyPrepared += 1;
          continue;
        } catch {
          try {
            await input.objectStore.deleteObject(previous.s3_storage_key);
          } catch {
            // A later S3 orphan sweep handles an unreachable prior object.
          }
        }
      }

      let uploadedKey: string | null = null;
      let digest = '0'.repeat(64);
      try {
        const source =
          plan.sourceBackend === 'sqlite'
            ? Buffer.from(plan.inlineCiphertext!)
            : await input.readLegacyCiphertext?.(plan.sourceStorageKey!);
        if (!source) {
          throw new Error(
            'SQLite attachment import legacy source reader is required',
          );
        }
        digest = assertCiphertext(plan, source);
        const uploaded = await input.objectStore.putCiphertext({
          ciphertext: source,
          ciphertextSha256: digest,
          encryption: 'e2ee-client-v1',
        });
        uploadedKey = uploaded.key;
        await verifyS3Object({
          store: input.objectStore,
          key: uploaded.key,
          ciphertextBytes: source.length,
          ciphertextSha256: digest,
        });
        await recordPreparation({
          client,
          runId,
          plan,
          ciphertextBytes: source.length,
          ciphertextSha256: digest,
          s3StorageKey: uploaded.key,
          state: 'verified',
          failureCode: null,
        });
        prepared += 1;
      } catch (error) {
        if (uploadedKey) {
          try {
            await input.objectStore.deleteObject(uploadedKey);
          } catch {
            // The S3 orphan sweep provides a second cleanup path.
          }
        }
        await recordPreparation({
          client,
          runId,
          plan,
          ciphertextBytes: plan.plaintextBytes + 16,
          ciphertextSha256: digest,
          s3StorageKey: null,
          state: 'failed',
          failureCode: failureCode(error),
        });
        throw error;
      }
    }
    return {
      runId,
      state: 'prepared',
      total: plans.length,
      alreadyPrepared,
      prepared,
      pending: plans.length - alreadyPrepared - prepared,
    };
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [
          ATTACHMENT_IMPORT_LOCK_KEY,
        ]);
      } catch {
        // Releasing the PostgreSQL session below also releases the lock.
      }
    }
    client.release();
  }
}
