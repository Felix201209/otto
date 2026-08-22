/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DeploymentLicenseView } from '../commercial_control/index.js';
import type { ControlCommandEnvelope } from '../control_commands/index.js';
import type {
  BootstrapEnterpriseProvisioningInput,
  BootstrapEnterpriseProvisioningResult,
} from '../identity_organization/index.js';
import { parseEnterpriseInitiationPayload } from './enterpriseInitiationPayload.js';

export interface EnterpriseInitiationCommandRunResult {
  status: 'succeeded' | 'failed';
  resultSummary: string;
  resourceId?: string;
  errorCategory?: string;
}

export interface EnterpriseInitiationCommandExecutorDependencies {
  getDeploymentLicense(): DeploymentLicenseView;
  provision(
    input: BootstrapEnterpriseProvisioningInput,
  ): BootstrapEnterpriseProvisioningResult;
}

const USABLE_LICENSE_STATES = new Set(['active', 'expiring', 'grace']);

function failed(
  errorCategory: string,
  resultSummary: string,
): EnterpriseInitiationCommandRunResult {
  return { status: 'failed', errorCategory, resultSummary };
}

/** Execute a signed enterprise.initiate command against current License state. */
export function createEnterpriseInitiationCommandExecutor(
  dependencies: EnterpriseInitiationCommandExecutorDependencies,
) {
  return (
    command: ControlCommandEnvelope,
  ): EnterpriseInitiationCommandRunResult => {
    if (command.type !== 'enterprise.initiate') {
      return failed('unsupported_command', 'command type is not supported');
    }
    if (!command.idempotencyKey?.trim()) {
      return failed(
        'missing_idempotency_key',
        'enterprise provisioning requires a business idempotency key',
      );
    }

    let payload: ReturnType<typeof parseEnterpriseInitiationPayload>;
    try {
      payload = parseEnterpriseInitiationPayload(command.payload);
    } catch {
      return failed(
        'invalid_payload',
        'enterprise provisioning payload is invalid',
      );
    }

    const license = dependencies.getDeploymentLicense();
    if (!USABLE_LICENSE_STATES.has(license.status)) {
      return failed('license_unavailable', 'deployment License is not usable');
    }
    if (license.deploymentId !== command.deploymentId) {
      return failed(
        'license_deployment_mismatch',
        'command does not match the deployment License',
      );
    }
    if (license.organizationId !== payload.organization.id) {
      return failed(
        'license_organization_mismatch',
        'enterprise does not match the deployment License',
      );
    }
    const licensedModules = new Set(license.modules);
    if (payload.modules.some((moduleId) => !licensedModules.has(moduleId))) {
      return failed(
        'module_not_licensed',
        'enterprise provisioning requested an unlicensed module',
      );
    }

    try {
      const result = dependencies.provision({
        deploymentId: command.deploymentId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        payloadDigest: command.payloadDigest,
        organization: payload.organization,
        ceo: payload.ceo,
        defaultDepartmentName: payload.defaultDepartmentName,
      });
      return {
        status: 'succeeded',
        resultSummary: result.replayed
          ? 'enterprise provisioning replayed safely'
          : 'enterprise provisioned',
        resourceId: result.organizationId,
      };
    } catch {
      return failed('provisioning_failed', 'enterprise provisioning failed');
    }
  };
}
