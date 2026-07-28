/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as commercialControl from './modules/commercial_control/index.js';
import * as legacyAuditRepository from './enterprise/auditRepository.js';
import * as legacyCredits from './enterprise/credits.js';
import * as legacyCreditsSchema from './enterprise/creditsSchema.js';
import * as legacyDeploymentRepository from './enterprise/deploymentRepository.js';
import * as legacyModuleUpdateManifest from './enterprise/moduleUpdateManifest.js';

const enterpriseDir = path.resolve(import.meta.dirname, 'enterprise');
const commercialControlDir = path.resolve(
  import.meta.dirname,
  'modules',
  'commercial_control',
);
const commercialControlImport = '../modules/commercial_control/index.js';

describe('commercial_control module boundary', () => {
  it('publishes deployment and module-update capabilities from one public entrypoint', () => {
    expect(commercialControl.getDeploymentId).toBeTypeOf('function');
    expect(commercialControl.createAuditLogFacade).toBeTypeOf('function');
    expect(commercialControl.createCreditsFacade).toBeTypeOf('function');
    expect(commercialControl.getModuleUpdateManifestFromStore).toBeTypeOf(
      'function',
    );
    expect(commercialControl.handleDeploymentRoute).toBeTypeOf('function');
    expect(commercialControl.handleModuleUpdateRoute).toBeTypeOf('function');
    expect(commercialControl.PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR.id).toBe(
      'commercial_control_private_deployment',
    );
  });

  it('keeps legacy enterprise imports as thin aliases of the module implementation', () => {
    expect(legacyDeploymentRepository.getDeploymentId).toBe(
      commercialControl.getDeploymentId,
    );
    expect(legacyAuditRepository.createAuditLogFacade).toBe(
      commercialControl.createAuditLogFacade,
    );
    expect(legacyCredits.CreditsRequestError).toBe(
      commercialControl.CreditsRequestError,
    );
    expect(legacyCreditsSchema.buildCreditsTablesSql).toBe(
      commercialControl.buildCreditsTablesSql,
    );
    expect(legacyModuleUpdateManifest.licenseModuleCatalog).toBe(
      commercialControl.licenseModuleCatalog,
    );
  });

  it('does not keep commercial-control implementations in the enterprise directory', () => {
    for (const file of [
      'deploymentRepository.ts',
      'deploymentTypes.ts',
      'auditRepository.ts',
      'credits.ts',
      'creditsSchema.ts',
      'moduleUpdateManifest.ts',
      'moduleUpdateRepository.ts',
      'deploymentRoutes.ts',
      'moduleUpdateRoutes.ts',
    ]) {
      const source = fs.readFileSync(path.join(enterpriseDir, file), 'utf8');
      expect(source).toMatch(/^export (?:\*|type \*) from /m);
      expect(source).not.toMatch(/\b(?:function|interface|class)\s+\w+/);
    }
  });

  it('routes new enterprise dependencies through the module public entrypoint', () => {
    const databaseFacade = fs.readFileSync(
      path.join(enterpriseDir, 'db.ts'),
      'utf8',
    );
    const routeDispatcher = fs.readFileSync(
      path.join(enterpriseDir, 'enterpriseRouteDispatcher.ts'),
      'utf8',
    );
    const creditsRoutes = fs.readFileSync(
      path.join(enterpriseDir, 'creditsRoutes.ts'),
      'utf8',
    );
    expect(databaseFacade).toContain(commercialControlImport);
    expect(routeDispatcher).toContain(commercialControlImport);
    expect(databaseFacade).not.toMatch(
      /from ['"]\.\/(?:audit|credits|deployment|moduleUpdate)(?:Repository|Routes|Types|Manifest|Schema)?\.js['"];/,
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS deployment_settings',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS deployment_license',
    );
    expect(databaseFacade).not.toContain(
      'CREATE TABLE IF NOT EXISTS telemetry_events',
    );
    expect(databaseFacade).not.toContain('idx_telemetry_events_status_created');
    expect(databaseFacade).toContain('PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR');
    expect(creditsRoutes).toContain(commercialControlImport);
    expect(creditsRoutes).not.toMatch(/from ['"]\.\/credits\.js['"]/);
  });

  it('keeps the audit kernel independent from the enterprise composition root', () => {
    for (const file of fs.readdirSync(commercialControlDir)) {
      if (!file.endsWith('.ts')) continue;
      const source = fs.readFileSync(
        path.join(commercialControlDir, file),
        'utf8',
      );
      expect(source).not.toMatch(/enterprise\/db(?:\.js)?/);
    }
  });
});
