/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createPostgresRegistrationRepository } from './postgresRegistrationRepository.js';
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

function poolWithClient(
  query: (
    sql: string,
    values: readonly unknown[],
  ) => Promise<PostgresQueryResult>,
) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client: PostgresClientLike = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      return query(sql, values);
    }),
    release: vi.fn(),
  };
  const pool: PostgresPoolLike = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(),
  };
  return { pool, client, statements };
}

describe('PostgreSQL registration authority', () => {
  it('derives an invite code but stores only its hash and a random nonce', async () => {
    const { pool, statements } = poolWithClient(async (sql, values) => {
      if (sql.includes('FROM organizations') && sql.includes('FOR UPDATE')) {
        return result([
          {
            id: 'org_default',
            name: 'Otto',
            slug: 'otto-default',
            type: 'enterprise',
            status: 'active',
            park_id: null,
            invite_secret: null,
            created_at: new Date('2026-08-01T00:00:00.000Z'),
            updated_at: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]);
      }
      if (sql.includes('INSERT INTO organization_invites')) {
        return result([
          {
            id: values[0],
            organization_id: values[1],
            nonce: values[2],
            code_hash: values[3],
            issued_at: values[4],
            expires_at: values[5],
            revoked_at: null,
            default_department: null,
            department_id: null,
            position_id: null,
            position_title: null,
            default_role: null,
            max_uses: null,
            used_count: 0,
          },
        ]);
      }
      return result();
    });
    const repository = createPostgresRegistrationRepository({
      pool,
      getAccount: vi.fn(),
      logAudit: vi.fn(async () => undefined),
    });

    const invite = await repository.issueOrganizationInvite({
      organizationId: 'org_default',
      createdByAccountId: 'acc_admin',
      now: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(invite.code).toMatch(
      /^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/,
    );
    const inserted = statements.find(({ sql }) =>
      sql.includes('INSERT INTO organization_invites'),
    )!;
    expect(inserted.values).not.toContain(invite.code);
    expect(inserted.values[3]).toBe(
      createHash('sha256')
        .update(invite.code.replaceAll('-', ''))
        .digest('hex'),
    );
    expect(statements.map(({ sql }) => sql)).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT']),
    );
  });

  it('hashes SMS codes and rate limits challenge creation under a transaction lock', async () => {
    const { pool, statements } = poolWithClient(async (sql) => {
      if (sql.includes('FROM accounts') && sql.includes('phone ='))
        return result();
      if (sql.includes('FROM sms_registration_challenges')) return result();
      return result(
        [],
        sql.includes('INSERT INTO sms_registration_challenges') ? 1 : 0,
      );
    });
    const repository = createPostgresRegistrationRepository({
      pool,
      getAccount: vi.fn(),
      logAudit: vi.fn(async () => undefined),
    });

    await expect(
      repository.requestSmsRegistration({
        phone: '13800138000',
        code: '123456',
        now: new Date('2026-08-01T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      state: 'issued',
      registrationMode: 'personal',
    });

    expect(
      statements.some(({ sql }) => sql.includes('pg_advisory_xact_lock')),
    ).toBe(true);
    const inserted = statements.find(({ sql }) =>
      sql.includes('INSERT INTO sms_registration_challenges'),
    )!;
    expect(inserted.values).not.toContain('123456');
    expect(String(inserted.values[3])).not.toHaveLength(6);
  });

  it('fails closed when a personal account still has tenant-bound E2EE state', async () => {
    const { pool, statements } = poolWithClient(async (sql) => {
      if (sql.includes('FROM accounts') && sql.includes('FOR UPDATE')) {
        return result([
          {
            id: 'acc_personal',
            organization_id: 'org_personal',
            account_type: 'personal',
            status: 'active',
            name: 'Personal User',
          },
        ]);
      }
      if (sql.includes('FROM organization_invites')) {
        return result([
          {
            id: 'orginvite_1',
            organization_id: 'org_default',
            nonce: 'legacy-nonce-1234567890',
            code_hash: 'a'.repeat(64),
            issued_at: new Date('2026-08-01T00:00:00.000Z'),
            expires_at: new Date('2026-08-08T00:00:00.000Z'),
            revoked_at: null,
            default_department: null,
            department_id: null,
            position_id: null,
            position_title: null,
            default_role: null,
            max_uses: 3,
            used_count: 0,
            organization_name: 'Otto',
            organization_status: 'active',
          },
        ]);
      }
      if (sql.includes('AS e2ee_devices')) {
        return result([
          {
            e2ee_devices: 1,
            transparency_entries: 1,
            direct_messages: 0,
            attachment_objects: 0,
            attachment_access: 0,
          },
        ]);
      }
      return result();
    });
    const repository = createPostgresRegistrationRepository({
      pool,
      getAccount: vi.fn(),
      logAudit: vi.fn(async () => undefined),
    });

    await expect(
      repository.joinOrganizationWithInvite({
        accountId: 'acc_personal',
        inviteCode: 'ABCD-EFGH-JKLM',
        now: new Date('2026-08-01T00:01:00.000Z'),
      }),
    ).resolves.toEqual({ state: 'security-state-present' });

    expect(
      statements.some(({ sql }) => sql.includes('UPDATE accounts SET')),
    ).toBe(false);
    expect(statements.map(({ sql }) => sql)).toContain('COMMIT');
  });

  it('moves legal consent, consumes the invite and revokes sessions atomically', async () => {
    const { pool, statements } = poolWithClient(async (sql) => {
      if (sql.includes('FROM accounts') && sql.includes('FOR UPDATE')) {
        return result([
          {
            id: 'acc_personal',
            organization_id: 'org_personal',
            account_type: 'personal',
            status: 'active',
            name: 'Personal User',
          },
        ]);
      }
      if (sql.includes('FROM organization_invites')) {
        return result([
          {
            id: 'orginvite_1',
            organization_id: 'org_default',
            nonce: 'legacy-nonce-1234567890',
            code_hash: 'a'.repeat(64),
            issued_at: new Date('2026-08-01T00:00:00.000Z'),
            expires_at: new Date('2026-08-08T00:00:00.000Z'),
            revoked_at: null,
            default_department: null,
            department_id: null,
            position_id: null,
            position_title: null,
            default_role: null,
            max_uses: 3,
            used_count: 0,
            organization_name: 'Otto',
            organization_status: 'active',
          },
        ]);
      }
      if (sql.includes('AS e2ee_devices')) {
        return result([
          {
            e2ee_devices: 0,
            transparency_entries: 0,
            direct_messages: 0,
            attachment_objects: 0,
            attachment_access: 0,
          },
        ]);
      }
      if (sql.includes('FROM legal_consents')) {
        return result([
          {
            document_id: 'terms',
            document_version: '2026-07-29',
            policy_hash: 'b'.repeat(64),
            source: 'registration',
            accepted_at: new Date('2026-08-01T00:00:00.000Z'),
          },
        ]);
      }
      if (
        sql.includes('UPDATE accounts SET') ||
        sql.includes('UPDATE organization_invites')
      ) {
        return result([], 1);
      }
      return result();
    });
    const getAccount = vi.fn(async () => ({ id: 'acc_personal' }) as never);
    const repository = createPostgresRegistrationRepository({
      pool,
      getAccount,
      logAudit: vi.fn(async () => undefined),
    });

    await expect(
      repository.joinOrganizationWithInvite({
        accountId: 'acc_personal',
        inviteCode: 'ABCD-EFGH-JKLM',
        now: new Date('2026-08-01T00:01:00.000Z'),
      }),
    ).resolves.toMatchObject({
      state: 'joined',
      account: { id: 'acc_personal' },
    });

    expect(
      statements.some(({ sql }) => sql.includes('DELETE FROM legal_consents')),
    ).toBe(true);
    expect(
      statements.some(({ sql }) =>
        sql.includes('UPDATE auth_sessions SET revoked_at'),
      ),
    ).toBe(true);
    expect(
      statements.some(({ sql }) =>
        sql.includes('SET used_count = used_count + 1'),
      ),
    ).toBe(true);
    expect(statements.map(({ sql }) => sql)).toContain('COMMIT');
  });
});
