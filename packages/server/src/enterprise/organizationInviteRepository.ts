import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Database } from '../modules/data_platform/index.js';
import {
  buildOrganizationInviteLink,
  resolveEnterprisePublicBaseUrl,
} from './publicInvite.js';
import type {
  OrganizationInviteInspection,
  OrganizationInviteIssueInput,
  OrganizationInviteOrganizationView,
  OrganizationInviteResolution,
  OrganizationInviteView,
} from './organizationInviteTypes.js';

interface OrganizationInviteRow {
  id: string;
  organization_id: string;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  default_department: string | null;
  department_id: string | null;
  position_id: string | null;
  position_title: string | null;
  default_role: string | null;
  max_uses: number | null;
  used_count: number;
}

interface OrganizationInviteOrganizationRow {
  id: string;
  name: string;
  slug: string;
  invite_secret: string;
  park_id?: string | null;
  park_address?: string | null;
  park_room_number?: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

interface AssignmentIdentity {
  department: string | null;
  departmentId: string | null;
  positionTitle: string | null;
  positionId: string | null;
}

export interface OrganizationInviteRepositoryStore {
  db(): Database;
  inviteValidityMs: number;
  inviteAlphabet: string;
  inviteCodeRawLength: number;
  toOrganizationView(
    row: OrganizationInviteOrganizationRow,
  ): OrganizationInviteOrganizationView;
  resolveAssignmentIdentity(
    database: Database,
    organizationId: string,
    input: {
      department?: string | null;
      departmentId?: string | null;
      positionTitle?: string | null;
      positionId?: string | null;
    },
  ): AssignmentIdentity;
  normalizeOptionalText(
    value: string | null | undefined,
    label: string,
    maxLength?: number,
  ): string | null;
  logAudit(
    action: string,
    accountId: string | null,
    detail: string,
    organizationId?: string,
  ): void;
}

export function normalizeOrganizationInviteCode(code: string): string {
  const compact = code.trim().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Za-km-z2-9]+$/.test(compact) ? compact : '';
}

function deriveOrganizationInviteCode(
  store: OrganizationInviteRepositoryStore,
  organization: OrganizationInviteOrganizationRow,
  nonce: string,
): string {
  const digest = createHmac('sha256', organization.invite_secret)
    .update(`${organization.id}:${nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < store.inviteCodeRawLength; index += 1) {
    code += store.inviteAlphabet[digest[index]! % store.inviteAlphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function toOrganizationInviteView(
  store: OrganizationInviteRepositoryStore,
  row: OrganizationInviteRow,
  organization: OrganizationInviteOrganizationRow,
  now: number,
): OrganizationInviteView {
  const status =
    row.revoked_at_ms != null
      ? 'revoked'
      : now >= row.expires_at_ms
        ? 'expired'
        : 'active';
  const code = deriveOrganizationInviteCode(store, organization, row.nonce);
  const publicBaseUrl = resolveEnterprisePublicBaseUrl({
    configuredUrl: process.env.OTTO_ENTERPRISE_PUBLIC_URL,
  });
  return {
    id: row.id,
    organizationId: row.organization_id,
    code,
    link: buildOrganizationInviteLink(publicBaseUrl, code),
    status,
    defaultDepartment: row.default_department,
    departmentId: row.department_id,
    positionId: row.position_id,
    positionTitle: row.position_title,
    defaultRole: row.default_role,
    maxUses: row.max_uses,
    usedCount: row.used_count ?? 0,
    issuedAt: new Date(row.issued_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    validHours: 168,
  };
}

type JoinedOrganizationInviteRow = OrganizationInviteRow &
  Omit<OrganizationInviteOrganizationRow, 'id'>;

function organizationFromJoinedRow(
  row: JoinedOrganizationInviteRow,
): OrganizationInviteOrganizationRow {
  return {
    id: row.organization_id,
    name: row.name,
    slug: row.slug,
    invite_secret: row.invite_secret,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function matchesInviteCode(
  store: OrganizationInviteRepositoryStore,
  row: JoinedOrganizationInviteRow,
  normalized: string,
): boolean {
  const expected = normalizeOrganizationInviteCode(
    deriveOrganizationInviteCode(
      store,
      organizationFromJoinedRow(row),
      row.nonce,
    ),
  );
  return (
    expected.length === normalized.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
  );
}

/**
 * Inspect one derived invite code without returning organization metadata.
 * Public landing pages use this to distinguish a missing link from a link that
 * existed but is no longer usable, while keeping tenant details private.
 */
export function inspectOrganizationInvite(
  store: OrganizationInviteRepositoryStore,
  code: string,
  now = Date.now(),
): OrganizationInviteInspection {
  const normalized = normalizeOrganizationInviteCode(code);
  if (normalized.length !== store.inviteCodeRawLength)
    return { status: 'invalid', organizationId: null };

  // 邀请码由 nonce 动态派生，库中没有可直接索引的明文 code；必须保留已撤销/
  // 已过期记录，公开落地页才能正确区分 404 与 410。先在 SQL 层排除已停用企业，
  // 再恒定时间比对候选 code，不能引用 organization_invites 中不存在的 status 列。
  const rows = store
    .db()
    .prepare(
      `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE o.status = 'active'
     ORDER BY i.issued_at_ms DESC`,
    )
    .all() as JoinedOrganizationInviteRow[];
  const matches = rows.filter((row) =>
    matchesInviteCode(store, row, normalized),
  );
  if (matches.length !== 1) return { status: 'invalid', organizationId: null };

  const match = matches[0]!;
  if (match.status !== 'active')
    return { status: 'invalid', organizationId: null };
  if (match.revoked_at_ms != null) {
    return { status: 'revoked', organizationId: match.organization_id };
  }
  if (now >= match.expires_at_ms) {
    return { status: 'expired', organizationId: match.organization_id };
  }
  if (match.max_uses != null && match.used_count >= match.max_uses) {
    return { status: 'revoked', organizationId: match.organization_id };
  }
  return { status: 'active', organizationId: match.organization_id };
}

export function issueOrganizationInvite(
  store: OrganizationInviteRepositoryStore,
  organizationId: string,
  now = Date.now(),
  createdByAccountId?: string | null,
  input?: string | OrganizationInviteIssueInput | null,
): OrganizationInviteView {
  const database = store.db();
  database.exec('SAVEPOINT issue_organization_invite');
  try {
    const organization = database
      .prepare('SELECT * FROM organizations WHERE id = ? AND status = ?')
      .get(organizationId, 'active') as
      OrganizationInviteOrganizationRow | undefined;
    if (!organization) throw new Error('Organization not found');
    const id = `orginvite_${randomUUID()}`;
    const nonce = randomBytes(24).toString('base64url');
    const expiresAtMs = now + store.inviteValidityMs;
    const options =
      typeof input === 'string' ? { defaultDepartment: input } : (input ?? {});
    const assignment = store.resolveAssignmentIdentity(
      database,
      organizationId,
      {
        department: options.defaultDepartment,
        departmentId: options.departmentId,
        positionId: options.positionId,
        positionTitle: options.positionTitle,
      },
    );
    const defaultRole = store.normalizeOptionalText(
      options.defaultRole,
      '角色',
    );
    const maxUses =
      options.maxUses == null ? null : Math.floor(Number(options.maxUses));
    if (
      maxUses != null &&
      (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 10_000)
    ) {
      throw new Error('邀请码可注册人数必须在 1 到 10000 之间');
    }
    database
      .prepare(
        `INSERT INTO organization_invites
         (id, organization_id, nonce, issued_at_ms, expires_at_ms, created_by_account_id,
          default_department, department_id, position_id, position_title, default_role, max_uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        organizationId,
        nonce,
        now,
        expiresAtMs,
        createdByAccountId || null,
        assignment.department,
        assignment.departmentId,
        assignment.positionId,
        assignment.positionTitle,
        defaultRole,
        maxUses,
      );
    database
      .prepare(
        `UPDATE organization_invites SET revoked_at_ms = ?
       WHERE organization_id = ? AND id <> ? AND revoked_at_ms IS NULL`,
      )
      .run(now, organizationId, id);
    store.logAudit(
      'organization_invite_issue',
      null,
      [assignment.department, assignment.positionTitle, defaultRole].filter(
        Boolean,
      ).length
        ? `Position invite issued for ${[
            assignment.department,
            assignment.positionTitle,
            defaultRole,
          ]
            .filter(Boolean)
            .join(' / ')}`
        : 'Registration invite issued for 7 days',
      organizationId,
    );
    const row = database
      .prepare('SELECT * FROM organization_invites WHERE id = ?')
      .get(id) as OrganizationInviteRow;
    database.exec('RELEASE SAVEPOINT issue_organization_invite');
    return toOrganizationInviteView(store, row, organization, now);
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT issue_organization_invite');
    database.exec('RELEASE SAVEPOINT issue_organization_invite');
    throw error;
  }
}

