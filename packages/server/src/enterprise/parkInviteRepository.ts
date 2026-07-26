import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Database } from '../sqlite-compat.js';
import type { ParkInviteView, ParkTenantProfileView } from './parkInviteTypes.js';

interface ParkInviteAccount {
  id: string;
  isAdmin: boolean;
  status: string;
}

interface ParkInvitePark {
  id: string;
  name: string;
  slug: string;
  brandName: string;
  adminOrganizationId: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

interface ParkInviteRow {
  id: string;
  park_id: string;
  nonce: string;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked_at_ms: number | null;
  max_uses: number | null;
  used_count: number;
}

interface ParkRow {
  id: string;
  name: string;
  slug: string;
  invite_secret: string;
  admin_organization_id: string;
  brand_name: string;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

interface ParkTenantProfileRow {
  organization_id: string;
  park_id: string;
  address: string;
  room_number: string;
  updated_at: string;
}

export interface ParkInviteRepositoryStore {
  db(): Database;
  getAccount(accountId: string, organizationId?: string): ParkInviteAccount | null;
  getPark(parkId: string): ParkInvitePark | null;
  getParkForOrganization(organizationId: string): ParkInvitePark | null;
  inviteValidityMs: number;
  inviteAlphabet: string;
  inviteCodeRawLength: number;
  normalizeInviteCode(code: string): string;
  normalizeOptionalText(value: string, field: string, maxLength?: number): string | null;
}

function deriveParkInviteCode(
  store: ParkInviteRepositoryStore,
  park: ParkRow,
  nonce: string,
): string {
  const digest = createHmac('sha256', park.invite_secret)
    .update(`${park.id}:${nonce}`)
    .digest();
  let code = '';
  for (let index = 0; index < store.inviteCodeRawLength; index += 1) {
    code += store.inviteAlphabet[digest[index]! % store.inviteAlphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

function toParkInviteView(
  store: ParkInviteRepositoryStore,
  row: ParkInviteRow,
  park: ParkRow,
  now: number,
): ParkInviteView {
  return {
    id: row.id,
    parkId: row.park_id,
    code: deriveParkInviteCode(store, park, row.nonce),
    status:
      row.revoked_at_ms != null
        ? 'revoked'
        : now >= row.expires_at_ms ||
            (row.max_uses != null && row.used_count >= row.max_uses)
          ? 'expired'
          : 'active',
    usedCount: row.used_count,
    maxUses: row.max_uses,
    issuedAt: new Date(row.issued_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
  };
}

function toParkTenantProfileView(row: ParkTenantProfileRow): ParkTenantProfileView {
  return {
    organizationId: row.organization_id,
    parkId: row.park_id,
    address: row.address,
    roomNumber: row.room_number,
    updatedAt: row.updated_at,
  };
}

export function getParkTenantProfile(
  store: ParkInviteRepositoryStore,
  organizationId: string,
): ParkTenantProfileView | null {
  const row = store.db()
    .prepare('SELECT * FROM park_tenant_profiles WHERE organization_id = ?')
    .get(organizationId) as ParkTenantProfileRow | undefined;
  return row ? toParkTenantProfileView(row) : null;
}

export function updateParkTenantProfile(
  store: ParkInviteRepositoryStore,
  input: {
    organizationId: string;
    actorAccountId: string;
    address: string;
    roomNumber: string;
  },
): ParkTenantProfileView {
  const actor = store.getAccount(input.actorAccountId, input.organizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有企业管理员可修改企业入驻资料');
  const park = store.getParkForOrganization(input.organizationId);
  if (!park || park.adminOrganizationId === input.organizationId)
    throw new Error('当前企业不是产业园入驻企业');
  const address = store.normalizeOptionalText(input.address, '企业地址', 160);
  const roomNumber = store.normalizeOptionalText(input.roomNumber, '门牌号', 40);
  if (!address) throw new Error('企业地址不能为空');
  if (!roomNumber) throw new Error('门牌号不能为空');
  store.db().prepare(
    `INSERT INTO park_tenant_profiles (organization_id, park_id, address, room_number)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET
       park_id = excluded.park_id,
       address = excluded.address,
       room_number = excluded.room_number,
       updated_at = datetime('now')`,
  ).run(input.organizationId, park.id, address, roomNumber);
  return getParkTenantProfile(store, input.organizationId)!;
}

export function issueParkInvite(
  store: ParkInviteRepositoryStore,
  input: {
    parkId: string;
    actorAccountId: string;
    maxUses?: number | null;
    now?: number;
  },
): ParkInviteView {
  const parkRow = store.db()
    .prepare('SELECT * FROM parks WHERE id = ?')
    .get(input.parkId) as ParkRow | undefined;
  if (!parkRow || parkRow.status !== 'active')
    throw new Error('产业园不存在或已停用');
  const actor = store.getAccount(input.actorAccountId, parkRow.admin_organization_id);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理企业管理员可生成邀请码');
  const maxUses = input.maxUses == null ? null : Math.floor(input.maxUses);
  if (maxUses != null && (maxUses < 1 || maxUses > 10_000))
    throw new Error('邀请码使用次数必须为 1 到 10000');
  const now = input.now ?? Date.now();
  const row: ParkInviteRow = {
    id: `park_invite_${randomUUID()}`,
    park_id: parkRow.id,
    nonce: randomBytes(20).toString('hex'),
    issued_at_ms: now,
    expires_at_ms: now + store.inviteValidityMs,
    revoked_at_ms: null,
    max_uses: maxUses,
    used_count: 0,
  };
  store.db()
    .prepare(
      `INSERT INTO park_invites
      (id, park_id, nonce, issued_at_ms, expires_at_ms, created_by_account_id, max_uses)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.park_id,
      row.nonce,
      row.issued_at_ms,
      row.expires_at_ms,
      actor.id,
      row.max_uses,
    );
  return toParkInviteView(store, row, parkRow, now);
}

export function joinOrganizationToPark(
  store: ParkInviteRepositoryStore,
  input: {
    organizationId: string;
    actorAccountId: string;
    code: string;
    address: string;
    roomNumber: string;
    now?: number;
  },
): ParkInvitePark {
  const actor = store.getAccount(input.actorAccountId, input.organizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有企业管理员可让企业加入产业园');
  if (store.getParkForOrganization(input.organizationId))
    throw new Error('企业已加入产业园');
  const address = store.normalizeOptionalText(input.address, '企业地址', 160);
  const roomNumber = store.normalizeOptionalText(input.roomNumber, '门牌号', 40);
  if (!address) throw new Error('企业地址不能为空');
  if (!roomNumber) throw new Error('门牌号不能为空');
  const normalized = store.normalizeInviteCode(input.code);
  if (normalized.length !== store.inviteCodeRawLength) throw new Error('产业园邀请码无效或已过期');
  const now = input.now ?? Date.now();
  const rows = store.db()
    .prepare(
      `SELECT i.*, p.name, p.slug, p.invite_secret, p.admin_organization_id,
            p.brand_name, p.status, p.created_at, p.updated_at
     FROM park_invites i JOIN parks p ON p.id = i.park_id
     WHERE i.revoked_at_ms IS NULL AND i.expires_at_ms > ? AND p.status = 'active'
       AND (i.max_uses IS NULL OR i.used_count < i.max_uses)`,
    )
    .all(now) as Array<ParkInviteRow & Omit<ParkRow, 'id'>>;
  const matches = rows.filter((row) => {
    const expected = store.normalizeInviteCode(
      deriveParkInviteCode(
        store,
        {
          id: row.park_id,
          name: row.name,
          slug: row.slug,
          invite_secret: row.invite_secret,
          admin_organization_id: row.admin_organization_id,
          brand_name: row.brand_name,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
        },
        row.nonce,
      ),
    );
    return (
      expected.length === normalized.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    );
  });
  if (matches.length !== 1) throw new Error('产业园邀请码无效或已过期');
  const invite = matches[0]!;
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const reserved = database
      .prepare(
        `UPDATE park_invites SET used_count = used_count + 1
       WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?
         AND (max_uses IS NULL OR used_count < max_uses)`,
      )
      .run(invite.id, now);
    if (Number(reserved.changes) !== 1)
      throw new Error('产业园邀请码无效或已过期');
    const joined = database
      .prepare(
        `UPDATE organizations SET park_id = ?, updated_at = datetime('now')
       WHERE id = ? AND park_id IS NULL`,
      )
      .run(invite.park_id, input.organizationId);
    if (Number(joined.changes) !== 1) throw new Error('企业已加入产业园');
    database.prepare(
      `INSERT INTO park_tenant_profiles (organization_id, park_id, address, room_number)
       VALUES (?, ?, ?, ?)`,
    ).run(input.organizationId, invite.park_id, address, roomNumber);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return store.getPark(invite.park_id)!;
}
