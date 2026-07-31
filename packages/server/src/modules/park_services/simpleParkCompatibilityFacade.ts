/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Compatibility storage for the original simple park HTTP API.
 */

import type { Database } from '../data_platform/index.js';

// ============================================================
// Entities
// ============================================================

export interface Park {
  id: string;
  name: string;
  address: string;
  adminUserIds: string[];
  createdAt: string;
}

export interface ParkInviteCode {
  code: string;
  parkId: string;
  createdBy: string;
  expiresAt: string;
  maxUses: number;
  usedCount: number;
  active: boolean;
}

export interface ParkServiceSpecialist {
  parkId: string;
  userId: string;
  serviceTypes: string[];
  assignedAt: string;
}

export interface ParkServiceRequest {
  id: string;
  parkId: string;
  enterpriseId: string;
  type: string;
  description: string;
  assignedTo: string | null;
  status: 'pending' | 'assigned' | 'in_progress' | 'resolved';
  createdAt: string;
}

export interface SimpleParkCompatibilityStore {
  db(): Database;
  createId(): string;
  randomInteger(maxExclusive: number): number;
  now(): Date;
}

/** Preserves the original simple park contract behind injected infrastructure. */
export function createSimpleParkCompatibilityFacade(
  store: SimpleParkCompatibilityStore,
) {
  // ============================================================
  // Schema
  // ============================================================

  function ensureParkSchema(): void {
    const db = store.db();
    db.exec(`
    CREATE TABLE IF NOT EXISTS simple_parks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      admin_user_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS simple_park_invite_codes (
      code TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 100,
      used_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (park_id) REFERENCES simple_parks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS simple_park_memberships (
      park_id TEXT NOT NULL,
      enterprise_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, enterprise_id),
      FOREIGN KEY (park_id) REFERENCES simple_parks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS simple_park_service_specialists (
      park_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      service_types TEXT NOT NULL DEFAULT '[]',
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, user_id),
      FOREIGN KEY (park_id) REFERENCES simple_parks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS simple_park_service_requests (
      id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      enterprise_id TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','assigned','in_progress','resolved')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (park_id) REFERENCES simple_parks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_simple_park_memberships_enterprise
      ON simple_park_memberships(enterprise_id);
    CREATE INDEX IF NOT EXISTS idx_simple_park_service_requests_status
      ON simple_park_service_requests(park_id, status);
    CREATE INDEX IF NOT EXISTS idx_simple_park_invite_codes_active
      ON simple_park_invite_codes(park_id, active);
  `);
  }

  // ============================================================
  // Park CRUD
  // ============================================================

  interface ParkRow {
    id: string;
    name: string;
    address: string;
    admin_user_ids: string;
    created_at: string;
  }

  function toPark(row: ParkRow): Park {
    let adminUserIds: string[] = [];
    try {
      adminUserIds = JSON.parse(row.admin_user_ids);
    } catch {
      /* keep [] */
    }
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      adminUserIds,
      createdAt: row.created_at,
    };
  }

  function createPark(input: {
    name: string;
    address?: string;
    adminUserIds?: string[];
  }): Park {
    ensureParkSchema();
    const name = input.name.trim();
    if (!name || name.length > 120)
      throw new Error('园区名称不能为空且不能超过 120 个字符');
    const id = `park_${store.createId()}`;
    const adminUserIds = input.adminUserIds ?? [];
    store
      .db()
      .prepare(
        `INSERT INTO simple_parks (id, name, address, admin_user_ids)
     VALUES (?, ?, ?, ?)`,
      )
      .run(id, name, input.address?.trim() || '', JSON.stringify(adminUserIds));
    return getPark(id)!;
  }

  function getPark(id: string): Park | null {
    ensureParkSchema();
    const row = store
      .db()
      .prepare('SELECT * FROM simple_parks WHERE id = ?')
      .get(id) as ParkRow | undefined;
    return row ? toPark(row) : null;
  }

  function listParks(): Park[] {
    ensureParkSchema();
    return (
      store
        .db()
        .prepare('SELECT * FROM simple_parks ORDER BY name')
        .all() as ParkRow[]
    ).map(toPark);
  }

  // ============================================================
  // Invite Codes
  // ============================================================

  const PARK_INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function generateParkInviteCode(): string {
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += PARK_INVITE_CHARS[store.randomInteger(PARK_INVITE_CHARS.length)];
    }
    return code;
  }

  interface ParkInviteCodeRow {
    code: string;
    park_id: string;
    created_by: string;
    expires_at: string;
    max_uses: number;
    used_count: number;
    active: number;
  }

  function toParkInviteCode(row: ParkInviteCodeRow): ParkInviteCode {
    return {
      code: row.code,
      parkId: row.park_id,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count,
      active: row.active === 1,
    };
  }

  function createInviteCode(input: {
    parkId: string;
    createdBy: string;
    expiresAt?: string; // ISO string; defaults to 7 days
    maxUses?: number;
  }): ParkInviteCode {
    ensureParkSchema();
    const park = getPark(input.parkId);
    if (!park) throw new Error('Park not found');
    const code = generateParkInviteCode();
    const expiresAt =
      input.expiresAt ||
      new Date(store.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const maxUses = input.maxUses ?? 100;
    store
      .db()
      .prepare(
        `INSERT INTO simple_park_invite_codes (code, park_id, created_by, expires_at, max_uses)
     VALUES (?, ?, ?, ?, ?)`,
      )
      .run(code, input.parkId, input.createdBy, expiresAt, maxUses);
    const row = store
      .db()
      .prepare('SELECT * FROM simple_park_invite_codes WHERE code = ?')
      .get(code) as ParkInviteCodeRow;
    return toParkInviteCode(row);
  }

  function validateInviteCode(code: string): {
    valid: boolean;
    parkId?: string;
    error?: string;
  } {
    ensureParkSchema();
    const row = store
      .db()
      .prepare('SELECT * FROM simple_park_invite_codes WHERE code = ?')
      .get(code) as ParkInviteCodeRow | undefined;
    if (!row) return { valid: false, error: '邀请码不存在' };
    if (!row.active) return { valid: false, error: '邀请码已失效' };
    if (row.used_count >= row.max_uses)
      return { valid: false, error: '邀请码已达使用上限' };
    if (new Date(row.expires_at).getTime() < store.now().getTime()) {
      return { valid: false, error: '邀请码已过期' };
    }
    return { valid: true, parkId: row.park_id };
  }

  function useInviteCode(
    code: string,
    enterpriseId: string,
  ): {
    success: boolean;
    parkId?: string;
    error?: string;
  } {
    ensureParkSchema();
    const validation = validateInviteCode(code);
    if (!validation.valid || !validation.parkId) {
      return { success: false, error: validation.error };
    }
    const parkId = validation.parkId;

    // Check if enterprise is already a member
    const existing = store
      .db()
      .prepare(
        'SELECT 1 FROM simple_park_memberships WHERE park_id = ? AND enterprise_id = ?',
      )
      .get(parkId, enterpriseId);
    if (existing) {
      return { success: false, error: '企业已是该园区成员' };
    }

    const db = store.db();
    db.prepare(
      'UPDATE simple_park_invite_codes SET used_count = used_count + 1 WHERE code = ?',
    ).run(code);
    db.prepare(
      'INSERT INTO simple_park_memberships (park_id, enterprise_id) VALUES (?, ?)',
    ).run(parkId, enterpriseId);
    return { success: true, parkId };
  }

  // ============================================================
  // Service Specialists
  // ============================================================

  interface ParkServiceSpecialistRow {
    park_id: string;
    user_id: string;
    service_types: string;
    assigned_at: string;
  }

  function toSpecialist(row: ParkServiceSpecialistRow): ParkServiceSpecialist {
    let serviceTypes: string[] = [];
    try {
      serviceTypes = JSON.parse(row.service_types);
    } catch {
      /* keep [] */
    }
    return {
      parkId: row.park_id,
      userId: row.user_id,
      serviceTypes,
      assignedAt: row.assigned_at,
    };
  }

  function assignSpecialist(input: {
    parkId: string;
    userId: string;
    serviceTypes: string[];
  }): ParkServiceSpecialist {
    ensureParkSchema();
    const park = getPark(input.parkId);
    if (!park) throw new Error('Park not found');
    const serviceTypes = [
      ...new Set(input.serviceTypes.map((s) => s.trim()).filter(Boolean)),
    ];
    if (serviceTypes.length === 0) throw new Error('至少指定一种服务类型');
    store
      .db()
      .prepare(
        `INSERT OR REPLACE INTO simple_park_service_specialists (park_id, user_id, service_types, assigned_at)
     VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(input.parkId, input.userId, JSON.stringify(serviceTypes));
    const row = store
      .db()
      .prepare(
        'SELECT * FROM simple_park_service_specialists WHERE park_id = ? AND user_id = ?',
      )
      .get(input.parkId, input.userId) as ParkServiceSpecialistRow;
    return toSpecialist(row);
  }

  function getSpecialists(parkId: string): ParkServiceSpecialist[] {
    ensureParkSchema();
    return (
      store
        .db()
        .prepare(
          'SELECT * FROM simple_park_service_specialists WHERE park_id = ? ORDER BY assigned_at',
        )
        .all(parkId) as ParkServiceSpecialistRow[]
    ).map(toSpecialist);
  }

  function removeSpecialist(parkId: string, userId: string): boolean {
    ensureParkSchema();
    const result = store
      .db()
      .prepare(
        'DELETE FROM simple_park_service_specialists WHERE park_id = ? AND user_id = ?',
      )
      .run(parkId, userId) as { changes?: number | bigint };
    return Number(result.changes ?? 0) > 0;
  }

  // ============================================================
  // Service Requests
  // ============================================================

  interface ParkServiceRequestRow {
    id: string;
    park_id: string;
    enterprise_id: string;
    type: string;
    description: string;
    assigned_to: string | null;
    status: 'pending' | 'assigned' | 'in_progress' | 'resolved';
    created_at: string;
  }

  function toServiceRequest(row: ParkServiceRequestRow): ParkServiceRequest {
    return {
      id: row.id,
      parkId: row.park_id,
      enterpriseId: row.enterprise_id,
      type: row.type,
      description: row.description,
      assignedTo: row.assigned_to,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  function createServiceRequest(input: {
    parkId: string;
    enterpriseId: string;
    type: string;
    description: string;
  }): ParkServiceRequest {
    ensureParkSchema();
    const type = input.type.trim();
    const description = input.description.trim();
    if (!type || !description) throw new Error('服务类型和描述不能为空');
    const id = `sr_${store.createId()}`;
    store
      .db()
      .prepare(
        `INSERT INTO simple_park_service_requests (id, park_id, enterprise_id, type, description)
     VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.parkId, input.enterpriseId, type, description);
    const row = store
      .db()
      .prepare('SELECT * FROM simple_park_service_requests WHERE id = ?')
      .get(id) as ParkServiceRequestRow;
    return toServiceRequest(row);
  }

  function routeServiceRequest(requestId: string): ParkServiceRequest | null {
    ensureParkSchema();
    const row = store
      .db()
      .prepare('SELECT * FROM simple_park_service_requests WHERE id = ?')
      .get(requestId) as ParkServiceRequestRow | undefined;
    if (!row) return null;
    if (row.status !== 'pending') return toServiceRequest(row);

    // Find matching specialist by service type
    const specialists = store
      .db()
      .prepare(
        'SELECT * FROM simple_park_service_specialists WHERE park_id = ?',
      )
      .all(row.park_id) as ParkServiceSpecialistRow[];

    const matching = specialists.filter((s) => {
      let types: string[] = [];
      try {
        types = JSON.parse(s.service_types);
      } catch {
        /* */
      }
      return types.includes(row.type);
    });

    if (matching.length > 0) {
      // Assign to first matching specialist
      const specialist = matching[0]!;
      store
        .db()
        .prepare(
          `UPDATE simple_park_service_requests
       SET assigned_to = ?, status = 'assigned'
       WHERE id = ?`,
        )
        .run(specialist.user_id, requestId);
    } else {
      // Fall back to park admin
      const park = getPark(row.park_id);
      const fallbackUser = park?.adminUserIds[0] ?? null;
      store
        .db()
        .prepare(
          `UPDATE simple_park_service_requests
       SET assigned_to = ?, status = 'assigned'
       WHERE id = ?`,
        )
        .run(fallbackUser, requestId);
    }

    const updated = store
      .db()
      .prepare('SELECT * FROM simple_park_service_requests WHERE id = ?')
      .get(requestId) as ParkServiceRequestRow;
    return toServiceRequest(updated);
  }

  function resolveServiceRequest(requestId: string): ParkServiceRequest | null {
    ensureParkSchema();
    const row = store
      .db()
      .prepare('SELECT * FROM simple_park_service_requests WHERE id = ?')
      .get(requestId) as ParkServiceRequestRow | undefined;
    if (!row) return null;
    store
      .db()
      .prepare(
        `UPDATE simple_park_service_requests SET status = 'resolved' WHERE id = ?`,
      )
      .run(requestId);
    const updated = store
      .db()
      .prepare('SELECT * FROM simple_park_service_requests WHERE id = ?')
      .get(requestId) as ParkServiceRequestRow;
    return toServiceRequest(updated);
  }

  function getParkServiceRequests(
    parkId: string,
    status?: string,
  ): ParkServiceRequest[] {
    ensureParkSchema();
    const rows = status
      ? (store
          .db()
          .prepare(
            'SELECT * FROM simple_park_service_requests WHERE park_id = ? AND status = ? ORDER BY created_at DESC',
          )
          .all(parkId, status) as ParkServiceRequestRow[])
      : (store
          .db()
          .prepare(
            'SELECT * FROM simple_park_service_requests WHERE park_id = ? ORDER BY created_at DESC',
          )
          .all(parkId) as ParkServiceRequestRow[]);
    return rows.map(toServiceRequest);
  }

  return {
    createPark,
    getPark,
    listParks,
    createInviteCode,
    validateInviteCode,
    useInviteCode,
    assignSpecialist,
    getSpecialists,
    removeSpecialist,
    createServiceRequest,
    routeServiceRequest,
    resolveServiceRequest,
    getParkServiceRequests,
  };
}
