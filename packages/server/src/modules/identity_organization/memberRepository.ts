/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from '../data_platform/index.js';

export interface MemberAssignmentIdentity {
  department: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
}

export interface CreateEmployeeInput {
  id: string;
  name: string;
  role?: string;
  department?: string;
  invite_code?: string;
  personality?: string;
  departmentId?: string;
  positionId?: string;
  positionTitle?: string;
  organizationId?: string;
}

export interface UpdateEmployeeOnboardingProfileInput {
  employeeId: string;
  organizationId: string;
  role: string | null;
  personality: string;
}

export interface EmployeeRecord {
  [key: string]: unknown;
  id: string;
  organization_id?: string;
  name: string;
  role?: string | null;
  department?: string | null;
  status?: string;
  onboarded_at?: string;
}

export interface MemberRepositoryStore {
  db(): Database;
  defaultOrganizationId: string;
  organizationExists(organizationId: string): boolean;
  resolveAssignmentIdentity(
    database: Database,
    organizationId: string,
    input: {
      department?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
    },
  ): MemberAssignmentIdentity;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
  legacyMemoryPaths?(): readonly string[];
}

interface LegacyMemoryUser {
  id: string;
  name: string;
  role?: string;
  teamIds?: string[];
  createdAt?: string;
}

interface LegacyMemoryTeam {
  id: string;
  name: string;
}

interface LegacyMemoryStore {
  users: LegacyMemoryUser[];
  teams: LegacyMemoryTeam[];
}

function legacyMemoryCandidates(
  store: MemberRepositoryStore,
): readonly string[] {
  return (
    store.legacyMemoryPaths?.() ?? [
      path.join(process.cwd(), '.otto', 'org', 'memory-store.json'),
      path.join(os.homedir(), '.otto-user', 'org', 'memory-store.json'),
    ]
  );
}

function loadLegacyMemoryStore(
  store: MemberRepositoryStore,
): LegacyMemoryStore {
  for (const candidate of legacyMemoryCandidates(store)) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(
        fs.readFileSync(candidate, 'utf8'),
      ) as Partial<LegacyMemoryStore>;
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        teams: Array.isArray(parsed.teams) ? parsed.teams : [],
      };
    } catch {
      // A damaged legacy cache must not block the authoritative SQLite directory.
    }
  }
  return { users: [], teams: [] };
}

function legacyEmployee(
  store: MemberRepositoryStore,
  id: string,
): EmployeeRecord | null {
  const memory = loadLegacyMemoryStore(store);
  const user = memory.users.find((candidate) => candidate.id === id);
  if (!user) return null;
  const team = memory.teams.find(
    (candidate) => candidate.id === user.teamIds?.[0],
  );
  return {
    id: user.id,
    name: user.name,
    role: user.role ?? null,
    department: team?.name ?? null,
    status: 'active',
    onboarded_at: user.createdAt,
  };
}

