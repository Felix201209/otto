/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getEnterpriseOrganizationFromDirectory,
  getOrganizationFromDirectory,
  listEnterpriseOrganizationsFromDirectory,
  listOrganizationsFromDirectory,
  type OrganizationDirectoryRepositoryStore,
  type OrganizationDirectoryView,
} from './organizationDirectoryRepository.js';

export interface OrganizationDirectoryFacade {
  getOrganization(id: string): OrganizationDirectoryView | null;
  listOrganizations(): OrganizationDirectoryView[];
  getEnterpriseOrganization(id: string): OrganizationDirectoryView | null;
  listEnterpriseOrganizations(): OrganizationDirectoryView[];
}

export function createOrganizationDirectoryFacade(
  store: OrganizationDirectoryRepositoryStore,
): OrganizationDirectoryFacade {
  return {
    getOrganization(id) {
      return getOrganizationFromDirectory(store, id);
    },
    listOrganizations() {
      return listOrganizationsFromDirectory(store);
    },
    getEnterpriseOrganization(id) {
      return getEnterpriseOrganizationFromDirectory(store, id);
    },
    listEnterpriseOrganizations() {
      return listEnterpriseOrganizationsFromDirectory(store);
    },
  };
}
