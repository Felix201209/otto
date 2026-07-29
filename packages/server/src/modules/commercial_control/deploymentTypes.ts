/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type {
  OrganizationFeatureKey,
  ProductModuleId,
} from '../../productModules.js';

export type DeploymentLicenseStatus =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'revoked'
  | 'missing'
  | 'invalid'
  | 'lease_missing'
  | 'lease_expired';

export interface DeploymentLicenseLeaseView {
  required: boolean;
  status: 'not_required' | 'active' | 'missing' | 'expired' | 'revoked';
  endpoint: string | null;
  expiresAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export interface DeploymentLicenseView {
  id: string;
  deploymentId: string;
  organizationId: string | null;
  machineFingerprint: string | null;
  customerName: string;
  plan: string;
  expiresAt: string;
  seatLimit: number;
  activeSeatCount: number;
  seatLimitExceeded: boolean;
  modules: string[];
  offline: boolean;
  telemetryAllowed: boolean;
  signatureAlgorithm: 'ed25519' | 'none';
  signingKeyId: string | null;
  lease: DeploymentLicenseLeaseView;
  status: DeploymentLicenseStatus;
  enforce: boolean;
  updatedAt: string;
}

export interface DeploymentTelemetrySettings {
  enabled: boolean;
  contentMode: 'operational_only' | 'diagnostic_redacted';
  endpoint: string | null;
}

export interface PrivateDeploymentStatus {
  deploymentId: string;
  machineFingerprint: string;
  license: DeploymentLicenseView;
  telemetry: DeploymentTelemetrySettings & {
    queued: number;
    failed: number;
    sent: number;
    lastQueuedAt: string | null;
  };
  dataBoundary: {
    uploadsContentByDefault: false;
    includesUserMessages: false;
    includesFiles: false;
    includesMeetingAudio: false;
    defaultPayload: string[];
  };
  moduleCatalog: Array<{
    module: string;
    productModuleId: ProductModuleId;
    features: OrganizationFeatureKey[];
  }>;
  runtimeHealth: {
    uptimeSec: number;
    nodeVersion: string;
    memoryRssMb: number;
    memoryHeapUsedMb: number;
    cpuUserMs: number;
    cpuSystemMs: number;
    activeOrganizations: number;
    activeAccounts: number;
    auditErrorCount: number;
    auditCrashCount: number;
    agentCallCount: number;
    tokenTotal: number;
    successRate: number | null;
    avgLatencyMs: number | null;
  };
}
