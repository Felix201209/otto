/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildNodePostgresPoolConfig } from './nodePostgresPool.js';

describe('node PostgreSQL pool configuration', () => {
  it('requires certificate verification by default and sets bounded timeouts', () => {
    const config = buildNodePostgresPoolConfig({
      connectionString: 'postgresql://otto:secret@db.internal/otto',
      environment: {},
    });

    expect(config).toMatchObject({
      application_name: 'otto-enterprise',
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      ssl: { rejectUnauthorized: true },
    });
  });

  it('supports an explicit local-development TLS opt-out and pool sizing', () => {
    const config = buildNodePostgresPoolConfig({
      connectionString:
        'postgresql://otto:secret@127.0.0.1/otto?sslmode=disable',
      environment: {
        OTTO_POSTGRES_POOL_MAX: '4',
        OTTO_POSTGRES_CONNECT_TIMEOUT_MS: '2500',
        OTTO_POSTGRES_STATEMENT_TIMEOUT_MS: '8000',
      },
    });

    expect(config).toMatchObject({
      max: 4,
      connectionTimeoutMillis: 2500,
      statement_timeout: 8000,
      ssl: false,
    });
    expect(String(config.connectionString)).not.toContain('sslmode');
  });

  it('rejects unsafe or unbounded pool configuration', () => {
    expect(() =>
      buildNodePostgresPoolConfig({
        connectionString: 'postgresql://db.internal/otto',
        environment: { OTTO_POSTGRES_SSL_MODE: 'trust-everything' },
      }),
    ).toThrow(/SSL mode/i);
    expect(() =>
      buildNodePostgresPoolConfig({
        connectionString: 'postgresql://db.internal/otto',
        environment: { OTTO_POSTGRES_POOL_MAX: '0' },
      }),
    ).toThrow(/POOL_MAX/i);
  });
});
