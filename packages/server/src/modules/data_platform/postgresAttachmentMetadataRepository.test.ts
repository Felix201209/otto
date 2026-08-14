/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from './postgresDatabaseLifecycle.js';
import {
  AttachmentQuotaExceededError,
  createPostgresAttachmentMetadataRepository,
} from './postgresAttachmentMetadataRepository.js';

const attachmentRow = {
  id: 'att-1',
  organization_id: 'org-1',
  owner_account_id: 'acc-owner',
  state: 'reserved',
  encryption: 'e2ee-client-v1',
  ciphertext_bytes: '20',
  ciphertext_sha256: 'a'.repeat(64),
  storage_backend: null,
  storage_key: null,
  multipart_upload_id: null,
  legacy_storage_backend: null,
  legacy_storage_key: null,
  expires_at: new Date('2026-08-01T00:00:00.000Z'),
  legacy_delete_after: null,
  legal_hold: false,
  mls_conversation_id: null,
  mls_session_generation: null,
  mls_group_id: null,
  mls_epoch: null,
  mls_message_id: null,
  mls_participant_account_ids: null,
  mls_authorized_devices: null,
};

class ScriptedPool implements PostgresPoolLike, PostgresClientLike {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  released = 0;

  constructor(
    private readonly respond: (
      sql: string,
      values: readonly unknown[],
    ) => PostgresQueryResult<Record<string, unknown>>,
  ) {}

  async connect(): Promise<PostgresClientLike> {
    return this;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.statements.push({ sql, values });
    return this.respond(sql, values) as PostgresQueryResult<Row>;
  }

  release(): void {
    this.released += 1;
  }

  async end(): Promise<void> {}
}

