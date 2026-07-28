/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  listParkServicesFromRepository,
  listParkServiceSpecialistsFromRepository,
  removeParkServiceSpecialistInRepository,
  setParkServiceSpecialistInRepository,
  updateParkServiceInRepository,
  type ParkServiceConfigurationRepositoryStore,
  type SetParkServiceSpecialistInput,
  type UpdateParkServiceInput,
} from './parkServiceConfigurationRepository.js';

export function createParkServiceConfigurationFacade(
  store: ParkServiceConfigurationRepositoryStore,
) {
  return {
    listServices(parkId: string) {
      return listParkServicesFromRepository(store, parkId);
    },
    updateService(input: UpdateParkServiceInput) {
      return updateParkServiceInRepository(store, input);
    },
    listSpecialists(parkId: string) {
      return listParkServiceSpecialistsFromRepository(store, parkId);
    },
    setSpecialist(input: SetParkServiceSpecialistInput) {
      return setParkServiceSpecialistInRepository(store, input);
    },
    removeSpecialist(input: SetParkServiceSpecialistInput) {
      return removeParkServiceSpecialistInRepository(store, input);
    },
  };
}
