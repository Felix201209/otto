/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  type DatabaseSchemaContributor,
} from './databaseSchemaContributor.js';
import { Database } from './sqliteCompat.js';

describe('database schema contributors', () => {
  it('applies contributors in their declared order', () => {
    const database = new Database(':memory:');
    const order: string[] = [];
    const contributors: DatabaseSchemaContributor[] = [
      { id: 'identity', apply: () => order.push('identity') },
      { id: 'collaboration', apply: () => order.push('collaboration') },
    ];
    try {
      applyDatabaseSchemaContributors(database, contributors);
      expect(order).toEqual(['identity', 'collaboration']);
    } finally {
      database.close();
    }
  });

  it('rejects duplicate ids before applying any contributor', () => {
    const database = new Database(':memory:');
    const apply = vi.fn();
    try {
      expect(() =>
        applyDatabaseSchemaContributors(database, [
          { id: 'collaboration', apply },
          { id: 'collaboration', apply },
        ]),
      ).toThrow('Duplicate database schema contributor id: collaboration');
      expect(apply).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it('rejects an empty contributor id', () => {
    const database = new Database(':memory:');
    try {
      expect(() =>
        applyDatabaseSchemaContributors(database, [{ id: '  ', apply() {} }]),
      ).toThrow('Database schema contributor id is required');
    } finally {
      database.close();
    }
  });
});
