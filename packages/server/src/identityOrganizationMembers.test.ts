/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createMemberDirectoryFacade,
  type MemberRepositoryStore,
} from './modules/identity_organization/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE employees (
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT,
      department TEXT,
      department_id TEXT,
      position_id TEXT,
      position_title TEXT,
      invite_code TEXT,
      personality TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      onboarded_at TEXT NOT NULL DEFAULT (datetime('now')),
      offboarded_at TEXT,
      PRIMARY KEY (organization_id, id)
    );
  `);
  return database;
}

describe('identity_organization member directory', () => {
  it('isolates member lists and offboarding by organization', () => {
    const database = createDatabase();
    const audit = vi.fn();
    const store: MemberRepositoryStore = {
      db: () => database,
      defaultOrganizationId: 'org-default',
      organizationExists: (organizationId) =>
        ['org-a', 'org-b'].includes(organizationId),
      resolveAssignmentIdentity: (_database, _organizationId, input) => ({
        department: input.department?.trim() || null,
        departmentId: input.departmentId ?? null,
        positionId: input.positionId ?? null,
        positionTitle: input.positionTitle?.trim() || null,
      }),
      audit,
      legacyMemoryPaths: () => [],
    };
    const members = createMemberDirectoryFacade(store);

    try {
      members.createEmployee({
        id: 'member-a',
        organizationId: 'org-a',
        name: 'Alice',
        department: 'Engineering',
      });
      members.createEmployee({
        id: 'member-b',
        organizationId: 'org-b',
        name: 'Bob',
        department: 'Operations',
      });

      expect(
        members.listEmployees(undefined, 'org-a').map((row) => row.id),
      ).toEqual(['member-a']);
      expect(
        members.listEmployees(undefined, 'org-b').map((row) => row.id),
      ).toEqual(['member-b']);
      expect(members.getEmployee('member-a', 'org-b')).toBeNull();
      expect(members.getEmployee('member-b')).toBeNull();

      expect(members.offboardEmployee('member-a', 'org-b')).toBe(false);
      expect(members.offboardEmployee('member-b')).toBe(false);
      expect(members.getEmployee('member-a', 'org-a')).toMatchObject({
        status: 'active',
      });
      expect(members.offboardEmployee('member-a', 'org-a')).toBe(true);
      expect(members.listEmployees(undefined, 'org-a')).toEqual([]);
      expect(members.getEmployee('member-a', 'org-a')).toMatchObject({
        status: 'offboarded',
      });
      expect(members.getEmployee('member-b', 'org-b')).toMatchObject({
        status: 'active',
      });
      expect(audit).toHaveBeenCalledWith(
        'offboard',
        'member-a',
        'Employee offboarded',
        'org-a',
      );
    } finally {
      database.close();
    }
  });

  it('rejects creation for an organization outside the injected identity store', () => {
    const database = createDatabase();
    const members = createMemberDirectoryFacade({
      db: () => database,
      defaultOrganizationId: 'org-default',
      organizationExists: () => false,
      resolveAssignmentIdentity: () => ({
        department: null,
        departmentId: null,
        positionId: null,
        positionTitle: null,
      }),
      audit: vi.fn(),
      legacyMemoryPaths: () => [],
    });

    try {
      expect(() =>
        members.createEmployee({
          id: 'member-unknown',
          organizationId: 'org-unknown',
          name: 'Unknown',
        }),
      ).toThrow('Organization not found');
    } finally {
      database.close();
    }
  });

  it('limits legacy OrgMemoryStore fallback to the default organization', () => {
    const database = createDatabase();
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-members-'),
    );
    const legacyPath = path.join(temporaryDirectory, 'memory-store.json');
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        users: [
          {
            id: 'legacy-member',
            name: 'Legacy User',
            role: 'member',
            teamIds: ['legacy-team'],
            createdAt: '2026-07-27T00:00:00.000Z',
          },
        ],
        teams: [{ id: 'legacy-team', name: 'Legacy Team' }],
      }),
    );
    const members = createMemberDirectoryFacade({
      db: () => database,
      defaultOrganizationId: 'org-default',
      organizationExists: () => true,
      resolveAssignmentIdentity: () => ({
        department: null,
        departmentId: null,
        positionId: null,
        positionTitle: null,
      }),
      audit: vi.fn(),
      legacyMemoryPaths: () => [legacyPath],
    });

    try {
      expect(members.getEmployee('legacy-member', 'org-default')).toMatchObject(
        {
          name: 'Legacy User',
          department: 'Legacy Team',
        },
      );
      expect(members.listEmployees(undefined, 'org-default')).toContainEqual(
        expect.objectContaining({ id: 'legacy-member' }),
      );
      expect(members.getEmployee('legacy-member', 'org-other')).toBeNull();
      expect(members.listEmployees(undefined, 'org-other')).toEqual([]);
    } finally {
      database.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
