/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';
import type { Database, EncryptedFieldCipher } from '../data_platform/index.js';
import { createAuditLogFacade } from './auditLogFacade.js';
import { createCreditsFacade } from './creditsFacade.js';
import {
  exportDeploymentDiagnostics as exportDeploymentDiagnosticsFromRepository,
  ensureDeploymentLicenseSecretsEncrypted as ensureDeploymentLicenseSecretsEncryptedInRepository,
  flushTelemetryQueue as flushTelemetryQueueInRepository,
  createDeploymentBillingUsageStore,
  getDeploymentId as getDeploymentIdFromRepository,
  getDeploymentLicense as getDeploymentLicenseFromRepository,
  getDeploymentUpdatePolicyCredentials,
  getMachineFingerprint as getMachineFingerprintFromRepository,
  getPrivateDeploymentStatus as getPrivateDeploymentStatusFromRepository,
  getTelemetryQueueSummary as getTelemetryQueueSummaryFromRepository,
  getTelemetrySettings as getTelemetrySettingsFromRepository,
  importDeploymentLicense as importDeploymentLicenseIntoRepository,
  importDeploymentLicenseLease as importDeploymentLicenseLeaseIntoRepository,
  ingestTelemetryBatch as ingestTelemetryBatchIntoRepository,
  isLicenseRestricted as isLicenseRestrictedInRepository,
  isLicenseUsableForOrganizationFeature as isLicenseUsableForOrganizationFeatureInRepository,
  recordTelemetryEvent as recordTelemetryEventInRepository,
  refreshDeploymentLicenseLease as refreshDeploymentLicenseLeaseInRepository,
  updateTelemetrySettings as updateTelemetrySettingsInRepository,
} from './deploymentRepository.js';
import {
  flushBillingUsageQueue as flushBillingUsageQueueInRepository,
  getBillingExecutionReceiptKey as getBillingExecutionReceiptKeyFromRepository,
  queueBillingUsage as queueBillingUsageInRepository,
} from './billingUsageRepository.js';
import {
  authorizeBillingOperation as authorizeBillingOperationInRepository,
  finalizeBillingOperation as finalizeBillingOperationInRepository,
  flushBillingAdmissionQueue as flushBillingAdmissionQueueInRepository,
} from './billingAdmissionRepository.js';
import { resolveDeploymentUpdatePolicy } from './updatePolicyClient.js';
import { createDeploymentSettingsRepository } from './deploymentSettingsRepository.js';
import {
  getModuleUpdateManifestFromStore,
  updateModuleUpdateDescriptorInStore,
  type ModuleUpdateDescriptorInput,
} from './moduleUpdateRepository.js';
import {
  getPrivateDeploymentRuntimeConfiguration,
  savePrivateDeploymentRuntimeConfiguration,
} from './privateDeploymentConfigurationRepository.js';
import type { PrivateDeploymentRuntimeConfiguration } from './deploymentTypes.js';

export interface CommercialControlCompositionOptions {
  db(): Database;
  defaultOrganizationId: string;
  creditTokenRate(): string | undefined;
  licenseEnforcementEnabled(): boolean;
  licenseVerificationPublicKeys(): readonly string[];
  telemetryEndpoint(): string | null;
  telemetryIngestSecret(): string;
  telemetryRetentionDays?(): number;
  fieldCipher?: EncryptedFieldCipher;
  databaseReadiness(): { ready: true; schemaVersion: number };
}

export type CommercialModuleUpdateInput = Omit<
  ModuleUpdateDescriptorInput,
  'organizationId'
> & {
  organizationId?: string;
};