export function getOrganizationInvite(
  store: OrganizationInviteRepositoryStore,
  organizationId: string,
  now = Date.now(),
): OrganizationInviteView | null {
  const database = store.db();
  const organization = database
    .prepare('SELECT * FROM organizations WHERE id = ?')
    .get(organizationId) as OrganizationInviteOrganizationRow | undefined;
  if (!organization) return null;
  const row = database
    .prepare(
      `SELECT * FROM organization_invites
     WHERE organization_id = ? ORDER BY issued_at_ms DESC LIMIT 1`,
    )
    .get(organizationId) as OrganizationInviteRow | undefined;
  return row ? toOrganizationInviteView(store, row, organization, now) : null;
}

export function resolveOrganizationInviteWithDefaults(
  store: OrganizationInviteRepositoryStore,
  code: string,
  now = Date.now(),
): OrganizationInviteResolution | null {
  const normalized = normalizeOrganizationInviteCode(code);
  if (normalized.length !== store.inviteCodeRawLength) return null;
  const rows = store
    .db()
    .prepare(
      `SELECT i.*, o.name, o.slug, o.invite_secret, o.status, o.created_at, o.updated_at
     FROM organization_invites i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.revoked_at_ms IS NULL AND i.expires_at_ms > ? AND o.status = 'active'`,
    )
    .all(now) as JoinedOrganizationInviteRow[];
  const matches = rows.filter((row) =>
    matchesInviteCode(store, row, normalized),
  );
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (match.max_uses != null && match.used_count >= match.max_uses) return null;
  return {
    organization: store.toOrganizationView(organizationFromJoinedRow(match)),
    inviteId: match.id,
    defaultDepartment: match.default_department ?? null,
    departmentId: match.department_id ?? null,
    positionId: match.position_id ?? null,
    positionTitle: match.position_title ?? null,
    defaultRole: match.default_role ?? null,
  };
}

export function resolveOrganizationInvite(
  store: OrganizationInviteRepositoryStore,
  code: string,
  now = Date.now(),
): OrganizationInviteOrganizationView | null {
  return (
    resolveOrganizationInviteWithDefaults(store, code, now)?.organization ??
    null
  );
}
