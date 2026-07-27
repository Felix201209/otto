/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createOrganizationDirectoryFacade,
  type OrganizationDirectoryRepositoryStore,
} from './modules/identity_organization/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      invite_secret TEXT NOT NULL,
      park_id TEXT,
      park_address TEXT,
      park_room_number TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      account_type TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  return database;
}

function createStore(database: Database): OrganizationDirectoryRepositoryStore {
  return { db: () => database };
}

function insertOrganization(
  database: Database,
  input: {
    id: string;
    name: string;
    slug: string;
    parkId?: string | null;
    address?: string | null;
    roomNumber?: string | null;
    status?: 'active' | 'disabled';
  },
): void {
  database
    .prepare(
      `INSERT INTO organizations
       (id, name, slug, invite_secret, park_id, park_address, park_room_number,
        status, created_at, updated_at)
       VALUES (?, ?, ?, 'secret', ?, ?, ?, ?, '2026-01-01', '2026-01-02')`,
    )
    .run(
      input.id,
      input.name,
      input.slug,
      input.parkId ?? null,
      input.address ?? null,
      input.roomNumber ?? null,
      input.status ?? 'active',
    );
}

function insertAccount(
  database: Database,
  input: {
    id: string;
    organizationId: string;
    accountType: 'personal' | 'enterprise';
    deleted?: boolean;
  },
): void {
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, account_type, deleted_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.organizationId,
      input.accountType,
      input.deleted ? '2026-01-03' : null,
    );
}

describe('identity_organization organization directory kernel', () => {
  it('keeps internal organization reads complete, sorted and fully mapped', () => {
    const database = createDatabase();
    insertOrganization(database, {
      id: 'org-zeta',
      name: 'Zeta',
      slug: 'zeta',
      parkId: 'park-1',
      address: '创新路 1 号',
      roomNumber: 'A-101',
      status: 'disabled',
    });
    insertOrganization(database, {
      id: 'org-alpha',
      name: 'Alpha',
      slug: 'alpha',
    });
    const directory = createOrganizationDirectoryFacade(createStore(database));

    try {
      expect(directory.listOrganizations().map(({ id }) => id)).toEqual([
        'org-alpha',
        'org-zeta',
      ]);
      expect(directory.getOrganization('org-zeta')).toEqual({
        id: 'org-zeta',
        name: 'Zeta',
        slug: 'zeta',
        parkId: 'park-1',
        parkAddress: '创新路 1 号',
        parkRoomNumber: 'A-101',
        status: 'disabled',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
      });
      expect(directory.getOrganization('missing')).toBeNull();
      expect(directory.getOrganization('org-alpha')).toMatchObject({
        parkId: null,
        parkAddress: null,
        parkRoomNumber: null,
      });
    } finally {
      database.close();
    }
  });

  it('shows only organizations with a live enterprise account to the platform', () => {
    const database = createDatabase();
    for (const input of [
      { id: 'org-enterprise', name: 'Enterprise', slug: 'enterprise' },
      { id: 'org-personal', name: 'Personal', slug: 'personal' },
      { id: 'org-deleted', name: 'Deleted', slug: 'deleted' },
      { id: 'org-orphan', name: 'Orphan', slug: 'orphan' },
    ]) {
      insertOrganization(database, input);
    }
    insertAccount(database, {
      id: 'acc-enterprise',
      organizationId: 'org-enterprise',
      accountType: 'enterprise',
    });
    insertAccount(database, {
      id: 'acc-personal',
      organizationId: 'org-personal',
      accountType: 'personal',
    });
    insertAccount(database, {
      id: 'acc-deleted',
      organizationId: 'org-deleted',
      accountType: 'enterprise',
      deleted: true,
    });
    const directory = createOrganizationDirectoryFacade(createStore(database));

    try {
      expect(directory.listOrganizations()).toHaveLength(4);
      expect(
        directory.listEnterpriseOrganizations().map(({ id }) => id),
      ).toEqual(['org-enterprise']);
      expect(directory.getEnterpriseOrganization('org-enterprise')?.id).toBe(
        'org-enterprise',
      );
      expect(directory.getEnterpriseOrganization('org-personal')).toBeNull();
      expect(directory.getEnterpriseOrganization('org-deleted')).toBeNull();
      expect(directory.getEnterpriseOrganization('org-orphan')).toBeNull();
    } finally {
      database.close();
    }
  });

  it('keeps enterprise directory ordering stable by name and slug', () => {
    const database = createDatabase();
    for (const input of [
      { id: 'org-b', name: 'Same', slug: 'b' },
      { id: 'org-a', name: 'Same', slug: 'a' },
      { id: 'org-first', name: 'First', slug: 'z' },
    ]) {
      insertOrganization(database, input);
      insertAccount(database, {
        id: `acc-${input.id}`,
        organizationId: input.id,
        accountType: 'enterprise',
      });
    }
    const directory = createOrganizationDirectoryFacade(createStore(database));

    try {
      expect(
        directory.listEnterpriseOrganizations().map(({ id }) => id),
      ).toEqual(['org-first', 'org-a', 'org-b']);
    } finally {
      database.close();
    }
  });
});
