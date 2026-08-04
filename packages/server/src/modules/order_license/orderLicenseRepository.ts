/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-11 订单事件持久化（SQLite）。
 *
 * 幂等地保存订单投影与已处理事件 ID，重启后可安全续跑：
 *  - order_events：事件 ID → 已处理标记（幂等去重）；
 *  - order_licenses：orderId → 最新权益聚合（含 licenseId、version、状态）。
 *
 * 中性设计：order_events 唯一键 event_id；order_licenses 唯一键 order_id。
 */

import type { Database } from '../data_platform/index.js';
import type {
  LicenseEntitlement,
  OrderEvent,
  OrderLifecycleState,
} from './orderLicenseTypes.js';

export interface OrderLicenseStore {
  db(): Database;
}

export interface StoredOrderEntitlement {
  order_id: string;
  order_state: OrderLifecycleState;
  version: number;
  deployment_id: string;
  customer_id: string;
  customer_name: string;
  plan: string;
  seat_limit: number;
  modules_json: string;
  issued_at_ms: number;
  expires_at_ms: number;
  grace_period_ms: number;
  license_id: string;
}

function ensureTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS order_events (
      event_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      processed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_licenses (
      order_id TEXT PRIMARY KEY,
      order_state TEXT NOT NULL,
      version INTEGER NOT NULL,
      deployment_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      plan TEXT NOT NULL,
      seat_limit INTEGER NOT NULL,
      modules_json TEXT NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      grace_period_ms INTEGER NOT NULL DEFAULT 0,
      license_id TEXT NOT NULL
    );
  `);
}

/** 事件是否已处理（幂等）；同时返回该 orderId 的既有版本（单调校验）。 */
export function getEventState(
  store: OrderLicenseStore,
  eventId: string,
  orderId: string,
): { processed: boolean; latestVersion: number; orderState: OrderLifecycleState | null } {
  const database = store.db();
  ensureTable(database);
  const ev = database.prepare(
    'SELECT event_id FROM order_events WHERE event_id = ?',
  ).get(eventId) as { event_id: string } | undefined;
  const order = database.prepare(
    'SELECT order_state, version FROM order_licenses WHERE order_id = ?',
  ).get(orderId) as { order_state: OrderLifecycleState; version: number } | undefined;
  return {
    processed: Boolean(ev),
    latestVersion: order?.version ?? 0,
    orderState: order?.order_state ?? null,
  };
}

/** 记录已处理事件 + 最新权益聚合（同一事务保证原子）。 */
export function persistOrderEntitlement(
  store: OrderLicenseStore,
  event: OrderEvent,
  entitlement: LicenseEntitlement,
  orderState: OrderLifecycleState,
  now: number,
): void {
  const database = store.db();
  ensureTable(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(
      `INSERT INTO order_events (event_id, order_id, version, processed_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    ).run(event.eventId, event.orderId, event.version, now);
    database.prepare(
      `INSERT INTO order_licenses
         (order_id, order_state, version, deployment_id, customer_id, customer_name,
          plan, seat_limit, modules_json, issued_at_ms, expires_at_ms,
          grace_period_ms, license_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         order_state = excluded.order_state,
         version = excluded.version,
         deployment_id = excluded.deployment_id,
         plan = excluded.plan,
         seat_limit = excluded.seat_limit,
         modules_json = excluded.modules_json,
         issued_at_ms = excluded.issued_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         grace_period_ms = excluded.grace_period_ms,
         license_id = excluded.license_id`,
    ).run(
      event.orderId,
      orderState,
      event.version,
      event.deploymentId,
      entitlement.customer.id,
      entitlement.customer.name,
      entitlement.plan,
      entitlement.seatLimit,
      JSON.stringify(entitlement.modules),
      entitlement.issuedAtMs,
      entitlement.expiresAtMs,
      entitlement.gracePeriodMs,
      entitlement.licenseId,
    );
    database.exec('COMMIT');
  } catch (e) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* noop */
    }
    throw e;
  }
}

/** 读取某 orderId 的最新权益（用于响应丢失恢复/核对）。 */
export function getOrderEntitlement(
  store: OrderLicenseStore,
  orderId: string,
): StoredOrderEntitlement | null {
  const database = store.db();
  ensureTable(database);
  return (
    database.prepare(
      `SELECT order_id, order_state, version, deployment_id, customer_id, customer_name,
              plan, seat_limit, modules_json, issued_at_ms, expires_at_ms,
              grace_period_ms, license_id
       FROM order_licenses WHERE order_id = ?`,
    ).get(orderId) as StoredOrderEntitlement | undefined
  ) ?? null;
}

/** 读取所有已持久化订单记录（用于重建状态机投影，保证多事件生命周期上下文）。 */
export function loadAllOrderRecords(
  store: OrderLicenseStore,
): Array<{
  orderId: string;
  state: OrderLifecycleState;
  latestVersion: number;
  deploymentId: string;
  customer: { id: string; name: string };
  plan: string;
  seatLimit: number;
  modules: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  gracePeriodMs: number;
}> {
  const database = store.db();
  ensureTable(database);
  const rows = database.prepare(
    `SELECT order_id, order_state, version, deployment_id, customer_id, customer_name,
            plan, seat_limit, modules_json, issued_at_ms, expires_at_ms, grace_period_ms
     FROM order_licenses`,
  ).all() as Array<{
    order_id: string;
    order_state: OrderLifecycleState;
    version: number;
    deployment_id: string;
    customer_id: string;
    customer_name: string;
    plan: string;
    seat_limit: number;
    modules_json: string;
    issued_at_ms: number;
    expires_at_ms: number;
    grace_period_ms: number;
  }>;
  return rows.map((r) => ({
    orderId: r.order_id,
    state: r.order_state,
    latestVersion: r.version,
    deploymentId: r.deployment_id,
    customer: { id: r.customer_id, name: r.customer_name },
    plan: r.plan,
    seatLimit: r.seat_limit,
    modules: JSON.parse(r.modules_json) as string[],
    issuedAtMs: r.issued_at_ms,
    expiresAtMs: r.expires_at_ms,
    gracePeriodMs: r.grace_period_ms,
  }));
}
