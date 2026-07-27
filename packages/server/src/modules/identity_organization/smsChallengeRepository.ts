/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export const SMS_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SMS_CHALLENGE_COOLDOWN_MS = 60 * 1000;
export const SMS_CHALLENGE_HOURLY_LIMIT = 5;
export const SMS_CHALLENGE_MAX_ATTEMPTS = 5;

export interface SmsChallengeAccountView {
  id: string;
  organizationId: string;
  employeeId: string | null;
  phone: string | null;
  status: 'active' | 'disabled';
}

export interface SmsChallengeRepositoryStore<
  TAccountView extends SmsChallengeAccountView,
> {
  db(): Database;
  defaultOrganizationId: string;
  getAccount(accountId: string): TAccountView | null;
  organizationExists(organizationId: string): boolean;
  normalizePhone(phone: string): string;
  hashSecret(secret: string): string;
  secretMatches(secret: string, stored: string): boolean;
  createChallengeId(kind: 'login' | 'registration'): string;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

export type SmsChallengeIssueResult =
  | {
      ok: true;
      challengeId: string;
      expiresAt: string;
      retryAfterSeconds: number;
    }
  | {
      ok: false;
      reason: 'cooldown' | 'hourly_limit';
      retryAfterSeconds: number;
    };

export interface SmsRegistrationChallengeOptions {
  now?: number;
  department?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  positionTitle?: string | null;
  role?: string | null;
  organizationInviteId?: string | null;
}

export type SmsRegistrationVerifyResult =
  | {
      ok: true;
      phone: string;
      organizationId: string;
      organizationInviteId: string | null;
      department: string | null;
      departmentId: string | null;
      positionId: string | null;
      positionTitle: string | null;
      role: string | null;
    }
  | {
      ok: false;
      reason: 'invalid' | 'expired' | 'locked' | 'used';
      attemptsRemaining: number;
    };

export type SmsChallengeVerifyResult<
  TAccountView extends SmsChallengeAccountView,
> =
  | { ok: true; account: TAccountView }
  | {
      ok: false;
      reason: 'invalid' | 'expired' | 'locked' | 'used';
      attemptsRemaining: number;
    };

type ChallengeTable =
  | {
      table: 'sms_login_challenges';
      key: 'account_id';
    }
  | {
      table: 'sms_registration_challenges';
      key: 'phone';
    };

function validateCode(code: string): void {
  if (!/^\d{6}$/.test(code)) throw new Error('验证码必须是 6 位数字');
}

function checkIssueRate(
  database: Database,
  challenge: ChallengeTable,
  subject: string,
  now: number,
): SmsChallengeIssueResult | null {
  const recent = database
    .prepare(
      `SELECT created_at_ms FROM ${challenge.table}
       WHERE ${challenge.key} = ? AND created_at_ms > ?
       ORDER BY created_at_ms DESC`,
    )
    .all(subject, now - 60 * 60 * 1000) as Array<{ created_at_ms: number }>;
  const latest = recent[0]?.created_at_ms;
  if (latest != null && now - latest < SMS_CHALLENGE_COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.ceil(
        (latest + SMS_CHALLENGE_COOLDOWN_MS - now) / 1000,
      ),
    };
  }
  if (recent.length >= SMS_CHALLENGE_HOURLY_LIMIT) {
    const oldest = recent[recent.length - 1]!.created_at_ms;
    return {
      ok: false,
      reason: 'hourly_limit',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + 60 * 60 * 1000 - now) / 1000),
      ),
    };
  }
  return null;
}

export function createSmsLoginChallengeInRepository<
  TAccountView extends SmsChallengeAccountView,
