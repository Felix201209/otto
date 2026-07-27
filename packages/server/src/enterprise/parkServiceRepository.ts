import type { Database } from '../modules/data_platform/index.js';
import type {
  ParkServiceSpecialistView,
  ParkServiceView,
} from './parkServiceTypes.js';

interface ParkServiceAccount {
  id: string;
  isAdmin: boolean;
  status: string;
}

interface ParkServicePark {
  id: string;
  adminOrganizationId: string;
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

export interface ParkServiceRepositoryStore {
  db(): Database;
  getAccount(accountId: string, organizationId?: string): ParkServiceAccount | null;
  getPark(parkId: string): ParkServicePark | null;
  normalizeOptionalText(value: string, field: string, maxLength?: number): string | null;
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

export function listParkServices(
  store: ParkServiceRepositoryStore,
  parkId: string,
): ParkServiceView[] {
  return (
    store.db()
      .prepare(
        'SELECT * FROM park_services WHERE park_id = ? ORDER BY name, id',
      )
      .all(parkId) as ParkServiceRow[]
  ).map(toParkServiceView);
}

export function updateParkService(
  store: ParkServiceRepositoryStore,
  input: {
    parkId: string;
    actorAccountId: string;
    serviceId: string;
    name?: string;
    enabled?: boolean;
    config?: Record<string, string>;
  },
): ParkServiceView {
  const park = store.getPark(input.parkId);
  if (!park) throw new Error('产业园不存在');
  const actor = store.getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理员可配置服务');
  const current = store.db()
    .prepare('SELECT * FROM park_services WHERE park_id = ? AND id = ?')
    .get(park.id, input.serviceId) as ParkServiceRow | undefined;
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
  store.db()
    .prepare(
      `UPDATE park_services SET name = ?, enabled = ?, config_json = ?, updated_at = datetime('now')
     WHERE park_id = ? AND id = ?`,
    )
    .run(
      name,
      (input.enabled ?? current.enabled === 1) ? 1 : 0,
      JSON.stringify(normalizedConfig),
      park.id,
      input.serviceId,
    );
  return toParkServiceView(
    store.db()
      .prepare('SELECT * FROM park_services WHERE park_id = ? AND id = ?')
      .get(park.id, input.serviceId) as ParkServiceRow,
  );
}

export function listParkServiceSpecialists(
  store: ParkServiceRepositoryStore,
  parkId: string,
): ParkServiceSpecialistView[] {
  return (
    store.db()
      .prepare(
        `SELECT s.park_id, s.service_id, a.id AS account_id, a.name
     FROM park_service_specialists s JOIN accounts a ON a.id = s.account_id
     WHERE s.park_id = ? AND a.status = 'active' AND a.deleted_at IS NULL
     ORDER BY s.service_id, a.name, a.id`,
      )
      .all(parkId) as ParkServiceSpecialistRow[]
  ).map(toParkServiceSpecialistView);
}

export function setParkServiceSpecialist(
  store: ParkServiceRepositoryStore,
  input: {
    parkId: string;
    actorAccountId: string;
    serviceId: string;
    accountId: string;
  },
): ParkServiceSpecialistView {
  const park = store.getPark(input.parkId);
  if (!park) throw new Error('产业园不存在');
  const actor = store.getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理员可设置服务专员');
  const specialist = store.getAccount(input.accountId, park.adminOrganizationId);
  if (!specialist || specialist.status !== 'active')
    throw new Error('专员必须属于产业园管理企业');
  const serviceId = input.serviceId.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(serviceId))
    throw new Error('服务标识格式不正确');
  const service = store.db()
    .prepare('SELECT enabled FROM park_services WHERE park_id = ? AND id = ?')
    .get(park.id, serviceId) as { enabled: number } | undefined;
  if (!service) throw new Error('园区服务不存在');
  if (service.enabled !== 1) throw new Error('园区服务已停用');
  store.db()
    .prepare(
      `INSERT OR IGNORE INTO park_service_specialists (park_id, service_id, account_id)
     VALUES (?, ?, ?)`,
    )
    .run(park.id, serviceId, specialist.id);
  return listParkServiceSpecialists(store, park.id).find(
    (item) => item.serviceId === serviceId && item.accountId === specialist.id,
  )!;
}

export function removeParkServiceSpecialist(
  store: ParkServiceRepositoryStore,
  input: {
    parkId: string;
    actorAccountId: string;
    serviceId: string;
    accountId: string;
  },
): void {
  const park = store.getPark(input.parkId);
  if (!park) throw new Error('产业园不存在');
  const actor = store.getAccount(input.actorAccountId, park.adminOrganizationId);
  if (!actor?.isAdmin || actor.status !== 'active')
    throw new Error('只有产业园管理员可设置服务专员');
  store.db()
    .prepare(
      `DELETE FROM park_service_specialists
     WHERE park_id = ? AND service_id = ? AND account_id = ?`,
    )
    .run(park.id, input.serviceId, input.accountId);
}
