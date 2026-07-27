/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createSmsLoginChallengeInRepository,
  createSmsRegistrationChallengeInRepository,
  discardSmsLoginChallengeInRepository,
  discardSmsRegistrationChallengeInRepository,
  verifySmsLoginChallengeInRepository,
  verifySmsRegistrationChallengeInRepository,
  type SmsChallengeAccountView,
  type SmsChallengeRepositoryStore,
  type SmsRegistrationChallengeOptions,
} from './smsChallengeRepository.js';

export function createSmsChallengeFacade<
  TAccountView extends SmsChallengeAccountView,
>(store: SmsChallengeRepositoryStore<TAccountView>) {
  return {
    createSmsLoginChallenge(
      accountId: string,
      code: string,
      options: { now?: number } = {},
    ) {
      return createSmsLoginChallengeInRepository(
        store,
        accountId,
        code,
        options,
      );
    },
    discardSmsLoginChallenge(challengeId: string) {
      return discardSmsLoginChallengeInRepository(store, challengeId);
    },
    verifySmsLoginChallenge(
      challengeId: string,
      code: string,
      now = Date.now(),
    ) {
      return verifySmsLoginChallengeInRepository(store, challengeId, code, now);
    },
    createSmsRegistrationChallenge(
      phone: string,
      code: string,
      organizationId = store.defaultOrganizationId,
      options: SmsRegistrationChallengeOptions = {},
    ) {
      return createSmsRegistrationChallengeInRepository(
        store,
        phone,
        code,
        organizationId,
        options,
      );
    },
    discardSmsRegistrationChallenge(challengeId: string) {
      return discardSmsRegistrationChallengeInRepository(store, challengeId);
    },
    verifySmsRegistrationChallenge(
      challengeId: string,
      code: string,
      now = Date.now(),
    ) {
      return verifySmsRegistrationChallengeInRepository(
        store,
        challengeId,
        code,
        now,
      );
    },
  };
}
