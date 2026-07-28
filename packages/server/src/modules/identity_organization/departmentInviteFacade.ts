/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  consumeDepartmentInviteInRepository,
  createDepartmentInviteInRepository,
  type DepartmentInviteConsumer,
  type DepartmentInviteRepositoryStore,
} from './departmentInviteRepository.js';

export function createDepartmentInviteFacade(
  store: DepartmentInviteRepositoryStore,
) {
  return {
    createInviteCode(
      department: string,
      createdBy?: string,
      maxUses = 1,
      organizationId = store.defaultOrganizationId,
    ) {
      return createDepartmentInviteInRepository(
        store,
        department,
        createdBy,
        maxUses,
        organizationId,
      );
    },
    validateInviteCode(
      code: string,
      organizationId?: string,
      consumer?: DepartmentInviteConsumer,
    ) {
      return consumeDepartmentInviteInRepository(
        store,
        code,
        organizationId,
        consumer,
      );
    },
  };
}
