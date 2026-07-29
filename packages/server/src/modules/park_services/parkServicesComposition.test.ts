/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { PARK_CORE_SCHEMA_CONTRIBUTOR } from './parkCoreSchema.js';
import { createParkServicesComposition } from './parkServicesComposition.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      invite_secret TEXT NOT NULL,
      park_id TEXT,
      park_address TEXT,
      park_room_number TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    INSERT INTO organizations
      (id, name, slug, invite_secret, status, created_at, updated_at)
    VALUES
      ('org-admin', 'Admin Organization', 'admin-org', 'secret', 'active',
       datetime('now'), datetime('now'));
    INSERT INTO accounts (id) VALUES ('admin');
  `);
  PARK_CORE_SCHEMA_CONTRIBUTOR.apply(database);
  return database;
}

describe('park services composition', () => {
  it('builds all park capabilities around shared tenant dependencies', () => {
    const database = createDatabase();
    let sequence = 0;
    let accountStatus: 'active' | 'disabled' = 'active';
    const account = {
      id: 'admin',
      organizationId: 'org-admin',
      employeeId: null,
      name: 'Admin',
      username: 'admin',
      isAdmin: true,
      status: accountStatus,
      department: 'Operations',
      tags: ['park-admin'],
    };
    const organization = {
      id: 'org-admin',
      name: 'Admin Organization',
      slug: 'admin-org',
      status: 'active' as const,
      parkAddress: null,
      parkRoomNumber: null,
    };
    const parkServices = createParkServicesComposition({
      db: () => database,
      getAccount: (accountId, organizationId) =>
        accountId === account.id &&
        (!organizationId || organizationId === account.organizationId)
          ? { ...account, status: accountStatus }
          : null,
      getOrganization: (organizationId) =>
        organizationId === organization.id ? organization : null,
      isOrganizationActive: (organizationId) =>
        organizationId === organization.id,
      listAccounts: (organizationId) =>
        !organizationId || organizationId === account.organizationId
          ? [{ ...account, status: accountStatus }]
          : [],
      getOrganizationFeatures: () => ({ park_service: true }),
      toOrganizationView: (row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        parkAddress: row.park_address,
        parkRoomNumber: row.park_room_number,
      }),
      normalizeOptionalText: (value) => value.trim() || null,
      normalizeSlug: (value) => value.trim().toLowerCase(),
      normalizeInviteCode: (value) => value.trim().toUpperCase(),
      normalizeTags: (tags) => tags ?? [],
      createUuid: () => `uuid-${++sequence}`,
      createRandomHex: (byteLength) => 'a'.repeat(byteLength * 2),
      inviteValidityMs: 60_000,
      inviteAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
      inviteCodeRawLength: 12,
      audit: () => undefined,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    try {
      const park = parkServices.createParkAsPlatform({
        adminOrganizationId: 'org-admin',
        name: 'Technology Park',
      });
      expect(park).toMatchObject({
        id: 'park_uuid-1',
        name: 'Technology Park',
        adminOrganizationId: 'org-admin',
      });
      const serviceIds = parkServices
        .listParkServices(park.id)
        .map(({ id }) => id);
      expect(serviceIds).toHaveLength(9);
      expect(serviceIds).toEqual(
        expect.arrayContaining([
          'renovation',
          'parking',
          'network-phone',
          'meeting-room',
          'electric-card',
          'repair',
          'vehicle-visit',
          'announcement',
          'satisfaction',
        ]),
      );
      expect(parkServices.createTicket).toBeTypeOf('function');
      expect(parkServices.createParkPublication).toBeTypeOf('function');
      expect(parkServices.createParkDataStatisticsTask).toBeTypeOf('function');
      expect(parkServices.createParkMeetingRoom).toBeTypeOf('function');

      accountStatus = 'disabled';
      expect(() =>
        parkServices.updateParkService({
          parkId: park.id,
          actorAccountId: account.id,
          serviceId: 'repair',
          enabled: false,
        }),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});
