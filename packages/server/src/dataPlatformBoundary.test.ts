/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFileEncryptionKeyProvider,
  Database,
} from './modules/data_platform/index.js';
import { Database as LegacyDatabase } from './sqlite-compat.js';

const sourceRoot = path.resolve(import.meta.dirname);

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(target);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      return [];
    }
    return [target];
  });
}

describe('data_platform storage kernel', () => {
  it('publishes reusable encrypted-storage key lifecycle primitives', () => {
    expect(createFileEncryptionKeyProvider).toBeTypeOf('function');
  });

  it('keeps the legacy sqlite path as an alias of the module implementation', () => {
    expect(LegacyDatabase).toBe(Database);
    const legacySource = fs.readFileSync(path.join(sourceRoot, 'sqlite-compat.ts'), 'utf8');
    expect(legacySource).toMatch(/^export \* from ['"]\.\/modules\/data_platform\/index\.js['"];$/m);
    expect(legacySource).not.toMatch(/\bclass\s+Database\b/);
  });

  it('supports named and positional parameters while normalizing undefined to SQL null', () => {
    const database = new Database(':memory:');
    try {
      database.exec('CREATE TABLE samples (name TEXT NOT NULL, note TEXT)');
      database.prepare('INSERT INTO samples (name, note) VALUES (@name, @note)')
        .run({ name: 'named', note: undefined });
      database.prepare('INSERT INTO samples (name, note) VALUES (?, ?)')
        .run('positional', undefined);

      expect(database.prepare('SELECT name, note FROM samples ORDER BY rowid').all())
        .toEqual([
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
      .filter((file) => /from ['"][^'"]*sqlite-compat\.js['"]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });
});
