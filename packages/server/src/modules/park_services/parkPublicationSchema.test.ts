/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createParkPublicationSchemaContributor } from './parkPublicationSchema.js';

const contributor = createParkPublicationSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id)
    VALUES ('org-default'), ('org-admin'), ('org-tenant');
    INSERT INTO accounts (id) VALUES ('account-admin'), ('account-tenant');
  `);
}

describe('park publication schema contributor', () => {
  it('creates the publication schema idempotently and preserves responses', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO park_publications
          (id, organization_id, kind, title, body, created_by_account_id)
        VALUES
          ('publication-a', 'org-admin', 'satisfaction', 'Survey', 'Rate us',
           'account-admin');
        INSERT INTO park_publication_recipients
          (organization_id, publication_id, account_id, read_at,
           submitted_at, response_data)
        VALUES
          ('org-tenant', 'publication-a', 'account-tenant', '2026-01-01',
           '2026-01-02', '{"rating":"5","submittedBy":"Alice"}');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT p.kind, r.organization_id, r.read_at, r.submitted_at,
                    r.response_data
             FROM park_publications p
             JOIN park_publication_recipients r
               ON r.publication_id = p.id
             WHERE p.id = 'publication-a'`,
          )
          .get(),
      ).toEqual({
        kind: 'satisfaction',
        organization_id: 'org-tenant',
        read_at: '2026-01-01',
        submitted_at: '2026-01-02',
        response_data: '{"rating":"5","submittedBy":"Alice"}',
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_park_publications_org_created',
               'idx_park_publication_recipients_account'
             ) ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_park_publication_recipients_account' },
        { name: 'idx_park_publications_org_created' },
      ]);
    } finally {
      database.close();
    }
  });

  it('upgrades legacy publication tables without losing acknowledgement data', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      database.exec(`
        CREATE TABLE park_publications (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_by_account_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE park_publication_recipients (
          publication_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          read_at TEXT,
          submitted_at TEXT,
          response_data TEXT,
          PRIMARY KEY (publication_id, account_id)
        );
        INSERT INTO park_publications
          (id, kind, title, body, created_by_account_id, created_at)
        VALUES
          ('legacy-publication', 'announcement', 'Legacy Notice', 'Body',
           'account-admin', '2026-01-01');
        INSERT INTO park_publication_recipients
          (publication_id, account_id, read_at)
        VALUES ('legacy-publication', 'account-tenant', '2026-01-02');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT p.organization_id AS publication_organization_id,
                    r.organization_id AS recipient_organization_id,
                    p.title, r.read_at
             FROM park_publications p
             JOIN park_publication_recipients r
               ON r.publication_id = p.id`,
          )
          .get(),
      ).toEqual({
        publication_organization_id: 'org-default',
        recipient_organization_id: 'org-default',
        title: 'Legacy Notice',
        read_at: '2026-01-02',
      });
    } finally {
      database.close();
    }
  });

  it('enforces publication type and recipient cascade constraints', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      expect(() =>
        database.exec(`
          INSERT INTO park_publications
            (id, organization_id, kind, title, body, created_by_account_id)
          VALUES
            ('invalid', 'org-admin', 'other', 'Invalid', 'Body',
             'account-admin');
        `),
      ).toThrow(/CHECK constraint failed/);

      database.exec(`
        INSERT INTO park_publications
          (id, organization_id, kind, title, body, created_by_account_id)
        VALUES
          ('publication-a', 'org-admin', 'announcement', 'Notice', 'Body',
           'account-admin');
        INSERT INTO park_publication_recipients
          (organization_id, publication_id, account_id)
        VALUES ('org-tenant', 'publication-a', 'account-tenant');
        DELETE FROM park_publications WHERE id = 'publication-a';
      `);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM park_publication_recipients')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rejects unsafe default organization ids', () => {
    expect(() =>
      createParkPublicationSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE park_publications; --",
      }),
    ).toThrow('Invalid default organization id for park publication schema');
  });
});
