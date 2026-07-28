/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  normalizeAssignmentName,
  stableAssignmentId,
} from './organizationStructureRepository.js';

interface LegacyDepartmentRow {
  organization_id: string;
  department_id: string | null;
  department: string;
}

interface LegacyPositionRow {
  organization_id: string;
  department_id: string;
  position_id: string | null;
  position_title: string;
}

interface DepartmentDirectoryRow {
  id: string;
  organization_id: string;
  name: string;
}

interface PositionDirectoryRow {
  id: string;
  organization_id: string;
  department_id: string;
  title: string;
}

function departmentKey(organizationId: string, name: string): string {
  return `${organizationId}\0${normalizeAssignmentName(name)}`;
}

function positionKey(
  organizationId: string,
  departmentId: string,
  title: string,
): string {
  return `${organizationId}\0${departmentId}\0${normalizeAssignmentName(title)}`;
}

function addUniqueSemanticRow<T extends { id: string }>(
  rows: Map<string, T>,
  key: string,
  row: T,
  label: string,
): void {
  const existing = rows.get(key);
  if (existing && existing.id !== row.id) {
    throw new Error(`${label} directory contains conflicting normalized names`);
  }
  rows.set(key, row);
}

/**
 * Migrates pre-v4 department and position fields into the authoritative
 * organization directory. Any ambiguous or cross-tenant identity aborts the
 * whole migration instead of leaving partially linked accounts.
 */
