/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL authority for public enterprise invitations and SMS
 * registration. Codes are never stored in plaintext: invitation lookup uses
 * a SHA-256 digest and SMS verification uses the same salted scrypt format as
 * account passwords.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import {
  hashIdentitySecret,
  identitySecretMatches,
  isAcceptableAccountPassword,
} from '../modules/identity_organization/index.js';
import {
  CURRENT_LEGAL_DOCUMENTS,
  legalDocumentHash,
} from '../modules/data_governance/legalDocuments.js';
import type {
  PostgresClientLike,
  PostgresPoolLike,
} from '../modules/data_platform/postgresDatabaseLifecycle.js';
import type { PostgresEnterpriseAccountView } from './postgresCoreRepository.js';

const INVITE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const INVITE_RAW_LENGTH = 12;
const INVITE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1_000;
const SMS_TTL_MS = 5 * 60 * 1_000;
const SMS_COOLDOWN_MS = 60 * 1_000;
const SMS_HOURLY_LIMIT = 5;
const SMS_MAX_ATTEMPTS = 5;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

type Queryable =
  Pick<PostgresPoolLike, 'query'> | Pick<PostgresClientLike, 'query'>;

interface OrganizationRow extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'enterprise' | 'park';
  status: 'active' | 'disabled';
  invite_secret: string | null;
}

interface InviteRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  nonce: string;
  code_hash: string;
  issued_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  default_department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  default_role: string | null;
  max_uses: number | string | null;
  used_count: number | string;
  organization_name?: string;
  organization_status?: 'active' | 'disabled';
}

interface ChallengeRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  phone: string;
  code_hash: string;
  expires_at: Date | string;
  attempts_remaining: number | string;
  organization_invite_id: string | null;
  department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  role: string | null;
  consumed_at: Date | string | null;
  created_at: Date | string;
}

export interface PostgresOrganizationInviteView {
  id: string;
  organizationId: string;
  code: string;
  status: 'active' | 'expired' | 'revoked';
  defaultDepartment: string | null;
  departmentId: string | null;
  positionId: string | null;
  positionTitle: string | null;
  defaultRole: string | null;
  maxUses: number | null;
  usedCount: number;
  issuedAt: string;
  expiresAt: string;
  validHours: 168;
}

export type PostgresSmsRegistrationIssueResult =
  | {
      state: 'issued';
      challengeId: string;
      expiresAt: string;
      retryAfterSeconds: number;
      registrationMode: 'personal' | 'enterprise';
      organization: { id: string; name: string } | null;
    }
  | { state: 'invalid-invite' | 'phone-conflict' }
  | {
      state: 'cooldown' | 'hourly-limit';
      retryAfterSeconds: number;
    };

export type PostgresSmsRegistrationCompletionResult =
  | { state: 'registered'; account: PostgresEnterpriseAccountView }
  | {
      state: 'invalid' | 'expired' | 'locked' | 'used';
      attemptsRemaining: number;
    }
  | { state: 'phone-conflict' | 'invite-unavailable' };

export type PostgresOrganizationJoinResult =
  | { state: 'joined'; account: PostgresEnterpriseAccountView }
  | {
      state: 'invalid-invite' | 'not-personal' | 'security-state-present';
    };

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function optionalText(
  value: string | null | undefined,
  label: string,
  maximumLength = 120,
): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maximumLength) {
    throw new Error(`${label} is too long`);
  }
  return normalized;
}

function defaultNormalizePhone(value: string): string {
  let digits = value.trim().replace(/[^\d]/gu, '');
  if (digits.startsWith('0086')) digits = digits.slice(4);
  else if (digits.startsWith('86') && digits.length === 13)
    digits = digits.slice(2);
  if (!/^1[3-9]\d{9}$/u.test(digits)) throw new Error('phone is invalid');
  return `+86${digits}`;
}

function normalizedInviteCode(value: string): string {
  const compact = value.trim().replace(/[\s-]/gu, '');
  return /^[A-HJ-NP-Za-km-z2-9]{12}$/u.test(compact) ? compact : '';
}

function invitationHash(code: string): string {
  return createHash('sha256').update(normalizedInviteCode(code)).digest('hex');
}

