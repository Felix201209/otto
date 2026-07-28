/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  normalizeAssignmentName,
  stableAssignmentId,
} from './organizationStructureRepository.js';
import type {
  AssignmentIdentity,
  AssignmentIdentityInput,
} from './assignmentIdentityTypes.js';

interface DepartmentIdentityRow {
  id: string | null;
  name: string | null;
}

interface PositionIdentityRow {
  id: string | null;
  title: string | null;
  department_id: string | null;
}

interface OwnedIdentityRow {
  organization_id: string;
}

function normalizeOptionalText(
  value: string | null | undefined,
  label: string,
  maxLength = 80,
): string | null {
  const clean = value?.trim() || null;
  if (clean && clean.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  }
  return clean;
}

function assertIdentityIdIsTenantSafe(
  database: Database,
  kind: 'department' | 'position',
  id: string | null,
  organizationId: string,
  label: string,
): void {
  if (!id) return;
  const identityColumn =
    kind === 'department' ? 'department_id' : 'position_id';
  const directoryTable =
    kind === 'department'
      ? 'organization_departments'
      : 'organization_positions';
  const owners = database
    .prepare(
      `SELECT organization_id FROM ${directoryTable} WHERE id = ?
       UNION ALL
       SELECT organization_id FROM accounts
         WHERE ${identityColumn} = ? AND deleted_at IS NULL
       UNION ALL
       SELECT organization_id FROM employees WHERE ${identityColumn} = ?
       UNION ALL
       SELECT organization_id FROM organization_invites WHERE ${identityColumn} = ?`,
    )
    .all(id, id, id, id) as OwnedIdentityRow[];
  if (owners.some((owner) => owner.organization_id !== organizationId)) {
    throw new Error(`${label} 已属于其他企业`);
  }
}

function withAssignmentSavepoint<T>(database: Database, operation: () => T): T {
  database.exec('SAVEPOINT assignment_identity');
  try {
    const result = operation();
    database.exec('RELEASE SAVEPOINT assignment_identity');
    return result;
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT assignment_identity');
    database.exec('RELEASE SAVEPOINT assignment_identity');
    throw error;
  }
}

/**
 * Resolves display names and stable IDs against the authoritative tenant
 * directory. Legacy callers may still provide names only; explicit IDs are
 * accepted only when they cannot point at another tenant or directory node.
 */
