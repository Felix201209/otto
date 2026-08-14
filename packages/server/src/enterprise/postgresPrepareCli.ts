#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  prepareEnterprisePostgres,
  safePostgresErrorMessage,
} from '../modules/data_platform/postgresDatabaseCli.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';

async function main(): Promise<void> {
  await prepareEnterprisePostgres({
    environment: process.env,
    migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
    log: (message) => console.log(message),
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(
      `[Otto Enterprise] PostgreSQL preparation failed: ${safePostgresErrorMessage(
        error,
        process.env.OTTO_POSTGRES_URL,
      )}`,
    );
    process.exitCode = 1;
  });
}