/** Builds all commercial controls around one deployment-scoped settings store. */
export function createCommercialControlComposition(
  options: CommercialControlCompositionOptions,
) {
  const audit = createAuditLogFacade({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
  });
  const credits = createCreditsFacade({
    db: options.db,
    creditTokenRate: options.creditTokenRate,
  });
  const settings = createDeploymentSettingsRepository(options.db);
  const deploymentStore = {
    db: options.db,
    ...settings,
    defaultOrganizationId: options.defaultOrganizationId,
    licenseEnforcementEnabled: options.licenseEnforcementEnabled,
    licenseVerificationPublicKeys: options.licenseVerificationPublicKeys,
    telemetryEndpoint: () =>
      options.telemetryEndpoint() ??
      getPrivateDeploymentRuntimeConfiguration(settings)?.telemetryEndpoint ??
      null,
    telemetryIngestSecret: options.telemetryIngestSecret,
    telemetryRetentionDays: options.telemetryRetentionDays,
    fieldCipher: options.fieldCipher,
    databaseReadiness: options.databaseReadiness,
    audit: audit.logAudit,
  };
  const getDeploymentId = () => getDeploymentIdFromRepository(deploymentStore);
  const billingUsageStore = createDeploymentBillingUsageStore(deploymentStore);
  const moduleUpdateStore = {
    ...settings,
    deploymentId: getDeploymentId,
    audit(input: {
      event: string;
      employeeId: string | null;
      message: string;
      organizationId: string;
    }) {
      audit.logAudit(
        input.event,
        input.employeeId,
        input.message,
        input.organizationId,
      );
    },
  };

  return {
    ...audit,
    ...credits,
    getModuleUpdateManifest: () =>
      getModuleUpdateManifestFromStore(moduleUpdateStore),
    updateModuleUpdateDescriptor(input: CommercialModuleUpdateInput) {
      return updateModuleUpdateDescriptorInStore(moduleUpdateStore, {
        ...input,
        organizationId: input.organizationId ?? options.defaultOrganizationId,
      });
    },
    getDeploymentId,
    getMachineFingerprint: getMachineFingerprintFromRepository,
    getDeploymentLicense: () =>
      getDeploymentLicenseFromRepository(deploymentStore),
    importDeploymentLicense: (
      raw: unknown,
      options?: Parameters<typeof importDeploymentLicenseIntoRepository>[2],
    ) => importDeploymentLicenseIntoRepository(deploymentStore, raw, options),
    importDeploymentLicenseLease: (raw: unknown) =>
      importDeploymentLicenseLeaseIntoRepository(deploymentStore, raw),
    ensureDeploymentLicenseSecretsEncrypted: () =>
      ensureDeploymentLicenseSecretsEncryptedInRepository(deploymentStore),
    refreshDeploymentLicenseLease: (
      fetchImpl?: Parameters<typeof refreshDeploymentLicenseLeaseInRepository>[1],
    ) => refreshDeploymentLicenseLeaseInRepository(deploymentStore, fetchImpl),
    resolveDeploymentUpdatePolicy: (
      input: { distributionId: string; currentVersion: string },
      fetchImpl?: typeof fetch,
    ) => resolveDeploymentUpdatePolicy({
      credentials: getDeploymentUpdatePolicyCredentials(deploymentStore),
      verificationPublicKeys: options.licenseVerificationPublicKeys(),
      distributionId: input.distributionId,
      currentVersion: input.currentVersion,
      fetchImpl,
    }),
    getTelemetrySettings: () =>
      getTelemetrySettingsFromRepository(deploymentStore),
    updateTelemetrySettings: (
      patch: Parameters<typeof updateTelemetrySettingsInRepository>[1],
    ) => updateTelemetrySettingsInRepository(deploymentStore, patch),
    recordTelemetryEvent: (
      input: Parameters<typeof recordTelemetryEventInRepository>[1],
    ) => recordTelemetryEventInRepository(deploymentStore, input),
    getTelemetryQueueSummary: () =>
      getTelemetryQueueSummaryFromRepository(deploymentStore),
    flushTelemetryQueue: (
      fetchImpl?: Parameters<typeof flushTelemetryQueueInRepository>[1],
    ) => flushTelemetryQueueInRepository(deploymentStore, fetchImpl),
    queueBillingUsage: (
      input: Parameters<typeof queueBillingUsageInRepository>[1],
    ) => queueBillingUsageInRepository(billingUsageStore, input),
    flushBillingUsageQueue: (
      fetchImpl?: Parameters<typeof flushBillingUsageQueueInRepository>[1],
    ) => flushBillingUsageQueueInRepository(billingUsageStore, fetchImpl),
    getBillingExecutionReceiptKey: () =>
      getBillingExecutionReceiptKeyFromRepository(billingUsageStore),
    authorizeBillingOperation: (
      input: Parameters<typeof authorizeBillingOperationInRepository>[1],
      fetchImpl?: typeof fetch,
    ) => authorizeBillingOperationInRepository(billingUsageStore, input, fetchImpl),
    finalizeBillingOperation: (
      admission: Parameters<typeof finalizeBillingOperationInRepository>[1],
      outcome: Parameters<typeof finalizeBillingOperationInRepository>[2],
      fetchImpl?: typeof fetch,
    ) => finalizeBillingOperationInRepository(
      billingUsageStore,
      admission,
      outcome,
      fetchImpl,
    ),
    flushBillingAdmissionQueue: (
      fetchImpl?: Parameters<typeof flushBillingAdmissionQueueInRepository>[1],
    ) => flushBillingAdmissionQueueInRepository(billingUsageStore, fetchImpl),
    ingestTelemetryBatch: (
      raw: unknown,
      authorization: string | undefined,
      authentication: Parameters<typeof ingestTelemetryBatchIntoRepository>[3],
      now?: number,
    ) => ingestTelemetryBatchIntoRepository(
      deploymentStore,
      raw,
      authorization,
      authentication,
      now,
    ),
    getPrivateDeploymentStatus: () =>
      getPrivateDeploymentStatusFromRepository(deploymentStore),
    getPrivateDeploymentRuntimeConfiguration: () =>
      getPrivateDeploymentRuntimeConfiguration(settings),
    savePrivateDeploymentRuntimeConfiguration: (
      configuration: PrivateDeploymentRuntimeConfiguration,
    ) => savePrivateDeploymentRuntimeConfiguration(settings, configuration),
    exportDeploymentDiagnostics: (
      input: Parameters<
        typeof exportDeploymentDiagnosticsFromRepository
      >[1] = {},
    ) => exportDeploymentDiagnosticsFromRepository(deploymentStore, input),
    isLicenseUsableForOrganizationFeature: (
      feature: OrganizationFeatureKey,
      organizationId?: string | null,
    ) => isLicenseUsableForOrganizationFeatureInRepository(
      deploymentStore,
      feature,
      organizationId,
    ),
    isLicenseRestricted: () => isLicenseRestrictedInRepository(deploymentStore),
  };
}
