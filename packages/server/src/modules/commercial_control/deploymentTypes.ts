/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type {
  OrganizationFeatureKey,
  ProductModuleId,
} from '../../productModules.js';
import type { BillingExecutionReceiptKeyView } from './billingUsageRepository.js';

export type DeploymentLicenseStatus =
  | 'active'
  | 'expiring'
  | 'grace'
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
  activeSeatCount: number | null;
  seatStatus:
    | 'unreported'
    | 'within_limit'
    | 'over_limit_monitor'
    | 'overage_grace'
    | 'blocked'
    | null;
  graceReasons: Array<'expiration' | 'seat_overage'>;
  graceExpiresAt: string | null;
}

export interface DeploymentLicenseView {
  id: string;
  revision: number;
  deploymentId: string;
  organizationId: string | null;
  machineFingerprint: string | null;
  customerName: string;
  plan: string;
  expiresAt: string;
  seatLimit: number;
  gracePeriodMs: number;
  seatEnforcement: 'monitor' | 'enforce';
  billingEnforcement: 'disabled' | 'enforce';
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
  billing: {
    queued: number;
    failed: number;
    sent: number;
    discarded: number;
    lastQueuedAt: string | null;
    lastError: string | null;
    admission: {
      authorized: number;
      pending: number;
      failed: number;
      finalized: number;
      discarded: number;
      lastError: string | null;
    };
    executionReceipt: {
      protocol: 'execution_receipt_v2';
      key: BillingExecutionReceiptKeyView | null;
      registrationRequired: boolean;
      error: string | null;
    };
    evidenceTrust: 'signed_execution_receipt_v2';
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

export interface PrivateDeploymentRuntimeConfiguration {
  controlOrigin: string;
  capabilities: {
    billing: boolean;
    telemetry: boolean;
    federation: boolean;
    updates: boolean;
    modelGateway: boolean;
    storage: boolean;
  };
  federationGatewayUrl: string | null;
  modelGatewayUrl: string | null;
  telemetryEndpoint: string | null;
  updateDistributionId: string | null;
  activatedAt: string;
}
