/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';
import { createPostgresEnterpriseBusinessRepository } from './postgresBusinessRepository.js';

function result<Row extends Record<string, unknown>>(
  rows: Row[] = [],
): PostgresQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

describe('PostgreSQL enterprise business repository', () => {
  it('encrypts account sync payloads and commits them under the account tenant', async () => {
    const key = Buffer.alloc(32, 7);
    let insertValues: readonly unknown[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return result();
        }
        if (sql.includes('SELECT id FROM accounts')) {
          expect(values).toEqual(['acc_1', 'org_1']);
          return result([{ id: 'acc_1' }]);
        }
        if (
          sql.includes('FROM account_sync_snapshots') &&
          sql.includes('FOR UPDATE')
        ) {
          expect(values).toEqual(['org_1', 'acc_1', 'worklog']);
          return result();
        }
        if (sql.includes('INSERT INTO account_sync_snapshots')) {
          insertValues = values;
          return result([
            {
              organization_id: values[0] as string,
              account_id: values[1] as string,
              scope: values[2] as string,
              version: values[3] as number,
              payload_ciphertext: values[4] as string,
              payload_iv: values[5] as string,
              payload_auth_tag: values[6] as string,
              payload_hash: values[7] as string,
              device_id: values[8] as string,
              updated_at: values[9] as Date,
            },
          ]);
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
      end: vi.fn(),
    } as unknown as PostgresPoolLike;
    const repository = createPostgresEnterpriseBusinessRepository({
      pool,
      accountSyncKeyProvider: { getKey: () => key, clear: vi.fn() },
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });
    const payload = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T12:00:00.000Z',
      files: [
        {
          path: 'private.md',
          content: 'tenant secret',
          modifiedAtMs: Date.parse('2026-08-03T12:00:00.000Z'),
          sha256: createHash('sha256')
            .update('tenant secret', 'utf8')
            .digest('hex'),
        },
      ],
    };

    const snapshot = await repository.putAccountSyncSnapshot({
      organizationId: 'org_1',
      accountId: 'acc_1',
      scope: 'worklog',
      expectedVersion: 0,
      payload,
      deviceId: 'desktop-1',
    });

    expect(snapshot).toMatchObject({
      scope: 'worklog',
      version: 1,
      payload,
      deviceId: 'desktop-1',
    });
    expect(insertValues.slice(0, 4)).toEqual(['org_1', 'acc_1', 'worklog', 1]);
    expect(String(insertValues[4])).not.toContain('tenant secret');
    expect(String(insertValues[4])).not.toContain('private.md');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
