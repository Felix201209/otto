/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResultRow,
} from 'pg';

import type {
  PostgresClientLike,
  PostgresPoolLike,
  PostgresQueryResult,
} from './postgresDatabaseLifecycle.js';

export interface NodePostgresEnvironment {
  OTTO_POSTGRES_POOL_MAX?: string;
  OTTO_POSTGRES_CONNECT_TIMEOUT_MS?: string;
  OTTO_POSTGRES_IDLE_TIMEOUT_MS?: string;
  OTTO_POSTGRES_STATEMENT_TIMEOUT_MS?: string;
  OTTO_POSTGRES_SSL_MODE?: string;
}

function boundedInteger(input: {
  name: string;
  value: string | undefined;
  fallback: number;
  min: number;
  max: number;
}): number {
  if (input.value === undefined || input.value.trim() === '') {
    return input.fallback;
  }
  const value = Number(input.value);
  if (!Number.isSafeInteger(value) || value < input.min || value > input.max) {
    throw new Error(
      `${input.name} must be an integer from ${input.min} to ${input.max}`,
    );
  }
  return value;
}

function resolveSsl(input: {
  connectionString: string;
  configuredMode?: string;
}): { connectionString: string; ssl: PoolConfig['ssl'] } {
  const parsed = new URL(input.connectionString);
  const urlMode = parsed.searchParams.get('sslmode')?.trim().toLowerCase();
  const mode =
    input.configuredMode?.trim().toLowerCase() || urlMode || 'verify-full';
  if (!['disable', 'require', 'verify-full'].includes(mode)) {
    throw new Error(
      'PostgreSQL SSL mode must be disable, require, or verify-full',
    );
  }
  parsed.searchParams.delete('sslmode');
  return {
    connectionString: parsed.toString(),
    ssl:
      mode === 'disable'
        ? false
        : { rejectUnauthorized: mode === 'verify-full' },
  };
}

export function buildNodePostgresPoolConfig(input: {
  connectionString: string;
  environment: NodePostgresEnvironment;
}): PoolConfig {
  const transport = resolveSsl({
    connectionString: input.connectionString,
    configuredMode: input.environment.OTTO_POSTGRES_SSL_MODE,
  });
  return {
    connectionString: transport.connectionString,
    application_name: 'otto-enterprise',
    max: boundedInteger({
      name: 'OTTO_POSTGRES_POOL_MAX',
      value: input.environment.OTTO_POSTGRES_POOL_MAX,
      fallback: 10,
      min: 1,
      max: 100,
    }),
    connectionTimeoutMillis: boundedInteger({
      name: 'OTTO_POSTGRES_CONNECT_TIMEOUT_MS',
      value: input.environment.OTTO_POSTGRES_CONNECT_TIMEOUT_MS,
      fallback: 10_000,
      min: 100,
      max: 120_000,
    }),
    idleTimeoutMillis: boundedInteger({
      name: 'OTTO_POSTGRES_IDLE_TIMEOUT_MS',
      value: input.environment.OTTO_POSTGRES_IDLE_TIMEOUT_MS,
      fallback: 30_000,
      min: 1_000,
      max: 600_000,
    }),
    statement_timeout: boundedInteger({
      name: 'OTTO_POSTGRES_STATEMENT_TIMEOUT_MS',
      value: input.environment.OTTO_POSTGRES_STATEMENT_TIMEOUT_MS,
      fallback: 30_000,
      min: 100,
      max: 600_000,
    }),
    ssl: transport.ssl,
  };
}

class NodePostgresClient implements PostgresClientLike {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.client.query<Row & QueryResultRow>(sql, [
      ...values,
    ]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  release(): void {
    this.client.release();
  }
}

class NodePostgresPool implements PostgresPoolLike {
  constructor(private readonly pool: Pool) {}

  async connect(): Promise<PostgresClientLike> {
    return new NodePostgresClient(await this.pool.connect());
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    const result = await this.pool.query<Row & QueryResultRow>(sql, [
      ...values,
    ]);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export function createNodePostgresPool(config: PoolConfig): PostgresPoolLike {
  return new NodePostgresPool(new Pool(config));
}