>(
  store: SmsChallengeRepositoryStore<TAccountView>,
  accountId: string,
  code: string,
  options: { now?: number } = {},
): SmsChallengeIssueResult {
  validateCode(code);
  const account = store.getAccount(accountId);
  if (!account || account.status !== 'active' || !account.phone) {
    throw new Error('Account not available for SMS login');
  }

  const now = options.now ?? Date.now();
  const limited = checkIssueRate(
    store.db(),
    { table: 'sms_login_challenges', key: 'account_id' },
    accountId,
    now,
  );
  if (limited) return limited;

  const challengeId = store.createChallengeId('login');
  const expiresAtMs = now + SMS_CHALLENGE_TTL_MS;
  store
    .db()
    .prepare(
      `INSERT INTO sms_login_challenges
       (id, organization_id, account_id, code_hash, expires_at_ms, attempts_remaining, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      challengeId,
      account.organizationId,
      accountId,
      store.hashSecret(code),
      expiresAtMs,
      SMS_CHALLENGE_MAX_ATTEMPTS,
      now,
    );
  store.audit(
    'sms_login_code_requested',
    account.employeeId,
    'SMS login code requested',
    account.organizationId,
  );
  return {
    ok: true,
    challengeId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    retryAfterSeconds: SMS_CHALLENGE_COOLDOWN_MS / 1000,
  };
}

export function discardSmsLoginChallengeInRepository<
  TAccountView extends SmsChallengeAccountView,
>(store: SmsChallengeRepositoryStore<TAccountView>, challengeId: string): void {
  if (!challengeId) return;
  store
    .db()
    .prepare(
      'DELETE FROM sms_login_challenges WHERE id = ? AND consumed_at_ms IS NULL',
    )
    .run(challengeId);
}

export function createSmsRegistrationChallengeInRepository<
  TAccountView extends SmsChallengeAccountView,
>(
  store: SmsChallengeRepositoryStore<TAccountView>,
  phone: string,
  code: string,
  organizationId = store.defaultOrganizationId,
  options: SmsRegistrationChallengeOptions = {},
): SmsChallengeIssueResult {
  validateCode(code);
  const normalized = store.normalizePhone(phone);
  if (!store.organizationExists(organizationId)) {
    throw new Error('Organization not found');
  }
  const now = options.now ?? Date.now();
  const limited = checkIssueRate(
    store.db(),
    { table: 'sms_registration_challenges', key: 'phone' },
    normalized,
    now,
  );
  if (limited) return limited;

  const department = options.department?.trim() || null;
  const departmentId = options.departmentId?.trim() || null;
  const positionId = options.positionId?.trim() || null;
  const positionTitle = options.positionTitle?.trim() || null;
  const role = options.role?.trim() || null;
  const organizationInviteId = options.organizationInviteId?.trim() || null;
  if (department && department.length > 80) {
    throw new Error('部门名称不能超过 80 个字符');
  }
  if (positionTitle && positionTitle.length > 80) {
    throw new Error('职位名称不能超过 80 个字符');
  }
  if (role && role.length > 80) throw new Error('角色不能超过 80 个字符');

  const challengeId = store.createChallengeId('registration');
  const expiresAtMs = now + SMS_CHALLENGE_TTL_MS;
  store
    .db()
    .prepare(
      `INSERT INTO sms_registration_challenges
       (id, organization_id, phone, code_hash, expires_at_ms, attempts_remaining,
        organization_invite_id, department, department_id, position_id, position_title, role, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      challengeId,
      organizationId,
      normalized,
      store.hashSecret(code),
      expiresAtMs,
      SMS_CHALLENGE_MAX_ATTEMPTS,
      organizationInviteId,
      department,
      departmentId,
      positionId,
      positionTitle,
      role,
      now,
    );
  store.audit(
    'sms_registration_code_requested',
    null,
    'SMS registration code requested',
    organizationId,
  );
  return {
    ok: true,
    challengeId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    retryAfterSeconds: SMS_CHALLENGE_COOLDOWN_MS / 1000,
  };
}

export function discardSmsRegistrationChallengeInRepository<
  TAccountView extends SmsChallengeAccountView,
>(store: SmsChallengeRepositoryStore<TAccountView>, challengeId: string): void {
  if (!challengeId) return;
  store
    .db()
    .prepare(
      'DELETE FROM sms_registration_challenges WHERE id = ? AND consumed_at_ms IS NULL',
    )
    .run(challengeId);
}

export function verifySmsRegistrationChallengeInRepository<
  TAccountView extends SmsChallengeAccountView,
>(
  store: SmsChallengeRepositoryStore<TAccountView>,
  challengeId: string,
  code: string,
  now = Date.now(),
): SmsRegistrationVerifyResult {
  const row = store
    .db()
    .prepare(
      `SELECT organization_id, phone, code_hash, expires_at_ms, attempts_remaining,
              organization_invite_id, department, department_id, position_id, position_title, role, consumed_at_ms
       FROM sms_registration_challenges WHERE id = ?`,
    )
    .get(challengeId) as
    | {
        organization_id: string;
        phone: string;
        code_hash: string;
        expires_at_ms: number;
        attempts_remaining: number;
        organization_invite_id: string | null;
        department: string | null;
        department_id: string | null;
        position_id: string | null;
        position_title: string | null;
        role: string | null;
        consumed_at_ms: number | null;
      }
    | undefined;

  if (!row) return { ok: false, reason: 'invalid', attemptsRemaining: 0 };
  if (row.consumed_at_ms != null) {
    return {
      ok: false,
      reason: row.attempts_remaining <= 0 ? 'locked' : 'used',
      attemptsRemaining: Math.max(0, row.attempts_remaining),
    };
  }
  if (now > row.expires_at_ms) {
    store
      .db()
      .prepare(
        'UPDATE sms_registration_challenges SET consumed_at_ms = ? WHERE id = ?',
      )
      .run(now, challengeId);
    return {
      ok: false,
      reason: 'expired',
      attemptsRemaining: row.attempts_remaining,
    };
  }
  if (!store.secretMatches(code, row.code_hash)) {
    const remaining = Math.max(0, row.attempts_remaining - 1);
    store
      .db()
      .prepare(
        `UPDATE sms_registration_challenges
         SET attempts_remaining = ?, consumed_at_ms = CASE WHEN ? = 0 THEN ? ELSE consumed_at_ms END
         WHERE id = ?`,
      )
      .run(remaining, remaining, now, challengeId);
    return {
      ok: false,
      reason: remaining === 0 ? 'locked' : 'invalid',
      attemptsRemaining: remaining,
    };
  }

  store
    .db()
    .prepare(
      'UPDATE sms_registration_challenges SET consumed_at_ms = ? WHERE id = ?',
    )
    .run(now, challengeId);
  store.audit(
    'sms_registration_verified',
    null,
    'SMS registration verified',
    row.organization_id,
  );
  return {
    ok: true,
    phone: row.phone,
    organizationId: row.organization_id,
    organizationInviteId: row.organization_invite_id,
    department: row.department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    role: row.role,
  };
}

export function verifySmsLoginChallengeInRepository<
  TAccountView extends SmsChallengeAccountView,
>(
  store: SmsChallengeRepositoryStore<TAccountView>,
  challengeId: string,
  code: string,
  now = Date.now(),
): SmsChallengeVerifyResult<TAccountView> {
  const row = store
    .db()
    .prepare(
      `SELECT c.account_id, c.code_hash, c.expires_at_ms, c.attempts_remaining, c.consumed_at_ms,
              a.status AS account_status
       FROM sms_login_challenges c
       JOIN accounts a ON a.id = c.account_id
       WHERE c.id = ?`,
    )
    .get(challengeId) as
    | {
        account_id: string;
        code_hash: string;
        expires_at_ms: number;
        attempts_remaining: number;
        consumed_at_ms: number | null;
        account_status: 'active' | 'disabled';
      }
    | undefined;

  if (!row) return { ok: false, reason: 'invalid', attemptsRemaining: 0 };
  if (row.consumed_at_ms != null) {
    return {
      ok: false,
      reason: row.attempts_remaining <= 0 ? 'locked' : 'used',
      attemptsRemaining: Math.max(0, row.attempts_remaining),
    };
  }
  if (row.account_status !== 'active') {
    store
      .db()
      .prepare(
        'UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?',
      )
      .run(now, challengeId);
    return { ok: false, reason: 'used', attemptsRemaining: 0 };
  }
  if (now > row.expires_at_ms) {
    store
      .db()
      .prepare(
        'UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?',
      )
      .run(now, challengeId);
    return {
      ok: false,
      reason: 'expired',
      attemptsRemaining: row.attempts_remaining,
    };
  }
  if (!store.secretMatches(code, row.code_hash)) {
    const remaining = Math.max(0, row.attempts_remaining - 1);
    store
      .db()
      .prepare(
        `UPDATE sms_login_challenges
         SET attempts_remaining = ?, consumed_at_ms = CASE WHEN ? = 0 THEN ? ELSE consumed_at_ms END
         WHERE id = ?`,
      )
      .run(remaining, remaining, now, challengeId);
    return {
      ok: false,
      reason: remaining === 0 ? 'locked' : 'invalid',
      attemptsRemaining: remaining,
    };
  }

  store
    .db()
    .prepare('UPDATE sms_login_challenges SET consumed_at_ms = ? WHERE id = ?')
    .run(now, challengeId);
  const account = store.getAccount(row.account_id);
  if (!account) return { ok: false, reason: 'used', attemptsRemaining: 0 };
  store.audit(
    'sms_login_verified',
    account.employeeId,
    'SMS login verified',
    account.organizationId,
  );
  return { ok: true, account };
}
