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
import {
  hashIdentitySecret,
  identitySecretMatches,
} from './credentialSecurity.js';
import { createMemberSchemaContributor } from './memberSchema.js';
import { IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR } from './organizationSchema.js';

interface TestAccountView {
  id: string;
  organizationId: string;
  employeeId: string | null;
  username: string;
  phone: string | null;
  status: 'active' | 'disabled';
}

interface TestAccountRow {
  id: string;
  organization_id: string;
  employee_id: string | null;
  username: string;
  phone: string | null;
  password_hash: string;
  status: 'active' | 'disabled';
  deleted_at: string | null;
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  applyDatabaseSchemaContributors(database, [
    IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
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
  database
    .prepare(
      `INSERT INTO accounts
       (id, organization_id, username, phone, password_hash, name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'account-1',
      'org-default',
      'alice',
      '+8613800000000',
      hashIdentitySecret('correct-password'),
      'Alice',
    );
  return database;
}

describe('identity organization account access composition', () => {
  it('wires directory, sessions and SMS challenges through one boundary', () => {
    const database = createDatabase();
    const audit = vi.fn();
    const access = createAccountAccessComposition<
      TestAccountView,
      TestAccountRow
    >({
      db: () => database,
      defaultOrganizationId: 'org-default',
      now: () => 1_000,
      normalizeIdentifier: (identifier) => identifier.trim().toLowerCase(),
      normalizePhone: (phone) => phone.trim(),
      passwordMatches: identitySecretMatches,
      isOrganizationActive: (organizationId) =>
        organizationId === 'org-default',
      organizationExists: (organizationId) => organizationId === 'org-default',
      toAccountView: (row) => ({
        id: row.id,
        organizationId: row.organization_id,
        employeeId: row.employee_id,
        username: row.username,
        phone: row.phone,
        status: row.status,
      }),
      hashSecret: hashIdentitySecret,
      secretMatches: identitySecretMatches,
      createChallengeId: (kind) => `${kind}-challenge`,
      audit,
    });

    try {
      expect(
        access.authenticateAccount(' ALICE ', 'correct-password'),
      ).toMatchObject({ id: 'account-1', organizationId: 'org-default' });

      const session = access.createAuthSession('account-1');
      expect(access.getAccountBySession(session.token)).toMatchObject({
        id: 'account-1',
      });

      const challenge = access.createSmsLoginChallenge('account-1', '123456', {
        now: 1_000,
      });
      expect(challenge).toMatchObject({ ok: true });
      if (!challenge.ok) throw new Error('SMS challenge was not created');
      expect(
        access.verifySmsLoginChallenge(challenge.challengeId, '123456', 1_001),
      ).toMatchObject({ ok: true, account: { id: 'account-1' } });
      expect(audit).toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});
