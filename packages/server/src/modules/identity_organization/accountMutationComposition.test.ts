/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { createAccountAccessComposition } from './accountAccessComposition.js';
import { createAccountAuthSchemaContributor } from './accountAuthSchema.js';
import type { AccountLifecycleView } from './accountLifecycleRepository.js';
import { createAccountMutationComposition } from './accountMutationComposition.js';
import {
  listAccountTagsInRepository,
  replaceMigratedAccountTagsInRepository,
} from './accountTagRepository.js';
import {
  assertAccountPassword,
  hashIdentitySecret,
  identitySecretMatches,
} from './credentialSecurity.js';
import { createEnterpriseInviteSchemaContributor } from './enterpriseInviteSchema.js';
import { createMemberSchemaContributor } from './memberSchema.js';
import { getOrganizationPositionRoleMappingFromRepository } from './organizationStructureRepository.js';
import { IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR } from './organizationStructureSchema.js';
import { createOrganizationWorkforceComposition } from './organizationWorkforceComposition.js';
import { IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR } from './organizationSchema.js';

interface TestAccountView extends AccountLifecycleView {
  phone: string | null;
  tags: string[];
}

interface TestAccountRow {
  id: string;
  organization_id: string;
  account_type: 'personal' | 'enterprise';
  employee_id: string | null;
  username: string;
  phone: string | null;
  password_hash: string;
  name: string;
  role: string | null;
  department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  is_admin: number;
  status: 'active' | 'disabled';
  deleted_at: string | null;
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  applyDatabaseSchemaContributors(database, [
    IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
    createEnterpriseInviteSchemaContributor({
      defaultOrganizationId: 'org-default',
    }),
    IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
    createMemberSchemaContributor({ defaultOrganizationId: 'org-default' }),
    createAccountAuthSchemaContributor({
      defaultOrganizationId: 'org-default',
    }),
  ]);
  database
    .prepare(
      `INSERT INTO organizations (id, name, slug, invite_secret)
       VALUES (?, ?, ?, ?)`,
    )
    .run('org-default', 'Default Enterprise', 'default-enterprise', 'secret');
  return database;
}

describe('identity organization account mutation composition', () => {
  it('wires lifecycle, tenant provisioning and registration in order', () => {
    const database = createDatabase();
    const audit = vi.fn();
    const accountTags = { db: () => database };
    const toAccountView = (row: TestAccountRow): TestAccountView => ({
      id: row.id,
      organizationId: row.organization_id,
      accountType: row.account_type,
      employeeId: row.employee_id,
      username: row.username,
      name: row.name,
      phone: row.phone,
      role: row.role,
      department: row.department,
      departmentId: row.department_id,
      positionId: row.position_id,
      positionTitle: row.position_title,
      isAdmin: row.is_admin === 1,
      status: row.status,
      tags: listAccountTagsInRepository(
        accountTags,
        row.id,
        row.organization_id,
      ),
    });
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
    const access = createAccountAccessComposition<
      TestAccountView,
      TestAccountRow
    >({
      db: () => database,
      defaultOrganizationId: 'org-default',
      now: () => 1_000,
      normalizeIdentifier: (value) => value.trim().toLowerCase(),
      normalizePhone: (value) => value.trim(),
      passwordMatches: identitySecretMatches,
      isOrganizationActive: (organizationId) =>
        workforce.getOrganization(organizationId)?.status === 'active',
      organizationExists: (organizationId) =>
        workforce.getOrganization(organizationId) !== null,
      toAccountView,
      hashSecret: hashIdentitySecret,
      secretMatches: identitySecretMatches,
      createChallengeId: (kind) => `${kind}-challenge`,
      audit,
    });
    let sequence = 0;
    const mutations = createAccountMutationComposition({
      db: () => database,
      defaultOrganizationId: 'org-default',
      now: () => 1_000,
      organizationExists: (organizationId) =>
        workforce.getOrganization(organizationId) !== null,
      normalizeUsername: (value) => value.trim().toLowerCase(),
      normalizePhone: (value) => value.trim(),
      normalizeOptionalPhone: (value) => value?.trim() || null,
      normalizeOptionalFeishuOpenId: (value) => value?.trim() || null,
      normalizeOptionalAvatarUrl: (value) => value?.trim() || null,
      assertPassword: assertAccountPassword,
      hashPassword: hashIdentitySecret,
      createAccountEntityId: (prefix) => `${prefix}-${++sequence}`,
      createDeletionPasswordHash: () => hashIdentitySecret('deleted-secret'),
      createOrganizationId: () => `org-${++sequence}`,
      createInviteSecret: () => 'invite-secret',
      createDefaultSlugSuffix: () => `slug-${++sequence}`,
      createUsernameSuffix: () => `user-${++sequence}`,
      createPersonalSlugSuffix: () => `personal-${++sequence}`,
      resolveAssignmentIdentity: workforce.resolveAssignmentIdentity,
      getPositionRoleMapping: getOrganizationPositionRoleMappingFromRepository,
      createEmployee(input) {
        const { inviteCode, ...employee } = input;
        return workforce.createEmployee({
          ...employee,
          invite_code: inviteCode,
        });
      },
      getAccount: access.getAccount,
      findAccountByPhone: access.findAccountByPhone,
      getOrganization: workforce.getOrganization,
      issueOrganizationInvite: workforce.issueOrganizationInvite,
      resolveOrganizationInviteWithDefaults:
        workforce.resolveOrganizationInviteWithDefaults,
      normalizeOrganizationInviteCode:
        workforce.normalizeOrganizationInviteCode,
      replaceMigratedAccountTags(accountId, organizationId, tags) {
        replaceMigratedAccountTagsInRepository(
          accountTags,
          accountId,
          organizationId,
          tags,
        );
      },
      audit,
    });

    try {
      const account = mutations.createAccount({
        username: 'owner',
        password: 'Correct-password-123',
        name: 'Owner',
      });
      expect(account).toMatchObject({
        organizationId: 'org-default',
        accountType: 'enterprise',
      });

      const provisioned = mutations.provisionOrganization({
        name: 'Acme',
        slug: 'acme',
        admin: {
          username: 'acme-admin',
          password: 'Correct-password-456',
          name: 'Acme Admin',
          phone: '+8613800000001',
        },
        now: 1_000,
      });
      expect(provisioned.organization).toMatchObject({
        name: 'Acme',
        slug: 'acme',
      });
      expect(provisioned.admin).toMatchObject({ isAdmin: true });
      expect(provisioned.invite).toMatchObject({ status: 'active' });

      const personal = mutations.createPersonalRegisteredAccount({
        phone: '+8613800000002',
        name: 'Personal User',
        password: 'Correct-password-789',
      });
      expect(personal).toMatchObject({
        accountType: 'personal',
        phone: '+8613800000002',
      });
      expect(audit).toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
