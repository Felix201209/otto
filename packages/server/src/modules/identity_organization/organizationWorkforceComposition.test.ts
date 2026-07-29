/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createAccountAuthSchemaContributor } from './accountAuthSchema.js';
import { createEnterpriseInviteSchemaContributor } from './enterpriseInviteSchema.js';
import { createMemberSchemaContributor } from './memberSchema.js';
import { createOrganizationWorkforceComposition } from './organizationWorkforceComposition.js';
import { IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR } from './organizationStructureSchema.js';
import { IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR } from './organizationSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  applyDatabaseSchemaContributors(database, [
    IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
    createAccountAuthSchemaContributor({
      defaultOrganizationId: 'org-default',
    }),
    createEnterpriseInviteSchemaContributor({
      defaultOrganizationId: 'org-default',
    }),
    IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
    createMemberSchemaContributor({ defaultOrganizationId: 'org-default' }),
  ]);
  database
    .prepare(
      `INSERT INTO organizations (id, name, slug, invite_secret)
       VALUES (?, ?, ?, ?)`,
    )
    .run('org-default', 'Default Enterprise', 'default-enterprise', 'secret');
  return database;
}

describe('identity organization workforce composition', () => {
  it('wires directory, structure, members and invites through one boundary', () => {
    const database = createDatabase();
    const audit = vi.fn();
    const workforce = createOrganizationWorkforceComposition({
      db: () => database,
      defaultOrganizationId: 'org-default',
      organizationInviteValidityMs: 7 * 24 * 60 * 60 * 1000,
      organizationInviteAlphabet:
        'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789',
      organizationInviteCodeRawLength: 12,
      normalizeOptionalText: (value) => value?.trim() || null,
      audit,
    });

    try {
      expect(workforce.getOrganization('org-default')).toMatchObject({
        name: 'Default Enterprise',
        status: 'active',
      });

      const department = workforce.createOrganizationDepartment({
        organizationId: 'org-default',
        name: 'Engineering',
      });
      const position = workforce.createOrganizationPosition({
        organizationId: 'org-default',
        departmentId: department.id,
        title: 'Developer',
      });
      workforce.createEmployee({
        id: 'employee-1',
        organizationId: 'org-default',
        name: 'Alice',
        department: 'Engineering',
        departmentId: department.id,
        positionId: position.id,
        positionTitle: 'Developer',
      });

      expect(workforce.getEmployee('employee-1', 'org-default')).toMatchObject({
        department: 'Engineering',
        position_title: 'Developer',
      });

      const departmentInvite = workforce.createInviteCode(
        'Engineering',
        'employee-1',
      );
      expect(
        workforce.validateInviteCode(departmentInvite, 'org-default'),
      ).toMatchObject({ valid: true, department: 'Engineering' });

      const organizationInvite = workforce.issueOrganizationInvite(
        'org-default',
        1_000,
        'employee-1',
        {
          defaultDepartment: 'Engineering',
          departmentId: department.id,
          positionId: position.id,
          positionTitle: 'Developer',
        },
      );
      expect(
        workforce.inspectOrganizationInvite(organizationInvite.code, 1_001),
      ).toMatchObject({ status: 'active', organizationId: 'org-default' });
      expect(audit).toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
