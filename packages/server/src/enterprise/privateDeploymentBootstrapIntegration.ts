/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  createPrivateDeploymentBootstrapCoordinator,
  type PrivateDeploymentBootstrapClaimConfig,
  type PrivateDeploymentBootstrapCoordinator,
  type PrivateDeploymentReadiness,
} from '../modules/deployment_lifecycle/index.js';
import * as db from './db.js';

interface OpenBootstrapSecretFile {
  fd: number;
  resolvedPath: string;
  stat: fs.Stats;
}

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function validateBootstrapSecretFile(stat: fs.Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 4_096
  ) {
    throw new Error('deployment bootstrap secret file is invalid');
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        'deployment bootstrap secret file permissions are too broad',
      );
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('deployment bootstrap secret file owner is invalid');
    }
  }
}

function openBootstrapSecretFile(
  configuredPath: string,
  accessFlag: number,
): OpenBootstrapSecretFile | null {
  if (!path.isAbsolute(configuredPath)) {
    throw new Error('deployment bootstrap secret file path must be absolute');
  }
  const resolvedPath = path.resolve(configuredPath);
  const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(resolvedPath, accessFlag | noFollow);
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    validateBootstrapSecretFile(stat);
    return { fd, resolvedPath, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readBootstrapSecret(environment: NodeJS.ProcessEnv): string | null {
  const configuredPath =
    environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE?.trim();
  if (configuredPath) {
    const opened = openBootstrapSecretFile(
      configuredPath,
      fs.constants.O_RDONLY,
    );
    if (!opened) return null;
    try {
      const value = fs.readFileSync(opened.fd, 'utf8').trim();
      return value || null;
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  return environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET?.trim() || null;
}

export function canConsumePrivateDeploymentBootstrapSecret(
  readiness: PrivateDeploymentReadiness,
): boolean {
  return (
    readiness.bootstrap.phase === 'activated' &&
    readiness.canUseLicensedFeatures &&
    readiness.steps.some(
      (step) => step.id === 'account_identity' && step.state === 'ready',
    )
  );
}

export function consumePrivateDeploymentBootstrapSecretFile(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const configuredPath =
    environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE?.trim();
  if (!configuredPath) return;
  const opened = openBootstrapSecretFile(configuredPath, fs.constants.O_WRONLY);
  if (!opened) {
    delete environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE;
    return;
  }
  try {
    fs.ftruncateSync(opened.fd, 0);
    fs.fsyncSync(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
  let current: fs.Stats;
  try {
    current = fs.lstatSync(opened.resolvedPath);
  } catch (error) {
    if (missingFile(error)) {
      delete environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE;
      return;
    }
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    current.dev !== opened.stat.dev ||
    current.ino !== opened.stat.ino
  ) {
    throw new Error('deployment bootstrap secret file changed during cleanup');
  }
  fs.unlinkSync(opened.resolvedPath);
  delete environment.OTTO_DEPLOYMENT_BOOTSTRAP_SECRET_FILE;
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
  environment?: NodeJS.ProcessEnv;
  applyProvisioningCommand?: (command: unknown) => void;
}): PrivateDeploymentBootstrapCoordinator {
  const environment = input.environment ?? process.env;
  const configuredFromEnvironment = input.config === undefined;
  const config = configuredFromEnvironment
    ? privateDeploymentBootstrapConfigFromEnvironment({
        ...input,
        environment,
      })
    : input.config ?? null;
  const coordinator = createPrivateDeploymentBootstrapCoordinator(
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
          identityReady:
            deployment.runtimeHealth.activeOrganizations > 0 &&
            deployment.runtimeHealth.activeAccounts > 0,
          provisioningIdentityReady: db.hasBootstrapEnterpriseIdentity(
            deployment.deploymentId,
            deployment.license.organizationId,
          ),
          runtimeConfiguration: db.getPrivateDeploymentRuntimeConfiguration(),
          bootstrap,
        };
      },
      importDeploymentLicense: db.importDeploymentLicense,
      refreshDeploymentLicenseLease: db.refreshDeploymentLicenseLease,
      saveRuntimeConfiguration: db.savePrivateDeploymentRuntimeConfiguration,
      applyProvisioningCommand(command) {
        if (!input.applyProvisioningCommand) {
          throw new Error('bootstrap_provisioning_not_configured');
        }
        input.applyProvisioningCommand(command);
      },
    },
    config,
    { fetch: input.fetch },
  );
  if (!configuredFromEnvironment) return coordinator;
  return {
    async prepare() {
      const result = await coordinator.prepare();
      if (canConsumePrivateDeploymentBootstrapSecret(result)) {
        consumePrivateDeploymentBootstrapSecretFile(environment);
      }
      return result;
    },
    readiness: () => coordinator.readiness(),
    snapshot: () => coordinator.snapshot(),
  };
}
