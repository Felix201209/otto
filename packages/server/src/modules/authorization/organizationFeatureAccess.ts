/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';
import type {
  OrganizationFeatureConfigurationFacade,
  OrganizationFeatures,
} from '../identity_organization/index.js';

export interface OrganizationFeatureAccessDependencies {
  configuration: OrganizationFeatureConfigurationFacade;
  isLicenseUsable(feature: OrganizationFeatureKey): boolean;
}

export interface OrganizationFeatureAccessFacade {
  getOrganizationFeatures(organizationId: string): OrganizationFeatures;
  updateOrganizationFeatures(
    organizationId: string,
    patch: Partial<OrganizationFeatures>,
  ): OrganizationFeatures;
  isOrganizationFeatureEnabled(
    organizationId: string,
    feature: OrganizationFeatureKey,
  ): boolean;
  requireOrganizationFeature(
    organizationId: string,
    feature: OrganizationFeatureKey,
  ): void;
}

export class OrganizationFeatureDeniedError extends Error {
  readonly code = 'organization_feature_disabled';

  constructor(
    readonly organizationId: string,
    readonly feature: OrganizationFeatureKey,
  ) {
    super(`功能未启用或未获授权: ${feature}`);
    this.name = 'OrganizationFeatureDeniedError';
  }
}

function applyLicensePolicy(
  configured: OrganizationFeatures,
  isLicenseUsable: (feature: OrganizationFeatureKey) => boolean,
): OrganizationFeatures {
  const effective = { ...configured };
  for (const feature of Object.keys(effective) as OrganizationFeatureKey[]) {
    if (!configured[feature]) {
      effective[feature] = false;
      continue;
    }
    try {
      effective[feature] = isLicenseUsable(feature) === true;
    } catch {
      effective[feature] = false;
    }
  }
  return effective;
}

export function createOrganizationFeatureAccessFacade(
  dependencies: OrganizationFeatureAccessDependencies,
): OrganizationFeatureAccessFacade {
  const effectiveFeatures = (organizationId: string): OrganizationFeatures =>
    applyLicensePolicy(
      dependencies.configuration.getConfiguredOrganizationFeatures(
        organizationId,
      ),
      dependencies.isLicenseUsable,
    );

  return {
    getOrganizationFeatures: effectiveFeatures,
    updateOrganizationFeatures(organizationId, patch) {
      const configured =
        dependencies.configuration.updateConfiguredOrganizationFeatures(
          organizationId,
          patch,
        );
      return applyLicensePolicy(configured, dependencies.isLicenseUsable);
    },
    isOrganizationFeatureEnabled(organizationId, feature) {
      return effectiveFeatures(organizationId)[feature] === true;
    },
    requireOrganizationFeature(organizationId, feature) {
      if (!effectiveFeatures(organizationId)[feature]) {
        throw new OrganizationFeatureDeniedError(organizationId, feature);
      }
    },
  };
}
