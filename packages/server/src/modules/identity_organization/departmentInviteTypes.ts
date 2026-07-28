/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface DepartmentInviteOrganization {
  id: string;
  status: 'active' | 'disabled';
}

export interface DepartmentInviteResolution {
  department: string;
  organizationId: string;
}

export type DepartmentInviteValidationResult =
  | {
      valid: true;
      department: string;
      organizationId: string;
    }
  | {
      valid: false;
      error: string;
    };

export interface DepartmentInviteRow {
  code: string;
  organization_id: string;
  department: string;
  max_uses: number;
  used_count: number;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
}
