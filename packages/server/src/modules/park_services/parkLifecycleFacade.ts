/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createParkAsPlatformInRepository,
  createParkInRepository,
  getParkForOrganizationFromRepository,
  getParkFromRepository,
  updateParkAsPlatformInRepository,
  type CreateParkAsPlatformInput,
  type CreateParkInput,
  type ParkLifecycleRepositoryStore,
  type UpdateParkAsPlatformInput,
} from './parkLifecycleRepository.js';

export function createParkLifecycleFacade(store: ParkLifecycleRepositoryStore) {
  return {
    getPark(parkId: string) {
      return getParkFromRepository(store, parkId);
    },
    getParkForOrganization(organizationId: string) {
      return getParkForOrganizationFromRepository(store, organizationId);
    },
    createPark(input: CreateParkInput) {
      return createParkInRepository(store, input);
    },
    createParkAsPlatform(input: CreateParkAsPlatformInput) {
      return createParkAsPlatformInRepository(store, input);
    },
    updateParkAsPlatform(input: UpdateParkAsPlatformInput) {
      return updateParkAsPlatformInRepository(store, input);
    },
  };
}
