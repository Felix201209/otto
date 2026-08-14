/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  AttachmentMetadataRecord,
  AttachmentMetadataRepository,
  AttachmentMetadataState,
  AttachmentStoragePointer,
} from './attachmentStorageService.js';
import {
  normalizeCiphertextSha256,
  type AttachmentCiphertextEncryption,
  type AttachmentMultipartPart,
  type AttachmentObjectBackend,
} from './attachmentObjectStore.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from './postgresDatabaseLifecycle.js';

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  owner_account_id: string;
  state: string;
  encryption: string;
  ciphertext_bytes: number | string;
  ciphertext_sha256: string;
  storage_backend: string | null;
  storage_key: string | null;
  multipart_upload_id: string | null;
  legacy_storage_backend: string | null;
  legacy_storage_key: string | null;
  expires_at: Date | string;
  legacy_delete_after: Date | string | null;
  legal_hold: boolean;
  mls_conversation_id: string | null;
  mls_session_generation: number | string | null;
  mls_group_id: string | null;
  mls_epoch: number | string | null;
  mls_message_id: string | null;
  mls_participant_account_ids: unknown;
  mls_authorized_devices: unknown;
}

const ATTACHMENT_COLUMNS = `
  id,
  organization_id,
  owner_account_id,
  state,
  encryption,
  ciphertext_bytes,
  ciphertext_sha256,
  storage_backend,
  storage_key,
  multipart_upload_id,
  legacy_storage_backend,
  legacy_storage_key,
  expires_at,
  legacy_delete_after,
  legal_hold,
  mls_conversation_id,
  mls_session_generation,
  mls_group_id,
  mls_epoch,
  mls_message_id,
  mls_participant_account_ids,
  mls_authorized_devices`;

const ATTACHMENT_STATES = new Set<AttachmentMetadataState>([
  'reserved',
  'uploading',
  'verifying',
  'cleaning',
  'available',
  'failed',
]);
const ENCRYPTION_TYPES = new Set<AttachmentCiphertextEncryption>([
  'e2ee-client-v1',
  'server-envelope-v1',
  'mls-client-v1',
]);
const BACKENDS = new Set<AttachmentObjectBackend>([
  'encrypted-filesystem',
  's3',
]);

export class AttachmentQuotaExceededError extends Error {
  constructor() {
    super('attachment storage quota exceeded');
    this.name = 'AttachmentQuotaExceededError';
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`PostgreSQL attachment ${field} is invalid`);
  }
  return value;
}

function safePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`PostgreSQL attachment ${field} is invalid`);
  }
  return parsed;
}

function timestamp(value: Date | string | null, field: string): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`PostgreSQL attachment ${field} is invalid`);
  }
  return parsed.toISOString();
}

function backend(value: string | null): AttachmentObjectBackend | null {
  if (value === null) return null;
  if (!BACKENDS.has(value as AttachmentObjectBackend)) {
    throw new Error('PostgreSQL attachment storage backend is invalid');
  }
  return value as AttachmentObjectBackend;
}

function pointer(
  backendValue: string | null,
  keyValue: string | null,
): AttachmentStoragePointer | null {
  if (backendValue === null && keyValue === null) return null;
  const parsedBackend = backend(backendValue);
  if (!parsedBackend || !keyValue) {
    throw new Error('PostgreSQL attachment storage location is incomplete');
  }
  return { backend: parsedBackend, key: keyValue };
}

