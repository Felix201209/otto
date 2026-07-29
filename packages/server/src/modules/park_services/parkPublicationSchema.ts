/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  DatabaseHandle,
  DatabaseSchemaContributor,
} from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function ensureOrganizationColumn(
  database: DatabaseHandle,
  table: string,
  defaultOrganizationId: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === 'organization_id')) {
    database.exec(
      `ALTER TABLE ${table} ADD COLUMN organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}'`,
    );
  }
}

export function createParkPublicationSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error(
      'Invalid default organization id for park publication schema',
    );
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'park_services_publications',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS park_publications (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          kind TEXT NOT NULL
            CHECK(kind IN ('announcement', 'satisfaction')),
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_by_account_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
            ON DELETE CASCADE,
          FOREIGN KEY (created_by_account_id) REFERENCES accounts(id)
        );

        CREATE TABLE IF NOT EXISTS park_publication_recipients (
          organization_id TEXT NOT NULL,
          publication_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          read_at TEXT,
          submitted_at TEXT,
          response_data TEXT,
          PRIMARY KEY (publication_id, account_id),
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
            ON DELETE CASCADE,
          FOREIGN KEY (publication_id) REFERENCES park_publications(id)
            ON DELETE CASCADE,
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        );
      `);

      ensureOrganizationColumn(
        database,
        'park_publications',
        defaultOrganizationId,
      );
      ensureOrganizationColumn(
        database,
        'park_publication_recipients',
        defaultOrganizationId,
      );

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_park_publications_org_created
          ON park_publications(organization_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_park_publication_recipients_account
          ON park_publication_recipients(account_id, publication_id);
      `);
    },
  };
}
