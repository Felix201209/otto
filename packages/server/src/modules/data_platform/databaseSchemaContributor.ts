/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseHandle } from './sqliteCompat.js';

export interface DatabaseSchemaContributor {
  id: string;
  apply(database: DatabaseHandle): void;
}

export function applyDatabaseSchemaContributors(
  database: DatabaseHandle,
  contributors: readonly DatabaseSchemaContributor[],
): void {
  const contributorIds = new Set<string>();
  for (const contributor of contributors) {
    const id = contributor.id.trim();
    if (!id) throw new Error('Database schema contributor id is required');
    if (contributorIds.has(id)) {
      throw new Error(`Duplicate database schema contributor id: ${id}`);
    }
    contributorIds.add(id);
  }

  for (const contributor of contributors) contributor.apply(database);
}