function deriveInviteCode(
  organizationId: string,
  inviteSecret: string,
  nonce: string,
): string {
  const digest = createHmac('sha256', inviteSecret)
    .update(`${organizationId}:${nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < INVITE_RAW_LENGTH; index += 1) {
    code += INVITE_ALPHABET[digest[index]! % INVITE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

async function transaction<T>(
  pool: PostgresPoolLike,
  operation: (client: PostgresClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query('BEGIN');
    active = true;
    const result = await operation(client);
    await client.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original domain or PostgreSQL error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function inviteStatus(
  row: InviteRow,
  now: Date,
): 'active' | 'expired' | 'revoked' {
  if (
    row.revoked_at ||
    (row.max_uses != null && Number(row.used_count) >= Number(row.max_uses))
  ) {
    return 'revoked';
  }
  return now.getTime() >= new Date(row.expires_at).getTime()
    ? 'expired'
    : 'active';
}

function inviteView(
  row: InviteRow,
  code: string,
  now: Date,
): PostgresOrganizationInviteView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    code,
    status: inviteStatus(row, now),
    defaultDepartment: row.default_department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    defaultRole: row.default_role,
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count),
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    validHours: 168,
  };
}

async function phoneExists(
  database: Queryable,
  phone: string,
): Promise<boolean> {
  const result = await database.query(
    `SELECT id FROM accounts
     WHERE phone = $1 AND deleted_at IS NULL LIMIT 1`,
    [phone],
  );
  return Boolean(result.rows[0]);
}

export function createPostgresRegistrationRepository(input: {
  pool: PostgresPoolLike;
  defaultOrganizationId?: string;
  normalizePhone?: (value: string) => string;
  getAccount: (
    id: string,
    organizationId?: string,
  ) => Promise<PostgresEnterpriseAccountView | null>;
  logAudit: (
    action: string,
    organizationId: string,
    actorEmployeeId: string | null,
    detail: Record<string, unknown>,
    database?: Queryable,
  ) => Promise<void>;
}) {
  const defaultOrganizationId =
    input.defaultOrganizationId?.trim() || 'org_default';
  const normalizePhone = input.normalizePhone ?? defaultNormalizePhone;

  async function resolveAssignment(
    database: Queryable,
    organizationId: string,
    raw: {
      defaultDepartment?: string | null;
      departmentId?: string | null;
      positionId?: string | null;
      positionTitle?: string | null;
      defaultRole?: string | null;
    },
  ) {
    const departmentId = optionalText(raw.departmentId, 'department id', 200);
    const positionId = optionalText(raw.positionId, 'position id', 200);
    let department = optionalText(raw.defaultDepartment, 'department');
    let positionTitle = optionalText(raw.positionTitle, 'position title');
    let role = optionalText(raw.defaultRole, 'default role');
    let isAdmin = false;

    if (departmentId) {
      const result = await database.query<
        { id: string; name: string } & Record<string, unknown>
      >(
        `SELECT id, name FROM organization_departments
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, departmentId],
      );
      if (!result.rows[0]) throw new Error('organization department not found');
      department = result.rows[0].name;
    }
    if (positionId) {
      const result = await database.query<
        {
          id: string;
          department_id: string;
          title: string;
          role_mapping: string | null;
        } & Record<string, unknown>
      >(
        `SELECT id, department_id, title, role_mapping
         FROM organization_positions
         WHERE organization_id = $1 AND id = $2`,
        [organizationId, positionId],
      );
      const position = result.rows[0];
      if (!position) throw new Error('organization position not found');
      if (departmentId && position.department_id !== departmentId) {
        throw new Error('organization position does not belong to department');
      }
      positionTitle = position.title;
      isAdmin = position.role_mapping === 'enterprise_admin';
      role =
        position.role_mapping === 'enterprise_admin'
          ? '企业管理员'
          : position.role_mapping === 'department_admin'
            ? '部门管理员'
            : (role ?? '成员');
    }
    return {
      department,
      departmentId,
      positionId,
      positionTitle,
      role: role ?? '成员',
      isAdmin,
    };
  }

  async function issueOrganizationInvite(raw: {
    organizationId: string;
    createdByAccountId?: string | null;
    now?: Date;
    defaultDepartment?: string | null;
    departmentId?: string | null;
    positionId?: string | null;
    positionTitle?: string | null;
    defaultRole?: string | null;
    maxUses?: number | null;
  }): Promise<PostgresOrganizationInviteView> {
    const organizationId = identifier(raw.organizationId, 'organization id');
    const now = raw.now ?? new Date();
    const maxUses =
      raw.maxUses == null ? null : Math.floor(Number(raw.maxUses));
    if (
      maxUses != null &&
      (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 10_000)
    ) {
      throw new Error('invite maximum uses must be between 1 and 10000');
    }

    return transaction(input.pool, async (client) => {
      const organizationResult = await client.query<OrganizationRow>(
        `SELECT * FROM organizations
         WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [organizationId],
      );
      const organization = organizationResult.rows[0];
      if (!organization) throw new Error('organization is unavailable');
      const inviteSecret =
        organization.invite_secret ?? randomBytes(32).toString('hex');
      if (!organization.invite_secret) {
        await client.query(
          `UPDATE organizations SET invite_secret = $2,
             updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [organizationId, inviteSecret],
        );
      }
      const assignment = await resolveAssignment(client, organizationId, raw);
      const id = `orginvite_${randomUUID()}`;
      const nonce = randomBytes(24).toString('base64url');
      const code = deriveInviteCode(organizationId, inviteSecret, nonce);
      const expiresAt = new Date(now.getTime() + INVITE_VALIDITY_MS);
      await client.query(
        `UPDATE organization_invites SET revoked_at = $2
         WHERE organization_id = $1 AND revoked_at IS NULL`,
        [organizationId, now.toISOString()],
      );
      const inserted = await client.query<InviteRow>(
        `INSERT INTO organization_invites
          (id, organization_id, nonce, code_hash, issued_at, expires_at,
           created_by_account_id, default_department, department_id,
           position_id, position_title, default_role, max_uses)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
                 $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          id,
          organizationId,
          nonce,
          invitationHash(code),
          now.toISOString(),
          expiresAt.toISOString(),
          raw.createdByAccountId
            ? identifier(raw.createdByAccountId, 'creator account id')
            : null,
          assignment.department,
          assignment.departmentId,
          assignment.positionId,
          assignment.positionTitle,
          assignment.role,
          maxUses,
        ],
      );
      await input.logAudit(
        'organization_invite_issued',
        organizationId,
        null,
        { inviteId: id, maxUses },
        client,
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('organization invite was not created');
      return inviteView(row, code, now);
    });
  }

  async function getOrganizationInvite(
    organizationId: string,
    now = new Date(),
  ): Promise<PostgresOrganizationInviteView | null> {
    const result = await input.pool.query<
      InviteRow & { invite_secret: string }
    >(
      `SELECT i.*, o.invite_secret
       FROM organization_invites AS i
       JOIN organizations AS o ON o.id = i.organization_id
       WHERE i.organization_id = $1
       ORDER BY i.issued_at DESC LIMIT 1`,
      [identifier(organizationId, 'organization id')],
    );
    const row = result.rows[0];
    if (!row?.invite_secret) return null;
    return inviteView(
      row,
      deriveInviteCode(row.organization_id, row.invite_secret, row.nonce),
      now,
    );
  }

  async function findInviteByCode(
    database: Queryable,
    code: string,
    lock: boolean,
  ): Promise<InviteRow | null> {
    const normalized = normalizedInviteCode(code);
    if (!normalized) return null;
    const result = await database.query<InviteRow>(
      `SELECT i.*, o.name AS organization_name,
              o.status AS organization_status
       FROM organization_invites AS i
       JOIN organizations AS o ON o.id = i.organization_id
       WHERE i.code_hash = $1${lock ? ' FOR UPDATE OF i' : ''}`,
      [invitationHash(normalized)],
    );
    return result.rows[0] ?? null;
  }

  async function inspectOrganizationInvite(
    code: string,
    now = new Date(),
  ): Promise<{
    status: 'active' | 'expired' | 'revoked' | 'invalid';
    organizationId: string | null;
  }> {
    const row = await findInviteByCode(input.pool, code, false);
    if (!row || row.organization_status !== 'active') {
      return { status: 'invalid', organizationId: null };
    }
    return {
      status: inviteStatus(row, now),
      organizationId: row.organization_id,
    };
  }

  async function requestSmsRegistration(raw: {
    phone: string;
    code: string;
    inviteCode?: string | null;
    now?: Date;
  }): Promise<PostgresSmsRegistrationIssueResult> {
    if (!/^\d{6}$/u.test(raw.code))
      throw new Error('SMS code must be six digits');
    const phone = normalizePhone(raw.phone);
    const now = raw.now ?? new Date();
    return transaction(input.pool, async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`sms-registration:${phone}`],
      );
      if (await phoneExists(client, phone)) return { state: 'phone-conflict' };

      let invite: InviteRow | null = null;
      if (raw.inviteCode?.trim()) {
        invite = await findInviteByCode(client, raw.inviteCode, true);
        if (
          !invite ||
          invite.organization_status !== 'active' ||
          inviteStatus(invite, now) !== 'active'
        ) {
          return { state: 'invalid-invite' };
        }
      }

      const recent = await client.query<
        { created_at: Date | string } & Record<string, unknown>
      >(
        `SELECT created_at FROM sms_registration_challenges
         WHERE phone = $1 AND created_at > $2::timestamptz
         ORDER BY created_at DESC`,
        [phone, new Date(now.getTime() - 60 * 60 * 1_000).toISOString()],
      );
      const latest = recent.rows[0]?.created_at;
      if (latest) {
        const retryAfter =
          new Date(latest).getTime() + SMS_COOLDOWN_MS - now.getTime();
        if (retryAfter > 0) {
          return {
            state: 'cooldown',
            retryAfterSeconds: Math.ceil(retryAfter / 1_000),
          };
        }
      }
      if (recent.rows.length >= SMS_HOURLY_LIMIT) {
        const oldest = recent.rows[recent.rows.length - 1]!.created_at;
        return {
          state: 'hourly-limit',
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (new Date(oldest).getTime() + 60 * 60 * 1_000 - now.getTime()) /
                1_000,
            ),
          ),
        };
      }

      const id = `smsreg_${randomUUID()}`;
      const organizationId = invite?.organization_id ?? defaultOrganizationId;
      const expiresAt = new Date(now.getTime() + SMS_TTL_MS);
      await client.query(
        `INSERT INTO sms_registration_challenges
          (id, organization_id, phone, code_hash, expires_at,
           attempts_remaining, organization_invite_id, department,
           department_id, position_id, position_title, role, created_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9,
                 $10, $11, $12, $13::timestamptz)`,
        [
          id,
          organizationId,
          phone,
          hashIdentitySecret(raw.code),
          expiresAt.toISOString(),
          SMS_MAX_ATTEMPTS,
          invite?.id ?? null,
          invite?.default_department ?? null,
          invite?.department_id ?? null,
          invite?.position_id ?? null,
          invite?.position_title ?? null,
          invite?.default_role ?? null,
          now.toISOString(),
        ],
      );
      await input.logAudit(
        'sms_registration_code_requested',
        organizationId,
        null,
        { registrationMode: invite ? 'enterprise' : 'personal' },
        client,
      );
      return {
        state: 'issued',
        challengeId: id,
        expiresAt: expiresAt.toISOString(),
        retryAfterSeconds: SMS_COOLDOWN_MS / 1_000,
        registrationMode: invite ? 'enterprise' : 'personal',
        organization: invite
          ? { id: invite.organization_id, name: invite.organization_name! }
          : null,
      };
    });
  }

  async function discardSmsRegistrationChallenge(
    challengeId: string,
  ): Promise<void> {
    if (!challengeId.trim()) return;
    await input.pool.query(
      `DELETE FROM sms_registration_challenges
       WHERE id = $1 AND consumed_at IS NULL`,
      [challengeId.trim()],
    );
  }

  async function completeSmsRegistration(raw: {
    challengeId: string;
    code: string;
    name: string;
    password: string;
    legalConsent: true;
    now?: Date;
  }): Promise<PostgresSmsRegistrationCompletionResult> {
    if (!/^smsreg_[A-Za-z0-9-]+$/u.test(raw.challengeId.trim())) {
      throw new Error('registration challenge id is invalid');
    }
    if (!/^\d{6}$/u.test(raw.code))
      throw new Error('SMS code must be six digits');
    const name = raw.name.trim();
    if (
      !name ||
      name.length > 120 ||
      !isAcceptableAccountPassword(raw.password)
    ) {
      throw new Error('registration name or password is invalid');
    }
    if (raw.legalConsent !== true) throw new Error('legal consent is required');
    const now = raw.now ?? new Date();

    type CompletionWithoutAccount = Exclude<
      PostgresSmsRegistrationCompletionResult,
      { state: 'registered' }
    >;
    const completed = await transaction<
      | { result: CompletionWithoutAccount }
      | { accountId: string; organizationId: string }
    >(input.pool, async (client) => {
      const challengeResult = await client.query<ChallengeRow>(
        `SELECT * FROM sms_registration_challenges
         WHERE id = $1 FOR UPDATE`,
        [raw.challengeId.trim()],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge) {
        return { result: { state: 'invalid', attemptsRemaining: 0 } as const };
      }
      const attempts = Number(challenge.attempts_remaining);
      if (challenge.consumed_at) {
        return {
          result: { state: 'used', attemptsRemaining: attempts } as const,
        };
      }
      if (now.getTime() >= new Date(challenge.expires_at).getTime()) {
        await client.query(
          `UPDATE sms_registration_challenges SET consumed_at = $2
           WHERE id = $1`,
          [challenge.id, now.toISOString()],
        );
        return {
          result: { state: 'expired', attemptsRemaining: attempts } as const,
        };
      }
      if (attempts <= 0) {
        return { result: { state: 'locked', attemptsRemaining: 0 } as const };
      }
      if (!identitySecretMatches(raw.code, challenge.code_hash)) {
        const remaining = Math.max(0, attempts - 1);
        await client.query(
          `UPDATE sms_registration_challenges
           SET attempts_remaining = $2 WHERE id = $1`,
          [challenge.id, remaining],
        );
        return {
          result: {
            state: remaining === 0 ? 'locked' : 'invalid',
            attemptsRemaining: remaining,
          } as const,
        };
      }

      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`sms-registration:${challenge.phone}`],
      );
      if (await phoneExists(client, challenge.phone)) {
        return { result: { state: 'phone-conflict' } as const };
      }

      let organizationId = challenge.organization_id;
      let accountType: 'personal' | 'enterprise' = 'enterprise';
      let assignment = {
        department: challenge.department,
        departmentId: challenge.department_id,
        positionId: challenge.position_id,
        positionTitle: challenge.position_title,
        role: challenge.role ?? '成员',
        isAdmin: false,
      };
      if (challenge.organization_invite_id) {
        const inviteResult = await client.query<InviteRow>(
          `SELECT * FROM organization_invites
           WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
          [challenge.organization_invite_id, organizationId],
        );
        const invite = inviteResult.rows[0];
        if (!invite || inviteStatus(invite, now) !== 'active') {
          return { result: { state: 'invite-unavailable' } as const };
        }
        assignment = await resolveAssignment(client, organizationId, {
          defaultDepartment: invite.default_department,
          departmentId: invite.department_id,
          positionId: invite.position_id,
          positionTitle: invite.position_title,
          defaultRole: invite.default_role,
        });
      } else {
        organizationId = `org_${randomUUID()}`;
        accountType = 'personal';
        assignment = {
          department: null,
          departmentId: null,
          positionId: null,
          positionTitle: null,
          role: '个人用户',
          isAdmin: false,
        };
        await client.query(
          `INSERT INTO organizations (id, name, slug, type, status)
           VALUES ($1, $2, $3, 'personal', 'active')`,
          [
            organizationId,
            `${name.slice(0, 60)}的个人空间`,
            `personal-${randomBytes(12).toString('hex')}`,
          ],
        );
        await client.query(
          `INSERT INTO organization_features
             (organization_id, enterprise_tree, direct_messages, atoa, park_services)
           VALUES ($1, FALSE, TRUE, TRUE, FALSE)`,
          [organizationId],
        );
      }

      const accountId = `acc_${randomUUID()}`;
      const digits = challenge.phone.slice(-4);
      const username = `otto_${digits}_${randomBytes(5).toString('hex')}`;
      const employeeId =
        accountType === 'enterprise' ? `emp_${randomUUID()}` : null;
      await client.query(
        `INSERT INTO accounts
          (id, organization_id, account_type, employee_id, username, phone,
           password_hash, name, role, department, department_id, position_id,
           position_title, is_admin, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, 'active')`,
        [
          accountId,
          organizationId,
          accountType,
          employeeId,
          username,
          challenge.phone,
          hashIdentitySecret(raw.password),
          name,
          assignment.role,
          assignment.department,
          assignment.departmentId,
          assignment.positionId,
          assignment.positionTitle,
          assignment.isAdmin,
        ],
      );
      if (accountType === 'enterprise') {
        await client.query(
          `INSERT INTO account_tags (account_id, organization_id, tag)
           VALUES ($1, $2, $3)`,
          [accountId, organizationId, '普通成员'],
        );
        const reserved = await client.query(
          `UPDATE organization_invites
           SET used_count = used_count + 1
           WHERE id = $1 AND organization_id = $2
             AND revoked_at IS NULL AND expires_at > $3::timestamptz
             AND (max_uses IS NULL OR used_count < max_uses)`,
          [challenge.organization_invite_id, organizationId, now.toISOString()],
        );
        if (Number(reserved.rowCount ?? 0) !== 1) {
          throw new Error('organization invitation became unavailable');
        }
      }
      for (const document of CURRENT_LEGAL_DOCUMENTS) {
        await client.query(
          `INSERT INTO legal_consents
             (account_id, organization_id, document_id, document_version,
              policy_hash, source, accepted_at)
           VALUES ($1, $2, $3, $4, $5, 'registration', $6::timestamptz)
           ON CONFLICT (account_id, document_id, document_version) DO NOTHING`,
          [
            accountId,
            organizationId,
            document.id,
            document.version,
            legalDocumentHash(document),
            now.toISOString(),
          ],
        );
      }
      await client.query(
        `UPDATE sms_registration_challenges SET consumed_at = $2
         WHERE id = $1`,
        [challenge.id, now.toISOString()],
      );
      await input.logAudit(
        'sms_registration_completed',
        organizationId,
        employeeId,
        { accountId, accountType, legalConsentRecorded: true },
        client,
      );
      return { accountId, organizationId };
    });

    if ('result' in completed) return completed.result;
    const account = await input.getAccount(
      completed.accountId,
      completed.organizationId,
    );
    if (!account) throw new Error('registered account could not be loaded');
    return { state: 'registered', account };
  }

  async function joinOrganizationWithInvite(raw: {
    accountId: string;
    inviteCode: string;
    now?: Date;
  }): Promise<PostgresOrganizationJoinResult> {
    const accountId = identifier(raw.accountId, 'account id');
    const now = raw.now ?? new Date();
    const moved = await transaction<
      | { state: 'invalid-invite' | 'not-personal' | 'security-state-present' }
      | { state: 'joined'; organizationId: string }
    >(input.pool, async (client) => {
      const accountResult = await client.query<
        {
          id: string;
          organization_id: string;
          account_type: 'personal' | 'enterprise';
          status: 'active' | 'disabled';
          name: string;
        } & Record<string, unknown>
      >(
        `SELECT id, organization_id, account_type, status, name
         FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [accountId],
      );
      const account = accountResult.rows[0];
      if (
        !account ||
        account.account_type !== 'personal' ||
        account.status !== 'active'
      ) {
        return { state: 'not-personal' };
      }
      const invite = await findInviteByCode(client, raw.inviteCode, true);
      if (
        !invite ||
        invite.organization_status !== 'active' ||
        inviteStatus(invite, now) !== 'active'
      ) {
        return { state: 'invalid-invite' };
      }

      const bound = await client.query<
        {
          e2ee_devices: number | string;
          transparency_entries: number | string;
          direct_messages: number | string;
          attachment_objects: number | string;
          attachment_access: number | string;
        } & Record<string, unknown>
      >(
        `SELECT
           (SELECT count(*) FROM e2ee_devices
             WHERE organization_id = $1 AND account_id = $2)::integer
             AS e2ee_devices,
           (SELECT count(*) FROM e2ee_key_transparency_log
             WHERE organization_id = $1 AND account_id = $2)::integer
             AS transparency_entries,
           (SELECT count(*) FROM direct_messages
             WHERE organization_id = $1
               AND (sender_account_id = $2 OR recipient_account_id = $2))::integer
             AS direct_messages,
           (SELECT count(*) FROM attachment_objects
             WHERE organization_id = $1 AND owner_account_id = $2)::integer
             AS attachment_objects,
           (SELECT count(*) FROM attachment_object_access
             WHERE organization_id = $1 AND account_id = $2)::integer
             AS attachment_access`,
        [account.organization_id, accountId],
      );
      const securityState = bound.rows[0];
      if (
        !securityState ||
        Object.values(securityState).some((value) => Number(value) > 0)
      ) {
        return { state: 'security-state-present' };
      }

      const assignment = await resolveAssignment(
        client,
        invite.organization_id,
        {
          defaultDepartment: invite.default_department,
          departmentId: invite.department_id,
          positionId: invite.position_id,
          positionTitle: invite.position_title,
          defaultRole: invite.default_role,
        },
      );
      const legal = await client.query<
        {
          document_id: 'terms' | 'privacy';
          document_version: string;
          policy_hash: string;
          source: 'registration' | 'settings' | 'migration';
          accepted_at: Date | string;
        } & Record<string, unknown>
      >(
        `SELECT document_id, document_version, policy_hash, source, accepted_at
         FROM legal_consents WHERE account_id = $1 FOR UPDATE`,
        [accountId],
      );
      await client.query('DELETE FROM account_tags WHERE account_id = $1', [
        accountId,
      ]);
      await client.query('DELETE FROM legal_consents WHERE account_id = $1', [
        accountId,
      ]);
      const employeeId = `emp_${randomUUID()}`;
      const updated = await client.query(
        `UPDATE accounts SET
           organization_id = $2, account_type = 'enterprise', employee_id = $3,
           role = $4, department = $5, department_id = $6, position_id = $7,
           position_title = $8, is_admin = $9, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND organization_id = $10 AND account_type = 'personal'
           AND status = 'active' AND deleted_at IS NULL`,
        [
          accountId,
          invite.organization_id,
          employeeId,
          assignment.role,
          assignment.department,
          assignment.departmentId,
          assignment.positionId,
          assignment.positionTitle,
          assignment.isAdmin,
          account.organization_id,
        ],
      );
      if (Number(updated.rowCount ?? 0) !== 1) {
        throw new Error('personal account organization move failed');
      }
      const reserved = await client.query(
        `UPDATE organization_invites
         SET used_count = used_count + 1
         WHERE id = $1 AND organization_id = $2
           AND revoked_at IS NULL AND expires_at > $3::timestamptz
           AND (max_uses IS NULL OR used_count < max_uses)`,
        [invite.id, invite.organization_id, now.toISOString()],
      );
      if (Number(reserved.rowCount ?? 0) !== 1) {
        throw new Error('organization invitation became unavailable');
      }
      await client.query(
        `INSERT INTO account_tags (account_id, organization_id, tag)
         VALUES ($1, $2, $3)`,
        [accountId, invite.organization_id, '普通成员'],
      );
      for (const consent of legal.rows) {
        await client.query(
          `INSERT INTO legal_consents
            (account_id, organization_id, document_id, document_version,
             policy_hash, source, accepted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
          [
            accountId,
            invite.organization_id,
            consent.document_id,
            consent.document_version,
            consent.policy_hash,
            consent.source,
            iso(consent.accepted_at),
          ],
        );
      }
      await client.query(
        `UPDATE auth_sessions SET revoked_at = $2
         WHERE account_id = $1 AND revoked_at IS NULL`,
        [accountId, now.toISOString()],
      );
      await client.query(
        `UPDATE organizations SET status = 'disabled',
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND type = 'personal'`,
        [account.organization_id],
      );
      await input.logAudit(
        'personal_account_joined_organization',
        invite.organization_id,
        employeeId,
        {
          accountId,
          inviteId: invite.id,
          previousOrganizationId: account.organization_id,
          sessionsRevoked: true,
        },
        client,
      );
      return { state: 'joined', organizationId: invite.organization_id };
    });
    if (moved.state !== 'joined') return moved;
    const account = await input.getAccount(accountId, moved.organizationId);
    if (!account) throw new Error('joined account could not be loaded');
    return { state: 'joined', account };
  }

  return {
    issueOrganizationInvite,
    getOrganizationInvite,
    inspectOrganizationInvite,
    requestSmsRegistration,
    discardSmsRegistrationChallenge,
    completeSmsRegistration,
    joinOrganizationWithInvite,
  };
}
