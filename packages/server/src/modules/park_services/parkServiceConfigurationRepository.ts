/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type {
  ParkServiceSpecialistView,
  ParkServiceView,
} from './parkServiceConfigurationTypes.js';

export interface ParkServiceConfigurationAccount {
  id: string;
  isAdmin: boolean;
  status: string;
}

export interface ParkServiceConfigurationPark {
  id: string;
  adminOrganizationId: string;
  status: 'active' | 'disabled';
}

interface ParkServiceRow {
  park_id: string;
  id: string;
  name: string;
  enabled: number;
  config_json: string;
  updated_at: string;
}

interface ParkServiceSpecialistRow {
  park_id: string;
  service_id: string;
  account_id: string;
  name: string;
}

export interface ParkServiceConfigurationRepositoryStore {
  db(): Database;
  getAccount(
    accountId: string,
    organizationId?: string,
  ): ParkServiceConfigurationAccount | null;
  getPark(parkId: string): ParkServiceConfigurationPark | null;
  normalizeOptionalText(
    value: string,
    field: string,
    maxLength?: number,
  ): string | null;
}

export interface UpdateParkServiceInput {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  name?: string;
  enabled?: boolean;
  config?: Record<string, string>;
}

export interface SetParkServiceSpecialistInput {
  parkId: string;
  actorAccountId: string;
  serviceId: string;
  accountId: string;
}

function toParkServiceView(row: ParkServiceRow): ParkServiceView {
  let config: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }
  } catch {
    config = {};
  }
  return {
    parkId: row.park_id,
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    config,
    updatedAt: row.updated_at,
  };
}

function toParkServiceSpecialistView(
  row: ParkServiceSpecialistRow,
): ParkServiceSpecialistView {
  return {
    parkId: row.park_id,
    serviceId: row.service_id,
    accountId: row.account_id,
    name: row.name,
  };
}

function normalizeServiceId(value: string): string {
  const serviceId = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(serviceId)) {
    throw new Error('服务标识格式不正确');
  }
  return serviceId;
}

function requireActiveParkAdmin(
  store: ParkServiceConfigurationRepositoryStore,
  parkId: string,
): {
  park: ParkServiceConfigurationPark;
  requireActor(actorAccountId: string, action: string): void;
} {
  const park = store.getPark(parkId);
  if (!park || park.status !== 'active') {
    throw new Error('产业园不存在或已停用');
  }
  return {
    park,
    requireActor(actorAccountId, action) {
      const actor = store.getAccount(actorAccountId, park.adminOrganizationId);
      if (!actor?.isAdmin || actor.status !== 'active') {
        throw new Error(action);
      }
    },
  };
}

export function listParkServicesFromRepository(
  store: ParkServiceConfigurationRepositoryStore,
  parkId: string,
): ParkServiceView[] {
  return (
    store
      .db()
      .prepare(
        'SELECT * FROM park_services WHERE park_id = ? ORDER BY name, id',
      )
      .all(parkId) as ParkServiceRow[]
  ).map(toParkServiceView);
}

export function updateParkServiceInRepository(
  store: ParkServiceConfigurationRepositoryStore,
  input: UpdateParkServiceInput,
): ParkServiceView {
  const access = requireActiveParkAdmin(store, input.parkId);
  access.requireActor(input.actorAccountId, '只有产业园管理员可配置服务');
  const serviceId = normalizeServiceId(input.serviceId);
  const current = store
    .db()
    .prepare('SELECT * FROM park_services WHERE park_id = ? AND id = ?')
    .get(access.park.id, serviceId) as ParkServiceRow | undefined;
  if (!current) throw new Error('园区服务不存在');

  const name =
    input.name === undefined
      ? current.name
      : store.normalizeOptionalText(input.name, '园区服务名称');
  if (!name) throw new Error('园区服务名称不能为空');
  const config = input.config ?? toParkServiceView(current).config;
  const normalizedConfig = Object.fromEntries(
    Object.entries(config).filter(
      (entry): entry is [string, string] =>
        entry[0].length <= 64 &&
        typeof entry[1] === 'string' &&
        entry[1].length <= 500,
    ),
  );
  store
    .db()
    .prepare(
      `UPDATE park_services
       SET name = ?, enabled = ?, config_json = ?, updated_at = datetime('now')
       WHERE park_id = ? AND id = ?`,
    )
    .run(
      name,
      (input.enabled ?? current.enabled === 1) ? 1 : 0,
      JSON.stringify(normalizedConfig),
      access.park.id,
      serviceId,
    );
  return toParkServiceView(
    store
      .db()
      .prepare('SELECT * FROM park_services WHERE park_id = ? AND id = ?')
      .get(access.park.id, serviceId) as ParkServiceRow,
  );
}

export function listParkServiceSpecialistsFromRepository(
  store: ParkServiceConfigurationRepositoryStore,
  parkId: string,
): ParkServiceSpecialistView[] {
  return (
    store
      .db()
      .prepare(
        `SELECT s.park_id, s.service_id, a.id AS account_id, a.name
         FROM park_service_specialists s
         JOIN parks p ON p.id = s.park_id AND p.status = 'active'
         JOIN accounts a ON a.id = s.account_id
           AND a.organization_id = p.admin_organization_id
         WHERE s.park_id = ? AND a.status = 'active' AND a.deleted_at IS NULL
         ORDER BY s.service_id, a.name, a.id`,
      )
      .all(parkId) as ParkServiceSpecialistRow[]
  ).map(toParkServiceSpecialistView);
}

export function setParkServiceSpecialistInRepository(
  store: ParkServiceConfigurationRepositoryStore,
  input: SetParkServiceSpecialistInput,
): ParkServiceSpecialistView {
  const access = requireActiveParkAdmin(store, input.parkId);
  access.requireActor(input.actorAccountId, '只有产业园管理员可设置服务专员');
  const specialist = store.getAccount(
    input.accountId.trim(),
    access.park.adminOrganizationId,
  );
  if (!specialist || specialist.status !== 'active') {
    throw new Error('专员必须属于产业园管理企业');
  }
  const serviceId = normalizeServiceId(input.serviceId);
  const service = store
    .db()
    .prepare('SELECT enabled FROM park_services WHERE park_id = ? AND id = ?')
    .get(access.park.id, serviceId) as { enabled: number } | undefined;
  if (!service) throw new Error('园区服务不存在');
  if (service.enabled !== 1) throw new Error('园区服务已停用');
  store
    .db()
    .prepare(
      `INSERT OR IGNORE INTO park_service_specialists
       (park_id, service_id, account_id) VALUES (?, ?, ?)`,
    )
    .run(access.park.id, serviceId, specialist.id);
  return listParkServiceSpecialistsFromRepository(store, access.park.id).find(
    (item) => item.serviceId === serviceId && item.accountId === specialist.id,
  )!;
}

export function removeParkServiceSpecialistInRepository(
  store: ParkServiceConfigurationRepositoryStore,
  input: SetParkServiceSpecialistInput,
): void {
  const access = requireActiveParkAdmin(store, input.parkId);
  access.requireActor(input.actorAccountId, '只有产业园管理员可设置服务专员');
  const serviceId = normalizeServiceId(input.serviceId);
  store
    .db()
    .prepare(
      `DELETE FROM park_service_specialists
       WHERE park_id = ? AND service_id = ? AND account_id = ?`,
    )
    .run(access.park.id, serviceId, input.accountId.trim());
}