export function createEmployeeInRepository(
  store: MemberRepositoryStore,
  employee: CreateEmployeeInput,
): void {
  const organizationId = employee.organizationId || store.defaultOrganizationId;
  if (!store.organizationExists(organizationId)) {
    throw new Error('Organization not found');
  }

  const database = store.db();
  const assignment = store.resolveAssignmentIdentity(database, organizationId, {
    department: employee.department,
    departmentId: employee.departmentId,
    positionId: employee.positionId,
    positionTitle: employee.positionTitle,
  });
  database
    .prepare(
      `INSERT INTO employees
       (id, organization_id, name, role, department, department_id, position_id, position_title,
        invite_code, personality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      employee.id,
      organizationId,
      employee.name,
      employee.role || null,
      assignment.department,
      assignment.departmentId,
      assignment.positionId,
      assignment.positionTitle,
      employee.invite_code || null,
      employee.personality || null,
    );
  store.audit(
    'onboard',
    employee.id,
    `Employee ${employee.name} onboarded to ${assignment.department || 'unassigned'}`,
    organizationId,
  );
}

export function getEmployeeFromRepository(
  store: MemberRepositoryStore,
  id: string,
  organizationId?: string,
): EmployeeRecord | null {
  const targetOrganizationId = organizationId ?? store.defaultOrganizationId;
  const local = store
    .db()
    .prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?')
    .get(id, targetOrganizationId);
  if (local) return local as EmployeeRecord;

  // Legacy OrgMemoryStore data predates tenancy and may only belong to the default organization.
  if (targetOrganizationId !== store.defaultOrganizationId) return null;
  return legacyEmployee(store, id);
}

export function listEmployeesFromRepository(
  store: MemberRepositoryStore,
  department?: string,
  organizationId = store.defaultOrganizationId,
): EmployeeRecord[] {
  const local = (
    department
      ? store
          .db()
          .prepare(
            `SELECT * FROM employees
           WHERE organization_id = ? AND department = ? AND status = ?
           ORDER BY onboarded_at`,
          )
          .all(organizationId, department, 'active')
      : store
          .db()
          .prepare(
            `SELECT * FROM employees
           WHERE organization_id = ? AND status = ? ORDER BY onboarded_at`,
          )
          .all(organizationId, 'active')
  ) as EmployeeRecord[];

  if (organizationId !== store.defaultOrganizationId) return local;

  const memory = loadLegacyMemoryStore(store);
  const localIds = new Set(local.map((employee) => employee.id));
  const legacy = memory.users
    .filter((user) => !localIds.has(user.id))
    .map((user): EmployeeRecord => {
      const team = memory.teams.find(
        (candidate) => candidate.id === user.teamIds?.[0],
      );
      return {
        id: user.id,
        name: user.name,
        role: user.role ?? null,
        department: team?.name ?? null,
        status: 'active',
        onboarded_at: user.createdAt,
      };
    })
    .filter((employee) => !department || employee.department === department);
  return [...local, ...legacy];
}

export function updateEmployeeOnboardingProfileInRepository(
  store: MemberRepositoryStore,
  input: UpdateEmployeeOnboardingProfileInput,
): EmployeeRecord | null {
  const result = store
    .db()
    .prepare(
      `UPDATE employees SET role = ?, personality = ?
       WHERE id = ? AND organization_id = ?`,
    )
    .run(
      input.role,
      input.personality,
      input.employeeId,
      input.organizationId,
    ) as { changes?: number | bigint };
  if (Number(result.changes ?? 0) === 0) return null;
  store.audit(
    'onboarding_profile_updated',
    input.employeeId,
    'Employee onboarding profile updated',
    input.organizationId,
  );
  return getEmployeeFromRepository(
    store,
    input.employeeId,
    input.organizationId,
  );
}

export function offboardEmployeeInRepository(
  store: MemberRepositoryStore,
  id: string,
  organizationId?: string,
): boolean {
  const employee = getEmployeeFromRepository(store, id, organizationId);
  if (!employee?.organization_id) return false;

  const result = store
    .db()
    .prepare(
      `UPDATE employees SET status = ?, offboarded_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    )
    .run('offboarded', id, employee.organization_id) as {
    changes?: number | bigint;
  };
  const changed = Number(result.changes ?? 0) > 0;
  if (changed) {
    store.audit(
      'offboard',
      id,
      'Employee offboarded',
      employee.organization_id,
    );
  }
  return changed;
}

/** Includes offboarded employees so backups preserve historical ownership. */
export function listEmployeesForBackup(
  store: Pick<MemberRepositoryStore, 'db'>,
  organizationId: string,
): EmployeeRecord[] {
  return store
    .db()
    .prepare(
      `SELECT * FROM employees
       WHERE organization_id = ?
       ORDER BY onboarded_at`,
    )
    .all(organizationId) as EmployeeRecord[];
}
