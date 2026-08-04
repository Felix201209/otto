/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

const NETWORK_FILESYSTEM_TYPES = new Set([
  0x6969, // NFS_SUPER_MAGIC
  0x517b, // SMB_SUPER_MAGIC
  0xff534d42, // CIFS_MAGIC_NUMBER
]);

export type EnterpriseDatabaseTopology =
  | {
      backend: 'sqlite';
      databasePath: string;
      replicas: 1;
    }
  | {
      backend: 'postgresql';
      connectionString: string;
      replicas: number;
    };

export interface EnterpriseDatabaseTopologyEnvironment {
  OTTO_ENTERPRISE_DATABASE_BACKEND?: string;
  OTTO_ENTERPRISE_REPLICA_COUNT?: string;
  OTTO_POSTGRES_URL?: string;
  OTTO_DATABASE_ENCRYPTION?: string;
}

export interface SqlitePathInspectionOptions {
  filesystemType?: (existingPath: string) => number | bigint | undefined;
}

function networkPath(databasePath: string): boolean {
  return /^(?:\\\\|\/\/|smb:\/\/|nfs:\/\/)/i.test(databasePath.trim());
}

function nearestExistingPath(inputPath: string): string | null {
  let current = path.resolve(inputPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function readFilesystemType(existingPath: string): number | bigint | undefined {
  try {
    return fs.statfsSync(existingPath).type;
  } catch {
    return undefined;
  }
}

/** SQLite locking is unsupported on NFS/SMB for an Otto write-serving process. */
export function assertLocalSqliteDatabasePath(
  databasePath: string,
  options: SqlitePathInspectionOptions = {},
): void {
  if (networkPath(databasePath)) {
    throw new Error(
      'SQLite database must use a local filesystem; NFS/SMB/network paths are not supported',
    );
  }
  const existingPath = nearestExistingPath(databasePath);
  if (!existingPath) return;
  const rawType =
    options.filesystemType?.(existingPath) ?? readFilesystemType(existingPath);
  if (rawType === undefined) return;
  const normalizedType = Number(rawType) >>> 0;
  if (NETWORK_FILESYSTEM_TYPES.has(normalizedType)) {
    throw new Error(
      'SQLite database must use a local filesystem; detected a network filesystem',
    );
  }
}

function parseReplicaCount(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 1;
  const replicas = Number(value);
  if (!Number.isSafeInteger(replicas) || replicas < 1 || replicas > 1_000) {
    throw new Error(
      'OTTO_ENTERPRISE_REPLICA_COUNT must be an integer from 1 to 1000',
    );
  }
  return replicas;
}

function parsePostgresUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('OTTO_POSTGRES_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('OTTO_POSTGRES_URL must use postgres:// or postgresql://');
  }
  if (!parsed.hostname || parsed.pathname === '' || parsed.pathname === '/') {
    throw new Error('OTTO_POSTGRES_URL must include a host and database name');
  }
  return parsed;
}

export function resolveEnterpriseDatabaseTopology(input: {
  environment: EnterpriseDatabaseTopologyEnvironment;
  sqliteDatabasePath: string;
}): EnterpriseDatabaseTopology {
  const configuredBackend =
    input.environment.OTTO_ENTERPRISE_DATABASE_BACKEND?.trim().toLowerCase() ||
    'sqlite';
  const replicas = parseReplicaCount(
    input.environment.OTTO_ENTERPRISE_REPLICA_COUNT,
  );

  if (configuredBackend === 'sqlite') {
    if (replicas !== 1) {
      throw new Error(
        'SQLite supports exactly one Otto Server writer; use PostgreSQL for multiple replicas',
      );
    }
    assertLocalSqliteDatabasePath(input.sqliteDatabasePath);
    return {
      backend: 'sqlite',
      databasePath: input.sqliteDatabasePath,
      replicas: 1,
    };
  }

  if (!['postgres', 'postgresql'].includes(configuredBackend)) {
    throw new Error(
      'OTTO_ENTERPRISE_DATABASE_BACKEND must be sqlite or postgresql',
    );
  }
  const connectionString = input.environment.OTTO_POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'OTTO_POSTGRES_URL is required when the enterprise database backend is PostgreSQL',
    );
  }
  parsePostgresUrl(connectionString);
  if (
    input.environment.OTTO_DATABASE_ENCRYPTION?.trim().toLowerCase() ===
    'required'
  ) {
    throw new Error(
      'SQLCipher encryption is only valid for local SQLite; configure PostgreSQL TLS and storage/KMS encryption instead',
    );
  }
  return { backend: 'postgresql', connectionString, replicas };
}

export function describeEnterpriseDatabaseTopology(
  topology: EnterpriseDatabaseTopology,
): { backend: 'sqlite' | 'postgresql'; replicas: number; target: string } {
  if (topology.backend === 'sqlite') {
    return {
      backend: 'sqlite',
      replicas: 1,
      target: path.basename(topology.databasePath),
    };
  }
  const parsed = parsePostgresUrl(topology.connectionString);
  const databaseName = parsed.pathname.replace(/^\/+/, '');
  return {
    backend: 'postgresql',
    replicas: topology.replicas,
    target: `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${databaseName}`,
  };
}

/**
 * The legacy synchronous repositories are deliberately SQLite-only. This
 * guard prevents a PostgreSQL deployment from silently creating a split-brain
 * local database while repositories are migrated to their async contracts.
 */
export function requireLocalSqliteTopology(
  topology: EnterpriseDatabaseTopology,
): Extract<EnterpriseDatabaseTopology, { backend: 'sqlite' }> {
  if (topology.backend !== 'sqlite') {
    throw new Error(
      'PostgreSQL is configured, but enterprise route repositories are not yet fully migrated; refusing unsafe SQLite fallback',
    );
  }
  return topology;
}