export function resolveAssignmentIdentityInRepository(
  database: Database,
  organizationId: string,
  input: AssignmentIdentityInput,
): AssignmentIdentity {
  const department = normalizeOptionalText(input.department, '部门名称');
  const requestedDepartmentId = normalizeOptionalText(
    input.departmentId,
    '部门 ID',
    120,
  );
  const positionTitle = normalizeOptionalText(input.positionTitle, '职位名称');
  const requestedPositionId = normalizeOptionalText(
    input.positionId,
    '职位 ID',
    120,
  );
  if (!department && requestedDepartmentId) {
    throw new Error('设置部门 ID 时必须同时提供部门名称');
  }
  if (!positionTitle && requestedPositionId) {
    throw new Error('设置职位 ID 时必须同时提供职位名称');
  }

  return withAssignmentSavepoint(database, () => {
    assertIdentityIdIsTenantSafe(
      database,
      'department',
      requestedDepartmentId,
      organizationId,
      '该部门 ID',
    );
    assertIdentityIdIsTenantSafe(
      database,
      'position',
      requestedPositionId,
      organizationId,
      '该职位 ID',
    );

    const departmentRows = database
      .prepare(
        `SELECT id, name FROM organization_departments WHERE organization_id = ?
         UNION ALL
         SELECT department_id AS id, department AS name FROM accounts
           WHERE organization_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT department_id AS id, department AS name FROM employees
           WHERE organization_id = ?
         UNION ALL
         SELECT department_id AS id, default_department AS name FROM organization_invites
           WHERE organization_id = ?`,
      )
      .all(
        organizationId,
        organizationId,
        organizationId,
        organizationId,
      ) as DepartmentIdentityRow[];
    const normalizedDepartment = department
      ? normalizeAssignmentName(department)
      : null;
    const existingDepartment = normalizedDepartment
      ? departmentRows.find(
          (row) =>
            row.id &&
            row.name &&
            normalizeAssignmentName(row.name) === normalizedDepartment,
        )
      : undefined;
    if (
      requestedDepartmentId &&
      existingDepartment?.id &&
      existingDepartment.id !== requestedDepartmentId
    ) {
      throw new Error('该部门名称已绑定其他部门 ID');
    }
    if (requestedDepartmentId) {
      const conflicting = departmentRows.find(
        (row) =>
          row.id === requestedDepartmentId &&
          row.name &&
          normalizeAssignmentName(row.name) !== normalizedDepartment,
      );
      if (conflicting) throw new Error('该部门 ID 已绑定其他部门名称');
    }
    const departmentId = department
      ? (requestedDepartmentId ??
        existingDepartment?.id ??
        stableAssignmentId('dept', organizationId, normalizedDepartment))
      : null;

    const positionRows = database
      .prepare(
        `SELECT id, title, department_id FROM organization_positions WHERE organization_id = ?
         UNION ALL
         SELECT position_id AS id, position_title AS title, department_id
           FROM accounts WHERE organization_id = ? AND deleted_at IS NULL
         UNION ALL
         SELECT position_id AS id, position_title AS title, department_id
           FROM employees WHERE organization_id = ?
         UNION ALL
         SELECT position_id AS id, position_title AS title, department_id
           FROM organization_invites WHERE organization_id = ?`,
      )
      .all(
        organizationId,
        organizationId,
        organizationId,
        organizationId,
      ) as PositionIdentityRow[];
    const normalizedPosition = positionTitle
      ? normalizeAssignmentName(positionTitle)
      : null;
    const existingPosition = normalizedPosition
      ? positionRows.find(
          (row) =>
            row.id &&
            row.title &&
            row.department_id === departmentId &&
            normalizeAssignmentName(row.title) === normalizedPosition,
        )
      : undefined;
    if (
      requestedPositionId &&
      existingPosition?.id &&
      existingPosition.id !== requestedPositionId
    ) {
      throw new Error('该职位名称已绑定其他职位 ID');
    }
    if (requestedPositionId) {
      const conflicting = positionRows.find(
        (row) =>
          row.id === requestedPositionId &&
          (row.department_id !== departmentId ||
            !row.title ||
            normalizeAssignmentName(row.title) !== normalizedPosition),
      );
      if (conflicting) throw new Error('该职位 ID 已绑定其他部门或职位名称');
    }
    const positionId = positionTitle
      ? (requestedPositionId ??
        existingPosition?.id ??
        stableAssignmentId(
          'pos',
          organizationId,
          departmentId,
          normalizedPosition,
        ))
      : null;

    assertIdentityIdIsTenantSafe(
      database,
      'department',
      departmentId,
      organizationId,
      '该部门 ID',
    );
    assertIdentityIdIsTenantSafe(
      database,
      'position',
      positionId,
      organizationId,
      '该职位 ID',
    );

    if (department && departmentId) {
      database
        .prepare(
          `INSERT OR IGNORE INTO organization_departments (id, organization_id, name)
           VALUES (?, ?, ?)`,
        )
        .run(departmentId, organizationId, department);
      const persisted = database
        .prepare(
          `SELECT name FROM organization_departments
           WHERE id = ? AND organization_id = ?`,
        )
        .get(departmentId, organizationId) as { name: string } | undefined;
      if (
        !persisted ||
        normalizeAssignmentName(persisted.name) !== normalizedDepartment
      ) {
        throw new Error('部门目录写入冲突');
      }
    }
    if (positionTitle && positionId && departmentId) {
      database
        .prepare(
          `INSERT OR IGNORE INTO organization_positions
            (id, organization_id, department_id, title, role_mapping)
           VALUES (?, ?, ?, ?, 'member')`,
        )
        .run(positionId, organizationId, departmentId, positionTitle);
      const persisted = database
        .prepare(
          `SELECT department_id, title FROM organization_positions
           WHERE id = ? AND organization_id = ?`,
        )
        .get(positionId, organizationId) as
        { department_id: string; title: string } | undefined;
      if (
        !persisted ||
        persisted.department_id !== departmentId ||
        normalizeAssignmentName(persisted.title) !== normalizedPosition
      ) {
        throw new Error('职位目录写入冲突');
      }
    }

    return { department, departmentId, positionTitle, positionId };
  });
}