describe('PostgreSQL attachment metadata repository', () => {
  it('fails quota reservation atomically before creating metadata', async () => {
    const pool = new ScriptedPool((sql) =>
      sql.includes('UPDATE attachment_storage_quotas')
        ? { rows: [], rowCount: 0 }
        : { rows: [] },
    );
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.reserveUpload({
        attachmentId: 'att-1',
        organizationId: 'org-1',
        accountId: 'acc-owner',
        authorizedAccountIds: ['acc-owner', 'acc-recipient'],
        encryption: 'e2ee-client-v1',
        ciphertextBytes: 20,
        ciphertextSha256: 'a'.repeat(64),
        expiresAt: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(AttachmentQuotaExceededError);

    expect(pool.statements.map(({ sql }) => sql.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('INSERT INTO attachment_storage_quotas'),
      expect.stringContaining('UPDATE attachment_storage_quotas'),
      'ROLLBACK',
    ]);
    expect(
      pool.statements.some(({ sql }) =>
        sql.includes('INSERT INTO attachment_objects'),
      ),
    ).toBe(false);
    expect(pool.released).toBe(1);
  });

  it('stores MLS generation authorization atomically without a file DEK', async () => {
    const mlsAuthorization = {
      conversationId: 'a'.repeat(64),
      sessionGeneration: 2,
      groupId: 'Z3JvdXAtMQ==',
      epoch: 4,
      messageId: 'mls-message-1',
      participantAccountIds: ['acc-owner', 'acc-recipient'] as [string, string],
      authorizedDevices: [
        { accountId: 'acc-owner', deviceId: 'device-owner' },
        { accountId: 'acc-recipient', deviceId: 'device-recipient' },
      ],
    };
    const pool = new ScriptedPool((sql) => {
      if (sql.includes('UPDATE attachment_storage_quotas')) {
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO attachment_objects')) {
        return {
          rows: [
            {
              ...attachmentRow,
              encryption: 'mls-client-v1',
              mls_conversation_id: mlsAuthorization.conversationId,
              mls_session_generation: '2',
              mls_group_id: mlsAuthorization.groupId,
              mls_epoch: '4',
              mls_message_id: mlsAuthorization.messageId,
              mls_participant_account_ids:
                mlsAuthorization.participantAccountIds,
              mls_authorized_devices: mlsAuthorization.authorizedDevices,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.reserveUpload({
        attachmentId: 'att-mls-1',
        organizationId: 'org-1',
        accountId: 'acc-owner',
        authorizedAccountIds: ['acc-owner', 'acc-recipient'],
        encryption: 'mls-client-v1',
        ciphertextBytes: 20,
        ciphertextSha256: 'a'.repeat(64),
        expiresAt: '2026-08-01T00:00:00.000Z',
        mlsAuthorization,
      }),
    ).resolves.toMatchObject({
      encryption: 'mls-client-v1',
      mlsAuthorization,
    });
    const insert = pool.statements.find(({ sql }) =>
      sql.includes('INSERT INTO attachment_objects'),
    );
    expect(insert?.sql).toContain('mls_authorized_devices');
    expect(JSON.stringify(insert?.values)).not.toMatch(/dek|fileName/i);
    expect(pool.statements.at(-1)?.sql).toBe('COMMIT');
  });

  it('authorizes by exact tenant/account metadata and maps bigint values', async () => {
    const pool = new ScriptedPool((sql, values) => {
      if (sql.includes('JOIN attachment_object_access')) {
        expect(values).toEqual(['att-1', 'org-1', 'acc-recipient']);
        return {
          rows: [
            {
              ...attachmentRow,
              state: 'available',
              storage_backend: 's3',
              storage_key: 'attachments/v1/ab/opaque.bin',
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.getAuthorizedAttachment({
        attachmentId: 'att-1',
        organizationId: 'org-1',
        accountId: 'acc-recipient',
      }),
    ).resolves.toMatchObject({
      id: 'att-1',
      organizationId: 'org-1',
      ownerAccountId: 'acc-owner',
      ciphertextBytes: 20,
      location: {
        backend: 's3',
        key: 'attachments/v1/ab/opaque.bin',
      },
    });
  });

  it('moves reserved quota to stored quota in the same transaction', async () => {
    const pool = new ScriptedPool((sql) => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: [attachmentRow] };
      }
      if (sql.includes('UPDATE attachment_storage_quotas')) {
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes("SET state = 'available'")) {
        return {
          rows: [
            {
              ...attachmentRow,
              state: 'available',
              storage_backend: 's3',
              storage_key: 'opaque-key',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.markAvailable({
        attachmentId: 'att-1',
        location: { backend: 's3', key: 'opaque-key' },
      }),
    ).resolves.toMatchObject({ state: 'available' });

    const quotaUpdate = pool.statements.find(({ sql }) =>
      sql.includes('UPDATE attachment_storage_quotas'),
    );
    expect(quotaUpdate?.sql).toContain('reserved_bytes = reserved_bytes - $2');
    expect(quotaUpdate?.sql).toContain('stored_bytes = stored_bytes + $2');
    expect(pool.statements.at(-1)?.sql).toBe('COMMIT');
  });

  it('persists multipart progress for resumable uploads', async () => {
    const pool = new ScriptedPool((sql) => {
      if (sql.includes('INSERT INTO attachment_multipart_parts')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT part_number, etag')) {
        return {
          rows: [
            {
              part_number: 1,
              etag: 'etag-1',
              ciphertext_bytes: '20',
              ciphertext_sha256: 'a'.repeat(64),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });
    const parts = [
      {
        partNumber: 1,
        eTag: 'etag-1',
        ciphertextBytes: 20,
        ciphertextSha256: 'a'.repeat(64),
      },
    ];

    await repository.recordMultipartParts({
      attachmentId: 'att-1',
      parts,
    });
    await expect(
      repository.listMultipartParts({ attachmentId: 'att-1' }),
    ).resolves.toEqual(parts);

    expect(pool.statements[0]?.values).toEqual([
      'att-1',
      [1],
      ['etag-1'],
      [20],
      ['a'.repeat(64)],
    ]);
  });

  it('claims multipart verification with a compare-and-set state change', async () => {
    const pool = new ScriptedPool((sql) => {
      if (sql.includes("SET state = 'verifying'")) {
        return {
          rows: [
            {
              ...attachmentRow,
              state: 'verifying',
              storage_backend: 's3',
              storage_key: 'opaque-key',
              multipart_upload_id: 'upload-1',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.claimMultipartVerification({
        attachmentId: 'att-1',
        leaseExpiresAt: '2026-08-01T00:15:00.000Z',
      }),
    ).resolves.toMatchObject({
      state: 'verifying',
      uploadId: 'upload-1',
      location: { backend: 's3', key: 'opaque-key' },
    });
    expect(pool.statements[0]?.sql).toContain("AND state = 'uploading'");
    expect(pool.statements[0]?.values).toEqual([
      'att-1',
      '2026-08-01T00:15:00.000Z',
    ]);
  });

  it('freezes the winning completion part list in one transaction', async () => {
    const pool = new ScriptedPool((sql) => {
      if (sql.includes('INSERT INTO attachment_multipart_parts')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await repository.replaceMultipartVerificationParts({
      attachmentId: 'att-1',
      parts: [
        {
          partNumber: 1,
          eTag: 'etag-1',
          ciphertextBytes: 20,
          ciphertextSha256: 'a'.repeat(64),
        },
      ],
    });

    expect(pool.statements.map(({ sql }) => sql.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('DELETE FROM attachment_multipart_parts'),
      expect.stringContaining('INSERT INTO attachment_multipart_parts'),
      'COMMIT',
    ]);
    expect(pool.statements[1]?.sql).toContain("state = 'verifying'");
    expect(pool.statements[2]?.sql).toContain("state = 'verifying'");
  });

  it('releases failed object references for grace-period orphan cleanup', async () => {
    const pool = new ScriptedPool(() => ({ rows: [] }));
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await repository.markFailed({
      attachmentId: 'att-1',
      failureCode: 'upload_completion_failed',
    });

    expect(pool.statements[0]?.sql).toContain('storage_backend = NULL');
    expect(pool.statements[0]?.sql).toContain('storage_key = NULL');
    expect(pool.statements[0]?.sql).toContain(
      "state IN ('reserved', 'uploading', 'verifying', 'cleaning')",
    );
  });

  it('claims an expired upload before deleting its object', async () => {
    const pool = new ScriptedPool((sql) => {
      if (sql.includes("SET state = 'cleaning'")) {
        return {
          rows: [
            {
              ...attachmentRow,
              state: 'cleaning',
              storage_backend: 's3',
              storage_key: 'expired-key',
              multipart_upload_id: 'upload-1',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.claimExpiredUpload({
        attachmentId: 'att-1',
        before: '2026-08-02T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      state: 'cleaning',
      location: { backend: 's3', key: 'expired-key' },
    });
    expect(pool.statements[0]?.sql).toContain('expires_at <= $2');
    expect(pool.statements[0]?.sql).toContain('legal_hold = FALSE');
  });

  it('claims legacy deletion only after grace and without a legal hold', async () => {
    const pool = new ScriptedPool((sql) => {
      if (sql.includes("migration_state = 'purging'")) {
        return {
          rows: [
            {
              ...attachmentRow,
              state: 'available',
              storage_backend: 's3',
              storage_key: 'primary-key',
              legacy_storage_backend: 'encrypted-filesystem',
              legacy_storage_key: 'legacy-key',
              legacy_delete_after: new Date('2026-08-01T00:00:00.000Z'),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [] };
    });
    const repository = createPostgresAttachmentMetadataRepository({
      pool,
      defaultQuotaBytes: 1_000,
    });

    await expect(
      repository.claimLegacyPurge({
        attachmentId: 'att-1',
        before: '2026-08-02T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      legacyLocation: {
        backend: 'encrypted-filesystem',
        key: 'legacy-key',
      },
    });
    expect(pool.statements[0]?.sql).toContain('legal_hold = FALSE');
    expect(pool.statements[0]?.sql).toContain('legacy_delete_after <= $2');
  });
});
