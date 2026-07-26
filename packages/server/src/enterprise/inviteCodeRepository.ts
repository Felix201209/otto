/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomInt } from 'node:crypto';

import {
  DEFAULT_ORGANIZATION_ID,
  getDB,
  getOrganization,
  logAudit,
} from './db.js';

export function createInviteCode(
  department: string,
  createdBy?: string,
  maxUses = 1,
  organizationId = DEFAULT_ORGANIZATION_ID,
): string {
  if (!getOrganization(organizationId))
    throw new Error('Organization not found');
  const code = generateCode();
  getDB()
    .prepare(
      `INSERT INTO invite_codes (code, organization_id, department, max_uses, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(code, organizationId, department, maxUses, createdBy || 'admin');
  logAudit(
    'invite_create',
    null,
    `Code ${code} for ${department}`,
    organizationId,
  );
  return code;
}

export function validateInviteCode(
  code: string,
  organizationId?: string,
): {
  valid: boolean;
  department?: string;
  organizationId?: string;
  error?: string;
} {
  const row: any = organizationId
    ? getDB()
        .prepare(
          'SELECT * FROM invite_codes WHERE code = ? AND organization_id = ?',
        )
        .get(code, organizationId)
    : getDB().prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!row) return { valid: false, error: 'Invalid invite code' };
  if (row.used_count >= row.max_uses)
    return { valid: false, error: 'Invite code already used' };
  if (row.expires_at && new Date(row.expires_at) < new Date())
    return { valid: false, error: 'Invite code expired' };
  const result = getDB()
    .prepare(
      'UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
    )
    .run(code);
  if (result.changes === 0)
    return { valid: false, error: 'Invite code already used' };
  return {
    valid: true,
    department: row.department,
    organizationId: row.organization_id,
  };
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
  return code;
}
