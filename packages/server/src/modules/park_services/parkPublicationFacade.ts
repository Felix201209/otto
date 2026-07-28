/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createParkPublicationInRepository,
  listParkAnnouncementResultsFromRepository,
  listParkPublicationsFromRepository,
  listParkSurveyResultsFromRepository,
  markParkPublicationReadInRepository,
  submitParkSurveyInRepository,
  type CreateParkPublicationInput,
  type ParkPublicationRepositoryStore,
} from './parkPublicationRepository.js';

export function createParkPublicationFacade(
  store: ParkPublicationRepositoryStore,
) {
  return {
    createParkPublication(input: CreateParkPublicationInput) {
      return createParkPublicationInRepository(store, input);
    },
    listParkPublications(accountId: string) {
      return listParkPublicationsFromRepository(store, accountId);
    },
    listParkAnnouncementResults(accountId: string) {
      return listParkAnnouncementResultsFromRepository(store, accountId);
    },
    listParkSurveyResults(accountId: string) {
      return listParkSurveyResultsFromRepository(store, accountId);
    },
    markParkPublicationRead(id: string, accountId: string) {
      return markParkPublicationReadInRepository(store, id, accountId);
    },
    submitParkSurvey(
      id: string,
      accountId: string,
      responseData: Record<string, string>,
    ) {
      return submitParkSurveyInRepository(store, id, accountId, responseData);
    },
  };
}
