/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as identityOrganization from './modules/identity_organization/index.js';
import * as legacyDepartmentInvite from './enterprise/inviteCodeRepository.js';
import * as legacyFacade from './enterprise/organizationInviteFacade.js';
import * as legacyRepository from './enterprise/organizationInviteRepository.js';
import * as legacyPublicInvite from './enterprise/publicInvite.js';
import * as legacyOrganizationRoutes from './enterprise/organizationRoutes.js';
import * as legacyEmployeeRepository from './enterprise/employeeRepository.js';
import * as enterpriseDb from './enterprise/db.js';

const sourceRoot = path.resolve(import.meta.dirname);
const enterpriseDir = path.join(sourceRoot, 'enterprise');
const moduleDir = path.join(sourceRoot, 'modules', 'identity_organization');

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(target);
    if (
      !entry.isFile() ||
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts')
    ) {
      return [];
    }
    return [target];
  });
}

describe('identity_organization invitation kernel', () => {
  it('keeps invite codes strict and links bound to an explicitly trusted base URL', () => {
    expect(
      identityOrganization.isOrganizationInviteCode('Ab3D-k9Pq-Z7xY'),
    ).toBe(true);
    expect(
      identityOrganization.isOrganizationInviteCode('Ab3D-k9Pq-Z7xI'),
    ).toBe(false);
    expect(
      identityOrganization.normalizeOrganizationInviteCode(' Ab3D-k9Pq-Z7xY '),
    ).toBe('Ab3Dk9PqZ7xY');

    expect(
      identityOrganization.resolveEnterprisePublicBaseUrl({
        configuredUrl: 'https://join.otto.example/tenant/',
        host: 'evil.example',
        port: 80,
      }),
    ).toBe('https://join.otto.example/tenant');
    expect(
      identityOrganization.buildOrganizationInviteLink(
        'https://join.otto.example/tenant',
        'Ab3D-k9Pq-Z7xY',
      ),
    ).toBe('https://join.otto.example/tenant/enterprise/join/Ab3D-k9Pq-Z7xY');
    expect(() =>
      identityOrganization.resolveEnterprisePublicBaseUrl({
        configuredUrl: 'https://user:pass@join.otto.example',
      }),
    ).toThrow(/OTTO_ENTERPRISE_PUBLIC_URL/);
  });

  it('publishes repository and facade capabilities from one public entrypoint', () => {
    expect(identityOrganization.createOrganizationInviteFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createDepartmentInviteFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.issueOrganizationInvite).toBeTypeOf('function');
    expect(identityOrganization.inspectOrganizationInvite).toBeTypeOf(
      'function',
    );
    expect(
      identityOrganization.resolveOrganizationInviteWithDefaults,
    ).toBeTypeOf('function');
  });

  it('keeps legacy enterprise paths as aliases of the module implementation', () => {
    expect(legacyFacade.createOrganizationInviteFacade).toBe(
      identityOrganization.createOrganizationInviteFacade,
    );
    expect(legacyDepartmentInvite.createDepartmentInviteFacade).toBe(
      identityOrganization.createDepartmentInviteFacade,
    );
    expect(legacyRepository.issueOrganizationInvite).toBe(
      identityOrganization.issueOrganizationInvite,
    );
    expect(legacyPublicInvite.buildOrganizationInviteLink).toBe(
      identityOrganization.buildOrganizationInviteLink,
    );
    expect(legacyOrganizationRoutes.handleOrganizationRoute).toBe(
      identityOrganization.handleOrganizationRoute,
    );
    expect(legacyEmployeeRepository.createEmployee).toBe(
      enterpriseDb.createEmployee,
    );
    expect(identityOrganization.createMemberDirectoryFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createMemberSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(
      identityOrganization.IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,
    ).toMatchObject({ id: 'identity_organization_structure' });
    expect(
      identityOrganization.IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,
    ).toMatchObject({ id: 'identity_organization_root' });
    expect(identityOrganization.backfillLegacyOrganizationStructure).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createAssignmentIdentityFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createAccountDirectoryFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createAccountLifecycleFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createAccountRegistrationFacade).toBeTypeOf(
      'function',
    );
    expect(
      identityOrganization.createOrganizationProvisioningFacade,
    ).toBeTypeOf('function');
    expect(identityOrganization.createOrganizationDirectoryFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createOrganizationStructureFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createOrganizationFeatureFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.createSmsChallengeFacade).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.hashIdentitySecret).toBeTypeOf('function');
    expect(identityOrganization.identitySecretMatches).toBeTypeOf('function');
    expect(identityOrganization.assertAccountPassword).toBeTypeOf('function');
    expect(identityOrganization.createAuthSessionFacade).toBeTypeOf('function');
    expect(identityOrganization.createAccountAuthSchemaContributor).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.migrateLegacyAuthSessions).toBeTypeOf(
      'function',
    );
    expect(identityOrganization.AUTH_SESSION_DEFAULT_TTL_MS).toBe(
      30 * 24 * 60 * 60 * 1000,
    );

    for (const file of [
      'organizationInviteFacade.ts',
      'organizationInviteRepository.ts',
      'organizationInviteTypes.ts',
      'inviteCodeRepository.ts',
      'publicInvite.ts',
      'organizationRoutes.ts',
      'employeeRepository.ts',
    ]) {
      const source = fs.readFileSync(path.join(enterpriseDir, file), 'utf8');
      expect(source).toMatch(
        /^export (?:\*|type \*) from ['"]\.\.\/modules\/identity_organization\/index\.js['"];$/m,
      );
      expect(source).not.toMatch(/\b(?:function|interface|class)\s+\w+/);
    }
  });

  it('does not let the identity module depend on the enterprise database facade', () => {
    const offenders = productionTypeScriptFiles(moduleDir)
      .filter((file) =>
        /enterprise[\\/]db|\.\.\/\.\.\/enterprise/.test(
          fs.readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(moduleDir, file));
    expect(offenders).toEqual([]);
  });

  it('routes production imports through the identity_organization public entrypoint', () => {
    const legacyFiles = new Set([
      path.join(enterpriseDir, 'organizationInviteFacade.ts'),
      path.join(enterpriseDir, 'organizationInviteRepository.ts'),
      path.join(enterpriseDir, 'organizationInviteTypes.ts'),
      path.join(enterpriseDir, 'inviteCodeRepository.ts'),
      path.join(enterpriseDir, 'publicInvite.ts'),
      path.join(enterpriseDir, 'organizationRoutes.ts'),
      path.join(enterpriseDir, 'employeeRepository.ts'),
    ]);
    const offenders = productionTypeScriptFiles(sourceRoot)
      .filter((file) => !legacyFiles.has(file))
      .filter((file) => !file.startsWith(`${moduleDir}${path.sep}`))
      .filter((file) =>
        /from ['"][^'"]*(?:organizationInvite(?:Facade|Repository|Types)|inviteCodeRepository|publicInvite|organizationRoutes|employeeRepository)\.js['"]/.test(
          fs.readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });

  it('does not let the enterprise database facade import the legacy employee repository', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain(
      '../modules/identity_organization/index.js',
    );
    expect(databaseFacade).not.toMatch(
      /from ['"]\.\/(?:employeeRepository|inviteCodeRepository)\.js['"]/,
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS employees',
    );
    expect(databaseFacade).not.toContain('idx_employees_organization');
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS organization_departments',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS organization_positions',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS organizations',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS organization_features',
    );
    expect(databaseFacade).not.toContain('idx_organizations_status');
    expect(databaseFacade).not.toContain('idx_organizations_park');
    expect(databaseFacade).not.toContain(
      "ensureTextColumn('organizations', 'park_id')",
    );
    expect(databaseFacade).toMatch(
      /IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,[\s\S]*?MODEL_GATEWAY_SCHEMA_CONTRIBUTOR/,
    );
    expect(databaseFacade).not.toContain('idx_organization_departments_org');
    expect(databaseFacade).not.toContain('idx_organization_positions_org');
    expect(databaseFacade).toContain(
      'IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR',
    );
    expect(databaseFacade).toContain('backfillLegacyOrganizationStructure(d)');
    expect(databaseFacade).not.toContain(
      'function backfillOrganizationStructure',
    );
    expect(databaseFacade).not.toContain(
      'SELECT organization_id, department_id, department FROM accounts',
    );
    expect(databaseFacade).toContain('createMemberSchemaContributor');
    expect(databaseFacade).toMatch(
      /IDENTITY_ORGANIZATION_STRUCTURE_SCHEMA_CONTRIBUTOR,[\s\S]*?createMemberSchemaContributor\(\{[\s\S]*?createWorklogSchemaContributor\(\{/,
    );
  });

  it('keeps department invite creation and consumption behind the identity facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createDepartmentInviteFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:createInviteCode|validateInviteCode)\s*\(/,
    );
    expect(databaseFacade).not.toContain(
      'UPDATE invite_codes SET used_count = used_count + 1',
    );
  });

  it('keeps auth-session implementation behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createAuthSessionFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:createAuthSession|getAccountBySession|revokeAuthSession)/,
    );
    expect(databaseFacade).not.toContain('function tokenHash(');
  });

  it('keeps account and authentication schema ownership in the identity module', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    for (const table of [
      'accounts',
      'account_tags',
      'auth_sessions',
      'sms_login_challenges',
      'sms_registration_challenges',
    ]) {
      expect(databaseFacade).not.toContain(
        `CREATE TABLE IF NOT EXISTS ${table}`,
      );
    }
    for (const index of [
      'idx_accounts_status',
      'idx_account_tags_tag',
      'idx_sessions_token',
      'idx_sms_challenges_account_created',
      'idx_sms_registration_phone_created',
      'idx_accounts_phone_unique',
      'idx_accounts_organization',
      'idx_accounts_feishu_open_id',
    ]) {
      expect(databaseFacade).not.toContain(
        `CREATE INDEX IF NOT EXISTS ${index}`,
      );
      expect(databaseFacade).not.toContain(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${index}`,
      );
    }
    expect(databaseFacade).not.toContain('function migrateLegacyAuthSessions');
    expect(databaseFacade).not.toContain(
      "ensureTextColumn('sms_registration_challenges'",
    );
    expect(databaseFacade).not.toContain("ensureTextColumn('accounts'");
    expect(databaseFacade).not.toContain('ALTER TABLE accounts');
    expect(databaseFacade).not.toMatch(/['"]auth_sessions['"],/);
    expect(databaseFacade).toMatch(
      /IDENTITY_ORGANIZATION_SCHEMA_CONTRIBUTOR,[\s\S]*?createAccountAuthSchemaContributor\(\{[\s\S]*?createCreditsSchemaContributor\(\{/,
    );
    expect(databaseFacade).toContain(
      'migrateLegacyAuthSessions(database, DEFAULT_ORGANIZATION_ID)',
    );
  });

  it('keeps account directory reads behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createAccountDirectoryFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:getAccount|listAccounts|authenticateAccount|findAccountByPhone|findActiveAccountByPhone)/,
    );
    expect(databaseFacade).not.toContain('WHERE feishu_open_id = ? AND status');
  });

  it('keeps account lifecycle writes behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createAccountLifecycleFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:createAccount|updateAccount|deleteAccount)/,
    );
  });

  it('keeps account registration transactions behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createAccountRegistrationFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:createSelfRegisteredAccount|createPersonalRegisteredAccount|joinOrganizationWithInvite)/,
    );
  });

  it('keeps organization provisioning behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createOrganizationProvisioningFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:createOrganization|provisionOrganization)\s*\(/,
    );
  });

  it('keeps organization directory reads behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createOrganizationDirectoryFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:getOrganization|listOrganizations|getEnterpriseOrganization|listEnterpriseOrganizations)\s*\(/,
    );
    expect(databaseFacade).not.toContain('function toOrganizationView(');
  });

  it('keeps organization structure writes behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createOrganizationStructureFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:listOrganizationStructure|createOrganizationDepartment|updateOrganizationDepartment|deleteOrganizationDepartment|createOrganizationPosition|updateOrganizationPosition|deleteOrganizationPosition)\s*\(/,
    );
    expect(databaseFacade).not.toContain(
      'function toOrganizationPositionView(',
    );
  });

  it('keeps assignment identity resolution behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createAssignmentIdentityFacade');
    expect(databaseFacade).not.toMatch(
      /export function resolveAssignmentIdentity\s*\(/,
    );
    expect(databaseFacade).not.toContain(
      'SELECT id, name FROM organization_departments WHERE organization_id = ?',
    );
    expect(databaseFacade).not.toContain('该职位 ID 已绑定其他部门或职位名称');
  });

  it('keeps feature persistence and license access behind module facades', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createOrganizationFeatureFacade');
    expect(databaseFacade).toContain('createOrganizationFeatureAccessFacade');
    expect(databaseFacade).not.toMatch(
      /export function (?:getOrganizationFeatures|updateOrganizationFeatures)\s*\(/,
    );
    expect(databaseFacade).not.toContain('DEFAULT_ORGANIZATION_FEATURES');
    expect(databaseFacade).not.toContain(
      'SELECT feature_key, enabled FROM organization_features',
    );
  });

  it('keeps credential policy and SMS challenge state behind the identity module facade', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createSmsChallengeFacade');
    expect(databaseFacade).toContain('hashIdentitySecret');
    expect(databaseFacade).not.toMatch(
      /export function (?:createSmsLoginChallenge|discardSmsLoginChallenge|verifySmsLoginChallenge|createSmsRegistrationChallenge|discardSmsRegistrationChallenge|verifySmsRegistrationChallenge)\s*\(/,
    );
    expect(databaseFacade).not.toContain('scryptSync');
    expect(databaseFacade).not.toContain(
      'SELECT created_at_ms FROM sms_login_challenges',
    );
    expect(databaseFacade).not.toContain(
      'SELECT created_at_ms FROM sms_registration_challenges',
    );
    expect(databaseFacade).not.toContain(
      "['password', 'password1', '12345678', '123456789', 'qwerty123']",
    );
  });
});
