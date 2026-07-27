/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getConfiguredOrganizationFeaturesFromRepository,
  updateConfiguredOrganizationFeaturesInRepository,
  type OrganizationFeatureRepositoryStore,
  type OrganizationFeatures,
} from './organizationFeatureRepository.js';

export interface OrganizationFeatureConfigurationFacade {
  getConfiguredOrganizationFeatures(
    organizationId: string,
  ): OrganizationFeatures;
  updateConfiguredOrganizationFeatures(
    organizationId: string,
    patch: Partial<OrganizationFeatures>,
  ): OrganizationFeatures;
}

export function createOrganizationFeatureFacade(
  store: OrganizationFeatureRepositoryStore,
): OrganizationFeatureConfigurationFacade {
  return {
    getConfiguredOrganizationFeatures(organizationId) {
      return getConfiguredOrganizationFeaturesFromRepository(
        store,
        organizationId,
      );
    },
    updateConfiguredOrganizationFeatures(organizationId, patch) {
      return updateConfiguredOrganizationFeaturesInRepository(
        store,
        organizationId,
        patch,
      );
    },
  };
}
