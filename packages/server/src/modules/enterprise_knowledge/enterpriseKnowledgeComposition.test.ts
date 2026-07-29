/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createEnterpriseKnowledgeComposition } from './enterpriseKnowledgeComposition.js';
import { createEnterpriseKnowledgeSchemaContributor } from './enterpriseKnowledgeSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE organizations (id TEXT PRIMARY KEY);');
  applyDatabaseSchemaContributors(database, [
    createEnterpriseKnowledgeSchemaContributor({
      defaultOrganizationId: 'org-a',
    }),
  ]);
  database.exec("INSERT INTO organizations (id) VALUES ('org-a'), ('org-b');");
  return database;
}

function createComposition(database: Database) {
  const organizations = new Set(['org-a', 'org-b']);
  return createEnterpriseKnowledgeComposition({
    db: () => database,
    defaultOrganizationId: 'org-a',
    getOrganization: (organizationId) =>
      organizations.has(organizationId) ? { id: organizationId } : null,
  });
}

describe('enterprise knowledge composition', () => {
  it('uses the default tenant and keeps source idempotency tenant-scoped', () => {
    const database = createDatabase();
    const knowledge = createComposition(database);
    const entry = {
      sourceId: 'shared-source',
      category: 'process',
      content: 'Reusable process',
    };

    try {
      expect(knowledge.addKnowledge(entry)).toBe(true);
      expect(knowledge.addKnowledge(entry)).toBe(false);
      expect(
        knowledge.addKnowledge({ ...entry, organizationId: 'org-b' }),
      ).toBe(true);
      expect(knowledge.getKnowledge()).toHaveLength(1);
      expect(
        knowledge.getKnowledge(undefined, undefined, 'org-b'),
      ).toHaveLength(1);
      expect(() =>
        knowledge.addKnowledge({ ...entry, organizationId: 'missing' }),
      ).toThrow('Organization not found');
    } finally {
      database.close();
    }
  });

  it('limits members to global and same-department knowledge', () => {
    const database = createDatabase();
    const knowledge = createComposition(database);

    try {
      knowledge.addKnowledge({
        category: 'global',
        content: 'Visible to everyone',
      });
      knowledge.addKnowledge({
        department: 'Engineering',
        category: 'engineering',
        content: 'Engineering only',
      });
      knowledge.addKnowledge({
        department: 'Sales',
        category: 'sales',
        content: 'Sales only',
      });

      expect(
        knowledge
          .getMemberKnowledge('Engineering')
          .map((entry) => entry.category),
      ).toEqual(expect.arrayContaining(['global', 'engineering']));
      expect(
        knowledge
          .getMemberKnowledge('Engineering')
          .map((entry) => entry.category),
      ).not.toContain('sales');
      expect(
        knowledge.getMemberKnowledge(null).map((entry) => entry.category),
      ).toEqual(['global']);
    } finally {
      database.close();
    }
  });
});
