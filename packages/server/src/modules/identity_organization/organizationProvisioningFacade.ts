/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createOrganizationInRepository,
  provisionOrganizationInRepository,
  type CreateOrganizationInput,
  type OrganizationProvisioningOrganizationView,
  type OrganizationProvisioningRepositoryStore,
  type ProvisionedOrganization,
  type ProvisionOrganizationInput,
} from './organizationProvisioningRepository.js';
import type { AccountLifecycleView } from './accountLifecycleRepository.js';

export interface OrganizationProvisioningFacade<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
> {
  createOrganization(input: CreateOrganizationInput): TOrganizationView;
  provisionOrganization(
    input: ProvisionOrganizationInput,
  ): ProvisionedOrganization<TOrganizationView, TAccountView, TInviteView>;
}

export function createOrganizationProvisioningFacade<
  TOrganizationView extends OrganizationProvisioningOrganizationView,
  TAccountView extends AccountLifecycleView,
  TInviteView,
>(
  store: OrganizationProvisioningRepositoryStore<
    TOrganizationView,
    TAccountView,
    TInviteView
  >,
): OrganizationProvisioningFacade<
  TOrganizationView,
  TAccountView,
  TInviteView
> {
  return {
    createOrganization(input) {
      return createOrganizationInRepository(store, input);
    },
    provisionOrganization(input) {
      return provisionOrganizationInRepository(store, input);
    },
  };
}
