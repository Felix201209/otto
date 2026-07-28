/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type { ParkServiceSeed, ParkView } from './parkLifecycleTypes.js';

interface ParkLifecycleAccount {
  id: string;
  isAdmin: boolean;
  status: string;
}

interface ParkLifecycleOrganization {
  id: string;
  name: string;
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

export interface ParkLifecycleRepositoryStore {
  db(): Database;
  getAccount(
    accountId: string,
    organizationId?: string,
  ): ParkLifecycleAccount | null;
  getOrganization(organizationId: string): ParkLifecycleOrganization | null;
  getActiveOrganizationAdmin(
    organizationId: string,
  ): ParkLifecycleAccount | null;
  normalizeOptionalText(
    value: string,
    field: string,
    maxLength?: number,
  ): string | null;
  normalizeSlug(value: string): string;
  createParkId(): string;
  createDefaultSlug(): string;
  createInviteSecret(): string;
  defaultServices: readonly ParkServiceSeed[];
}

export interface CreateParkInput {
  adminOrganizationId: string;
  actorAccountId: string;
  name: string;
  slug?: string;
  brandName?: string;
}

export interface CreateParkAsPlatformInput {
  adminOrganizationId: string;
  name?: string;
  slug?: string;
  brandName?: string;
}

export interface UpdateParkAsPlatformInput {
  adminOrganizationId: string;
  name?: string;
  brandName?: string;
}

function toParkView(row: ParkRow): ParkView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    brandName: row.brand_name,
    adminOrganizationId: row.admin_organization_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getParkFromRepository(
  store: ParkLifecycleRepositoryStore,
  parkId: string,
): ParkView | null {
  const row = store
    .db()
    .prepare('SELECT * FROM parks WHERE id = ?')
    .get(parkId) as ParkRow | undefined;
  return row ? toParkView(row) : null;
}

export function getParkForOrganizationFromRepository(
  store: ParkLifecycleRepositoryStore,
  organizationId: string,
): ParkView | null {
  const row = store
    .db()
    .prepare(
      `SELECT p.* FROM organizations o
       JOIN parks p ON p.id = o.park_id
       WHERE o.id = ? AND p.status = 'active'`,
    )
    .get(organizationId) as ParkRow | undefined;
  return row ? toParkView(row) : null;
}

export function createParkInRepository(
  store: ParkLifecycleRepositoryStore,
  input: CreateParkInput,
): ParkView {
  const actor = store.getAccount(
    input.actorAccountId,
    input.adminOrganizationId,
  );
  if (!actor?.isAdmin || actor.status !== 'active') {
    throw new Error('只有企业管理员可注册产业园');
  }
  const name = store.normalizeOptionalText(input.name, '产业园名称');
  if (!name) throw new Error('产业园名称不能为空');
  const brandName =
    store.normalizeOptionalText(input.brandName ?? '', '园区服务名称') ??
    `${name}服务`;
  const slug = store.normalizeSlug(input.slug || store.createDefaultSlug());
  const id = store.createParkId();
  const database = store.db();

  database.exec('BEGIN IMMEDIATE');
  try {
    const organization = database
      .prepare('SELECT park_id FROM organizations WHERE id = ?')
      .get(input.adminOrganizationId) as { park_id: string | null } | undefined;
    if (!organization || organization.park_id) {
      throw new Error('企业已加入产业园');
    }
    database
      .prepare(
        `INSERT INTO parks
         (id, name, slug, invite_secret, admin_organization_id, brand_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        slug,
        store.createInviteSecret(),
        input.adminOrganizationId,
        brandName,
      );
    const attached = database
      .prepare(
        `UPDATE organizations SET park_id = ?, updated_at = datetime('now')
         WHERE id = ? AND park_id IS NULL`,
      )
      .run(id, input.adminOrganizationId);
    if (Number(attached.changes) !== 1) {
      throw new Error('企业已加入产业园');
    }
    const insertService = database.prepare(
      `INSERT INTO park_services (park_id, id, name, enabled, config_json)
       VALUES (?, ?, ?, 1, '{}')`,
    );
    for (const service of store.defaultServices) {
      insertService.run(id, service.id, service.name);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return getParkFromRepository(store, id)!;
}

export function createParkAsPlatformInRepository(
  store: ParkLifecycleRepositoryStore,
  input: CreateParkAsPlatformInput,
): ParkView {
  const organization = store.getOrganization(input.adminOrganizationId);
  if (!organization) throw new Error('Organization not found');
  const admin = store.getActiveOrganizationAdmin(input.adminOrganizationId);
  if (!admin) {
    throw new Error('Park admin organization requires an active admin account');
  }
  return createParkInRepository(store, {
    adminOrganizationId: input.adminOrganizationId,
    actorAccountId: admin.id,
    name: input.name || organization.name,
    slug: input.slug,
    brandName: input.brandName,
  });
}

export function updateParkAsPlatformInRepository(
  store: ParkLifecycleRepositoryStore,
  input: UpdateParkAsPlatformInput,
): ParkView {
  const current = store
    .db()
    .prepare(
      `SELECT * FROM parks
       WHERE admin_organization_id = ? AND status = 'active'`,
    )
    .get(input.adminOrganizationId) as ParkRow | undefined;
  if (!current) throw new Error('Park admin organization not found');

  const name =
    input.name === undefined
      ? current.name
      : store.normalizeOptionalText(input.name, '产业园名称');
  if (!name) throw new Error('产业园名称不能为空');
  const brandName =
    input.brandName === undefined
      ? current.brand_name
      : store.normalizeOptionalText(input.brandName, '园区服务名称');
  if (!brandName) throw new Error('园区服务名称不能为空');

  store
    .db()
    .prepare(
      `UPDATE parks
       SET name = ?, brand_name = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'active'`,
    )
    .run(name, brandName, current.id);
  return getParkFromRepository(store, current.id)!;
}
