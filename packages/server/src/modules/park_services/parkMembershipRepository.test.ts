/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import type { ParkView } from './parkLifecycleTypes.js';
import { listParkTenantOrganizationsFromRepository } from './parkMembershipRepository.js';

interface TenantView {
  id: string;
  name: string;
  parkId: string | null;
  address: string | null;
  roomNumber: string | null;
}

function createPark(id: string, adminOrganizationId: string): ParkView {
  return {
    id,
    name: id,
    slug: id,
    brandName: id,
    adminOrganizationId,
    status: 'active',
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
  };
}

describe('park membership repository tenant directory', () => {
  it('lists only the requested park tenants and excludes its admin organization', () => {
    const database = new Database(':memory:');
    try {
      database.exec(`
        CREATE TABLE organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL,
          invite_secret TEXT NOT NULL,
          park_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE park_tenant_profiles (
          organization_id TEXT PRIMARY KEY,
          park_id TEXT NOT NULL,
          address TEXT NOT NULL,
          room_number TEXT NOT NULL
        );
        INSERT INTO organizations
          (id, name, slug, invite_secret, park_id, status, created_at, updated_at)
        VALUES
          ('park-admin-a', '园区管理方', 'park-admin-a', 'secret', 'park-a', 'active', '2026-01-01', '2026-01-01'),
          ('tenant-b', 'Beta 企业', 'tenant-b', 'secret', 'park-a', 'active', '2026-01-01', '2026-01-01'),
          ('tenant-a', 'alpha 企业', 'tenant-a', 'secret', 'park-a', 'active', '2026-01-01', '2026-01-01'),
          ('tenant-other', '其他园区企业', 'tenant-other', 'secret', 'park-b', 'active', '2026-01-01', '2026-01-01');
        INSERT INTO park_tenant_profiles
          (organization_id, park_id, address, room_number)
        VALUES ('tenant-a', 'park-a', 'A 座', '101');
      `);
      const parks = new Map([
        ['park-a', createPark('park-a', 'park-admin-a')],
        ['park-b', createPark('park-b', 'park-admin-b')],
      ]);
      const store = {
        db: () => database,
        getPark: (parkId: string) => parks.get(parkId) ?? null,
        toOrganizationView: (row: {
          id: string;
          name: string;
          park_id: string | null;
          park_address: string | null;
          park_room_number: string | null;
        }): TenantView => ({
          id: row.id,
          name: row.name,
          parkId: row.park_id,
          address: row.park_address,
          roomNumber: row.park_room_number,
        }),
      };

      expect(
        listParkTenantOrganizationsFromRepository(store, 'park-a'),
      ).toEqual([
        {
          id: 'tenant-a',
          name: 'alpha 企业',
          parkId: 'park-a',
          address: 'A 座',
          roomNumber: '101',
        },
        {
          id: 'tenant-b',
          name: 'Beta 企业',
          parkId: 'park-a',
          address: null,
          roomNumber: null,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('preserves the existing not-found contract', () => {
    const database = new Database(':memory:');
    try {
      expect(() =>
        listParkTenantOrganizationsFromRepository(
          {
            db: () => database,
            getPark: () => null,
            toOrganizationView: () => null,
          },
          'missing-park',
        ),
      ).toThrow('Park not found');
    } finally {
      database.close();
    }
  });
});
