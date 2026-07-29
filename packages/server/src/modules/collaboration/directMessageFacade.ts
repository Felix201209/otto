/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getDirectMessageAttachmentFromRepository,
  listDirectMessagesFromRepository,
  listPendingAtoaRequestsFromRepository,
  listUnreadDirectMessageNotificationsFromRepository,
  markAtoaRequestReadFromResponseInRepository,
  migrateDirectMessageContentEncryption,
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
  let contentEncryptionInitialized = false;
  const ensureContentEncrypted = () => {
    if (contentEncryptionInitialized) return 0;
    const migrated = migrateDirectMessageContentEncryption(store);
    contentEncryptionInitialized = true;
    return migrated;
  };
  return {
    ensureDirectMessageContentEncrypted: ensureContentEncrypted,
    sendDirectMessage(input: SendDirectMessageInput) {
      ensureContentEncrypted();
      return sendDirectMessageInRepository(store, input);
    },
    listDirectMessages(input: ListDirectMessagesInput) {
      ensureContentEncrypted();
      return listDirectMessagesFromRepository(store, input);
    },
    getDirectMessageAttachment(input: GetDirectMessageAttachmentInput) {
      ensureContentEncrypted();
      return getDirectMessageAttachmentFromRepository(store, input);
    },
    listUnreadDirectMessageNotifications(
      input: ListUnreadDirectMessageNotificationsInput,
    ) {
      ensureContentEncrypted();
      return listUnreadDirectMessageNotificationsFromRepository(store, input);
    },
    listPendingAtoaRequests(input: ListPendingAtoaRequestsInput) {
      ensureContentEncrypted();
      return listPendingAtoaRequestsFromRepository(store, input);
    },
    markAtoaRequestReadFromResponse(
      input: MarkAtoaRequestReadFromResponseInput,
    ) {
      ensureContentEncrypted();
      return markAtoaRequestReadFromResponseInRepository(store, input);
    },
  };
}
