/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createPrivateDeploymentBootstrapCoordinator,
  type PrivateDeploymentBootstrapClaimConfig,
  type PrivateDeploymentBootstrapCoordinator,
} from '../modules/deployment_lifecycle/index.js';
import * as db from './db.js';

function readBootstrapSecret(environment: NodeJS.ProcessEnv): string | null {
  const configuredPath = environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE?.trim();
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 4_096) {
      throw new Error('deployment bootstrap secret file is invalid');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('deployment bootstrap secret file permissions are too broad');
    }
    const value = fs.readFileSync(resolved, 'utf8').trim();
    return value || null;
  }
  return environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET?.trim() || null;
}

export function privateDeploymentBootstrapConfigFromEnvironment(
  input: {
    appVersion: string;
    buildCommit: string;
    publicOrigin: string;
    environment?: NodeJS.ProcessEnv;
  },
): PrivateDeploymentBootstrapClaimConfig | null {
  const environment = input.environment ?? process.env;
  const controlUrl = (
    environment.OTTO_CONTROL_URL || environment.OTTO_CONTROL_ORIGIN || ''
  ).trim();
  const bootstrapSecret = readBootstrapSecret(environment);
  if (!controlUrl || !bootstrapSecret) return null;
  return {
    controlUrl,
    bootstrapSecret,
    appVersion: input.appVersion,
    buildCommit: input.buildCommit,
    publicOrigin: input.publicOrigin,
    deploymentKind:
      environment.OTTO_DEPLOYMENT_KIND?.trim() || 'self-hosted',
    allowInsecureLoopback:
      environment.NODE_ENV === 'test' &&
      environment.OTTO_CONTROL_ALLOW_INSECURE_LOOPBACK === 'true',
  };
}

export function createEnterprisePrivateDeploymentBootstrap(input: {
  appVersion: string;
  buildCommit: string;
  publicOrigin: string;
  config?: PrivateDeploymentBootstrapClaimConfig | null;
  fetch?: typeof fetch;
}): PrivateDeploymentBootstrapCoordinator {
  const config = input.config === undefined
    ? privateDeploymentBootstrapConfigFromEnvironment(input)
    : input.config;
  return createPrivateDeploymentBootstrapCoordinator(
    {
      getReadinessSource(bootstrap) {
        const deployment = db.getPrivateDeploymentStatus();
        let databaseReady = false;
        let storageReady = false;
        try {
          db.getDatabaseReadiness();
          databaseReady = true;
          const topology = db.getEnterpriseServiceTopology();
          const protection = db.getDataProtectionStatus();
          storageReady = (
            topology.attachments.backend === 's3' ||
            topology.attachments.backend === 'encrypted-filesystem'
          ) && !protection.capacityWarning && !protection.lastError;
        } catch {
          databaseReady = false;
          storageReady = false;
        }
        const federation = db.getFederationStatus();
        return {
          deployment,
          databaseReady,
          storageReady,
          federation: {
            enabled: federation.enabled,
            configured: federation.configured,
            lastError: federation.lastError,
          },
          activeOrganizations: deployment.runtimeHealth.activeOrganizations,
          activeAccounts: deployment.runtimeHealth.activeAccounts,
          runtimeConfiguration: db.getPrivateDeploymentRuntimeConfiguration(),
          bootstrap,
        };
      },
      importDeploymentLicense: db.importDeploymentLicense,
      refreshDeploymentLicenseLease: db.refreshDeploymentLicenseLease,
      saveRuntimeConfiguration: db.savePrivateDeploymentRuntimeConfiguration,
    },
    config,
    { fetch: input.fetch },
  );
}
