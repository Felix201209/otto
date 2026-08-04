#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildNodePostgresPoolConfig,
  createAttachmentObjectStoreRuntime,
  createEncryptedObjectStore,
  createFileEncryptionKeyProvider,
  createNodePostgresPool,
  createPostgresDatabaseLifecycle,
  describeEnterpriseDatabaseTopology,
  resolveEnterpriseDatabaseTopology,
  type AttachmentObjectStoreEnvironment,
  type EnterpriseDatabaseTopologyEnvironment,
  type NodePostgresEnvironment,
} from '../modules/data_platform/index.js';
import { prepareSqliteAttachmentImport } from './postgresAttachmentImport.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';

type AttachmentImportEnvironment = NodeJS.ProcessEnv &
  EnterpriseDatabaseTopologyEnvironment &
  NodePostgresEnvironment &
  AttachmentObjectStoreEnvironment & {
    OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED?: string;
    OTTO_SQLITE_ATTACHMENT_STORAGE_DIR?: string;
    OTTO_SQLITE_ATTACHMENT_ENCRYPTION_KEY_FILE?: string;
  };

export interface PostgresAttachmentImportArguments {
  runId: string;
  dryRun: boolean;
}

export function parsePostgresAttachmentImportArguments(
  args: readonly string[],
): PostgresAttachmentImportArguments {
  let runId = '';
  let dryRun = true;
  let selectedMode: 'dry-run' | 'execute' | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--run') {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--run requires a verified SQLite import run id');
      }
      runId = value;
      index += 1;
      continue;
    }
    if (argument === '--dry-run' || argument === '--execute') {
      const mode = argument === '--execute' ? 'execute' : 'dry-run';
      if (selectedMode && selectedMode !== mode) {
        throw new Error('--dry-run and --execute cannot be combined');
      }
      selectedMode = mode;
      dryRun = mode === 'dry-run';
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!runId) throw new Error('--run is required');
  return { runId, dryRun };
}

export function safeAttachmentImportErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'unknown error')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, 'postgresql://[REDACTED]')
    .replace(/https?:\/\/[^\s]+/giu, '[REDACTED_URL]')
    .replace(
      /attachments[\\/]v1[\\/][0-9a-f]{2}[\\/][0-9a-f]{32}\.bin/giu,
      '[REDACTED_OBJECT_KEY]',
    )
    .replace(
      /[0-9a-f]{2}[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.otto-object/giu,
      '[REDACTED_OBJECT_KEY]',
    )
    .slice(0, 1_000);
}

export async function prepareEnterprisePostgresAttachments(input: {
  arguments: readonly string[];
  environment: AttachmentImportEnvironment;
  log?: (message: string) => void;
}) {
  const options = parsePostgresAttachmentImportArguments(input.arguments);
  if (
    !options.dryRun &&
    input.environment.OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED?.trim().toLowerCase() !==
      'true'
  ) {
    throw new Error(
      'execute requires OTTO_SQLITE_IMPORT_MAINTENANCE_CONFIRMED=true after stopping all SQLite writers',
    );
  }
  const topology = resolveEnterpriseDatabaseTopology({
    environment: input.environment,
    sqliteDatabasePath: 'attachment-import-does-not-open-sqlite.db',
  });
  if (topology.backend !== 'postgresql') {
    throw new Error('attachment import requires PostgreSQL enterprise mode');
  }
  const sourceKeyProvider: {
    current: ReturnType<typeof createFileEncryptionKeyProvider> | null;
  } = { current: null };
  let lifecycle: ReturnType<typeof createPostgresDatabaseLifecycle> | null =
    null;
  let target: ReturnType<typeof createAttachmentObjectStoreRuntime> | null =
    null;
  try {
    const pool = createNodePostgresPool(
      buildNodePostgresPoolConfig({
        connectionString: topology.connectionString,
        environment: input.environment,
      }),
    );
    lifecycle = createPostgresDatabaseLifecycle({
      pool,
      migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
    });
    target = createAttachmentObjectStoreRuntime({
      environment: input.environment,
    });
    await lifecycle.initialize();
    const result = await prepareSqliteAttachmentImport({
      pool,
      runId: options.runId,
      objectStore: target.store,
      dryRun: options.dryRun,
      readLegacyCiphertext: async (key) => {
        const sourceDirectory =
          input.environment.OTTO_SQLITE_ATTACHMENT_STORAGE_DIR?.trim();
        const sourceKeyPath =
          input.environment.OTTO_SQLITE_ATTACHMENT_ENCRYPTION_KEY_FILE?.trim();
        if (!sourceDirectory || !sourceKeyPath) {
          throw new Error(
            'legacy filesystem attachments require OTTO_SQLITE_ATTACHMENT_STORAGE_DIR and OTTO_SQLITE_ATTACHMENT_ENCRYPTION_KEY_FILE',
          );
        }
        sourceKeyProvider.current ??= createFileEncryptionKeyProvider({
          keyPath: path.resolve(sourceKeyPath),
          keyBytes: 32,
          invalidKeyMessage: 'legacy attachment encryption key is invalid',
          createIfMissing: false,
          managePermissions: false,
        });
        const source = createEncryptedObjectStore({
          root: path.resolve(sourceDirectory),
          keyProvider: sourceKeyProvider.current,
        });
        return source.read(key);
      },
    });
    input.log?.(
      JSON.stringify({
        mode: options.dryRun ? 'dry-run' : 'execute',
        target: describeEnterpriseDatabaseTopology(topology),
        objectStore: 's3',
        ...result,
      }),
    );
    return result;
  } finally {
    sourceKeyProvider.current?.clear();
    target?.close();
    await lifecycle?.close();
  }
}

async function main(): Promise<void> {
  try {
    await prepareEnterprisePostgresAttachments({
      arguments: process.argv.slice(2),
      environment: process.env,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error(
      `[Otto Enterprise] attachment import failed: ${safeAttachmentImportErrorMessage(error)}`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) void main();
