/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_ORGANIZATION_ID,
  getDB,
  getOrganization,
  resolveAssignmentIdentity,
} from './db.js';
import { logAudit } from './auditRepository.js';

export function createEmployee(emp: {
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
}): void {
  const organizationId = emp.organizationId || DEFAULT_ORGANIZATION_ID;
  if (!getOrganization(organizationId))
    throw new Error('Organization not found');
  const database = getDB();
  const assignment = resolveAssignmentIdentity(database, organizationId, {
    department: emp.department,
    departmentId: emp.departmentId,
    positionId: emp.positionId,
    positionTitle: emp.positionTitle,
  });
  database
    .prepare(
      `INSERT INTO employees
       (id, organization_id, name, role, department, department_id, position_id, position_title,
        invite_code, personality)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      emp.id,
      organizationId,
      emp.name,
      emp.role || null,
      assignment.department,
      assignment.departmentId,
      assignment.positionId,
      assignment.positionTitle,
      emp.invite_code || null,
      emp.personality || null,
    );
  logAudit(
    'onboard',
    emp.id,
    `Employee ${emp.name} onboarded to ${assignment.department || 'unassigned'}`,
    organizationId,
  );
}

export function getEmployee(id: string, organizationId?: string): any | null {
  // 1. 先查 SQLite（B套本地数据）
  const local = organizationId
    ? getDB()
        .prepare('SELECT * FROM employees WHERE id = ? AND organization_id = ?')
        .get(id, organizationId)
    : getDB().prepare('SELECT * FROM employees WHERE id = ?').get(id);
  if (local) return local;

  // 2. 降级查 OrgMemoryStore（A套飞书同步数据）
  // A 套历史数据没有租户字段，只能视为默认企业；绝不能并入其他企业。
  if (organizationId && organizationId !== DEFAULT_ORGANIZATION_ID) return null;
  try {
    const orgData = loadOrgMemoryStore();
    const user = orgData.users?.find((u: any) => u.id === id);
    if (user) {
      const team = orgData.teams?.find((t: any) => t.id === user.teamIds?.[0]);
      return {
        id: user.id,
        name: user.name,
        role: user.role,
        department: team?.name || null,
        status: 'active',
        onboarded_at: user.createdAt,
      };
    }
  } catch {
    /* A套数据不可用时降级返回null */
  }

  return null;
}

export function listEmployees(
  department?: string,
  organizationId = DEFAULT_ORGANIZATION_ID,
): any[] {
  // 1. 先查 SQLite
  let local: any[];
  if (department) {
    local = getDB()
      .prepare(
        `SELECT * FROM employees
       WHERE organization_id = ? AND department = ? AND status = ? ORDER BY onboarded_at`,
      )
      .all(organizationId, department, 'active');
  } else {
    local = getDB()
      .prepare(
        'SELECT * FROM employees WHERE organization_id = ? AND status = ? ORDER BY onboarded_at',
      )
      .all(organizationId, 'active');
  }

  // 2. 合并 OrgMemoryStore 的飞书同步数据（去重）
  if (organizationId !== DEFAULT_ORGANIZATION_ID) return local;
  try {
    const orgData = loadOrgMemoryStore();
    const localIds = new Set(local.map((e: any) => e.id));
    const orgUsers = (orgData.users || [])
      .filter((u: any) => !localIds.has(u.id))
      .map((u: any) => {
        const team = orgData.teams?.find((t: any) => t.id === u.teamIds?.[0]);
        return {
          id: u.id,
          name: u.name,
          role: u.role,
          department: team?.name || null,
          status: 'active',
          onboarded_at: u.createdAt,
        };
      })
      .filter((u: any) => !department || u.department === department);

    return [...local, ...orgUsers];
  } catch {
    return local;
  }
}

/**
 * 加载 A套（OrgMemoryStore）的数据。
 * 用于统一两套企业系统的员工数据。
 */
function loadOrgMemoryStore(): any {
  // 尝试几个可能的路径
  const candidates = [
    path.join(process.cwd(), '.otto', 'org', 'memory-store.json'),
    path.join(os.homedir(), '.otto-user', 'org', 'memory-store.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {
      /* skip */
    }
  }
  return { users: [], teams: [], companies: [], licenses: [] };
}

export function offboardEmployee(id: string, organizationId?: string): boolean {
  const employee = getEmployee(id, organizationId);
  if (!employee || !employee.organization_id) return false;
  const result = getDB()
    .prepare(
      `UPDATE employees SET status = ?, offboarded_at = datetime('now')
     WHERE id = ? AND organization_id = ?`,
    )
    .run('offboarded', id, employee.organization_id) as {
    changes?: number | bigint;
  };
  const changed = Number(result.changes ?? 0) > 0;
  if (changed)
    logAudit('offboard', id, 'Employee offboarded', employee.organization_id);
  return changed;
}
