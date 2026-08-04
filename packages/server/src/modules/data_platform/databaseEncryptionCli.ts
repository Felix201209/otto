#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertDataProtectionServiceStopped } from './dataProtectionRestore.js';
import {
  createSqlCipherFileRuntime,
  parseSqlCipherRuntimeMode,
} from './sqlCipherRuntime.js';
import { createSqlCipherDatabaseLifecycle } from './sqlCipherDatabaseLifecycle.js';

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

export function rotateOfflineSqlCipherDatabase(input: {
  dataDirectory: string;
  databasePath?: string;
  environment?: NodeJS.ProcessEnv;
}): { keyVersion: number; recoveryPath: string } {
  const dataDirectory = path.resolve(input.dataDirectory);
  const databasePath = path.resolve(
    input.databasePath ?? path.join(dataDirectory, 'data.db'),
  );
  assertDataProtectionServiceStopped(dataDirectory);
  const runtime = createSqlCipherFileRuntime({
    dataDirectory,
    environment: input.environment,
  });
  const lifecycle = createSqlCipherDatabaseLifecycle({
    dataDirectory,
    databasePath,
    keyProvider: runtime.keyProvider,
    driver: runtime.driver,
  });
  try {
    return lifecycle.rotateKey();
  } finally {
    lifecycle.clearKeys();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'rotate') {
    throw new Error(
      'usage: otto-database-encryption rotate --confirm-rotation',
    );
  }
  if (!process.argv.includes('--confirm-rotation')) {
    throw new Error(
      'database key rotation requires --confirm-rotation and a stopped enterprise server',
    );
  }
  if (parseSqlCipherRuntimeMode() !== 'required') {
    throw new Error('SQLCipher database encryption is disabled');
  }
  const dataDirectory = path.resolve(
    argument('--data-dir') ??
      process.env.OTTO_ENTERPRISE_DIR ??
      path.join(os.homedir(), '.otto-enterprise'),
  );
  const result = rotateOfflineSqlCipherDatabase({ dataDirectory });
  process.stdout.write(
    `${JSON.stringify({ rotated: true, dataDirectory, ...result })}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
