/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  getEnterpriseSkillLeaderboardFromRepository,
  installEnterpriseSkillInRepository,
  listEnterpriseSkillsFromRepository,
  rateEnterpriseSkillInRepository,
  recordEnterpriseSkillUsageInRepository,
  reviewEnterpriseSkillInRepository,
  submitEnterpriseSkillInRepository,
  type EnterpriseSkillActor,
  type EnterpriseSkillMarketStore,
  type EnterpriseSkillScope,
  type EnterpriseSkillSort,
  type EnterpriseSkillVisibility,
} from './skillMarketplaceRepository.js';

export function createEnterpriseSkillMarketplaceFacade(store: EnterpriseSkillMarketStore) {
  return {
    submitEnterpriseSkill(actor: EnterpriseSkillActor, input: {
      name: string;
      slug?: string;
      description: string;
      content: string;
      visibility?: EnterpriseSkillVisibility;
    }) {
      return submitEnterpriseSkillInRepository(store, actor, input);
    },
    listEnterpriseSkills(actor: EnterpriseSkillActor, input: {
      scope?: EnterpriseSkillScope;
      query?: string;
      sort?: EnterpriseSkillSort;
    } = {}) {
      return listEnterpriseSkillsFromRepository(store, actor, input);
    },
    reviewEnterpriseSkill(actor: EnterpriseSkillActor, input: {
      id: string;
      action: 'approve' | 'archive';
      visibility?: EnterpriseSkillVisibility;
    }) {
      return reviewEnterpriseSkillInRepository(store, actor, input);
    },
    installEnterpriseSkill(actor: EnterpriseSkillActor, id: string) {
      return installEnterpriseSkillInRepository(store, actor, id);
    },
    rateEnterpriseSkill(actor: EnterpriseSkillActor, id: string, score: number) {
      return rateEnterpriseSkillInRepository(store, actor, id, score);
    },
    recordEnterpriseSkillUsage(actor: EnterpriseSkillActor, id: string, success: boolean, eventId?: string) {
      return recordEnterpriseSkillUsageInRepository(store, actor, id, success, eventId);
    },
    getEnterpriseSkillLeaderboard(actor: EnterpriseSkillActor) {
      return getEnterpriseSkillLeaderboardFromRepository(store, actor);
    },
  };
}
