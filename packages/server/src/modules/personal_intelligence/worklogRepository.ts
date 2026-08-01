/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { buildWorklogReport } from './worklogAnalytics.js';
import { normalizeCostCNY, normalizeTokens } from './worklogEstimates.js';
import type {
  LogWorkTaskInput,
  PersonalWorklogEmployee,
  PersonalWorklogOrganization,
  WorklogRecord,
  WorklogReport,
} from './worklogTypes.js';

const MAX_TASK_TYPE_LENGTH = 160;
const MAX_CONTEXT_LENGTH = 20_000;
const MAX_RESULT_LENGTH = 40_000;
const MAX_DURATION_MINUTES = 43_200;
const MAX_TOKENS_PER_TASK = 1_000_000_000;
const MAX_COST_CNY_PER_TASK = 10_000_000;

export interface WorklogRepositoryStore<
  TEmployee extends PersonalWorklogEmployee = PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization =
    PersonalWorklogOrganization,
> {
  db(): Database;
  defaultOrganizationId: string;
  getOrganization(organizationId: string): TOrganization | null;
  getEmployee(employeeId: string, organizationId: string): TEmployee | null;
  listActiveEmployees(
    department: string | undefined,
    organizationId: string,
  ): TEmployee[];
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

function normalizeRequiredText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${fieldName} required`);
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} 不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | null {
  if (value == null) return null;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} 不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

function normalizeDuration(value: unknown): number {
  if (value == null || value === '') return 0;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error('duration_min 必须是非负数字');
  }
  if (number > MAX_DURATION_MINUTES) {
    throw new Error(`duration_min 不能超过 ${MAX_DURATION_MINUTES}`);
  }
  return number;
}

function normalizeBoundedMetric(
  value: unknown,
  fieldName: 'tokens_used' | 'cost_cny',
  maximum: number,
): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number) && number > maximum) {
    throw new Error(`${fieldName} 不能超过 ${maximum}`);
  }
  return fieldName === 'tokens_used'
    ? normalizeTokens(value)
    : normalizeCostCNY(value);
}

function normalizePeriodDays(value: number): number {
  const period = Number.isFinite(value) ? Math.floor(value) : 30;
  return Math.min(365, Math.max(1, period || 30));
}

function normalizeHistoryLimit(value: number): number {
  const limit = Number.isFinite(value) ? Math.floor(value) : 20;
  return Math.min(100, Math.max(1, limit || 1));
}

function activeOrganization<
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
>(
  store: WorklogRepositoryStore<TEmployee, TOrganization>,
  organizationId: string,
): TOrganization {
  const organization = store.getOrganization(organizationId);
  if (!organization) throw new Error('Organization not found');
  if (organization.status !== 'active') {
    throw new Error('Organization is disabled');
  }
  return organization;
}

export function logWorkTaskInRepository<
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
>(
  store: WorklogRepositoryStore<TEmployee, TOrganization>,
  input: LogWorkTaskInput,
): void {
  const organizationId =
    input.organizationId?.trim() || store.defaultOrganizationId;
  activeOrganization(store, organizationId);
  const employee = store.getEmployee(input.employee_id, organizationId);
  if (
    !employee ||
    employee.organization_id !== organizationId ||
    employee.status !== 'active'
  ) {
    throw new Error('Employee not found');
  }

  const taskType = normalizeRequiredText(
    input.task_type,
    'task_type',
    MAX_TASK_TYPE_LENGTH,
  );
  const context = normalizeOptionalText(
    input.context,
    'context',
    MAX_CONTEXT_LENGTH,
  );
  const result = normalizeOptionalText(
    input.result,
    'result',
    MAX_RESULT_LENGTH,
  );
  const duration = normalizeDuration(input.duration_min);
  const tokens = normalizeBoundedMetric(
    input.tokens_used,
    'tokens_used',
    MAX_TOKENS_PER_TASK,
  );
  const cost = normalizeBoundedMetric(
    input.cost_cny,
    'cost_cny',
    MAX_COST_CNY_PER_TASK,
  );

  const database = store.db();
  const ownsTransaction = !database.inTransaction;
  let transactionStarted = false;
  if (ownsTransaction) {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
  }
  try {
    database
      .prepare(
        `INSERT INTO task_logs
         (organization_id, employee_id, task_type, context, result,
          duration_min, tokens_used, cost_cny)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        organizationId,
        employee.id,
        taskType,
        context,
        result,
        duration,
        tokens,
        cost,
      );
    store.audit(
      'learn',
      employee.id,
      `Task: ${taskType} (${duration}min)`,
      organizationId,
    );
    if (ownsTransaction) {
      database.exec('COMMIT');
      transactionStarted = false;
    }
  } catch (error) {
    if (transactionStarted) {
      // node:sqlite on Node 22 can report `inTransaction === false` after an
      // ABORT trigger while still retaining prior statements. Always attempt
      // the rollback we own; engines that already closed it simply reject it.
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the original write/audit failure as the observable error.
      }
    }
    throw error;
  }
}

