/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as identityOrganization from './modules/identity_organization/index.js';
import * as legacyFacade from './enterprise/organizationInviteFacade.js';
import * as legacyRepository from './enterprise/organizationInviteRepository.js';
import * as legacyPublicInvite from './enterprise/publicInvite.js';

const sourceRoot = path.resolve(import.meta.dirname);
const enterpriseDir = path.join(sourceRoot, 'enterprise');
const moduleDir = path.join(sourceRoot, 'modules', 'identity_organization');

function productionTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(target);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
      return [];
    }
    return [target];
  });
}

describe('identity_organization invitation kernel', () => {
  it('keeps invite codes strict and links bound to an explicitly trusted base URL', () => {
    expect(identityOrganization.isOrganizationInviteCode('Ab3D-k9Pq-Z7xY')).toBe(true);
    expect(identityOrganization.isOrganizationInviteCode('Ab3D-k9Pq-Z7xI')).toBe(false);
    expect(identityOrganization.normalizeOrganizationInviteCode(' Ab3D-k9Pq-Z7xY '))
      .toBe('Ab3Dk9PqZ7xY');

    expect(identityOrganization.resolveEnterprisePublicBaseUrl({
      configuredUrl: 'https://join.otto.example/tenant/',
      host: 'evil.example',
      port: 80,
    })).toBe('https://join.otto.example/tenant');
    expect(identityOrganization.buildOrganizationInviteLink(
      'https://join.otto.example/tenant',
      'Ab3D-k9Pq-Z7xY',
    )).toBe('https://join.otto.example/tenant/enterprise/join/Ab3D-k9Pq-Z7xY');
    expect(() => identityOrganization.resolveEnterprisePublicBaseUrl({
      configuredUrl: 'https://user:pass@join.otto.example',
    })).toThrow(/OTTO_ENTERPRISE_PUBLIC_URL/);
  });

  it('publishes repository and facade capabilities from one public entrypoint', () => {
    expect(identityOrganization.createOrganizationInviteFacade).toBeTypeOf('function');
    expect(identityOrganization.issueOrganizationInvite).toBeTypeOf('function');
    expect(identityOrganization.inspectOrganizationInvite).toBeTypeOf('function');
    expect(identityOrganization.resolveOrganizationInviteWithDefaults).toBeTypeOf('function');
  });

  it('keeps legacy enterprise paths as aliases of the module implementation', () => {
    expect(legacyFacade.createOrganizationInviteFacade)
      .toBe(identityOrganization.createOrganizationInviteFacade);
    expect(legacyRepository.issueOrganizationInvite)
      .toBe(identityOrganization.issueOrganizationInvite);
    expect(legacyPublicInvite.buildOrganizationInviteLink)
      .toBe(identityOrganization.buildOrganizationInviteLink);

    for (const file of [
      'organizationInviteFacade.ts',
      'organizationInviteRepository.ts',
      'organizationInviteTypes.ts',
      'publicInvite.ts',
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
      .filter((file) => /enterprise[\\/]db|\.\.\/\.\.\/enterprise/.test(
        fs.readFileSync(file, 'utf8'),
      ))
      .map((file) => path.relative(moduleDir, file));
    expect(offenders).toEqual([]);
  });

  it('routes production imports through the identity_organization public entrypoint', () => {
    const legacyFiles = new Set([
      path.join(enterpriseDir, 'organizationInviteFacade.ts'),
      path.join(enterpriseDir, 'organizationInviteRepository.ts'),
      path.join(enterpriseDir, 'organizationInviteTypes.ts'),
      path.join(enterpriseDir, 'publicInvite.ts'),
    ]);
    const offenders = productionTypeScriptFiles(sourceRoot)
      .filter((file) => !legacyFiles.has(file))
      .filter((file) => !file.startsWith(`${moduleDir}${path.sep}`))
      .filter((file) => /from ['"][^'"]*(?:organizationInvite(?:Facade|Repository|Types)|publicInvite)\.js['"]/.test(
        fs.readFileSync(file, 'utf8'),
      ))
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });
});
