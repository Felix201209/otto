/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 数据库 Schema 贡献器：根服务器本地元数据表。
 *
 * 原则：
 *  - 只存计数/时延/字节/TTL/路径类型/配额与错误类别，不存明文内容。
 *  - rendezvous record 的 candidates 只存校验后的规范化 JSON；relay 数据只存计数，
 *    具体密文块在内存中短时驻留，P2P 成功后销毁。
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const MESH_RENDEZVOUS_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'mesh_rendezvous',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS mesh_rendezvous_records (
        node_id TEXT PRIMARY KEY,
        signed_record_json TEXT NOT NULL,
        signing_key_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mesh_rendezvous_expiry
        ON mesh_rendezvous_records(expires_at_ms);

      CREATE TABLE IF NOT EXISTS mesh_nat_sessions (
        session_id TEXT PRIMARY KEY,
        node_a TEXT NOT NULL,
        node_b TEXT NOT NULL,
        tenant_a TEXT,
        tenant_b TEXT,
        path_type TEXT NOT NULL CHECK(path_type IN ('p2p', 'relay')),
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mesh_nat_sessions_expiry
        ON mesh_nat_sessions(expires_at_ms);
      CREATE INDEX IF NOT EXISTS idx_mesh_nat_sessions_nodes
        ON mesh_nat_sessions(node_a, node_b);

      CREATE TABLE IF NOT EXISTS mesh_quota_buckets (
        scope TEXT NOT NULL,
        window_started_at_ms INTEGER NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        byte_count INTEGER NOT NULL DEFAULT 0,
        connection_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, window_started_at_ms)
      );

      CREATE TABLE IF NOT EXISTS mesh_ddos_decisions (
        source TEXT PRIMARY KEY,
        decision TEXT NOT NULL CHECK(decision IN ('allow', 'throttle', 'block')),
        reason TEXT NOT NULL,
        decided_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mesh_ddos_expiry
        ON mesh_ddos_decisions(expires_at_ms);

      CREATE TABLE IF NOT EXISTS mesh_path_receipts (
        receipt_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path_type TEXT NOT NULL CHECK(path_type IN ('p2p', 'relay')),
        node_a TEXT NOT NULL,
        node_b TEXT NOT NULL,
        bytes_forwarded INTEGER NOT NULL DEFAULT 0,
        chunks_forwarded INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mesh_path_receipts_created
        ON mesh_path_receipts(created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_mesh_path_receipts_session
        ON mesh_path_receipts(session_id);
    `);
  },
};
