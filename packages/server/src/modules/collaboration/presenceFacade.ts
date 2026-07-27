/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  listAccountPresenceFromRepository,
  touchAccountPresenceInRepository,
  type AccountPresenceRepositoryStore,
  type TouchAccountPresenceInput,
} from './presenceRepository.js';

export function createAccountPresenceFacade(
  store: AccountPresenceRepositoryStore,
) {
  return {
    touchAccountPresence(input: TouchAccountPresenceInput) {
      return touchAccountPresenceInRepository(store, input);
    },
    listAccountPresence(
      organizationId: string,
      onlineWindowMs?: number,
      nowMs?: number,
    ) {
      return listAccountPresenceFromRepository(
        store,
        organizationId,
        onlineWindowMs,
        nowMs,
      );
    },
  };
}
