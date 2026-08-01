/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  AttachmentObjectStore,
  AttachmentObjectLocation,
} from '../modules/data_platform/attachmentObjectStore.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';
import { prepareSqliteAttachmentImport } from './postgresAttachmentImport.js';
import {
  parsePostgresAttachmentImportArguments,
  safeAttachmentImportErrorMessage,
} from './postgresAttachmentImportCli.js';

function result<Row extends Record<string, unknown>>(
  rows: Row[] = [],
): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

const ciphertext = Buffer.alloc(48, 7);
const ciphertextSha256 = createHash('sha256')
  .update(ciphertext)
  .digest('hex');
const nonce = Buffer.alloc(12, 9).toString('base64');

const messageColumns = [
  'id',
  'organization_id',
  'sender_account_id',
  'recipient_account_id',
  'e2ee_protocol_version',
];
const messageRow = ['msg-1', 'org-1', 'sender-1', 'recipient-1', 1];
const attachmentColumns = [
  'id',
  'message_id',
  'organization_id',
  'ordinal',
  'byte_size',
  'content',
  'storage_backend',
  'storage_key',
  'e2ee_nonce',
  'created_at',
];

function poolFor(input: {
  attachmentRow?: unknown[];
  preparedRows?: Array<Record<string, unknown>>;
} = {}) {
  const writes: Array<readonly unknown[]> = [];
  const attachmentRow =
    input.attachmentRow ??
    [
      'att-1',
      'msg-1',
      'org-1',
      0,
      32,
      ciphertext,
      'sqlite',
      null,
      nonce,
      '2026-08-01 00:00:00',
    ];
  const client: PostgresClientLike = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('FROM otto_sqlite_import_runs')) {
        return result([{ id: 'import-1', state: 'verified' }]);
      }
      if (sql.includes('FROM otto_sqlite_import_tables')) {
        const tableName = String(values[1]);
        const columns =
          tableName === 'direct_messages'
            ? messageColumns
            : tableName === 'direct_message_attachments'
              ? attachmentColumns
              : [];
        return columns.length
          ? result([
              {
                table_name: tableName,
                column_names: columns,
                source_row_count: 1,
                copied_row_count: 1,
                state: 'verified',
              },
            ])
          : result();
      }
      if (sql.includes('FROM otto_sqlite_import_rows')) {
        return result([
          {
            row_data:
              values[1] === 'direct_messages' ? messageRow : attachmentRow,
          },
        ]);
      }
      if (
        sql.includes('FROM otto_sqlite_import_attachment_objects') &&
        sql.includes('SELECT')
      ) {
        return result(input.preparedRows ?? []);
      }
      if (sql.includes('INSERT INTO otto_sqlite_import_attachment_objects')) {
        writes.push(values);
      }
      return result();
    }),
    release: vi.fn(),
  };
  const pool: PostgresPoolLike = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(),
  };
  return { pool, client, writes };
}

function s3Store() {
  const objectKey = `attachments/v1/ab/${'a'.repeat(32)}.bin`;
  const location: AttachmentObjectLocation = {
    backend: 's3',
    key: objectKey,
    ciphertextBytes: ciphertext.length,
    ciphertextSha256,
  };
  return {
    backend: 's3',
    supportsPresignedUrls: true,
    supportsMultipartUpload: true,
    putCiphertext: vi.fn(async () => location),
    getCiphertext: vi.fn(async () => ciphertext),
    deleteObject: vi.fn(async () => undefined),
    headObject: vi.fn(async () => location),
  } as unknown as AttachmentObjectStore;
}

