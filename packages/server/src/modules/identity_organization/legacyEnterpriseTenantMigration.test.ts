/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { migrateLegacyEnterpriseTenant } from './legacyEnterpriseTenantMigration.js';

describe('legacy enterprise tenant migration', () => {
  it('seeds the default organization and assigns legacy presence rows idempotently', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          invite_secret TEXT NOT NULL
        );
        CREATE TABLE account_presence (
          account_id TEXT PRIMARY KEY,
          last_seen_at TEXT NOT NULL
        );
        INSERT INTO account_presence (account_id, last_seen_at)
        VALUES ('account-1', '2026-01-01 00:00:00');
      `);
      const options = {
        defaultOrganizationId: 'organization-default',
        defaultOrganizationName: '默认企业',
        inviteSecret: 'initial-secret',
      };

      migrateLegacyEnterpriseTenant(database, options);
      migrateLegacyEnterpriseTenant(database, {
        ...options,
        defaultOrganizationName: '不能覆盖既有企业',
        inviteSecret: 'replacement-secret',
      });

      expect(database.prepare('SELECT * FROM organizations').all()).toEqual([
        {
          id: 'organization-default',
          name: '默认企业',
          slug: 'default',
          invite_secret: 'initial-secret',
        },
      ]);
      expect(
        database
          .prepare('SELECT account_id, organization_id FROM account_presence')
          .all(),
      ).toEqual([
        {
          account_id: 'account-1',
          organization_id: 'organization-default',
        },
      ]);
      expect(
        database
          .prepare('PRAGMA table_info(account_presence)')
          .all()
          .filter(
            (column) =>
              (column as { name?: string }).name === 'organization_id',
          ),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('escapes the default tenant id used by SQLite column defaults', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          invite_secret TEXT NOT NULL
        );
        CREATE TABLE account_presence (
          account_id TEXT PRIMARY KEY,
          last_seen_at TEXT NOT NULL
        );
      `);
      migrateLegacyEnterpriseTenant(database, {
        defaultOrganizationId: "organization'quoted",
        defaultOrganizationName: 'Quoted tenant',
        inviteSecret: 'secret',
      });
      database
        .prepare(
          'INSERT INTO account_presence (account_id, last_seen_at) VALUES (?, ?)',
        )
        .run('account-quoted', '2026-01-01');

      expect(
        database
          .prepare(
            'SELECT organization_id FROM account_presence WHERE account_id = ?',
          )
          .get('account-quoted'),
      ).toEqual({ organization_id: "organization'quoted" });
    } finally {
      database.close();
    }
  });
});
