/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getDirectMessageAttachmentFromRepository,
  listDirectMessagesFromRepository,
  listPendingAtoaRequestsFromRepository,
  listUnreadDirectMessageNotificationsFromRepository,
  markAtoaRequestReadFromResponseInRepository,
  sendDirectMessageInRepository,
  type DirectMessageRepositoryStore,
  type GetDirectMessageAttachmentInput,
  type ListDirectMessagesInput,
  type ListPendingAtoaRequestsInput,
  type ListUnreadDirectMessageNotificationsInput,
  type MarkAtoaRequestReadFromResponseInput,
  type SendDirectMessageInput,
} from './directMessageRepository.js';

export function createDirectMessageFacade(store: DirectMessageRepositoryStore) {
  return {
    sendDirectMessage(input: SendDirectMessageInput) {
      return sendDirectMessageInRepository(store, input);
    },
    listDirectMessages(input: ListDirectMessagesInput) {
      return listDirectMessagesFromRepository(store, input);
    },
    getDirectMessageAttachment(input: GetDirectMessageAttachmentInput) {
      return getDirectMessageAttachmentFromRepository(store, input);
    },
    listUnreadDirectMessageNotifications(
      input: ListUnreadDirectMessageNotificationsInput,
    ) {
      return listUnreadDirectMessageNotificationsFromRepository(store, input);
    },
    listPendingAtoaRequests(input: ListPendingAtoaRequestsInput) {
      return listPendingAtoaRequestsFromRepository(store, input);
    },
    markAtoaRequestReadFromResponse(
      input: MarkAtoaRequestReadFromResponseInput,
    ) {
      return markAtoaRequestReadFromResponseInRepository(store, input);
    },
  };
}
