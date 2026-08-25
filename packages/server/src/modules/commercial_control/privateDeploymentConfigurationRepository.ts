/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DeploymentSettingsRepository } from './deploymentSettingsRepository.js';
import type { PrivateDeploymentRuntimeConfiguration } from './deploymentTypes.js';

const SETTING_KEY = 'private_deployment_runtime_configuration_v1';

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

export function parsePrivateDeploymentRuntimeConfiguration(
  raw: unknown,
): PrivateDeploymentRuntimeConfiguration | null {
  const value = safeObject(raw);
  const capabilities = safeObject(value.capabilities);
  const controlOrigin = optionalString(value.controlOrigin);
  const activatedAt = optionalString(value.activatedAt);
  if (!controlOrigin || !activatedAt) return null;
  try {
    if (new URL(controlOrigin).origin !== controlOrigin) return null;
  } catch {
    return null;
  }
  return {
    controlOrigin,
    capabilities: {
      billing: booleanValue(capabilities.billing),
      telemetry: booleanValue(capabilities.telemetry),
      federation: booleanValue(capabilities.federation),
      updates: booleanValue(capabilities.updates),
      modelGateway: booleanValue(capabilities.modelGateway),
      storage: booleanValue(capabilities.storage),
    },
    federationGatewayUrl: optionalString(value.federationGatewayUrl),
    modelGatewayUrl: optionalString(value.modelGatewayUrl),
    telemetryEndpoint: optionalString(value.telemetryEndpoint),
    updateDistributionId: optionalString(value.updateDistributionId),
    activatedAt,
  };
}

export function getPrivateDeploymentRuntimeConfiguration(
  settings: DeploymentSettingsRepository,
): PrivateDeploymentRuntimeConfiguration | null {
  const encoded = settings.readSetting(SETTING_KEY);
  if (!encoded) return null;
  try {
    return parsePrivateDeploymentRuntimeConfiguration(JSON.parse(encoded));
  } catch {
    return null;
  }
}

export function savePrivateDeploymentRuntimeConfiguration(
  settings: DeploymentSettingsRepository,
  configuration: PrivateDeploymentRuntimeConfiguration,
): void {
  const normalized = parsePrivateDeploymentRuntimeConfiguration(configuration);
  if (!normalized) throw new Error('private deployment configuration is invalid');
  settings.writeSetting(SETTING_KEY, JSON.stringify(normalized));
}
