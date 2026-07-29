/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';
import type { Database } from '../data_platform/index.js';
import { createAuditLogFacade } from './auditLogFacade.js';
import { createCreditsFacade } from './creditsFacade.js';
import {
  exportDeploymentDiagnostics as exportDeploymentDiagnosticsFromRepository,
  flushTelemetryQueue as flushTelemetryQueueInRepository,
  getDeploymentId as getDeploymentIdFromRepository,
  getDeploymentLicense as getDeploymentLicenseFromRepository,
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
import { createDeploymentSettingsRepository } from './deploymentSettingsRepository.js';
import {
  getModuleUpdateManifestFromStore,
  updateModuleUpdateDescriptorInStore,
  type ModuleUpdateDescriptorInput,
} from './moduleUpdateRepository.js';

export interface CommercialControlCompositionOptions {
  db(): Database;
  defaultOrganizationId: string;
  creditTokenRate(): string | undefined;
  licenseEnforcementEnabled(): boolean;
  licenseVerificationPublicKeys(): readonly string[];
  telemetryEndpoint(): string | null;
  telemetryIngestSecret(): string;
  telemetryRetentionDays?(): number;
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
    telemetryEndpoint: options.telemetryEndpoint,
    telemetryIngestSecret: options.telemetryIngestSecret,
    telemetryRetentionDays: options.telemetryRetentionDays,
    databaseReadiness: options.databaseReadiness,
    audit: audit.logAudit,
  };
  const getDeploymentId = () => getDeploymentIdFromRepository(deploymentStore);
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
    importDeploymentLicense: (raw: unknown) =>
      importDeploymentLicenseIntoRepository(deploymentStore, raw),
    importDeploymentLicenseLease: (raw: unknown) =>
      importDeploymentLicenseLeaseIntoRepository(deploymentStore, raw),
    refreshDeploymentLicenseLease: (
      fetchImpl?: Parameters<typeof refreshDeploymentLicenseLeaseInRepository>[1],
    ) => refreshDeploymentLicenseLeaseInRepository(deploymentStore, fetchImpl),
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
    ingestTelemetryBatch: (
      raw: unknown,
      authorization: string | undefined,
    ) => ingestTelemetryBatchIntoRepository(
      deploymentStore,
      raw,
      authorization,
    ),
    getPrivateDeploymentStatus: () =>
      getPrivateDeploymentStatusFromRepository(deploymentStore),
    exportDeploymentDiagnostics: (
      input: Parameters<
        typeof exportDeploymentDiagnosticsFromRepository
      >[1] = {},
    ) => exportDeploymentDiagnosticsFromRepository(deploymentStore, input),
    isLicenseUsableForOrganizationFeature: (feature: OrganizationFeatureKey) =>
      isLicenseUsableForOrganizationFeatureInRepository(
        deploymentStore,
        feature,
      ),
    isLicenseRestricted: () => isLicenseRestrictedInRepository(deploymentStore),
  };
}