function mapAttachment(row: AttachmentRow): AttachmentMetadataRecord {
  if (!ATTACHMENT_STATES.has(row.state as AttachmentMetadataState)) {
    throw new Error('PostgreSQL attachment state is invalid');
  }
  if (!ENCRYPTION_TYPES.has(row.encryption as AttachmentCiphertextEncryption)) {
    throw new Error('PostgreSQL attachment encryption type is invalid');
  }
  const mlsFields = [
    row.mls_conversation_id,
    row.mls_session_generation,
    row.mls_group_id,
    row.mls_epoch,
    row.mls_message_id,
    row.mls_participant_account_ids,
    row.mls_authorized_devices,
  ];
  const hasMlsAuthorization = mlsFields.some(
    (value) => value !== null && value !== undefined,
  );
  let mlsAuthorization: AttachmentMetadataRecord['mlsAuthorization'] = null;
  if (hasMlsAuthorization) {
    if (
      row.encryption !== 'mls-client-v1' ||
      !Array.isArray(row.mls_participant_account_ids) ||
      row.mls_participant_account_ids.length !== 2 ||
      row.mls_participant_account_ids.some((value) => typeof value !== 'string') ||
      !Array.isArray(row.mls_authorized_devices) ||
      row.mls_authorized_devices.length < 2 ||
      row.mls_authorized_devices.length > 100 ||
      row.mls_authorized_devices.some(
        (value) =>
          !value ||
          typeof value !== 'object' ||
          typeof (value as Record<string, unknown>).accountId !== 'string' ||
          typeof (value as Record<string, unknown>).deviceId !== 'string',
      )
    ) {
      throw new Error('PostgreSQL MLS attachment authorization is invalid');
    }
    mlsAuthorization = {
      conversationId: requiredString(
        row.mls_conversation_id,
        'MLS conversation id',
      ),
      sessionGeneration: safePositiveInteger(
        row.mls_session_generation,
        'MLS session generation',
      ),
      groupId: requiredString(row.mls_group_id, 'MLS group id'),
      epoch: safePositiveInteger(row.mls_epoch, 'MLS epoch'),
      messageId: requiredString(row.mls_message_id, 'MLS message id'),
      participantAccountIds: [
        row.mls_participant_account_ids[0] as string,
        row.mls_participant_account_ids[1] as string,
      ],
      authorizedDevices: row.mls_authorized_devices.map((value) => ({
        accountId: (value as Record<string, string>).accountId,
        deviceId: (value as Record<string, string>).deviceId,
      })),
    };
  } else if (row.encryption === 'mls-client-v1') {
    throw new Error('PostgreSQL MLS attachment authorization is missing');
  }
  return {
    id: requiredString(row.id, 'id'),
    organizationId: requiredString(row.organization_id, 'organization id'),
    ownerAccountId: requiredString(row.owner_account_id, 'owner account id'),
    state: row.state as AttachmentMetadataState,
    encryption: row.encryption as AttachmentCiphertextEncryption,
    ciphertextBytes: safePositiveInteger(
      row.ciphertext_bytes,
      'ciphertext size',
    ),
    ciphertextSha256: requiredString(
      row.ciphertext_sha256,
      'ciphertext checksum',
    ),
    location: pointer(row.storage_backend, row.storage_key),
    legacyLocation: pointer(row.legacy_storage_backend, row.legacy_storage_key),
    uploadId: row.multipart_upload_id,
    expiresAt: timestamp(row.expires_at, 'expiry') as string,
    legacyDeleteAfter: timestamp(
      row.legacy_delete_after,
      'legacy deletion time',
    ),
    legalHold: row.legal_hold,
    mlsAuthorization,
  };
}

function requiredRow(rows: AttachmentRow[], operation: string): AttachmentRow {
  const row = rows[0];
  if (!row) throw new Error(`attachment metadata ${operation} failed`);
  return row;
}

async function rollback(client: PostgresClientLike): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary transaction error.
  }
}

