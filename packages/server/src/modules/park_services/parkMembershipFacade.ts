/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getParkTenantProfileFromRepository,
  issueParkInviteInRepository,
  joinOrganizationToParkInRepository,
  updateParkTenantProfileInRepository,
  type IssueParkInviteInput,
  type JoinOrganizationToParkInput,
  type ParkMembershipRepositoryStore,
  type UpdateParkTenantProfileInput,
} from './parkMembershipRepository.js';

export function createParkMembershipFacade(
  store: ParkMembershipRepositoryStore,
) {
  return {
    getTenantProfile(organizationId: string) {
      return getParkTenantProfileFromRepository(store, organizationId);
    },
    updateTenantProfile(input: UpdateParkTenantProfileInput) {
      return updateParkTenantProfileInRepository(store, input);
    },
    issueInvite(input: IssueParkInviteInput) {
      return issueParkInviteInRepository(store, input);
    },
    joinOrganization(input: JoinOrganizationToParkInput) {
      return joinOrganizationToParkInRepository(store, input);
    },
  };
}
