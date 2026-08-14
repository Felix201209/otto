/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  assertLocalSqliteDatabasePath,
  describeEnterpriseDatabaseTopology,
  requireLocalSqliteTopology,
  resolveEnterpriseDatabaseTopology,
} from './enterpriseDatabaseTopology.js';

describe('enterprise database topology', () => {
  it('keeps a single local SQLite database as the default desktop topology', () => {
    expect(
      resolveEnterpriseDatabaseTopology({
        environment: {},
        sqliteDatabasePath: 'D:\\otto-data\\data.db',
      }),
    ).toEqual({
      backend: 'sqlite',
      databasePath: 'D:\\otto-data\\data.db',
      replicas: 1,
    });
  });

  it('refuses multiple writers against SQLite', () => {
    expect(() =>
      resolveEnterpriseDatabaseTopology({
        environment: { OTTO_ENTERPRISE_REPLICA_COUNT: '2' },
        sqliteDatabasePath: '/var/lib/otto/data.db',
      }),
    ).toThrow(/SQLite.*exactly one.*PostgreSQL/i);
  });

  it.each([
    String.raw`\\server\share\otto\data.db`,
    '//server/share/otto/data.db',
    'smb://server/share/otto/data.db',
    'nfs://server/export/otto/data.db',
  ])('refuses a SQLite database on a network share: %s', (databasePath) => {
    expect(() => assertLocalSqliteDatabasePath(databasePath)).toThrow(
      /SQLite.*NFS|SMB|network/i,
    );
  });

  it.each([0x6969, 0x517b, 0xff534d42])(
    'refuses a mounted NFS/SMB filesystem type: %s',
    (filesystemType) => {
      expect(() =>
        assertLocalSqliteDatabasePath('/srv/otto/data.db', {
          filesystemType: () => filesystemType,
        }),
      ).toThrow(/network filesystem/i);
    },
  );

  it('requires PostgreSQL configuration and rejects SQLCipher server settings', () => {
    expect(() =>
      resolveEnterpriseDatabaseTopology({
        environment: { OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql' },
        sqliteDatabasePath: '/unused/data.db',
      }),
    ).toThrow(/OTTO_POSTGRES_URL is required/i);

    expect(() =>
      resolveEnterpriseDatabaseTopology({
        environment: {
          OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
          OTTO_POSTGRES_URL: 'postgresql://otto:secret@db.internal/otto',
          OTTO_DATABASE_ENCRYPTION: 'required',
        },
        sqliteDatabasePath: '/unused/data.db',
      }),
    ).toThrow(/SQLCipher.*local SQLite/i);
  });

  it('allows multiple PostgreSQL application replicas without exposing credentials', () => {
    const topology = resolveEnterpriseDatabaseTopology({
      environment: {
        OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
        OTTO_ENTERPRISE_REPLICA_COUNT: '4',
        OTTO_POSTGRES_URL:
          'postgresql://otto:super-secret@db.internal:5432/otto',
      },
      sqliteDatabasePath: '/unused/data.db',
    });

    expect(topology).toMatchObject({
      backend: 'postgresql',
      replicas: 4,
      connectionString: 'postgresql://otto:super-secret@db.internal:5432/otto',
    });
    const description = describeEnterpriseDatabaseTopology(topology);
    expect(description).toEqual({
      backend: 'postgresql',
      replicas: 4,
      target: 'db.internal:5432/otto',
    });
    expect(JSON.stringify(description)).not.toContain('super-secret');
    expect(JSON.stringify(description)).not.toContain('otto@');
  });

  it('does not silently fall back to SQLite when PostgreSQL is configured', () => {
    const topology = resolveEnterpriseDatabaseTopology({
      environment: {
        OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
        OTTO_POSTGRES_URL: 'postgresql://otto:secret@db.internal/otto',
      },
      sqliteDatabasePath: '/unused/data.db',
    });

    expect(() => requireLocalSqliteTopology(topology)).toThrow(
      /PostgreSQL.*repositories.*not.*migrated.*refusing.*SQLite fallback/i,
    );
  });
});
