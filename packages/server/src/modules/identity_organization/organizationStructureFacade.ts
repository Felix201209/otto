/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createOrganizationDepartmentInRepository,
  createOrganizationPositionInRepository,
  deleteOrganizationDepartmentInRepository,
  deleteOrganizationPositionInRepository,
  listOrganizationStructureFromRepository,
  updateOrganizationDepartmentInRepository,
  updateOrganizationPositionInRepository,
  type CreateOrganizationDepartmentInput,
  type CreateOrganizationPositionInput,
  type DeleteOrganizationDepartmentInput,
  type DeleteOrganizationPositionInput,
  type OrganizationDepartmentView,
  type OrganizationPositionView,
  type OrganizationStructureRepositoryStore,
  type UpdateOrganizationDepartmentInput,
  type UpdateOrganizationPositionInput,
} from './organizationStructureRepository.js';

export interface OrganizationStructureFacade {
  listOrganizationStructure(
    organizationId: string,
  ): OrganizationDepartmentView[];
  createOrganizationDepartment(
    input: CreateOrganizationDepartmentInput,
  ): OrganizationDepartmentView;
  updateOrganizationDepartment(
    input: UpdateOrganizationDepartmentInput,
  ): OrganizationDepartmentView;
  deleteOrganizationDepartment(input: DeleteOrganizationDepartmentInput): void;
  createOrganizationPosition(
    input: CreateOrganizationPositionInput,
  ): OrganizationPositionView;
  updateOrganizationPosition(
    input: UpdateOrganizationPositionInput,
  ): OrganizationPositionView;
  deleteOrganizationPosition(input: DeleteOrganizationPositionInput): void;
}

export function createOrganizationStructureFacade(
  store: OrganizationStructureRepositoryStore,
): OrganizationStructureFacade {
  return {
    listOrganizationStructure(organizationId) {
      return listOrganizationStructureFromRepository(store, organizationId);
    },
    createOrganizationDepartment(input) {
      return createOrganizationDepartmentInRepository(store, input);
    },
    updateOrganizationDepartment(input) {
      return updateOrganizationDepartmentInRepository(store, input);
    },
    deleteOrganizationDepartment(input) {
      deleteOrganizationDepartmentInRepository(store, input);
    },
    createOrganizationPosition(input) {
      return createOrganizationPositionInRepository(store, input);
    },
    updateOrganizationPosition(input) {
      return updateOrganizationPositionInRepository(store, input);
    },
    deleteOrganizationPosition(input) {
      deleteOrganizationPositionInRepository(store, input);
    },
  };
}
