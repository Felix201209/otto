/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomInt } from 'node:crypto';
import type { Database } from '../data_platform/index.js';
import type {
  DepartmentInviteOrganization,
  DepartmentInviteResolution,
  DepartmentInviteRow,
  DepartmentInviteValidationResult,
} from './departmentInviteTypes.js';

const DEPARTMENT_INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEPARTMENT_INVITE_LENGTH = 6;
const MAX_DEPARTMENT_LENGTH = 160;
const MAX_CREATED_BY_LENGTH = 160;
const MAX_INVITE_USES = 10_000;
const MAX_CODE_GENERATION_ATTEMPTS = 16;

export interface DepartmentInviteRepositoryStore {
  db(): Database;
  defaultOrganizationId: string;
  getOrganization(organizationId: string): DepartmentInviteOrganization | null;
  logAudit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
  generateCode?(): string;
  now?(): number;
}

export type DepartmentInviteConsumer = (
  invite: DepartmentInviteResolution,
) => void;

function normalizeDepartment(department: string): string {
  const normalized = department.trim();
  if (!normalized) throw new Error('department required');
  if (normalized.length > MAX_DEPARTMENT_LENGTH) {
    throw new Error(`department 不能超过 ${MAX_DEPARTMENT_LENGTH} 个字符`);
  }
  return normalized;
}

function normalizeCreatedBy(createdBy?: string): string {
  const normalized = createdBy?.trim() || 'admin';
  if (normalized.length > MAX_CREATED_BY_LENGTH) {
    throw new Error(`createdBy 不能超过 ${MAX_CREATED_BY_LENGTH} 个字符`);
  }
  return normalized;
}

function normalizeMaxUses(maxUses: number): number {
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_INVITE_USES) {
    throw new Error(`maxUses 必须是 1-${MAX_INVITE_USES} 的整数`);
  }
  return maxUses;
}

function normalizeCode(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  return new RegExp(
    `^[${DEPARTMENT_INVITE_ALPHABET}]{${DEPARTMENT_INVITE_LENGTH}}$`,
  ).test(normalized)
    ? normalized
    : null;
}

function generateDepartmentInviteCode(): string {
  let code = '';
  for (let index = 0; index < DEPARTMENT_INVITE_LENGTH; index += 1) {
    code +=
      DEPARTMENT_INVITE_ALPHABET[randomInt(DEPARTMENT_INVITE_ALPHABET.length)];
  }
  return code;
}

function isCodeCollision(error: unknown): boolean {
  return /UNIQUE constraint failed:\s*invite_codes\.code/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function sqliteTimestampMs(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(
    /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`,
  );
}

function withImmediateTransaction<T>(
  database: Database,
  operation: () => T,
): T {
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (ownsTransaction) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function requireActiveOrganization(
  store: DepartmentInviteRepositoryStore,
  organizationId: string,
): DepartmentInviteOrganization {
  const organization = store.getOrganization(organizationId);
  if (!organization) throw new Error('Organization not found');
  if (organization.status !== 'active')
    throw new Error('Organization is disabled');
  return organization;
}

export function createDepartmentInviteInRepository(
  store: DepartmentInviteRepositoryStore,
  department: string,
  createdBy?: string,
  maxUses = 1,
  organizationId = store.defaultOrganizationId,
): string {
  const normalizedDepartment = normalizeDepartment(department);
  const normalizedCreatedBy = normalizeCreatedBy(createdBy);
  const normalizedMaxUses = normalizeMaxUses(maxUses);
  const database = store.db();

  return withImmediateTransaction(database, () => {
    requireActiveOrganization(store, organizationId);

    let code: string | null = null;
    for (
      let attempt = 0;
      attempt < MAX_CODE_GENERATION_ATTEMPTS;
      attempt += 1
    ) {
      const candidate = normalizeCode(
        store.generateCode?.() ?? generateDepartmentInviteCode(),
      );
      if (!candidate) throw new Error('generated invite code is invalid');
      try {
        database
          .prepare(
            `INSERT INTO invite_codes
             (code, organization_id, department, max_uses, created_by)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            candidate,
            organizationId,
            normalizedDepartment,
            normalizedMaxUses,
            normalizedCreatedBy,
          );
        code = candidate;
        break;
      } catch (error) {
        if (!isCodeCollision(error)) throw error;
      }
    }

    if (!code) throw new Error('Unable to allocate a unique invite code');
    store.logAudit(
      'invite_create',
      null,
      `Code ${code} for ${normalizedDepartment}`,
      organizationId,
    );
    return code;
  });
}

export function consumeDepartmentInviteInRepository(
  store: DepartmentInviteRepositoryStore,
  code: string,
  organizationId?: string,
  consumer?: DepartmentInviteConsumer,
): DepartmentInviteValidationResult {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) return { valid: false, error: 'Invalid invite code' };
  const database = store.db();

  return withImmediateTransaction(database, () => {
    const row = (
      organizationId
        ? database
            .prepare(
              `SELECT code, organization_id, department, max_uses, used_count,
                    created_by, created_at, expires_at
             FROM invite_codes
             WHERE code = ? AND organization_id = ?`,
            )
            .get(normalizedCode, organizationId)
        : database
            .prepare(
              `SELECT code, organization_id, department, max_uses, used_count,
                    created_by, created_at, expires_at
             FROM invite_codes
             WHERE code = ?`,
            )
            .get(normalizedCode)
    ) as DepartmentInviteRow | undefined;

    if (!row) return { valid: false, error: 'Invalid invite code' };
    const organization = store.getOrganization(row.organization_id);
    if (!organization || organization.status !== 'active') {
      return { valid: false, error: 'Organization is disabled' };
    }
    if (row.used_count >= row.max_uses) {
      return { valid: false, error: 'Invite code already used' };
    }
    if (row.expires_at) {
      const expiresAt = sqliteTimestampMs(row.expires_at);
      if (
        !Number.isFinite(expiresAt) ||
        expiresAt < (store.now?.() ?? Date.now())
      ) {
        return { valid: false, error: 'Invite code expired' };
      }
    }

    const update = database
      .prepare(
        `UPDATE invite_codes
         SET used_count = used_count + 1
         WHERE code = ? AND organization_id = ? AND used_count = ?
           AND used_count < max_uses`,
      )
      .run(normalizedCode, row.organization_id, row.used_count);
    if (Number(update.changes) !== 1) {
      return { valid: false, error: 'Invite code already used' };
    }

    const resolution = {
      department: row.department,
      organizationId: row.organization_id,
    };
    consumer?.(resolution);
    return { valid: true, ...resolution };
  });
}

export function listDepartmentInvitesForBackup(
  store: Pick<DepartmentInviteRepositoryStore, 'db'>,
  organizationId: string,
): DepartmentInviteRow[] {
  return store
    .db()
    .prepare(
      `SELECT * FROM invite_codes
       WHERE organization_id = ?
       ORDER BY created_at, code`,
    )
    .all(organizationId) as DepartmentInviteRow[];
}
