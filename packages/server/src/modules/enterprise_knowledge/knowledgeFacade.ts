/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  addEnterpriseKnowledgeInRepository,
  listEnterpriseKnowledgeFromRepository,
  listMemberEnterpriseKnowledgeFromRepository,
  searchEnterpriseKnowledgeInRepository,
  type AddEnterpriseKnowledgeInput,
  type EnterpriseKnowledgeRepositoryStore,
} from './knowledgeRepository.js';

export function createEnterpriseKnowledgeFacade(
  store: EnterpriseKnowledgeRepositoryStore,
) {
  return {
    addKnowledge(input: AddEnterpriseKnowledgeInput) {
      return addEnterpriseKnowledgeInRepository(store, input);
    },
    getKnowledge(
      department?: string,
      category?: string,
      organizationId?: string,
    ) {
      return listEnterpriseKnowledgeFromRepository(
        store,
        department,
        category,
        organizationId,
      );
    },
    searchKnowledge(
      query: string,
      department?: string,
      organizationId?: string,
    ) {
      return searchEnterpriseKnowledgeInRepository(
        store,
        query,
        department,
        organizationId,
      );
    },
    getMemberKnowledge(
      memberDepartment: string | null | undefined,
      query = '',
      organizationId?: string,
    ) {
      return listMemberEnterpriseKnowledgeFromRepository(
        store,
        memberDepartment,
        query,
        organizationId,
      );
    },
  };
}
