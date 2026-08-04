/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-10 注册持久化（SQLite）。
 *
 * 取代 getMachineFingerprint 的可变硬件拼接：记录改为「公钥绑定实例身份」，
 * 一次性安全注册，防重放（consumed_tokens）与防克隆（deployment_id 主键 + registered 终态）。
 *
 * 表：
 *  - deployment_registrations：deployment_id → 已注册部署（含派生指纹、公钥、终态）。
 *  - consumed_bootstrap_nonces：nonce → 已消费凭据（防重放）。
 */

import type { Database } from '../data_platform/index.js';
import type { RegisteredDeployment } from './deploymentRegistrationTypes.js';

export interface RegistrationStore {
  db(): Database;
}

export interface StoredRegistration {
  deployment_id: string;
  customer_id: string;
  order_id: string;
  state: string;
  public_key_hex: string;
  fingerprint: string;
  identity_version: number;
  registered_at_ms: number;
  consumed_nonce: string;
  legacy_machine_fingerprint_in_use: number;
}

function ensureTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS deployment_registrations (
      deployment_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      state TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      identity_version INTEGER NOT NULL DEFAULT 1,
      registered_at_ms INTEGER NOT NULL,
      consumed_nonce TEXT NOT NULL,
      legacy_machine_fingerprint_in_use INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS consumed_bootstrap_nonces (
      nonce TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      consumed_at_ms INTEGER NOT NULL
    );
  `);
}

/** 是否已注册该部署（防克隆：registered 终态不可重复）。 */
export function isDeploymentRegistered(
  store: RegistrationStore,
  deploymentId: string,
): boolean {
  const database = store.db();
  ensureTable(database);
  const row = database
    .prepare('SELECT deployment_id FROM deployment_registrations WHERE deployment_id = ? AND state = ?')
    .get(deploymentId, 'registered') as { deployment_id: string } | undefined;
  return Boolean(row);
}

/** bootstrap nonce 是否已被消费（防重放）。 */
export function isNonceConsumed(store: RegistrationStore, nonce: string): boolean {
  const database = store.db();
  ensureTable(database);
  const row = database
    .prepare('SELECT nonce FROM consumed_bootstrap_nonces WHERE nonce = ?')
    .get(nonce) as { nonce: string } | undefined;
  return Boolean(row);
}

/** 读取既有注册（用于 customer 归属核对等）。 */
export function getRegistration(
  store: RegistrationStore,
  deploymentId: string,
): StoredRegistration | null {
  const database = store.db();
  ensureTable(database);
  return (
    database
      .prepare('SELECT * FROM deployment_registrations WHERE deployment_id = ?')
      .get(deploymentId) as StoredRegistration | undefined
  ) ?? null;
}

/** 读取既有注册中的指纹/公钥（供迁移对照）。 */
export function getRegistrationIdentity(
  store: RegistrationStore,
  deploymentId: string,
): { fingerprint: string; publicKeyHex: string; legacyMachineFingerprintInUse: boolean } | null {
  const reg = getRegistration(store, deploymentId);
  if (!reg) return null;
  return {
    fingerprint: reg.fingerprint,
    publicKeyHex: reg.public_key_hex,
    legacyMachineFingerprintInUse: reg.legacy_machine_fingerprint_in_use === 1,
  };
}

/**
 * 原子落库：一次性注册。
 * 仅在既未注册、nonce 未消费时成功。防重放 + 防克隆在同一事务内保证。
 */
export function persistRegistration(
  store: RegistrationStore,
  record: RegisteredDeployment,
  nowMs: number,
): { ok: boolean; reason?: 'already_registered' | 'nonce_replayed' } {
  const database = store.db();
  ensureTable(database);
  database.exec('BEGIN IMMEDIATE');
  try {
    if (isDeploymentRegistered(store, record.deploymentId)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'already_registered' };
    }
    if (isNonceConsumed(store, record.consumedNonce)) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'nonce_replayed' };
    }
    database
      .prepare(
        `INSERT INTO deployment_registrations
           (deployment_id, customer_id, order_id, state, public_key_hex, fingerprint,
            identity_version, registered_at_ms, consumed_nonce, legacy_machine_fingerprint_in_use)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.deploymentId,
        record.customerId,
        record.orderId,
        record.state,
        record.publicKeyHex,
        record.fingerprint,
        record.identityVersion,
        record.registeredAtMs,
        record.consumedNonce,
        record.legacyMachineFingerprintInUse ? 1 : 0,
      );
    database
      .prepare(
        'INSERT INTO consumed_bootstrap_nonces (nonce, deployment_id, consumed_at_ms) VALUES (?, ?, ?)',
      )
      .run(record.consumedNonce, record.deploymentId, nowMs);
    database.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* noop */
    }
    throw e;
  }
}