export function createPostgresAttachmentMetadataRepository(input: {
  pool: PostgresPoolLike;
  defaultQuotaBytes: number;
}): AttachmentMetadataRepository {
  if (
    !Number.isSafeInteger(input.defaultQuotaBytes) ||
    input.defaultQuotaBytes <= 0
  ) {
    throw new Error('default attachment storage quota is invalid');
  }

  return {
    async reserveUpload(reservation) {
      const client = await input.pool.connect();
      let inTransaction = false;
      try {
        await client.query('BEGIN');
        inTransaction = true;
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [reservation.organizationId],
        );
        await client.query(
          `INSERT INTO attachment_storage_quotas
             (organization_id, max_bytes)
           VALUES ($1, $2)
           ON CONFLICT (organization_id) DO NOTHING`,
          [reservation.organizationId, input.defaultQuotaBytes],
        );
        const quota = await client.query(
          `UPDATE attachment_storage_quotas
           SET reserved_bytes = reserved_bytes + $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE organization_id = $1
             AND reserved_bytes + stored_bytes + $2 <= max_bytes
           RETURNING organization_id`,
          [reservation.organizationId, reservation.ciphertextBytes],
        );
        if (!quota.rows[0]) throw new AttachmentQuotaExceededError();

        const inserted = await client.query<AttachmentRow>(
          `INSERT INTO attachment_objects (
             id, organization_id, owner_account_id, state, encryption,
             ciphertext_bytes, ciphertext_sha256, expires_at,
             mls_conversation_id, mls_session_generation, mls_group_id,
             mls_epoch, mls_message_id, mls_participant_account_ids,
             mls_authorized_devices
           ) VALUES (
             $1, $2, $3, 'reserved', $4, $5, $6, $7,
             $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb
           )
           RETURNING ${ATTACHMENT_COLUMNS}`,
          [
            reservation.attachmentId,
            reservation.organizationId,
            reservation.accountId,
            reservation.encryption,
            reservation.ciphertextBytes,
            reservation.ciphertextSha256,
            reservation.expiresAt,
            reservation.mlsAuthorization?.conversationId ?? null,
            reservation.mlsAuthorization?.sessionGeneration ?? null,
            reservation.mlsAuthorization?.groupId ?? null,
            reservation.mlsAuthorization?.epoch ?? null,
            reservation.mlsAuthorization?.messageId ?? null,
            reservation.mlsAuthorization
              ? JSON.stringify(reservation.mlsAuthorization.participantAccountIds)
              : null,
            reservation.mlsAuthorization
              ? JSON.stringify(reservation.mlsAuthorization.authorizedDevices)
              : null,
          ],
        );
        await client.query(
          `INSERT INTO attachment_object_access
             (attachment_id, organization_id, account_id)
           SELECT $1, $2, account_id
           FROM unnest($3::text[]) AS account_id
           ON CONFLICT (attachment_id, account_id) DO NOTHING`,
          [
            reservation.attachmentId,
            reservation.organizationId,
            reservation.authorizedAccountIds,
          ],
        );
        await client.query('COMMIT');
        inTransaction = false;
        return mapAttachment(requiredRow(inserted.rows, 'reservation'));
      } catch (error) {
        if (inTransaction) await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async attachMultipartUpload(upload) {
      const result = await input.pool.query<AttachmentRow>(
        `UPDATE attachment_objects
         SET state = 'uploading',
             storage_backend = $2,
             storage_key = $3,
             multipart_upload_id = $4,
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1 AND state = 'reserved'
         RETURNING ${ATTACHMENT_COLUMNS}`,
        [
          upload.attachmentId,
          upload.location.backend,
          upload.location.key,
          upload.uploadId,
        ],
      );
      return mapAttachment(requiredRow(result.rows, 'multipart activation'));
    },

    async recordMultipartParts(request) {
      const result = await input.pool.query(
        `INSERT INTO attachment_multipart_parts (
           attachment_id, part_number, etag, ciphertext_bytes,
           ciphertext_sha256, recorded_at
         )
         SELECT $1, part.part_number, part.etag, part.ciphertext_bytes,
                part.ciphertext_sha256, CURRENT_TIMESTAMP
         FROM unnest(
           $2::integer[], $3::text[], $4::bigint[], $5::text[]
         ) AS part(part_number, etag, ciphertext_bytes, ciphertext_sha256)
         WHERE EXISTS (
           SELECT 1 FROM attachment_objects
           WHERE id = $1 AND state = 'uploading'
         )
         ON CONFLICT (attachment_id, part_number) DO UPDATE
         SET etag = EXCLUDED.etag,
             ciphertext_bytes = EXCLUDED.ciphertext_bytes,
             ciphertext_sha256 = EXCLUDED.ciphertext_sha256,
             recorded_at = CURRENT_TIMESTAMP`,
        [
          request.attachmentId,
          request.parts.map((part) => part.partNumber),
          request.parts.map((part) => part.eTag),
          request.parts.map((part) => part.ciphertextBytes),
          request.parts.map((part) => part.ciphertextSha256),
        ],
      );
      if (result.rowCount !== request.parts.length) {
        throw new Error('attachment multipart progress could not be recorded');
      }
    },

    async replaceMultipartVerificationParts(request) {
      const client = await input.pool.connect();
      let inTransaction = false;
      try {
        await client.query('BEGIN');
        inTransaction = true;
        await client.query(
          `DELETE FROM attachment_multipart_parts AS part
           WHERE part.attachment_id = $1
             AND EXISTS (
               SELECT 1 FROM attachment_objects
               WHERE id = $1 AND state = 'verifying'
             )`,
          [request.attachmentId],
        );
        const inserted = await client.query(
          `INSERT INTO attachment_multipart_parts (
             attachment_id, part_number, etag, ciphertext_bytes,
             ciphertext_sha256, recorded_at
           )
           SELECT $1, part.part_number, part.etag, part.ciphertext_bytes,
                  part.ciphertext_sha256, CURRENT_TIMESTAMP
           FROM unnest(
             $2::integer[], $3::text[], $4::bigint[], $5::text[]
           ) AS part(part_number, etag, ciphertext_bytes, ciphertext_sha256)
           WHERE EXISTS (
             SELECT 1 FROM attachment_objects
             WHERE id = $1 AND state = 'verifying'
           )`,
          [
            request.attachmentId,
            request.parts.map((part) => part.partNumber),
            request.parts.map((part) => part.eTag),
            request.parts.map((part) => part.ciphertextBytes),
            request.parts.map((part) => part.ciphertextSha256),
          ],
        );
        if (inserted.rowCount !== request.parts.length) {
          throw new Error('attachment verification parts could not be frozen');
        }
        await client.query('COMMIT');
        inTransaction = false;
      } catch (error) {
        if (inTransaction) await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async listMultipartParts(request) {
      const result = await input.pool.query<
        Record<string, unknown> & {
          part_number: number;
          etag: string;
          ciphertext_bytes: number | string;
          ciphertext_sha256: string;
        }
      >(
        `SELECT part_number, etag, ciphertext_bytes, ciphertext_sha256
         FROM attachment_multipart_parts
         WHERE attachment_id = $1
         ORDER BY part_number`,
        [request.attachmentId],
      );
      return result.rows.map<AttachmentMultipartPart>((row) => {
        const partNumber = Number(row.part_number);
        if (
          !Number.isSafeInteger(partNumber) ||
          partNumber < 1 ||
          partNumber > 10_000 ||
          !row.etag ||
          row.etag.length > 512
        ) {
          throw new Error('PostgreSQL attachment multipart part is invalid');
        }
        return {
          partNumber,
          eTag: row.etag,
          ciphertextBytes: safePositiveInteger(
            row.ciphertext_bytes,
            'multipart part size',
          ),
          ciphertextSha256: normalizeCiphertextSha256(row.ciphertext_sha256),
        };
      });
    },

    async claimMultipartVerification(request) {
      const result = await input.pool.query<AttachmentRow>(
        `UPDATE attachment_objects
         SET state = 'verifying',
             expires_at = $2,
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1
           AND state = 'uploading'
           AND storage_key IS NOT NULL
           AND multipart_upload_id IS NOT NULL
           AND expires_at > CURRENT_TIMESTAMP
         RETURNING ${ATTACHMENT_COLUMNS}`,
        [request.attachmentId, request.leaseExpiresAt],
      );
      return result.rows[0] ? mapAttachment(result.rows[0]) : null;
    },

    async getAuthorizedAttachment(request) {
      const result = await input.pool.query<AttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS.replaceAll('\n  ', '\n  object.')}
         FROM attachment_objects AS object
         JOIN attachment_object_access AS access
           ON access.attachment_id = object.id
          AND access.organization_id = object.organization_id
         WHERE object.id = $1
           AND object.organization_id = $2
           AND access.account_id = $3`,
        [request.attachmentId, request.organizationId, request.accountId],
      );
      return result.rows[0] ? mapAttachment(result.rows[0]) : null;
    },

    async markAvailable(available) {
      const client = await input.pool.connect();
      let inTransaction = false;
      try {
        await client.query('BEGIN');
        inTransaction = true;
        const locked = await client.query<AttachmentRow>(
          `SELECT ${ATTACHMENT_COLUMNS}
           FROM attachment_objects
           WHERE id = $1
           FOR UPDATE`,
          [available.attachmentId],
        );
        const current = requiredRow(locked.rows, 'availability lock');
        const currentMetadata = mapAttachment(current);
        if (currentMetadata.state === 'available') {
          await client.query('COMMIT');
          inTransaction = false;
          return currentMetadata;
        }
        if (!['reserved', 'verifying'].includes(currentMetadata.state)) {
          throw new Error(
            'attachment cannot become available from its current state',
          );
        }
        const quota = await client.query(
          `UPDATE attachment_storage_quotas
           SET reserved_bytes = reserved_bytes - $2,
               stored_bytes = stored_bytes + $2,
               updated_at = CURRENT_TIMESTAMP
           WHERE organization_id = $1
             AND reserved_bytes >= $2
           RETURNING organization_id`,
          [currentMetadata.organizationId, currentMetadata.ciphertextBytes],
        );
        if (!quota.rows[0]) {
          throw new Error('attachment quota reservation is inconsistent');
        }
        const updated = await client.query<AttachmentRow>(
          `UPDATE attachment_objects
           SET state = 'available',
               storage_backend = $2,
               storage_key = $3,
               multipart_upload_id = NULL,
               available_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP,
               version = version + 1
           WHERE id = $1 AND state IN ('reserved', 'verifying')
           RETURNING ${ATTACHMENT_COLUMNS}`,
          [
            available.attachmentId,
            available.location.backend,
            available.location.key,
          ],
        );
        await client.query(
          'DELETE FROM attachment_multipart_parts WHERE attachment_id = $1',
          [available.attachmentId],
        );
        await client.query('COMMIT');
        inTransaction = false;
        return mapAttachment(requiredRow(updated.rows, 'availability update'));
      } catch (error) {
        if (inTransaction) await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async markFailed(failed) {
      await input.pool.query(
        `WITH failed_attachment AS (
           UPDATE attachment_objects
           SET state = 'failed',
               failure_code = $2,
               storage_backend = NULL,
               storage_key = NULL,
               multipart_upload_id = NULL,
               updated_at = CURRENT_TIMESTAMP,
               version = version + 1
           WHERE id = $1 AND state IN ('reserved', 'uploading', 'verifying', 'cleaning')
           RETURNING id, organization_id, ciphertext_bytes
         ), released_quota AS (
           UPDATE attachment_storage_quotas AS quota
           SET reserved_bytes = quota.reserved_bytes - failed.ciphertext_bytes,
               updated_at = CURRENT_TIMESTAMP
           FROM failed_attachment AS failed
           WHERE quota.organization_id = failed.organization_id
             AND quota.reserved_bytes >= failed.ciphertext_bytes
           RETURNING quota.organization_id
         )
         DELETE FROM attachment_multipart_parts
         WHERE attachment_id IN (SELECT id FROM failed_attachment)`,
        [failed.attachmentId, failed.failureCode],
      );
    },

    async listExpiredUploads(request) {
      const result = await input.pool.query<AttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS}
         FROM attachment_objects
         WHERE state IN ('reserved', 'uploading', 'verifying', 'cleaning')
           AND expires_at <= $1
         ORDER BY expires_at, id
         LIMIT $2`,
        [request.before, request.limit],
      );
      return result.rows.map(mapAttachment);
    },

    async claimExpiredUpload(request) {
      const result = await input.pool.query<AttachmentRow>(
        `UPDATE attachment_objects
         SET state = 'cleaning',
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1
           AND state IN ('reserved', 'uploading', 'verifying', 'cleaning')
           AND legal_hold = FALSE
           AND expires_at <= $2
         RETURNING ${ATTACHMENT_COLUMNS}`,
        [request.attachmentId, request.before],
      );
      return result.rows[0] ? mapAttachment(result.rows[0]) : null;
    },

    async isStorageKeyReferenced(request) {
      const result = await input.pool.query<{ referenced: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM attachment_objects
           WHERE (storage_backend = $1 AND storage_key = $2)
              OR (legacy_storage_backend = $1 AND legacy_storage_key = $2)
         ) AS referenced`,
        [request.backend, request.key],
      );
      return result.rows[0]?.referenced === true;
    },

    async claimMigration(request) {
      const result = await input.pool.query<AttachmentRow>(
        `UPDATE attachment_objects
         SET migration_state = 'copying',
             failure_code = NULL,
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1
           AND state = 'available'
           AND storage_backend <> $2
           AND legacy_storage_key IS NULL
           AND migration_state IN ('none', 'failed')
         RETURNING ${ATTACHMENT_COLUMNS}`,
        [request.attachmentId, request.targetBackend],
      );
      return result.rows[0] ? mapAttachment(result.rows[0]) : null;
    },

    async completeMigration(completed) {
      const result = await input.pool.query(
        `UPDATE attachment_objects
         SET storage_backend = $2,
             storage_key = $3,
             legacy_storage_backend = $4,
             legacy_storage_key = $5,
             legacy_delete_after = $6,
             migration_state = 'verified',
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1 AND migration_state = 'copying'`,
        [
          completed.attachmentId,
          completed.location.backend,
          completed.location.key,
          completed.legacyLocation.backend,
          completed.legacyLocation.key,
          completed.legacyDeleteAfter,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error('attachment migration completion failed');
      }
    },

    async failMigration(failed) {
      await input.pool.query(
        `UPDATE attachment_objects
         SET migration_state = 'failed',
             failure_code = $2,
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1 AND migration_state = 'copying'`,
        [failed.attachmentId, failed.failureCode],
      );
    },

    async listLegacyPurgeCandidates(request) {
      const result = await input.pool.query<AttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS}
         FROM attachment_objects
         WHERE state = 'available'
           AND legal_hold = FALSE
           AND legacy_storage_key IS NOT NULL
           AND legacy_delete_after <= $1
           AND migration_state IN ('verified', 'purging')
         ORDER BY legacy_delete_after, id
         LIMIT $2`,
        [request.before, request.limit],
      );
      return result.rows.map(mapAttachment);
    },

    async claimLegacyPurge(request) {
      const result = await input.pool.query<AttachmentRow>(
        `UPDATE attachment_objects
         SET migration_state = 'purging',
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1
           AND state = 'available'
           AND legal_hold = FALSE
           AND legacy_storage_key IS NOT NULL
           AND legacy_delete_after <= $2
           AND migration_state IN ('verified', 'purging')
         RETURNING ${ATTACHMENT_COLUMNS}`,
        [request.attachmentId, request.before],
      );
      return result.rows[0] ? mapAttachment(result.rows[0]) : null;
    },

    async clearLegacyLocation(request) {
      await input.pool.query(
        `UPDATE attachment_objects
         SET legacy_storage_backend = NULL,
             legacy_storage_key = NULL,
             legacy_delete_after = NULL,
             migration_state = 'none',
             updated_at = CURRENT_TIMESTAMP,
             version = version + 1
         WHERE id = $1
           AND legal_hold = FALSE
           AND migration_state = 'purging'
           AND legacy_delete_after <= CURRENT_TIMESTAMP`,
        [request.attachmentId],
      );
    },
  };
}
