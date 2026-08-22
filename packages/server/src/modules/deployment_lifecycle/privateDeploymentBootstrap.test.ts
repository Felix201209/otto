/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DeploymentLicenseView,
  PrivateDeploymentRuntimeConfiguration,
  PrivateDeploymentStatus,
} from '../commercial_control/index.js';
import {
  buildPrivateDeploymentReadiness,
  createPrivateDeploymentBootstrapCoordinator,
  type PrivateDeploymentBootstrapServices,
} from './privateDeploymentBootstrap.js';

function deploymentLicense(
  status: DeploymentLicenseView['status'],
): DeploymentLicenseView {
  return {
    id: status === 'missing' ? 'unlicensed' : 'lic_test',
    revision: 1,
    deploymentId: 'dep_test',
    organizationId: status === 'missing' ? null : 'org_acme',
    machineFingerprint: 'a'.repeat(64),
    customerName: 'Acme',
    plan: 'enterprise',
    expiresAt: '2027-01-01T00:00:00.000Z',
    seatLimit: 100,
    gracePeriodMs: 0,
    seatEnforcement: 'enforce',
    billingEnforcement: 'disabled',
    activeSeatCount: 0,
    seatLimitExceeded: false,
    modules: ['enterprise', 'knowledge'],
    offline: false,
    telemetryAllowed: false,
    signatureAlgorithm: 'ed25519',
    signingKeyId: 'key_test',
    lease: {
      required: false,
      status: 'not_required',
      endpoint: null,
      expiresAt: null,
      lastRefreshAt: null,
      lastError: null,
      activeSeatCount: null,
      seatStatus: null,
      graceReasons: [],
      graceExpiresAt: null,
    },
    status,
    enforce: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function deployment(
  status: DeploymentLicenseView['status'],
): PrivateDeploymentStatus {
  return {
    deploymentId: 'dep_test',
    machineFingerprint: 'a'.repeat(64),
    license: deploymentLicense(status),
    telemetry: {
      enabled: false,
      contentMode: 'operational_only',
      endpoint: null,
      queued: 0,
      failed: 0,
      sent: 0,
      lastQueuedAt: null,
    },
    billing: {
      queued: 0,
      failed: 0,
      sent: 0,
      discarded: 0,
      lastQueuedAt: null,
      lastError: null,
      admission: {
        authorized: 0,
        pending: 0,
        failed: 0,
        finalized: 0,
        discarded: 0,
        lastError: null,
      },
      executionReceipt: {
        protocol: 'execution_receipt_v2',
        key: null,
        registrationRequired: false,
        error: null,
      },
      evidenceTrust: 'signed_execution_receipt_v2',
    },
    dataBoundary: {
      uploadsContentByDefault: false,
      includesUserMessages: false,
      includesFiles: false,
      includesMeetingAudio: false,
      defaultPayload: [],
    },
    moduleCatalog: [],
    runtimeHealth: {
      uptimeSec: 1,
      nodeVersion: process.version,
      memoryRssMb: 1,
      memoryHeapUsedMb: 1,
      cpuUserMs: 1,
      cpuSystemMs: 1,
      activeOrganizations: 1,
      activeAccounts: 1,
      auditErrorCount: 0,
      auditCrashCount: 0,
      agentCallCount: 0,
      tokenTotal: 0,
      successRate: null,
      avgLatencyMs: null,
    },
  };
}

function fixture() {
  let currentDeployment = deployment('missing');
  let runtimeConfiguration: PrivateDeploymentRuntimeConfiguration | null = null;
  let identityReady = false;
  let provisioningIdentityReady = false;
  const applyProvisioningCommand = vi.fn(() => {
    identityReady = true;
    provisioningIdentityReady = true;
  });
  const services: PrivateDeploymentBootstrapServices = {
    getReadinessSource: (bootstrap) => ({
      deployment: currentDeployment,
      databaseReady: true,
      storageReady: true,
      federation: { enabled: false, configured: false },
      activeOrganizations: currentDeployment.runtimeHealth.activeOrganizations,
      activeAccounts: currentDeployment.runtimeHealth.activeAccounts,
      identityReady,
      provisioningIdentityReady,
      runtimeConfiguration,
      bootstrap,
    }),
    importDeploymentLicense: () => {
      currentDeployment = deployment('active');
      return currentDeployment.license;
    },
    refreshDeploymentLicenseLease: async () => ({
      refreshed: false,
      skippedReason: 'not_required',
      error: null,
    }),
    saveRuntimeConfiguration: (value) => {
      runtimeConfiguration = value;
    },
    applyProvisioningCommand,
  };
  return {
    services,
    applyProvisioningCommand,
    setExistingIdentityReady() {
      identityReady = true;
    },
    setApplyImplementation(value: () => void) {
      applyProvisioningCommand.mockImplementation(() => {
        value();
        identityReady = true;
        provisioningIdentityReady = true;
      });
    },
  };
}

function response(provisioningCommand: unknown = { commandId: 'cmd_test' }) {
  return new Response(
    JSON.stringify({
      status: 'activated',
      licenseEnvelope: { license: {}, signature: 'ed25519:test' },
      capabilities: {
        billing: false,
        telemetry: false,
        federation: false,
        updates: false,
        modelGateway: false,
        storage: true,
      },
      provisioningCommand,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

const config = {
  controlUrl: 'http://127.0.0.1:9000',
  bootstrapSecret: 'x'.repeat(48),
  appVersion: '1.10.2',
  buildCommit: 'a'.repeat(40),
  deploymentKind: 'self-hosted',
  allowInsecureLoopback: true,
};

describe('private deployment provisioning bootstrap', () => {
  it('blocks licensed features until enterprise identity exists', () => {
    const state = fixture();
    state.services.importDeploymentLicense({});
    const readiness = buildPrivateDeploymentReadiness(
      state.services.getReadinessSource({
        phase: 'activated',
        lastAttemptAt: null,
        lastSuccessAt: null,
        errorCode: null,
      }),
    );

    expect(readiness.canAuthenticate).toBe(true);
    expect(readiness.canUseLicensedFeatures).toBe(false);
    expect(readiness.state).toBe('ready_for_identity');
  });

  it('applies the signed provisioning command before reporting ready', async () => {
    const state = fixture();
    const fetch = vi.fn(async () => response());
    const coordinator = createPrivateDeploymentBootstrapCoordinator(
      state.services,
      config,
      {
        fetch,
      },
    );

    const readiness = await coordinator.prepare();
    expect(state.applyProvisioningCommand).toHaveBeenCalledWith({
      commandId: 'cmd_test',
    });
    expect(readiness.state).toBe('ready');
    expect(readiness.bootstrap.phase).toBe('activated');
    await coordinator.prepare();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the secret retry path alive when provisioning fails', async () => {
    const state = fixture();
    let attempts = 0;
    state.setApplyImplementation(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('bootstrap_provisioning_failed');
    });
    let now = 1_000_000;
    const fetch = vi.fn(async () => response());
    const coordinator = createPrivateDeploymentBootstrapCoordinator(
      state.services,
      config,
      {
        fetch,
        now: () => now,
        retryAfterMs: 5_000,
      },
    );

    const failed = await coordinator.prepare();
    expect(failed.bootstrap).toMatchObject({
      phase: 'failed',
      errorCode: 'bootstrap_provisioning_failed',
    });
    now += 6_000;
    const recovered = await coordinator.prepare();
    expect(recovered.bootstrap.phase).toBe('activated');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('requires a provisioning command even when a migrated identity exists', async () => {
    const state = fixture();
    state.setExistingIdentityReady();
    const coordinator = createPrivateDeploymentBootstrapCoordinator(
      state.services,
      config,
      {
        fetch: async () => response(null),
      },
    );

    const readiness = await coordinator.prepare();
    expect(readiness.bootstrap).toMatchObject({
      phase: 'failed',
      errorCode: 'bootstrap_provisioning_command_missing',
    });
    expect(state.applyProvisioningCommand).not.toHaveBeenCalled();
  });

  it('does not treat a migrated identity as proof that a new command ran', async () => {
    const state = fixture();
    state.setExistingIdentityReady();
    state.applyProvisioningCommand.mockImplementation(() => undefined);
    const coordinator = createPrivateDeploymentBootstrapCoordinator(
      state.services,
      config,
      {
        fetch: async () => response(),
      },
    );

    const readiness = await coordinator.prepare();
    expect(readiness.bootstrap).toMatchObject({
      phase: 'failed',
      errorCode: 'bootstrap_provisioning_incomplete',
    });
  });

});
