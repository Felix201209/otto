/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  importEnterpriseSqliteToPostgres,
  parseSqlitePostgresImportArguments,
  safeSqlitePostgresImportErrorMessage,
} from './sqlitePostgresImportCli.js';
import { Database } from './sqliteCompat.js';

const temporaryDirectories: string[] = [];

function sourceFile(): { path: string; database: Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-import-cli-'));
  temporaryDirectories.push(directory);
  const sourcePath = path.join(directory, 'enterprise-snapshot.db');
  const database = new Database(sourcePath);
  database.exec(
    'PRAGMA user_version = 20; CREATE TABLE accounts (id TEXT PRIMARY KEY);',
  );
  database.prepare('INSERT INTO accounts (id) VALUES (?)').run('account_1');
  return { path: sourcePath, database };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite to PostgreSQL import CLI', () => {
  it('defaults to dry-run and validates bounded batch arguments', () => {
    expect(
      parseSqlitePostgresImportArguments([
        '--source',
        'snapshot.db',
        '--batch-size',
        '250',
      ]),
    ).toEqual({
      dryRun: true,
      sourcePath: 'snapshot.db',
      batchSize: 250,
    });
    expect(() =>
      parseSqlitePostgresImportArguments(['--execute', '--dry-run']),
    ).toThrow(/cannot be combined/i);
    expect(() =>
      parseSqlitePostgresImportArguments(['--batch-size', '0']),
    ).toThrow(/batch-size/i);
    expect(() => parseSqlitePostgresImportArguments(['--unknown'])).toThrow(
      /unknown argument/i,
    );
  });

  it('requires an explicit maintenance confirmation before writing', async () => {
    await expect(
      importEnterpriseSqliteToPostgres({
        arguments: ['--execute', '--source', 'snapshot.db'],
        environment: {
          OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
          OTTO_POSTGRES_URL:
            'postgresql://otto:super-secret@db.internal:5432/otto',
        },
        sourceFactory: () => {
          throw new Error('source must not open');
        },
      }),
    ).rejects.toThrow(/maintenance.*confirmed/i);
  });

  it('performs a credential-free, connection-free dry-run', async () => {
    const source = sourceFile();
    const close = vi.fn(() => source.database.close());
    const poolFactory = vi.fn(() => {
      throw new Error('dry-run must not connect to PostgreSQL');
    });
    const log = vi.fn();

    const result = await importEnterpriseSqliteToPostgres({
      arguments: ['--source', source.path],
      environment: {
        OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql',
        OTTO_POSTGRES_URL:
          'postgresql://otto:super-secret@db.internal:5432/otto',
        OTTO_SQLITE_IMPORT_ENCRYPTION: 'required',
      },
      sourceFactory: () => ({ database: source.database, close }),
      poolFactory,
      log,
    });

    expect(result).toMatchObject({ state: 'planned', runId: null });
    expect(close).toHaveBeenCalledOnce();
    expect(poolFactory).not.toHaveBeenCalled();
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain('enterprise-snapshot.db');
    expect(output).toContain('db.internal:5432/otto');
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain(path.dirname(source.path));
  });

  it('redacts database credentials and local source directories from errors', () => {
    const connectionString =
      'postgresql://otto:super-secret@db.internal:5432/otto';
    const sourcePath = String.raw`C:\Users\operator\private\snapshot.db`;
    const message = safeSqlitePostgresImportErrorMessage(
      new Error(`failed ${connectionString} while reading ${sourcePath}`),
      { OTTO_POSTGRES_URL: connectionString },
      sourcePath,
    );

    expect(message).not.toContain('super-secret');
    expect(message).not.toContain('operator');
    expect(message).toContain('snapshot.db');
  });
});
