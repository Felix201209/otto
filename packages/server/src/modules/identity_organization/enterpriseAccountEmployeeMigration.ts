/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import type { Database } from '../data_platform/index.js';
import {
  normalizeAssignmentName,
  stableAssignmentId,
} from './organizationStructureRepository.js';

interface MigrationAccountRow {
  id: string;
  organization_id: string;
  employee_id: string | null;
  name: string;
  role: string | null;
  department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  status: 'active' | 'disabled';
  created_at: string;
}

interface MigrationEmployeeRow {
  id: string;
  organization_id: string;
}

export interface EnterpriseAccountEmployeeMigrationOptions {
  createEmployeeId?: () => string;
}

/** Repairs legacy enterprise accounts that predate employee records. */
export function backfillEnterpriseAccountEmployees(
  database: Database,
  options: EnterpriseAccountEmployeeMigrationOptions = {},
): void {
  const createEmployeeId =
    options.createEmployeeId ?? (() => `emp_${randomUUID()}`);
  const accounts = database
    .prepare(
      `SELECT id, organization_id, employee_id, name, role, department, department_id,
              position_id, position_title, status, created_at
       FROM accounts
       WHERE account_type = 'enterprise' AND deleted_at IS NULL`,
    )
    .all() as MigrationAccountRow[];
  const findEmployee = database.prepare(
    'SELECT id, organization_id FROM employees WHERE id = ?',
  );
  const insertEmployee = database.prepare(
    `INSERT INTO employees
       (id, organization_id, name, role, department, department_id, position_id,
        position_title, status, onboarded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const bindAccount = database.prepare(
    'UPDATE accounts SET employee_id = ? WHERE id = ? AND organization_id = ?',
  );
  const syncAccountAssignments = database.prepare(
    `UPDATE accounts SET department_id = ?, position_id = ?
     WHERE id = ? AND organization_id = ?`,
  );
  const syncEmployee = database.prepare(
    `UPDATE employees
     SET name = ?,
         role = COALESCE(?, role),
         department = COALESCE(?, department),
         department_id = COALESCE(?, department_id),
         position_id = COALESCE(?, position_id),
         position_title = COALESCE(?, position_title)
     WHERE id = ? AND organization_id = ?`,
  );
  const syncAccount = database.prepare(
    `UPDATE accounts
     SET role = COALESCE(role, (SELECT role FROM employees WHERE id = ?)),
         department = COALESCE(department, (SELECT department FROM employees WHERE id = ?)),
         department_id = COALESCE(
           department_id,
           (SELECT department_id FROM employees WHERE id = ?)
         ),
         position_id = COALESCE(position_id, (SELECT position_id FROM employees WHERE id = ?)),
         position_title = COALESCE(
           position_title,
           (SELECT position_title FROM employees WHERE id = ?)
         )
     WHERE id = ? AND organization_id = ?`,
  );

  database.exec('SAVEPOINT backfill_enterprise_account_employees');
  try {
    for (const account of accounts) {
      const departmentId =
        account.department_id ??
        (account.department
          ? stableAssignmentId(
              'dept',
              account.organization_id,
              normalizeAssignmentName(account.department),
            )
          : null);
      const positionId =
        account.position_id ??
        (account.position_title
          ? stableAssignmentId(
              'pos',
              account.organization_id,
              departmentId,
              normalizeAssignmentName(account.position_title),
            )
          : null);
      if (
        departmentId !== account.department_id ||
        positionId !== account.position_id
      ) {
        syncAccountAssignments.run(
          departmentId,
          positionId,
          account.id,
          account.organization_id,
        );
        account.department_id = departmentId;
        account.position_id = positionId;
      }

      const linked = account.employee_id
        ? (findEmployee.get(account.employee_id) as
            MigrationEmployeeRow | undefined)
        : undefined;
      let employeeId =
        linked?.organization_id === account.organization_id ? linked.id : null;
      if (!employeeId) {
        employeeId = createEmployeeId();
        insertEmployee.run(
          employeeId,
          account.organization_id,
          account.name,
          account.role,
          account.department,
          account.department_id,
          account.position_id,
          account.position_title,
          account.status === 'active' ? 'active' : 'offboarded',
          account.created_at,
        );
        bindAccount.run(employeeId, account.id, account.organization_id);
      }

      syncEmployee.run(
        account.name,
        account.role,
        account.department,
        account.department_id,
        account.position_id,
        account.position_title,
        employeeId,
        account.organization_id,
      );
      syncAccount.run(
        employeeId,
        employeeId,
        employeeId,
        employeeId,
        employeeId,
        account.id,
        account.organization_id,
      );
    }
    database.exec('RELEASE SAVEPOINT backfill_enterprise_account_employees');
  } catch (error) {
    database.exec(
      'ROLLBACK TO SAVEPOINT backfill_enterprise_account_employees',
    );
    database.exec('RELEASE SAVEPOINT backfill_enterprise_account_employees');
    throw error;
  }
}
