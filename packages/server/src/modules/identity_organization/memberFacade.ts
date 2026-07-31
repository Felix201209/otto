/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createEmployeeInRepository,
  getEmployeeFromRepository,
  listEmployeesFromRepository,
  offboardEmployeeInRepository,
  updateEmployeeOnboardingProfileInRepository,
  type CreateEmployeeInput,
  type EmployeeRecord,
  type MemberRepositoryStore,
  type UpdateEmployeeOnboardingProfileInput,
} from './memberRepository.js';

export interface MemberDirectoryFacade {
  createEmployee(employee: CreateEmployeeInput): void;
  getEmployee(id: string, organizationId?: string): EmployeeRecord | null;
  listEmployees(department?: string, organizationId?: string): EmployeeRecord[];
  updateEmployeeOnboardingProfile(
    input: UpdateEmployeeOnboardingProfileInput,
  ): EmployeeRecord | null;
  offboardEmployee(id: string, organizationId?: string): boolean;
}

export function createMemberDirectoryFacade(
  store: MemberRepositoryStore,
): MemberDirectoryFacade {
  return {
    createEmployee(employee) {
      return createEmployeeInRepository(store, employee);
    },
    getEmployee(id, organizationId) {
      return getEmployeeFromRepository(store, id, organizationId);
    },
    listEmployees(department, organizationId) {
      return listEmployeesFromRepository(store, department, organizationId);
    },
    updateEmployeeOnboardingProfile(input) {
      return updateEmployeeOnboardingProfileInRepository(store, input);
    },
    offboardEmployee(id, organizationId) {
      return offboardEmployeeInRepository(store, id, organizationId);
    },
  };
}
