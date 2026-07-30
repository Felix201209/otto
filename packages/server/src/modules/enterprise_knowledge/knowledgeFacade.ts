/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  addEnterpriseKnowledgeInRepository,
  listEnterpriseKnowledgeForAdministrationFromRepository,
  listEnterpriseKnowledgeForBackupFromRepository,
  listEnterpriseKnowledgeFromRepository,
  listEnterpriseKnowledgeRevisionsFromRepository,
  listMemberEnterpriseKnowledgeFromRepository,
  reviewEnterpriseKnowledgeInRepository,
  reviseEnterpriseKnowledgeInRepository,
  saveEnterpriseKnowledgeInRepository,
  searchEnterpriseKnowledgeInRepository,
  type AddEnterpriseKnowledgeInput,
  type EnterpriseKnowledgeStatus,
  type ReviseEnterpriseKnowledgeInput,
  type EnterpriseKnowledgeRepositoryStore,
} from './knowledgeRepository.js';

export function createEnterpriseKnowledgeFacade(
  store: EnterpriseKnowledgeRepositoryStore,
) {
  return {
    addKnowledge(input: AddEnterpriseKnowledgeInput) {
      return addEnterpriseKnowledgeInRepository(store, input);
    },
    saveKnowledge(input: AddEnterpriseKnowledgeInput) {
      return saveEnterpriseKnowledgeInRepository(store, input);
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
      options: { includeOwnPending?: boolean; contributorAccountId?: string } = {},
    ) {
      return listMemberEnterpriseKnowledgeFromRepository(
        store,
        memberDepartment,
        query,
        organizationId,
        options,
      );
    },
    getKnowledgeForAdministration(
      query = '',
      department?: string,
      organizationId?: string,
      status?: EnterpriseKnowledgeStatus,
    ) {
      return listEnterpriseKnowledgeForAdministrationFromRepository(
        store,
        query,
        department,
        organizationId,
        status,
      );
    },
    getKnowledgeForBackup(organizationId?: string) {
      return listEnterpriseKnowledgeForBackupFromRepository(store, organizationId);
    },
    reviewKnowledge(input: {
      id: number;
      organizationId?: string;
      action: 'approve' | 'archive';
      reviewer: string;
      note?: string;
    }) {
      return reviewEnterpriseKnowledgeInRepository(store, input);
    },
    reviseKnowledge(input: ReviseEnterpriseKnowledgeInput) {
      return reviseEnterpriseKnowledgeInRepository(store, input);
    },
    getKnowledgeRevisions(id: number, organizationId?: string) {
      return listEnterpriseKnowledgeRevisionsFromRepository(store, id, organizationId);
    },
  };
}