describe('verified SQLite attachment import', () => {
  it('defaults to a non-mutating rehearsal and requires an import run id', () => {
    expect(
      parsePostgresAttachmentImportArguments(['--run', 'import-1']),
    ).toEqual({ runId: 'import-1', dryRun: true });
    expect(
      parsePostgresAttachmentImportArguments([
        '--run',
        'import-1',
        '--execute',
      ]),
    ).toEqual({ runId: 'import-1', dryRun: false });
    expect(() => parsePostgresAttachmentImportArguments([])).toThrow(
      '--run is required',
    );
    expect(() =>
      parsePostgresAttachmentImportArguments([
        '--run',
        'import-1',
        '--dry-run',
        '--execute',
      ]),
    ).toThrow(/cannot be combined/i);
  });

  it('rehearses the complete plan without reading or writing object storage', async () => {
    const { pool, writes } = poolFor();
    const store = s3Store();

    await expect(
      prepareSqliteAttachmentImport({
        pool,
        runId: 'import-1',
        objectStore: store,
        dryRun: true,
      }),
    ).resolves.toEqual({
      runId: 'import-1',
      state: 'planned',
      total: 1,
      alreadyPrepared: 0,
      prepared: 0,
      pending: 1,
    });
    expect(store.putCiphertext).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('uploads and fully verifies inline E2EE ciphertext before recording it', async () => {
    const { pool, writes } = poolFor();
    const store = s3Store();

    const prepared = await prepareSqliteAttachmentImport({
      pool,
      runId: 'import-1',
      objectStore: store,
    });

    expect(prepared).toMatchObject({
      state: 'prepared',
      total: 1,
      prepared: 1,
      pending: 0,
    });
    expect(store.putCiphertext).toHaveBeenCalledWith({
      ciphertext,
      ciphertextSha256,
      encryption: 'e2ee-client-v1',
    });
    expect(store.headObject).toHaveBeenCalledWith(
      `attachments/v1/ab/${'a'.repeat(32)}.bin`,
    );
    expect(store.getCiphertext).toHaveBeenCalledWith(
      `attachments/v1/ab/${'a'.repeat(32)}.bin`,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(
      expect.arrayContaining([
        'import-1',
        'att-1',
        'msg-1',
        ciphertext.length,
        ciphertextSha256,
        `attachments/v1/ab/${'a'.repeat(32)}.bin`,
      ]),
    );
  });

  it('decrypts a legacy filesystem object through the explicit source reader', async () => {
    const { pool } = poolFor({
      attachmentRow: [
        'att-1',
        'msg-1',
        'org-1',
        0,
        32,
        Buffer.alloc(0),
        'encrypted-filesystem',
        'ab/cd/' + 'a'.repeat(64) + '.otto-object',
        nonce,
        '2026-08-01 00:00:00',
      ],
    });
    const sourceReader = vi.fn(async () => ciphertext);

    await prepareSqliteAttachmentImport({
      pool,
      runId: 'import-1',
      objectStore: s3Store(),
      readLegacyCiphertext: sourceReader,
    });

    expect(sourceReader).toHaveBeenCalledWith(
      'ab/cd/' + 'a'.repeat(64) + '.otto-object',
    );
  });

  it('revalidates and skips an already prepared S3 object during a resumed run', async () => {
    const { pool, writes } = poolFor({
      preparedRows: [
        {
          attachment_id: 'att-1',
          state: 'verified',
          ciphertext_bytes: ciphertext.length,
          ciphertext_sha256: ciphertextSha256,
          s3_storage_key: `attachments/v1/ab/${'a'.repeat(32)}.bin`,
        },
      ],
    });
    const store = s3Store();

    await expect(
      prepareSqliteAttachmentImport({
        pool,
        runId: 'import-1',
        objectStore: store,
      }),
    ).resolves.toMatchObject({
      state: 'prepared',
      alreadyPrepared: 1,
      prepared: 0,
      pending: 0,
    });
    expect(store.putCiphertext).not.toHaveBeenCalled();
    expect(store.headObject).toHaveBeenCalledOnce();
    expect(store.getCiphertext).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('redacts database URLs and both legacy and S3 object keys from CLI errors', () => {
    const legacyKey = `ab/cd/${'b'.repeat(64)}.otto-object`;
    const s3Key = `attachments/v1/ef/${'c'.repeat(32)}.bin`;
    const message = safeAttachmentImportErrorMessage(
      new Error(
        `read D:\\legacy\\${legacyKey}: ${s3Key} at postgresql://otto:secret@db.internal/otto`,
      ),
    );

    expect(message).not.toContain(legacyKey);
    expect(message).not.toContain(s3Key);
    expect(message).not.toContain('secret');
    expect(message).toContain('[REDACTED_OBJECT_KEY]');
    expect(message).toContain('postgresql://[REDACTED]');
  });
});
