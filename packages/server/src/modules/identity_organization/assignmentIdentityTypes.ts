/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface AssignmentIdentityInput {
  department?: string | null;
  departmentId?: string | null;
  positionTitle?: string | null;
  positionId?: string | null;
}

export interface AssignmentIdentity {
  department: string | null;
  departmentId: string | null;
  positionTitle: string | null;
  positionId: string | null;
}
