/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../data_platform/index.js';
import { createAuditLogSchemaContributor } from './auditLogSchema.js';
import { createCommercialControlComposition } from './commercialControlComposition.js';
import { PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR } from './privateDeploymentSchema.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-default');
  `);
  createAuditLogSchemaContributor({
    defaultOrganizationId: 'org-default',
  }).apply(database);
  PRIVATE_DEPLOYMENT_SCHEMA_CONTRIBUTOR.apply(database);
  return database;
}

describe('commercial control composition', () => {
  it('shares one deployment settings store across audit, telemetry, and updates', () => {
    const database = createDatabase();
    const commercialControl = createCommercialControlComposition({
      db: () => database,
      defaultOrganizationId: 'org-default',
      creditTokenRate: () => undefined,
      licenseEnforcementEnabled: () => false,
      licenseSigningSecret: () => '',
      telemetryEndpoint: () => 'https://telemetry.example.test',
      databaseReadiness: () => ({ ready: true, schemaVersion: 1 }),
    });

    try {
      commercialControl.logAudit('composition_test', null, 'ready');
      expect(commercialControl.getAuditLogs()).toEqual([
        expect.objectContaining({
          organization_id: 'org-default',
          event: 'composition_test',
          detail: 'ready',
        }),
      ]);

      const deploymentId = commercialControl.getDeploymentId();
      expect(deploymentId).toMatch(/^dep_/);
      expect(commercialControl.getDeploymentId()).toBe(deploymentId);
      expect(commercialControl.getTelemetrySettings()).toEqual({
        enabled: true,
        contentMode: 'operational_only',
        endpoint: 'https://telemetry.example.test',
      });
      expect(
        commercialControl.updateTelemetrySettings({ enabled: false }),
      ).toMatchObject({ enabled: false });

      const moduleId =
        commercialControl.getModuleUpdateManifest().catalog[0]?.module;
      expect(moduleId).toBeTruthy();
      commercialControl.updateModuleUpdateDescriptor({
        module: moduleId!,
        version: '2.0.0',
        rollout: 'stable',
      });
      expect(commercialControl.getModuleUpdateManifest()).toMatchObject({
        deploymentId,
        modules: [
          expect.objectContaining({
            module: moduleId,
            version: '2.0.0',
            rollout: 'stable',
          }),
        ],
      });
      expect(commercialControl.getTelemetryQueueSummary()).toEqual({
        queued: 0,
        failed: 0,
        sent: 0,
        lastQueuedAt: null,
      });
      expect(commercialControl.getCreditBalance).toBeTypeOf('function');
    } finally {
      database.close();
    }
  });
});
