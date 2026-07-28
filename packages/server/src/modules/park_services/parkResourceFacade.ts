/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createParkResourceRepository,
  type ParkResourceRepositoryStore,
} from './parkResourceRepository.js';
import type {
  ParkMeetingPeriodReservationInput,
  ParkMeetingRoomInput,
  ParkMeetingSlotAvailabilityInput,
  ParkMeetingSlotReservationInput,
  ParkSettingsInput,
} from './parkResourceTypes.js';

export function createParkResourceFacade(store: ParkResourceRepositoryStore) {
  const repository = createParkResourceRepository(store);
  return {
    createParkMeetingRoom(organizationId: string, input: ParkMeetingRoomInput) {
      return repository.createParkMeetingRoom(organizationId, input);
    },
    deleteParkMeetingRoom(organizationId: string, id: string) {
      return repository.deleteParkMeetingRoom(organizationId, id);
    },
    getParkSettings(organizationId: string) {
      return repository.getParkSettings(organizationId);
    },
    listParkMeetingRooms(organizationId: string, includeDisabled = false) {
      return repository.listParkMeetingRooms(organizationId, includeDisabled);
    },
    listParkMeetingSlots(
      organizationId: string,
      fromDate?: string,
      toDate?: string,
    ) {
      return repository.listParkMeetingSlots(organizationId, fromDate, toDate);
    },
    reserveParkMeetingPeriod(
      organizationId: string,
      input: ParkMeetingPeriodReservationInput,
    ) {
      return repository.reserveParkMeetingPeriod(organizationId, input);
    },
    reserveParkMeetingSlot(
      organizationId: string,
      input: ParkMeetingSlotReservationInput,
    ) {
      return repository.reserveParkMeetingSlot(organizationId, input);
    },
    setParkMeetingSlotAvailability(
      organizationId: string,
      input: ParkMeetingSlotAvailabilityInput,
    ) {
      return repository.setParkMeetingSlotAvailability(organizationId, input);
    },
    updateParkMeetingRoom(
      organizationId: string,
      id: string,
      input: ParkMeetingRoomInput,
    ) {
      return repository.updateParkMeetingRoom(organizationId, id, input);
    },
    updateParkSettings(organizationId: string, input: ParkSettingsInput) {
      return repository.updateParkSettings(organizationId, input);
    },
  };
}
