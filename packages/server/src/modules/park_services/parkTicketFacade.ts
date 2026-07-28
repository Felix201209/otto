/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { normalizeParkServiceFormData } from './parkServiceFormRules.js';
import {
  createTicket as createTicketInRepository,
  getTicketCreatorForAccount as getCreatorFromRepository,
  getTicketForAccount as getTicketFromRepository,
  getTicketNotificationRecipients as getNotificationRecipientsFromRepository,
  getTicketTransferredNotificationRecipients as getTransferredRecipientsFromRepository,
  isTicketFeatureEnabledForAccount as isFeatureEnabledInRepository,
  listTicketInbox as listInboxFromRepository,
  listTicketsForAccount as listTicketsFromRepository,
  markTicketRead as markReadInRepository,
  recordTicketNotification as recordNotificationInRepository,
  type ParkTicketRepositoryStore,
  updateTicket as updateTicketInRepository,
} from './parkTicketRepository.js';
import type {
  CreateTicketInput,
  ParkTicketAccount,
  RecordTicketNotificationInput,
  UpdateTicketInput,
} from './parkTicketTypes.js';

export function createParkTicketFacade<TAccount extends ParkTicketAccount>(
  store: ParkTicketRepositoryStore<TAccount>,
) {
  return {
    createTicket(input: CreateTicketInput) {
      return createTicketInRepository(store, input);
    },
    getTicketCreatorForAccount(id: string, accountId: string) {
      return getCreatorFromRepository(store, id, accountId);
    },
    getTicketForAccount(id: string, accountId: string) {
      return getTicketFromRepository(store, id, accountId);
    },
    getTicketNotificationRecipients(ticketId: string) {
      return getNotificationRecipientsFromRepository(store, ticketId);
    },
    getTicketTransferredNotificationRecipients(ticketId: string) {
      return getTransferredRecipientsFromRepository(store, ticketId);
    },
    isTicketFeatureEnabledForAccount(id: string, accountId: string) {
      return isFeatureEnabledInRepository(store, id, accountId);
    },
    listTicketInbox(accountId: string) {
      return listInboxFromRepository(store, accountId);
    },
    listTicketsForAccount(accountId: string) {
      return listTicketsFromRepository(store, accountId);
    },
    markTicketRead(ticketId: string, accountId: string) {
      return markReadInRepository(store, ticketId, accountId);
    },
    normalizeParkServiceFormData,
    recordTicketNotification(input: RecordTicketNotificationInput) {
      return recordNotificationInRepository(store, input);
    },
    updateTicket(input: UpdateTicketInput) {
      return updateTicketInRepository(store, input);
    },
  };
}