export function getTaskHistoryFromRepository<
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
>(
  store: WorklogRepositoryStore<TEmployee, TOrganization>,
  employeeId: string,
  limit = 20,
  organizationId = store.defaultOrganizationId,
): WorklogRecord[] {
  activeOrganization(store, organizationId);
  if (!store.getEmployee(employeeId, organizationId)) return [];
  return store
    .db()
    .prepare(
      `SELECT * FROM task_logs
       WHERE employee_id = ? AND organization_id = ?
       ORDER BY datetime(created_at) DESC, id DESC LIMIT ?`,
    )
    .all(
      employeeId,
      organizationId,
      normalizeHistoryLimit(limit),
    ) as WorklogRecord[];
}

export function getWorklogReportFromRepository<
  TEmployee extends PersonalWorklogEmployee,
  TOrganization extends PersonalWorklogOrganization,
>(
  store: WorklogRepositoryStore<TEmployee, TOrganization>,
  periodDays = 30,
  department?: string,
  organizationId = store.defaultOrganizationId,
): WorklogReport {
  activeOrganization(store, organizationId);
  const safePeriodDays = normalizePeriodDays(periodDays);
  const normalizedDepartment = department?.trim() || undefined;
  if (normalizedDepartment && normalizedDepartment.length > 160) {
    throw new Error('department 不能超过 160 个字符');
  }
  const since = new Date(
    Date.now() - safePeriodDays * 86_400_000,
  ).toISOString();
  let tasks = store
    .db()
    .prepare(
      `SELECT * FROM task_logs
       WHERE organization_id = ? AND datetime(created_at) >= datetime(?)
       ORDER BY datetime(created_at), id`,
    )
    .all(organizationId, since) as WorklogRecord[];

  if (normalizedDepartment) {
    const departmentByEmployee = new Map<string, string | null>();
    tasks = tasks.filter((task) => {
      if (!departmentByEmployee.has(task.employee_id)) {
        const employee = store.getEmployee(task.employee_id, organizationId);
        departmentByEmployee.set(
          task.employee_id,
          employee?.department ?? null,
        );
      }
      return (
        departmentByEmployee.get(task.employee_id) === normalizedDepartment
      );
    });
  }

  return buildWorklogReport(
    tasks,
    store.listActiveEmployees(normalizedDepartment, organizationId).length,
    safePeriodDays,
  );
}

export function listWorklogsForBackup(
  store: Pick<WorklogRepositoryStore, 'db'>,
  organizationId: string,
): WorklogRecord[] {
  return store
    .db()
    .prepare(
      `SELECT * FROM task_logs
       WHERE organization_id = ?
       ORDER BY created_at DESC
       LIMIT 1000`,
    )
    .all(organizationId) as WorklogRecord[];
}
