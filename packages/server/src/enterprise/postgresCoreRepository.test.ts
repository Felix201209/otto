/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';
import {
  createPostgresEnterpriseCoreRepository,
  normalizePostgresEnterprisePhone,
} from './postgresCoreRepository.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';

function result<Row extends Record<string, unknown>>(
  rows: Row[] = [],
  rowCount: number | null = rows.length,
): PostgresQueryResult<Row> {
  return { rows, rowCount };
}

describe('PostgreSQL enterprise core authority', () => {
  it('installs authoritative organization, account, session, audit and E2EE tables', () => {
    const migration = ENTERPRISE_POSTGRES_MIGRATIONS.at(-1);
    expect(migration).toMatchObject({
      version: 4,
      name: 'enterprise-core-domain',
    });
    for (const table of [
      'organizations',
      'accounts',
      'auth_sessions',
      'auth_login_limits',
      'audit_logs',
      'e2ee_devices',
      'e2ee_key_transparency_log',
      'direct_messages',
    ]) {
      expect(migration!.sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(migration!.sql).toContain('token_hash TEXT PRIMARY KEY');
    expect(migration!.sql).not.toContain('token TEXT PRIMARY KEY');
  });

  it('normalizes mainland phone numbers without importing the SQLite repository', () => {
    expect(normalizePostgresEnterprisePhone('138 0013 8000')).toBe(
      '+8613800138000',
    );
    expect(normalizePostgresEnterprisePhone('+86 13800138000')).toBe(
      '+8613800138000',
    );
    expect(() => normalizePostgresEnterprisePhone('10086')).toThrow(
      'phone is invalid',
    );
  });

  it('stores only a SHA-256 session token digest in PostgreSQL', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return result([], 1);
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    const session = await repository.createAuthSession('acc_admin');

    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('INSERT INTO auth_sessions');
    expect(queries[0]!.values[0]).toBe(
      createHash('sha256').update(session.token).digest('hex'),
    );
    expect(queries[0]!.values).not.toContain(session.token);
  });

  it('shares login throttling without persisting the account identifier', async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return result([{ retry_after_seconds: 900 }]);
      }),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    expect(await repository.recordLoginFailure('Admin@Example.COM')).toBe(900);

    expect(queries[0]!.sql).toContain('INSERT INTO auth_login_limits');
    expect(queries[0]!.values[0]).toBe(
      createHash('sha256').update('admin@example.com').digest('hex'),
    );
    expect(queries[0]!.values).not.toContain('Admin@Example.COM');
  });

  it('rolls back an account transaction when PostgreSQL rejects a write', async () => {
    const statements: string[] = [];
    const client: PostgresClientLike = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('SELECT * FROM organizations')) {
          return result([
            {
              id: 'org_default',
              name: 'Otto',
              slug: 'otto-default',
              type: 'enterprise',
              status: 'active',
              park_id: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ]);
        }
        if (sql.includes('INSERT INTO accounts')) {
          throw new Error('duplicate account');
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
    const repository = createPostgresEnterpriseCoreRepository({ pool });

    await expect(
      repository.createAccount({
        username: 'admin',
        password: 'Secure-password-2026',
        name: 'Administrator',
        isAdmin: true,
      }),
    ).rejects.toThrow('duplicate account');

    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects E2EE attachment writes until the shared S3 route is mounted', async () => {
    const pool: PostgresPoolLike = {
      connect: vi.fn(),
      query: vi.fn(),
      end: vi.fn(),
    };
    const repository = createPostgresEnterpriseCoreRepository({ pool });
    await expect(
      repository.sendE2eeDirectMessage({
        organizationId: 'org_default',
        senderAccountId: 'acc_sender',
        recipientAccountId: 'acc_recipient',
        messageId: 'msg_1',
        senderDeviceId: 'device_1',
        protocolVersion: 1,
        contentType: 'message',
        ciphertext: Buffer.alloc(32).toString('base64'),
        nonce: Buffer.alloc(12).toString('base64'),
        signature: Buffer.alloc(64).toString('base64'),
        envelopes: [],
        attachments: [
          {
            id: 'attachment_1',
            ciphertext: Buffer.alloc(32).toString('base64'),
            nonce: Buffer.alloc(12).toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow('require the S3 route service');
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
