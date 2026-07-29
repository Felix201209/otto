/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyDatabaseSchemaContributors,
  createEnterpriseBackupFacade,
  createEnterpriseDatabaseLifecycle,
  createFileEncryptionKeyProvider,
  Database,
} from './modules/data_platform/index.js';
import { PRODUCT_MODULES } from './productModules.js';
import { Database as LegacyDatabase } from './sqlite-compat.js';

const sourceRoot = path.resolve(import.meta.dirname);
const moduleDirectory = path.join(sourceRoot, 'modules', 'data_platform');

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(target);
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts')
    ) {
      return [];
    }
    return [target];
  });
}

describe('data_platform storage kernel', () => {
  it('publishes reusable storage and database lifecycle primitives', () => {
    expect(createFileEncryptionKeyProvider).toBeTypeOf('function');
    expect(createEnterpriseDatabaseLifecycle).toBeTypeOf('function');
    expect(applyDatabaseSchemaContributors).toBeTypeOf('function');
    expect(createEnterpriseBackupFacade).toBeTypeOf('function');
  });

  it('keeps the legacy sqlite path as an alias of the module implementation', () => {
    expect(LegacyDatabase).toBe(Database);
    const legacySource = fs.readFileSync(
      path.join(sourceRoot, 'sqlite-compat.ts'),
      'utf8',
    );
    expect(legacySource).toMatch(
      /^export \* from ['"]\.\/modules\/data_platform\/index\.js['"];$/m,
    );
    expect(legacySource).not.toMatch(/\bclass\s+Database\b/);
  });

  it('supports named and positional parameters while normalizing undefined to SQL null', () => {
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE samples (name TEXT NOT NULL, note TEXT)');
      database
        .prepare('INSERT INTO samples (name, note) VALUES (@name, @note)')
        .run({ name: 'named', note: undefined });
      database
        .prepare('INSERT INTO samples (name, note) VALUES (?, ?)')
        .run('positional', undefined);

      expect(
        database.prepare('SELECT name, note FROM samples ORDER BY rowid').all(),
      ).toEqual([
        { name: 'named', note: null },
        { name: 'positional', note: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('routes production database imports through the data_platform public entrypoint', () => {
    const offenders = productionTypeScriptFiles(sourceRoot)
      .filter((file) => file !== path.join(sourceRoot, 'sqlite-compat.ts'))
      .filter((file) =>
        /from ['"][^'"]*sqlite-compat\.js['"]/.test(fs.readFileSync(file, 'utf8')),
      )
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });

  it('remains a dependency-free platform module in the product registry', () => {
    const manifest = PRODUCT_MODULES.find(
      (entry) => entry.id === 'data_platform',
    );
    expect(manifest?.layer).toBe('platform');
    expect(manifest?.dependencies).toEqual([]);
    expect(manifest?.dataOwnership).toEqual(
      expect.arrayContaining(['database migrations', 'encryption keys']),
    );
  });

  it('does not import the enterprise composition root or own domain tables', () => {
    const productionSources = fs
      .readdirSync(moduleDirectory)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => fs.readFileSync(path.join(moduleDirectory, file), 'utf8'))
      .join('\n');

    expect(productionSources).not.toMatch(/enterprise[\\/]db|\.\.\/\.\.\/enterprise/);
    expect(productionSources).not.toMatch(
      /CREATE TABLE[^;]*(?:organizations|accounts|park_tickets)/i,
    );
  });

  it('keeps domain migration composition in the enterprise database facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(sourceRoot, 'enterprise', 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createEnterpriseDatabaseLifecycle');
    expect(databaseFacade).toContain('initializeSchema: initSchema');
    expect(databaseFacade).not.toMatch(/\blet db:\s*Database/);
    expect(databaseFacade).not.toContain('new Database(DB_PATH)');
  });

  it('aggregates backups without moving domain queries into data_platform', () => {
    const backupSource = fs.readFileSync(
      path.join(moduleDirectory, 'enterpriseBackupFacade.ts'),
      'utf8',
    );
    const databaseFacade = fs.readFileSync(
      path.join(sourceRoot, 'enterprise', 'db.ts'),
      'utf8',
    );

    expect(backupSource).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    expect(backupSource).not.toMatch(
      /\b(?:task_logs|invite_codes|it_tickets|ticket_deliveries)\b/i,
    );
    expect(databaseFacade).toContain('createEnterpriseBackupFacade');
    expect(databaseFacade).toContain('export const { exportAll }');
    expect(databaseFacade).not.toContain('export function exportAll');
    expect(databaseFacade).not.toMatch(
      /SELECT \* FROM (?:employees|task_logs|invite_codes|it_tickets|ticket_deliveries)/,
    );
  });
});
