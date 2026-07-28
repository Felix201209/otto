/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  listAccountSyncSnapshotsFromRepository,
  putAccountSyncSnapshotInRepository,
  type AccountSyncRepositoryStore,
} from './accountSyncRepository.js';
import type { PutAccountSyncSnapshotInput } from './accountSyncTypes.js';

export function createAccountSyncFacade(store: AccountSyncRepositoryStore) {
  return {
    listAccountSyncSnapshots(accountId: string) {
      return listAccountSyncSnapshotsFromRepository(store, accountId);
    },
    putAccountSyncSnapshot(input: PutAccountSyncSnapshotInput) {
      return putAccountSyncSnapshotInRepository(store, input);
    },
  };
}