export function backfillLegacyOrganizationStructure(database: Database): void {
  database.exec('SAVEPOINT organization_structure_backfill');
  try {
    const departmentsById = new Map<string, DepartmentDirectoryRow>();
    const departmentsByName = new Map<string, DepartmentDirectoryRow>();
    for (const row of database
      .prepare(`SELECT id, organization_id, name FROM organization_departments`)
      .all() as DepartmentDirectoryRow[]) {
      departmentsById.set(row.id, row);
      addUniqueSemanticRow(
        departmentsByName,
        departmentKey(row.organization_id, row.name),
        row,
        'Department',
      );
    }

    const departments = database
      .prepare(
        `SELECT organization_id, department_id, department FROM accounts
         WHERE deleted_at IS NULL AND department IS NOT NULL
           AND trim(department) <> ''
         UNION
         SELECT organization_id, department_id, department FROM employees
         WHERE department IS NOT NULL AND trim(department) <> ''`,
      )
      .all() as LegacyDepartmentRow[];
    departments.sort(
      (left, right) =>
        Number(Boolean(right.department_id)) -
        Number(Boolean(left.department_id)),
    );

    const insertDepartment = database.prepare(
      `INSERT INTO organization_departments (id, organization_id, name)
       VALUES (?, ?, ?)`,
    );
    const linkAccountDepartment = database.prepare(
      `UPDATE accounts SET department_id = ?
       WHERE organization_id = ? AND department_id IS NULL AND department = ?`,
    );
    const linkEmployeeDepartment = database.prepare(
      `UPDATE employees SET department_id = ?
       WHERE organization_id = ? AND department_id IS NULL AND department = ?`,
    );

    for (const row of departments) {
      const displayName = row.department.trim();
      const semanticKey = departmentKey(row.organization_id, displayName);
      const requestedId = row.department_id || null;
      const existingByName = departmentsByName.get(semanticKey);
      const id =
        requestedId ??
        existingByName?.id ??
        stableAssignmentId(
          'dept',
          row.organization_id,
          normalizeAssignmentName(displayName),
        );
      const existingById = departmentsById.get(id);
      if (
        existingById &&
        (existingById.organization_id !== row.organization_id ||
          departmentKey(existingById.organization_id, existingById.name) !==
            semanticKey)
      ) {
        throw new Error('Department id belongs to another directory identity');
      }
      if (existingByName && existingByName.id !== id) {
        throw new Error('Department name is already bound to another id');
      }
      if (!existingById) {
        const created: DepartmentDirectoryRow = {
          id,
          organization_id: row.organization_id,
          name: displayName,
        };
        insertDepartment.run(id, row.organization_id, displayName);
        departmentsById.set(id, created);
        departmentsByName.set(semanticKey, created);
      }
      linkAccountDepartment.run(id, row.organization_id, row.department);
      linkEmployeeDepartment.run(id, row.organization_id, row.department);
    }

    const positionsById = new Map<string, PositionDirectoryRow>();
    const positionsByName = new Map<string, PositionDirectoryRow>();
    for (const row of database
      .prepare(
        `SELECT id, organization_id, department_id, title
         FROM organization_positions`,
      )
      .all() as PositionDirectoryRow[]) {
      positionsById.set(row.id, row);
      addUniqueSemanticRow(
        positionsByName,
        positionKey(row.organization_id, row.department_id, row.title),
        row,
        'Position',
      );
    }

    const positions = database
      .prepare(
        `SELECT organization_id, department_id, position_id, position_title
         FROM accounts
         WHERE deleted_at IS NULL AND department_id IS NOT NULL
           AND position_title IS NOT NULL AND trim(position_title) <> ''
         UNION
         SELECT organization_id, department_id, position_id, position_title
         FROM employees
         WHERE department_id IS NOT NULL
           AND position_title IS NOT NULL AND trim(position_title) <> ''`,
      )
      .all() as LegacyPositionRow[];
    positions.sort(
      (left, right) =>
        Number(Boolean(right.position_id)) - Number(Boolean(left.position_id)),
    );

    const insertPosition = database.prepare(
      `INSERT INTO organization_positions
        (id, organization_id, department_id, title, role_mapping)
       VALUES (?, ?, ?, ?, 'member')`,
    );
    const linkAccountPosition = database.prepare(
      `UPDATE accounts SET position_id = ?
       WHERE organization_id = ? AND position_id IS NULL
         AND department_id = ? AND position_title = ?`,
    );
    const linkEmployeePosition = database.prepare(
      `UPDATE employees SET position_id = ?
       WHERE organization_id = ? AND position_id IS NULL
         AND department_id = ? AND position_title = ?`,
    );

    for (const row of positions) {
      const department = departmentsById.get(row.department_id);
      if (!department || department.organization_id !== row.organization_id) {
        throw new Error('Position department belongs to another organization');
      }
      const displayTitle = row.position_title.trim();
      const semanticKey = positionKey(
        row.organization_id,
        row.department_id,
        displayTitle,
      );
      const requestedId = row.position_id || null;
      const existingByName = positionsByName.get(semanticKey);
      const id =
        requestedId ??
        existingByName?.id ??
        stableAssignmentId(
          'pos',
          row.organization_id,
          row.department_id,
          normalizeAssignmentName(displayTitle),
        );
      const existingById = positionsById.get(id);
      if (
        existingById &&
        (existingById.organization_id !== row.organization_id ||
          existingById.department_id !== row.department_id ||
          positionKey(
            existingById.organization_id,
            existingById.department_id,
            existingById.title,
          ) !== semanticKey)
      ) {
        throw new Error('Position id belongs to another directory identity');
      }
      if (existingByName && existingByName.id !== id) {
        throw new Error('Position name is already bound to another id');
      }
      if (!existingById) {
        const created: PositionDirectoryRow = {
          id,
          organization_id: row.organization_id,
          department_id: row.department_id,
          title: displayTitle,
        };
        insertPosition.run(
          id,
          row.organization_id,
          row.department_id,
          displayTitle,
        );
        positionsById.set(id, created);
        positionsByName.set(semanticKey, created);
      }
      linkAccountPosition.run(
        id,
        row.organization_id,
        row.department_id,
        row.position_title,
      );
      linkEmployeePosition.run(
        id,
        row.organization_id,
        row.department_id,
        row.position_title,
      );
    }

    database.exec('RELEASE SAVEPOINT organization_structure_backfill');
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT organization_structure_backfill');
    database.exec('RELEASE SAVEPOINT organization_structure_backfill');
    throw error;
  }
}
