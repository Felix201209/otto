/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as authorization from './modules/authorization/index.js';
import * as legacyToolPolicy from './authorizationPolicy.js';
import * as legacyEnterpriseGuards from './enterprise/enterpriseRouteGuards.js';

const sourceRoot = path.resolve(import.meta.dirname);

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

describe('authorization module boundary', () => {
  it('publishes one fail-closed authorization composition entrypoint', () => {
    expect(authorization.createAuthorizationComposition).toBeTypeOf(
      'function',
    );
    const databaseFacade = fs.readFileSync(
      path.join(sourceRoot, 'enterprise', 'db.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain('createAuthorizationComposition');
    expect(databaseFacade).not.toContain(
      'createOrganizationFeatureAccessFacade',
    );
    expect(databaseFacade).not.toContain('createOrganizationFeatureFacade');
  });

  it('keeps mandatory tool confirmations fail-closed in automatic mode', () => {
    expect(authorization.shouldRequestConfirmation('auto', { type: 'edit' })).toBe(false);
    expect(authorization.shouldRequestConfirmation('auto', {
      type: 'exec',
      riskLevel: 'high',
    })).toBe(true);
    expect(authorization.shouldRequestConfirmation('auto', {
      type: 'exec',
      warning: 'dangerous command',
    })).toBe(true);
    expect(authorization.shouldRequestConfirmation('auto', { type: 'delete' })).toBe(true);
    expect(authorization.shouldRequestConfirmation('auto', { type: 'question' })).toBe(true);
    expect(authorization.shouldRequestConfirmation('auto', { type: 'workflow' })).toBe(true);
  });

  it('only treats the explicit simple-park exceptions as public', () => {
    expect(authorization.isPublicSimpleParkRoute(
      '/enterprise/park/join',
      'POST',
      new URL('http://localhost/enterprise/park/join'),
    )).toBe(true);
    expect(authorization.isPublicSimpleParkRoute(
      '/enterprise/park/services',
      'GET',
      new URL('http://localhost/enterprise/park/services?parkId=park-1'),
    )).toBe(true);
    expect(authorization.isPublicSimpleParkRoute(
      '/enterprise/park/services/request',
      'POST',
      new URL('http://localhost/enterprise/park/services/request'),
    )).toBe(false);
    expect(authorization.isMemberRoute('/enterprise/park/services/request')).toBe(true);

    expect(authorization.isPublicSimpleParkRoute(
      '/enterprise/park/join',
      'GET',
      new URL('http://localhost/enterprise/park/join'),
    )).toBe(false);
    expect(authorization.isPublicSimpleParkRoute(
      '/enterprise/park/services',
      'GET',
      new URL('http://localhost/enterprise/park/services'),
    )).toBe(false);
    expect(authorization.isPublicSimpleParkRoute(
      '/enterprise/park',
      'POST',
      new URL('http://localhost/enterprise/park'),
    )).toBe(false);
  });

  it('preserves enterprise route and license-maintenance classifications', () => {
    expect(authorization.isAdminRoute('/enterprise/accounts')).toBe(true);
    expect(authorization.isAdminRoute('/enterprise/accounts/member-1')).toBe(true);
    expect(authorization.isMemberRoute('/enterprise/messages/member-1')).toBe(true);
    expect(authorization.isMemberRoute('/enterprise/account-sync')).toBe(true);
    expect(authorization.isLicenseMaintenanceRoute('/enterprise/account-sync')).toBe(true);
    expect(authorization.isAdminRoute('/enterprise/deployment/data-protection')).toBe(true);
    expect(
      authorization.isLicenseMaintenanceRoute(
        '/enterprise/deployment/data-protection/backup',
      ),
    ).toBe(true);
    expect(authorization.isLicenseMaintenanceRoute('/enterprise/auth/login')).toBe(true);
    expect(authorization.isLicenseMaintenanceRoute('/enterprise/messages/member-1')).toBe(false);
    expect(authorization.isAdminRoute('/enterprise/federation/admin/status')).toBe(true);
    expect(authorization.isMemberRoute('/enterprise/federation/messages')).toBe(true);
    expect(authorization.isMemberRoute('/enterprise/federation/admin/status')).toBe(false);
  });

  it('keeps legacy paths as aliases of the module implementation', () => {
    expect(legacyToolPolicy.shouldRequestConfirmation)
      .toBe(authorization.shouldRequestConfirmation);
    expect(legacyEnterpriseGuards.isAdminRoute).toBe(authorization.isAdminRoute);

    const toolPolicySource = fs.readFileSync(
      path.join(sourceRoot, 'authorizationPolicy.ts'),
      'utf8',
    );
    const routeGuardsSource = fs.readFileSync(
      path.join(sourceRoot, 'enterprise', 'enterpriseRouteGuards.ts'),
      'utf8',
    );
    expect(toolPolicySource).toMatch(/^export \* from ['"]\.\/modules\/authorization\/index\.js['"];$/m);
    expect(routeGuardsSource).toMatch(/^export \* from ['"]\.\.\/modules\/authorization\/index\.js['"];$/m);
  });

  it('routes production imports through the authorization public entrypoint', () => {
    const legacyFiles = new Set([
      path.join(sourceRoot, 'authorizationPolicy.ts'),
      path.join(sourceRoot, 'enterprise', 'enterpriseRouteGuards.ts'),
    ]);
    const offenders = productionTypeScriptFiles(sourceRoot)
      .filter((file) => !legacyFiles.has(file))
      .filter((file) => /from ['"][^'"]*(?:authorizationPolicy|enterpriseRouteGuards)\.js['"]/.test(
        fs.readFileSync(file, 'utf8'),
      ))
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders).toEqual([]);
  });
});
