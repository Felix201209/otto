/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 企业 report 算法 + 成本口径单测。
 * 数据安全：绝不污染真实企业库。每个测试用独立临时 OTTO_ENTERPRISE_DIR，
 * 并 vi.resetModules() + 动态 import，让 db.ts 的模块级单例每次全新，互不串档。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, scryptSync } from 'node:crypto';
import { Database } from '../sqlite-compat.js';
import {
  ATOA_DIRECT_MESSAGE_MAX_LENGTH,
  ATOA_REQUEST_PREFIX,
  ATOA_RESPONSE_PREFIX,
  buildAtoaRequest,
  buildAtoaResponse,
} from '../../../core/src/a2a/atoaProtocol.js';

type DbModule = typeof import('./db.js');

let tmpDir: string;
const prevEnv: Record<string, string | undefined> = {};

// 需要在测试里覆盖/还原的 env（隔离目录 + 估算参数）。
const ENV_KEYS = [
  'OTTO_ENTERPRISE_DIR',
  'OTTO_ESTIMATE_MANUAL_MULT',
  'OTTO_ESTIMATE_CNY_PER_HOUR',
  'OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP',
  'OTTO_ENTERPRISE_USAGE_DAILY_LIMIT',
] as const;

/** 设隔离目录 + 可选估算 env，然后拿到全新的 db 模块（单例已重置）。 */
async function freshDb(
  estimateEnv: Record<string, string> = {},
): Promise<DbModule> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  for (const [k, v] of Object.entries(estimateEnv)) process.env[k] = v;
  vi.resetModules();
  return import('./db.js');
}

beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ent-db-'));
});

afterEach(() => {
  // 还原所有被动过的 env，并清掉临时库，绝不留痕。
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('知识库旧库迁移', () => {
  it('为单组织旧表补齐 organization_id/source_id，保留历史知识并支持幂等写入', async () => {
    const legacy = new Database(path.join(tmpDir, 'data.db'));
    legacy.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        department TEXT,
        category TEXT,
        content TEXT NOT NULL,
        contributor TEXT,
        confidence REAL DEFAULT 0.5,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO knowledge (department, category, content, contributor, confidence)
      VALUES ('研发部', 'solution', '旧版知识仍需保留', '历史员工', 0.9);
    `);
    legacy.close();

    const db = await freshDb();
    const columns = db
      .getDB()
      .prepare('PRAGMA table_info(knowledge)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['organization_id', 'source_id']),
    );
    expect(db.getKnowledge()).toEqual([
      expect.objectContaining({
        content: '旧版知识仍需保留',
        contributor: '历史员工',
      }),
    ]);

    const entry = {
      sourceId: 'local-kb-1',
      department: '研发部',
      category: 'solution',
      content: '自动捕获的新知识',
      contributor: '当前员工',
      confidence: 0.85,
    };
    expect(db.addKnowledge(entry)).toBe(true);
    expect(db.addKnowledge(entry)).toBe(false);
  });
});

describe('旧账号会话迁移', () => {
  it('把 v1.9.1 单组织账号和明文 token 会话迁移到 schema 8，保留登录建联能力', async () => {
    const salt = '00112233445566778899aabbccddeeff';
    const password = 'legacy-password';
    const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
    const legacyToken = 'legacy-session-token-preserved';
    const legacy = new Database(path.join(tmpDir, 'data.db'));
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT DEFAULT '',
        role TEXT DEFAULT 'member',
        department TEXT DEFAULT 'default',
        phone TEXT,
        credits_balance INTEGER DEFAULT 0,
        credits_distributed INTEGER DEFAULT 0,
        max_distribute INTEGER DEFAULT 0,
        tokens_used INTEGER DEFAULT 0,
        tokens_limit INTEGER DEFAULT 4000000,
        invite_code TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE auth_sessions (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    legacy
      .prepare(
        `INSERT INTO accounts (id, username, name, password_hash, role, department, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        'legacy_account_1',
        'legacy-user',
        '历史用户',
        passwordHash,
        'admin',
        '旧部门',
      );
    legacy
      .prepare(
        `INSERT INTO auth_sessions (token, account_id, expires_at)
       VALUES (?, ?, ?)`,
      )
      .run(
        legacyToken,
        'legacy_account_1',
        new Date(Date.now() + 3_600_000).toISOString(),
      );
    legacy.close();

    const db = await freshDb();
    expect(db.getDatabaseReadiness()).toEqual({
      ready: true,
      schemaVersion: 17,
    });
    const sessionColumns = db
      .getDB()
      .prepare('PRAGMA table_info(auth_sessions)')
      .all() as Array<{ name: string }>;
    expect(sessionColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'organization_id',
        'account_id',
        'token_hash',
        'expires_at',
        'revoked_at',
        'last_used_at',
      ]),
    );
    expect(db.authenticateAccount('legacy-user', password)).toMatchObject({
      id: 'legacy_account_1',
      username: 'legacy-user',
      organizationId: db.DEFAULT_ORGANIZATION_ID,
    });
    expect(db.getAccountBySession(legacyToken)).toMatchObject({
      id: 'legacy_account_1',
      username: 'legacy-user',
    });
    const freshSession = db.createAuthSession('legacy_account_1');
    expect(db.getAccountBySession(freshSession.token)).toMatchObject({
      id: 'legacy_account_1',
      username: 'legacy-user',
    });
  });
});

describe('数据库 readiness', () => {
  it('执行真实查询并返回当前 schema version', async () => {
    const db = await freshDb();
    expect(db.getDatabaseReadiness()).toEqual({
      ready: true,
      schemaVersion: 17,
    });
  });

  it('从 v10 升级时保留工单历史并允许记录物业报修转交', async () => {
    const first = await freshDb();
    const creator = first.createAccount({
      username: 'ticket-migration-creator', password: 'ticket-migration-password', name: '迁移申请人',
    });
    first.createTicket({
      createdByAccountId: creator.id,
      title: '历史 IT 工单',
      description: '必须保留创建记录',
      targetTags: ['IT'],
    });
    first.closeEnterpriseDatabase();

    const legacy = new Database(path.join(tmpDir, 'data.db'));
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE ticket_events RENAME TO ticket_events_v11_source;
      CREATE TABLE ticket_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        actor_account_id TEXT,
        action TEXT NOT NULL CHECK(action IN ('created', 'accept', 'respond', 'complete', 'confirm')),
        status_before TEXT,
        status_after TEXT NOT NULL,
        response_type TEXT,
        response_text TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO ticket_events
      SELECT * FROM ticket_events_v11_source;
      DROP TABLE ticket_events_v11_source;
      PRAGMA user_version = 10;
    `);
    legacy.close();

    vi.resetModules();
    const reopened: DbModule = await import('./db.js');
    expect(reopened.getDatabaseReadiness()).toEqual({ ready: true, schemaVersion: 17 });
    const tableSql = (reopened.getDB().prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_events'",
    ).get() as { sql: string }).sql;
    expect(tableSql).toContain("'transfer'");
    expect((reopened.getDB().prepare('SELECT COUNT(*) AS count FROM ticket_events').get() as { count: number }).count).toBe(1);
  });

  it('从 v11 补齐既有园区申请单号并推进当日园区级序列', async () => {
    const first = await freshDb();
    const parkOrganization = first.createOrganization({
      name: '申请单号迁移园区',
      slug: 'application-number-migration',
    });
    const parkAdmin = first.createAccount({
      organizationId: parkOrganization.id,
      username: 'application.number.admin',
      password: 'application-number-password',
      name: '园区管理员',
      isAdmin: true,
    });
    const park = first.createPark({
      adminOrganizationId: parkOrganization.id,
      actorAccountId: parkAdmin.id,
      name: '申请单号迁移园区',
    });
    const legacyTicket = first.createTicket({
      createdByAccountId: parkAdmin.id,
      serviceId: 'parking',
      title: '历史停车申请',
      description: '迁移后必须有用户可见申请单号',
      formData: {
        company: parkOrganization.name,
        roomNumber: 'A-101',
        contact: parkAdmin.name,
        phone: '13800138000',
        applicationType: 'underground-fixed',
        quantity: '1',
      },
    });
    first.closeEnterpriseDatabase();

    const legacy = new Database(path.join(tmpDir, 'data.db'));
    legacy.exec(`
      UPDATE it_tickets SET created_at = '2026-07-28 16:00:00'
      WHERE id = '${legacyTicket.id}';
      DROP INDEX idx_it_tickets_park_application_number;
      ALTER TABLE it_tickets DROP COLUMN application_number;
      DROP TABLE park_application_sequences;
      PRAGMA user_version = 11;
    `);
    legacy.close();

    vi.resetModules();
    const reopened: DbModule = await import('./db.js');
    try {
      expect(reopened.getDatabaseReadiness()).toEqual({
        ready: true,
        schemaVersion: 17,
      });
      const migrated = reopened.getTicketForAccount(
        legacyTicket.id,
        parkAdmin.id,
      );
      expect(migrated?.applicationNumber).toBe('20260729001');
      expect(
        reopened.getDB().prepare(
          `SELECT date_key, last_sequence FROM park_application_sequences
           WHERE park_id = ?`,
        ).get(park.id),
      ).toEqual({ date_key: '20260729', last_sequence: 1 });
    } finally {
      reopened.closeEnterpriseDatabase();
    }
  });

  it('从真实 v3 列布局升级到 v5，保留账号员工关联和园区服务列且可重复初始化', async () => {
    const first = await freshDb();
    const organization = first.createOrganization({
      name: '迁移企业',
      slug: 'migration-v3',
    });
    const employeeId = 'emp_v3_preserved';
    first.createEmployee({
      id: employeeId,
      organizationId: organization.id,
      name: '历史员工',
      role: '成员',
      department: '研发部',
    });
    const account = first.createAccount({
      organizationId: organization.id,
      employeeId,
      username: 'v3-preserved',
      password: 'v3-preserved-password',
      name: '历史员工',
      role: '成员',
      department: '研发部',
      positionId: 'position_engineer',
      positionTitle: '工程师',
    });
    const unlinkedAccount = first.createAccount({
      organizationId: organization.id,
      username: 'v3-unlinked',
      password: 'v3-unlinked-password',
      name: '未关联员工',
      role: '成员',
      department: '产品部',
      positionId: 'position_product_manager',
      positionTitle: '产品经理',
    });
    const personalAccount = first.createPersonalRegisteredAccount({
      phone: '13800138000',
      name: '个人用户',
      password: 'personal-password',
    });
    first.closeEnterpriseDatabase();

    // 真实模拟上一版 v3：保留完整业务表与数据，只移除 v4 才新增的列。
    const legacy = new Database(path.join(tmpDir, 'data.db'));
    legacy.exec(`
      ALTER TABLE accounts DROP COLUMN department_id;
      ALTER TABLE accounts DROP COLUMN avatar_url;
      ALTER TABLE employees DROP COLUMN department_id;
      ALTER TABLE employees DROP COLUMN position_id;
      ALTER TABLE employees DROP COLUMN position_title;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    vi.resetModules();
    const reopened: DbModule = await import('./db.js');
    try {
      expect(reopened.getDatabaseReadiness()).toEqual({
        ready: true,
        schemaVersion: 17,
      });
      const organizationColumns = reopened
        .getDB()
        .prepare('PRAGMA table_info(organizations)')
        .all() as Array<{ name: string }>;
      const accountColumns = reopened
        .getDB()
        .prepare('PRAGMA table_info(accounts)')
        .all() as Array<{ name: string }>;
      expect(
        organizationColumns.filter(
          (column) => column.name === 'credit_balance',
        ),
      ).toHaveLength(1);
      expect(
        organizationColumns.filter((column) => column.name === 'park_id'),
      ).toHaveLength(1);
      expect(
        accountColumns.filter((column) => column.name === 'account_type'),
      ).toHaveLength(1);
      expect(
        accountColumns.filter((column) => column.name === 'deleted_at'),
      ).toHaveLength(1);
      expect(
        accountColumns.filter((column) => column.name === 'department_id'),
      ).toHaveLength(1);
      expect(
        accountColumns.filter((column) => column.name === 'avatar_url'),
      ).toHaveLength(1);
      const employeeColumns = reopened
        .getDB()
        .prepare('PRAGMA table_info(employees)')
        .all() as Array<{ name: string }>;
      expect(
        employeeColumns.filter((column) => column.name === 'department_id'),
      ).toHaveLength(1);
      expect(
        employeeColumns.filter((column) => column.name === 'position_id'),
      ).toHaveLength(1);
      expect(
        employeeColumns.filter((column) => column.name === 'position_title'),
      ).toHaveLength(1);
      const migratedLinkedAccount = reopened.getAccount(
        account.id,
        organization.id,
      );
      expect(migratedLinkedAccount).toMatchObject({
        id: account.id,
        employeeId,
        department: '研发部',
        departmentId: expect.stringMatching(/^dept_[a-f0-9]{20}$/),
        positionId: 'position_engineer',
        positionTitle: '工程师',
      });
      const migratedLinkedEmployee = reopened.getEmployee(
        employeeId,
        organization.id,
      );
      expect(migratedLinkedEmployee).toMatchObject({
        id: employeeId,
        organization_id: organization.id,
        name: '历史员工',
        department: '研发部',
        department_id: expect.stringMatching(/^dept_[a-f0-9]{20}$/),
        position_id: 'position_engineer',
        position_title: '工程师',
      });
      expect(migratedLinkedEmployee.department_id).toBe(
        migratedLinkedAccount!.departmentId,
      );
      const migratedUnlinkedAccount = reopened.getAccount(
        unlinkedAccount.id,
        organization.id,
      );
      expect(migratedUnlinkedAccount).toMatchObject({
        id: unlinkedAccount.id,
        accountType: 'enterprise',
        department: '产品部',
        positionId: 'position_product_manager',
        positionTitle: '产品经理',
        employeeId: expect.stringMatching(/^emp_/),
      });
      expect(
        reopened.getEmployee(
          migratedUnlinkedAccount!.employeeId!,
          organization.id,
        ),
      ).toMatchObject({
        organization_id: organization.id,
        name: '未关联员工',
        department: '产品部',
        position_id: 'position_product_manager',
        position_title: '产品经理',
      });
      expect(
        reopened.getAccount(personalAccount.id, personalAccount.organizationId),
      ).toMatchObject({
        id: personalAccount.id,
        accountType: 'personal',
        employeeId: null,
      });
      const ticketColumns = reopened
        .getDB()
        .prepare('PRAGMA table_info(it_tickets)')
        .all() as Array<{ name: string }>;
      expect(
        ticketColumns.filter((column) => column.name === 'service_id'),
      ).toHaveLength(1);
      expect(
        ticketColumns.filter((column) => column.name === 'form_data'),
      ).toHaveLength(1);
      expect(
        ticketColumns.filter((column) => column.name === 'park_id'),
      ).toHaveLength(1);
      expect(
        ticketColumns.filter((column) => column.name === 'application_number'),
      ).toHaveLength(1);

      const employeeIdsBeforeReopen = reopened
        .listEmployees(undefined, organization.id)
        .map((employee) => employee.id)
        .sort();
      reopened.closeEnterpriseDatabase();
      vi.resetModules();
      const reopenedAgain: DbModule = await import('./db.js');
      expect(
        reopenedAgain
          .listEmployees(undefined, organization.id)
          .map((employee) => employee.id)
          .sort(),
      ).toEqual(employeeIdsBeforeReopen);
      expect(
        reopenedAgain.getAccount(unlinkedAccount.id, organization.id)
          ?.employeeId,
      ).toBe(migratedUnlinkedAccount!.employeeId);
      reopenedAgain.closeEnterpriseDatabase();
    } finally {
      reopened.closeEnterpriseDatabase();
    }
  });

  it('拒绝打开高于当前版本的未来 schema，且不降级或改写原库', async () => {
    const future = new Database(path.join(tmpDir, 'data.db'));
    future.exec(`
      CREATE TABLE future_only (id TEXT PRIMARY KEY);
      INSERT INTO future_only (id) VALUES ('preserve-me');
      PRAGMA user_version = 18;
    `);
    future.close();

    const db = await freshDb();
    expect(() => db.getDB()).toThrow(/schema version 18.*current version 17/i);

    const reopened = new Database(path.join(tmpDir, 'data.db'));
    try {
      expect(
        (
          reopened.prepare('PRAGMA user_version').get() as {
            user_version: number;
          }
        ).user_version,
      ).toBe(18);
      expect(
        (reopened.prepare('SELECT id FROM future_only').get() as { id: string })
          .id,
      ).toBe('preserve-me');
    } finally {
      reopened.close();
    }
  });
});

describe('园区服务表单价格归一化', () => {
  it('停车和网络电话按受理单计算本次金额与月度持续费用', async () => {
    const db = await freshDb();
    const common = {
      company: '测试企业', roomNumber: '1203 室', contact: '张三', phone: '13800138000',
    };
    expect(db.normalizeParkServiceFormData('parking', {
      ...common, applicationType: 'underground-fixed', quantity: '2',
    })).toMatchObject({
      applicationType: '地下固定停车位', quantity: '2', pricing: '260元/月',
      amountCny: '520', recurringMonthlyCny: '520',
    });
    expect(db.normalizeParkServiceFormData('network-phone', {
      ...common, businessType: 'phone-open', quantity: '2', expectedDate: '2026-08-01',
    })).toMatchObject({
      quantity: '2', amountCny: '540', recurringMonthlyCny: '70', expectedDate: '2026-08-01',
    });
  });

  it('物业客服一次完成回复并转交工程部，工程完成说明回到原客服记录', async () => {
    const db = await freshDb();
    const parkOrganization = db.createOrganization({ name: '测试园区方', slug: 'simple-repair-park' });
    const parkAdmin = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'simple.repair.admin', password: 'simple-repair-admin-password',
      name: '园区管理员', isAdmin: true,
    });
    const specialist = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'simple.repair.service', password: 'simple-repair-service-password',
      name: '园区客服',
    });
    const engineer = db.createAccount({
      organizationId: parkOrganization.id,
      username: 'simple.repair.engineer', password: 'simple-repair-engineer-password',
      name: '工程人员',
      department: '工程部',
    });
    const tenant = db.createOrganization({ name: '测试入驻企业', slug: 'simple-repair-tenant' });
    const tenantAdmin = db.createAccount({
      organizationId: tenant.id,
      username: 'simple.repair.tenant.admin', password: 'simple-repair-tenant-password',
      name: '企业管理员', isAdmin: true,
    });
    const reporter = db.createAccount({
      organizationId: tenant.id,
      username: 'simple.repair.reporter', password: 'simple-repair-reporter-password',
      name: '报修员工',
    });
    const park = db.createPark({
      adminOrganizationId: parkOrganization.id, actorAccountId: parkAdmin.id, name: '测试产业园',
    });
    const invite = db.issueParkInvite({ parkId: park.id, actorAccountId: parkAdmin.id });
    db.joinOrganizationToPark({
      organizationId: tenant.id, actorAccountId: tenantAdmin.id, code: invite.code,
      address: 'A 座', roomNumber: '1203 室',
    });
    db.setParkServiceSpecialist({
      parkId: park.id, actorAccountId: parkAdmin.id, serviceId: 'repair', accountId: specialist.id,
    });
    const ticket = db.createTicket({
      createdByAccountId: reporter.id,
      serviceId: 'repair',
      title: '物业报修 · 灯具维修',
      description: '办公室灯具无法点亮',
      formData: {
        company: tenant.name, roomNumber: '1203 室', contact: reporter.name, phone: '13800138000',
        category: '灯具维修', issue: '办公室灯具无法点亮', urgency: '普通',
      },
    });
    const transferred = db.updateTicket({
      ticketId: ticket.id,
      accountId: specialist.id,
      action: 'respond_and_transfer',
      responseType: '客服已受理',
      responseText: '已核对报修信息，现转交工程部处理。',
      transferNote: '请检查办公室照明线路并填写完成说明。',
    });
    expect(transferred.status).toBe('已转交');
    expect(transferred.history.map((entry) => entry.action)).toEqual([
      'created', 'respond', 'transfer',
    ]);
    expect(
      db.getTicketForAccount(ticket.id, reporter.id),
    ).toMatchObject({
      creatorUpdateAt: expect.any(String),
      creatorUpdateReadAt: null,
    });
    db.closeEnterpriseDatabase();
    vi.resetModules();
    const reopened: DbModule = await import('./db.js');
    expect(
      reopened.getTicketForAccount(ticket.id, reporter.id),
    ).toMatchObject({
      creatorUpdateAt: expect.any(String),
      creatorUpdateReadAt: null,
    });
    expect(
      reopened.markTicketRead(ticket.id, reporter.id),
    ).toMatchObject({
      creatorUpdateAt: expect.any(String),
      creatorUpdateReadAt: expect.any(String),
    });
    const completed = reopened.updateTicket({
      ticketId: ticket.id,
      accountId: engineer.id,
      action: 'complete',
      responseType: '照明维修完成',
      responseText: '已更换故障空气开关并完成通电测试。',
    });
    expect(completed.status).toBe('已完成');
    expect(
      reopened.getTicketForAccount(ticket.id, specialist.id),
    ).toMatchObject({
      status: '已完成',
      responseType: '照明维修完成',
      responseText: '已更换故障空气开关并完成通电测试。',
    });
    reopened.closeEnterpriseDatabase();
  });
});

describe('账号数据恢复快照', () => {
  it('按账号隔离并加密存储个人记忆，使用版本号拒绝覆盖新数据', async () => {
    const db = await freshDb();
    const first = db.createAccount({
      username: 'sync-account-a',
      password: 'sync-password-a',
      name: '同步用户 A',
    });
    const second = db.createAccount({
      username: 'sync-account-b',
      password: 'sync-password-b',
      name: '同步用户 B',
    });
    const secret = 'private-memory-plaintext-must-not-be-in-sqlite';
    const memoryContent = '- ' + secret + String.fromCharCode(10);
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: '2026-07-26T10:00:00.000Z',
      files: [{
        path: 'memory/global.md',
        content: memoryContent,
        modifiedAtMs: Date.parse('2026-07-26T10:00:00.000Z'),
        sha256: createHash('sha256').update(memoryContent).digest('hex'),
      }],
    };

    const stored = db.putAccountSyncSnapshot({
      accountId: first.id,
      scope: 'personal_memory',
      expectedVersion: 0,
      payload,
      deviceId: 'device-a',
    });
    expect(stored).toMatchObject({
      scope: 'personal_memory',
      version: 1,
      payload,
      deviceId: 'device-a',
    });
    const raw = db.getDB()
      .prepare('SELECT payload_ciphertext FROM account_sync_snapshots WHERE account_id = ?')
      .get(first.id) as { payload_ciphertext: string };
    expect(raw.payload_ciphertext).not.toContain(secret);
    expect(db.listAccountSyncSnapshots(first.id)).toEqual([
      expect.objectContaining({ version: 1, payload }),
    ]);
    expect(db.listAccountSyncSnapshots(second.id)).toEqual([]);

    try {
      db.putAccountSyncSnapshot({
        accountId: first.id,
        scope: 'personal_memory',
        expectedVersion: 0,
        payload,
      });
      throw new Error('expected account sync conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(db.AccountSyncConflictError);
      expect((error as InstanceType<typeof db.AccountSyncConflictError>).currentVersion).toBe(1);
    }

    db.closeEnterpriseDatabase();
    vi.resetModules();
    const reopened: DbModule = await import('./db.js');
    expect(reopened.listAccountSyncSnapshots(first.id)).toEqual([
      expect.objectContaining({ version: 1, payload }),
    ]);
    reopened.closeEnterpriseDatabase();
  });

  it('rejects damaged encrypted snapshots without exposing partial content', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'sync-damaged-account',
      password: 'sync-damaged-password',
      name: 'Damaged sync account',
    });
    const content = 'private account memory';
    db.putAccountSyncSnapshot({
      accountId: account.id,
      scope: 'personal_memory',
      expectedVersion: 0,
      payload: {
        schemaVersion: 1,
        generatedAt: '2026-07-26T10:00:00.000Z',
        files: [
          {
            path: 'memory/global.md',
            content,
            modifiedAtMs: Date.parse('2026-07-26T10:00:00.000Z'),
            sha256: createHash('sha256').update(content).digest('hex'),
          },
        ],
      },
    });
    db.getDB()
      .prepare(
        'UPDATE account_sync_snapshots SET payload_auth_tag = ? WHERE account_id = ?',
      )
      .run('AAAAAAAAAAAAAAAAAAAAAA==', account.id);

    expect(() => db.listAccountSyncSnapshots(account.id)).toThrow(
      'account sync snapshot integrity check failed',
    );
  });

  it('requires active tenant identity and never reuses another tenant snapshot', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'sync-tenant-account',
      password: 'sync-tenant-password',
      name: 'Tenant sync account',
    });
    const content = 'tenant-bound memory';
    const payload = {
      schemaVersion: 1 as const,
      generatedAt: '2026-07-26T10:00:00.000Z',
      files: [
        {
          path: 'memory/global.md',
          content,
          modifiedAtMs: Date.parse('2026-07-26T10:00:00.000Z'),
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    };
    db.putAccountSyncSnapshot({
      accountId: account.id,
      scope: 'personal_memory',
      expectedVersion: 0,
      payload,
    });

    db.getDB()
      .prepare('UPDATE accounts SET status = ? WHERE id = ?')
      .run('disabled', account.id);
    expect(() => db.listAccountSyncSnapshots(account.id)).toThrow(
      'account not found',
    );
    db.getDB()
      .prepare('UPDATE accounts SET status = ? WHERE id = ?')
      .run('active', account.id);

    db.getDB()
      .prepare('UPDATE organizations SET status = ? WHERE id = ?')
      .run('disabled', db.DEFAULT_ORGANIZATION_ID);
    expect(() => db.listAccountSyncSnapshots(account.id)).toThrow(
      'account not found',
    );
    db.getDB()
      .prepare('UPDATE organizations SET status = ? WHERE id = ?')
      .run('active', db.DEFAULT_ORGANIZATION_ID);

    const otherOrganization = db.createOrganization({
      name: 'Account sync other tenant',
    });
    db.getDB()
      .prepare('UPDATE accounts SET organization_id = ? WHERE id = ?')
      .run(otherOrganization.id, account.id);
    expect(db.listAccountSyncSnapshots(account.id)).toEqual([]);
    expect(() =>
      db.putAccountSyncSnapshot({
        accountId: account.id,
        scope: 'personal_memory',
        expectedVersion: 0,
        payload,
      }),
    ).toThrow('account sync snapshot organization mismatch');
  });
});
describe('企业组织结构与功能配置', () => {
  it('支持自定义部门、岗位映射与重命名，并同步既有成员', async () => {
    const db = await freshDb();
    const department = db.createOrganizationDepartment({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      name: '客户成功中心',
    });
    const position = db.createOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      departmentId: department.id,
      title: '客户成功专员',
      roleMapping: 'member',
    });
    const account = db.createAccount({
      username: 'custom-department-member',
      password: 'custom-department-password',
      name: '自定义部门成员',
      department: department.name,
      departmentId: department.id,
      positionId: position.id,
      positionTitle: position.title,
      role: '成员',
      isAdmin: false,
    });

    const renamed = db.updateOrganizationDepartment({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      departmentId: department.id,
      name: '客户体验中心',
    });
    expect(renamed.name).toBe('客户体验中心');
    expect(db.getAccount(account.id)).toMatchObject({
      department: '客户体验中心',
      departmentId: department.id,
      positionId: position.id,
      positionTitle: '客户成功专员',
    });
    expect(db.listOrganizationStructure(db.DEFAULT_ORGANIZATION_ID)).toEqual([
      expect.objectContaining({
        id: department.id,
        name: '客户体验中心',
        positions: [
          expect.objectContaining({ id: position.id, roleMapping: 'member' }),
        ],
      }),
    ]);
    expect(() =>
      db.deleteOrganizationDepartment({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        departmentId: department.id,
      }),
    ).toThrow(/仍有成员|仍有岗位/);
  });

  it('功能开关按企业持久化且不会影响其他租户', async () => {
    const db = await freshDb();
    const other = db.createOrganization({ name: '功能隔离企业' });
    expect(
      db.getOrganizationFeatures(db.DEFAULT_ORGANIZATION_ID).park_service,
    ).toBe(true);
    expect(
      db.updateOrganizationFeatures(db.DEFAULT_ORGANIZATION_ID, {
        park_service: false,
        direct_messages: false,
        feishu_auto_reply: false,
        enterprise_tree: false,
      }),
    ).toMatchObject({
      park_service: false,
      direct_messages: false,
      feishu_auto_reply: false,
      enterprise_tree: false,
    });
    expect(db.getOrganizationFeatures(other.id)).toMatchObject({
      park_service: true,
      direct_messages: true,
      feishu_auto_reply: true,
      enterprise_tree: true,
    });
  });

  it('飞书自动回复要求所有绑定账号、企业和有效功能均可用', async () => {
    const db = await freshDb();
    const other = db.createOrganization({ name: '飞书关联企业' });
    db.createAccount({
      username: 'feishu-default-member',
      password: 'feishu-default-password',
      name: '默认企业飞书成员',
      feishuOpenId: 'ou_shared_policy',
    });
    const otherAccount = db.createAccount({
      organizationId: other.id,
      username: 'feishu-other-member',
      password: 'feishu-other-password',
      name: '关联企业飞书成员',
      feishuOpenId: 'ou_shared_policy',
    });

    expect(db.isFeishuAutoReplyEnabledForOpenId('ou_shared_policy')).toBe(
      true,
    );
    db.updateOrganizationFeatures(other.id, { feishu_auto_reply: false });
    expect(db.isFeishuAutoReplyEnabledForOpenId('ou_shared_policy')).toBe(
      false,
    );
    db.updateOrganizationFeatures(other.id, { feishu_auto_reply: true });
    db.updateAccount(otherAccount.id, { status: 'disabled' }, other.id);
    expect(db.isFeishuAutoReplyEnabledForOpenId('ou_shared_policy')).toBe(
      false,
    );
    expect(db.isFeishuAutoReplyEnabledForOpenId('   ')).toBe(false);
    expect(db.isFeishuAutoReplyEnabledForOpenId('ou_legacy_allowlist')).toBe(
      true,
    );
  });

  it('功能开关与审计日志原子提交，审计失败时回滚全部配置', async () => {
    const db = await freshDb();
    const before = db.getOrganizationFeatures(db.DEFAULT_ORGANIZATION_ID);
    db.getDB().exec(`
      CREATE TRIGGER fail_feature_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.event = 'organization_features_update'
      BEGIN
        SELECT RAISE(ABORT, 'forced feature audit failure');
      END;
    `);

    expect(() =>
      db.updateOrganizationFeatures(db.DEFAULT_ORGANIZATION_ID, {
        knowledge: false,
        park_service: false,
      }),
    ).toThrow(/forced feature audit failure/);
    expect(db.getOrganizationFeatures(db.DEFAULT_ORGANIZATION_ID)).toEqual(
      before,
    );
    expect(
      db
        .getDB()
        .prepare(
          'SELECT COUNT(*) AS count FROM organization_features WHERE organization_id = ?',
        )
        .get(db.DEFAULT_ORGANIZATION_ID),
    ).toEqual({ count: 0 });
  });

  it('职位权限映射可双向升降权，单纯重命名不会改变映射', async () => {
    const db = await freshDb();
    db.createAccount({
      username: 'mapping-safety-admin',
      password: 'mapping-safety-password',
      name: '保底管理员',
      isAdmin: true,
    });
    const department = db.createOrganizationDepartment({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      name: '运营部',
    });
    const position = db.createOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      departmentId: department.id,
      title: '运营负责人',
      roleMapping: 'enterprise_admin',
    });
    const mapped = db.createAccount({
      username: 'mapped-position-member',
      password: 'mapped-position-password',
      name: '映射成员',
      department: department.name,
      departmentId: department.id,
      positionId: position.id,
      positionTitle: position.title,
      role: '成员',
      isAdmin: false,
    });
    expect(mapped).toMatchObject({ isAdmin: true, role: '企业管理员' });

    db.updateOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      positionId: position.id,
      title: '运营总监',
    });
    expect(db.getAccount(mapped.id)).toMatchObject({
      isAdmin: true,
      role: '企业管理员',
      positionTitle: '运营总监',
    });

    db.updateOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      positionId: position.id,
      roleMapping: 'department_admin',
    });
    expect(db.getAccount(mapped.id)).toMatchObject({
      isAdmin: false,
      role: '部门管理员',
    });
  });

  it('按真实部门和职位 ID 任命时强制双向权限映射并撤销旧会话', async () => {
    const db = await freshDb();
    const guard = db.createAccount({
      username: 'assignment-guard-admin',
      password: 'assignment-guard-password',
      name: '保底管理员',
      isAdmin: true,
      role: '企业管理员',
    });
    const target = db.createAccount({
      username: 'assignment-target',
      password: 'assignment-target-password',
      name: '待任命成员',
      isAdmin: false,
      role: '自由文本角色',
    });
    const department = db.createOrganizationDepartment({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      name: '产品部',
    });
    const adminPosition = db.createOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      departmentId: department.id,
      title: '产品总监',
      roleMapping: 'enterprise_admin',
    });
    const memberPosition = db.createOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      departmentId: department.id,
      title: '产品经理',
      roleMapping: 'member',
    });
    const oldSession = db.createAuthSession(target.id);

    expect(
      db.updateAccount(target.id, {
        department: department.name,
        departmentId: department.id,
        positionTitle: adminPosition.title,
        positionId: adminPosition.id,
        // 职位映射必须压过前端同时传入的冲突字段。
        role: '成员',
        isAdmin: false,
      }),
    ).toMatchObject({
      departmentId: department.id,
      positionId: adminPosition.id,
      role: '企业管理员',
      isAdmin: true,
    });
    expect(db.getAccountBySession(oldSession.token)).toBeNull();

    expect(
      db.updateAccount(target.id, {
        department: department.name,
        departmentId: department.id,
        positionTitle: memberPosition.title,
        positionId: memberPosition.id,
      }),
    ).toMatchObject({
      positionId: memberPosition.id,
      role: '成员',
      isAdmin: false,
    });

    expect(() =>
      db.updateAccount(guard.id, {
        department: department.name,
        departmentId: department.id,
        positionTitle: memberPosition.title,
        positionId: memberPosition.id,
      }),
    ).toThrow('企业至少需要保留一名可登录管理员');
    expect(db.getAccount(guard.id)).toMatchObject({
      isAdmin: true,
      role: '企业管理员',
    });
  });
});

describe('园区数据统计任务', () => {
  it('按企业隔离投递，支持分派、填报、审核、退回和催办', async () => {
    const db = await freshDb();
    const parkAdmin = db.createAccount({
      username: 'park-statistics-admin', password: 'park-statistics-password', name: '园区管理员', isAdmin: true,
    });
    const park = db.createPark({
      adminOrganizationId: db.DEFAULT_ORGANIZATION_ID,
      actorAccountId: parkAdmin.id,
      name: '统计测试园区',
    });
    const tenantOrg = db.createOrganization({ name: '入住企业甲', slug: 'statistics-tenant' });
    const ceo = db.createAccount({
      organizationId: tenantOrg.id,
      username: 'statistics-ceo', password: 'statistics-ceo-password', name: '企业负责人', isAdmin: true,
    });
    const employee = db.createAccount({
      organizationId: tenantOrg.id,
      username: 'statistics-employee', password: 'statistics-employee-password', name: '填报员工', isAdmin: false,
    });
    const invite = db.issueParkInvite({ parkId: park.id, actorAccountId: parkAdmin.id });
    db.joinOrganizationToPark({ organizationId: tenantOrg.id, actorAccountId: ceo.id, code: invite.code, address: 'A 座 101', roomNumber: '101' });

    const created = db.createParkDataStatisticsTask({
      createdByAccountId: parkAdmin.id,
      title: '年度经营数据',
      description: '请按模板填报',
      deadline: '2099-12-31',
      fields: ['营业收入', '员工人数'],
      organizationIds: [tenantOrg.id],
    });
    expect(created.recipientCount).toBe(1);
    expect(db.listParkDataStatisticsTasks(ceo.id)[0]?.assignments[0]).toMatchObject({
      organizationId: tenantOrg.id,
      ceoAccountId: ceo.id,
      status: 'pending',
    });
    expect(db.listParkDataStatisticsTasks(parkAdmin.id)[0]?.assignments).toHaveLength(1);

    db.delegateParkDataStatistics(created.task.id, ceo.id, employee.id);
    db.submitParkDataStatisticsDraft(created.task.id, employee.id, { 营业收入: '100 万', 员工人数: '20' });
    expect(db.listParkDataStatisticsTasks(ceo.id)[0]?.assignments[0]?.status).toBe('pending_review');
    db.reviewParkDataStatistics(created.task.id, ceo.id, false, '请补充统计口径');
    expect(db.listParkDataStatisticsTasks(employee.id)[0]?.assignments[0]?.status).toBe('returned');
    db.submitParkDataStatisticsDraft(created.task.id, employee.id, { 营业收入: '100 万', 员工人数: '20', 统计口径: '含税' });
    db.reviewParkDataStatistics(created.task.id, ceo.id, true);
    expect(db.listParkDataStatisticsTasks(parkAdmin.id)[0]?.assignments[0]?.status).toBe('submitted');
    db.remindParkDataStatistics(created.task.id, parkAdmin.id);
  });
});
describe('企业 Token 用量时间窗口', () => {
  it('按 UTC datetime 比较完整 30 天边界，并把 SQLite 时间返回为带 Z 的 ISO', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    try {
      const db = await freshDb();
      const account = db.createAccount({
        username: 'usage-window',
        password: 'usage-window-password',
        name: '用量边界用户',
      });
      db.recordTokenUsage({
        accountId: account.id,
        sessionId: 'inside',
        messageId: 'inside-window',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      db.recordTokenUsage({
        accountId: account.id,
        sessionId: 'outside',
        messageId: 'outside-window',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
      db.getDB()
        .prepare(
          'UPDATE account_token_usage SET created_at = ? WHERE message_id = ?',
        )
        .run('2026-06-16 13:00:00', 'inside-window');
      db.getDB()
        .prepare(
          'UPDATE account_token_usage SET created_at = ? WHERE message_id = ?',
        )
        .run('2026-06-16 11:59:59', 'outside-window');

      const summary = db.getOrganizationUsageSummary(
        db.DEFAULT_ORGANIZATION_ID,
        30,
      );
      expect(summary).toMatchObject({
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalTokens: 15,
        requestCount: 1,
      });
      expect(
        summary.byAccount.find((row) => row.accountId === account.id)
          ?.lastUsedAt,
      ).toBe('2026-06-16T13:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('每账号每日记录数有硬上限，重复消息仍保持幂等且不消耗额外配额', async () => {
    const db = await freshDb({ OTTO_ENTERPRISE_USAGE_DAILY_LIMIT: '2' });
    const account = db.createAccount({
      username: 'usage-quota',
      password: 'usage-quota-password',
      name: '用量配额用户',
    });
    const record = (messageId: string) =>
      db.recordTokenUsage({
        accountId: account.id,
        sessionId: 'quota-session',
        messageId,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      });

    expect(record('message-1')).toBe(true);
    expect(record('message-1')).toBe(false);
    expect(record('message-2')).toBe(true);
    expect(() => record('message-3')).toThrow(
      '账号今日 Token 用量记录已达上限',
    );
  });

  it('停用账号和停用企业都不能继续写入或读取计量数据', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'usage-disabled',
      password: 'usage-disabled-password',
      name: '停用计量用户',
    });
    const usage = {
      accountId: account.id,
      sessionId: 'disabled-session',
      messageId: 'disabled-message',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };

    expect(db.recordTokenUsage(usage)).toBe(true);
    db.updateAccount(account.id, { status: 'disabled' });
    expect(() =>
      db.recordTokenUsage({ ...usage, messageId: 'disabled-message-2' }),
    ).toThrow('Account is disabled');
    expect(
      db
        .getOrganizationUsageSummary(db.DEFAULT_ORGANIZATION_ID)
        .byAccount.find((row) => row.accountId === account.id),
    ).toMatchObject({ totalTokens: 2, requestCount: 1 });

    db.updateAccount(account.id, { status: 'active' });
    db.getDB()
      .prepare('UPDATE organizations SET status = ? WHERE id = ?')
      .run('disabled', db.DEFAULT_ORGANIZATION_ID);
    expect(() => db.recordTokenUsage(usage)).toThrow(
      'Organization is disabled',
    );
    expect(() =>
      db.getOrganizationUsageSummary(db.DEFAULT_ORGANIZATION_ID),
    ).toThrow('Organization is disabled');
  });

  it('拒绝超长标识、模型名和异常 Token 数字，避免静默截断或低估', async () => {
    const db = await freshDb();
    const account = db.createAccount({
      username: 'usage-validation',
      password: 'usage-validation-password',
      name: '计量校验用户',
    });
    const usage = {
      accountId: account.id,
      sessionId: 'validation-session',
      messageId: 'validation-message',
      model: 'gpt-test',
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };

    expect(() =>
      db.recordTokenUsage({ ...usage, messageId: 'm'.repeat(161) }),
    ).toThrow('messageId 不能超过 160 个字符');
    expect(() =>
      db.recordTokenUsage({ ...usage, model: 'm'.repeat(121) }),
    ).toThrow('model 不能超过 120 个字符');
    expect(() =>
      db.recordTokenUsage({ ...usage, inputTokens: Number.NaN }),
    ).toThrow('Token 用量必须是非负数字');
    expect(() =>
      db.recordTokenUsage({ ...usage, inputTokens: 1_000_000_001 }),
    ).toThrow('单项 Token 用量不能超过 1000000000');
  });
});

describe('企业成员直聊', () => {
  it('未读收件箱可重复查询且不会把消息提前标记已读', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'unread-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'unread-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const message = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '新的企业内部消息',
    });

    const first = db.listUnreadDirectMessageNotifications({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: bob.id,
    });
    const second = db.listUnreadDirectMessageNotifications({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: bob.id,
    });
    expect(first).toEqual([
      expect.objectContaining({
        id: message.id,
        source: 'enterprise',
        title: 'Alice 发来消息',
        senderAccountId: alice.id,
        preview: '新的企业内部消息',
      }),
    ]);
    expect(second).toEqual(first);
    expect(
      db.listUnreadDirectMessageNotifications({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        accountId: bob.id,
        limit: Number.NaN,
      }),
    ).toEqual(first);
    expect(
      db
        .getDB()
        .prepare('SELECT read_at FROM direct_messages WHERE id = ?')
        .get(message.id),
    ).toEqual({ read_at: null });
  });

  it('只在同一企业的双方之间持久化、按时间读取并标记已读', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'chat-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'chat-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const message = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '  项目进展怎么样？  ',
    });
    expect(message).toMatchObject({
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '项目进展怎么样？',
      readAt: null,
    });
    expect(
      db.listDirectMessages({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        accountId: bob.id,
        peerAccountId: alice.id,
      })[0],
    ).toMatchObject({ id: message.id, content: '项目进展怎么样？' });
    expect(
      db.listDirectMessages({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        accountId: alice.id,
        peerAccountId: bob.id,
      })[0].readAt,
    ).not.toBeNull();
  });

  it('持久化企业私聊附件，并且只允许会话双方读取原文件', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'attachment-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'attachment-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const charlie = db.createAccount({
      username: 'attachment-charlie',
      password: 'charlie-password-123',
      name: 'Charlie',
    });
    const file = Buffer.from('%PDF-1.7\nOtto enterprise attachment');

    const message = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '',
      attachments: [{
        fileName: '项目说明.pdf',
        mimeType: 'application/pdf',
        size: file.length,
        data: file.toString('base64'),
      }],
    });

    expect(message.content).toContain('项目说明.pdf');
    expect(message.attachments).toEqual([
      expect.objectContaining({
        fileName: '项目说明.pdf',
        mimeType: 'application/pdf',
        size: file.length,
      }),
    ]);
    const attachmentId = message.attachments[0]!.id;
    const stored = db.getDB().prepare(
      `SELECT content, storage_backend, storage_key
       FROM direct_message_attachments WHERE id = ?`,
    ).get(attachmentId) as {
      content: Uint8Array;
      storage_backend: string;
      storage_key: string;
    };
    expect(stored.storage_backend).toBe('encrypted-filesystem');
    expect(Buffer.from(stored.content)).toHaveLength(0);
    const encryptedFile = fs.readFileSync(
      path.join(tmpDir, 'attachments', ...stored.storage_key.split('/')),
    );
    expect(encryptedFile.includes(file)).toBe(false);
    expect(db.getDirectMessageAttachment({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: bob.id,
      attachmentId,
    })).toMatchObject({
      id: attachmentId,
      data: file.toString('base64'),
    });
    expect(() => db.getDirectMessageAttachment({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      accountId: charlie.id,
      attachmentId,
    })).toThrow('附件不存在或无权访问');
  });

  it('拒绝给自己、跨企业或停用成员发送消息', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'guard-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const otherOrg = db.createOrganization({ name: '另一企业' });
    const outsider = db.createAccount({
      organizationId: otherOrg.id,
      username: 'outsider',
      password: 'outsider-password-123',
      name: 'Outsider',
    });
    expect(() =>
      db.sendDirectMessage({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        senderAccountId: alice.id,
        recipientAccountId: alice.id,
        content: 'self',
      }),
    ).toThrow('不能给自己');
    expect(() =>
      db.sendDirectMessage({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        senderAccountId: alice.id,
        recipientAccountId: outsider.id,
        content: 'cross tenant',
      }),
    ).toThrow('不存在或已停用');
  });

  it('真实私聊数据库接受经过最终序列化裁剪的 A2A 请求和回复', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'atoa-boundary-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'atoa-boundary-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const requestContent = buildAtoaRequest(`${'问题😀\n'.repeat(1200)}`, {
      id: 'boundary-request',
      mode: 'consult',
      requestedSources: [
        'current_chat',
        'enterprise_knowledge',
        'work_logs',
        'schedules',
      ],
      initiatorProposal: `${'候选方案😀\n'.repeat(1200)}`,
    });

    expect(requestContent.length).toBeLessThanOrEqual(
      ATOA_DIRECT_MESSAGE_MAX_LENGTH,
    );
    expect(
      new TextEncoder().encode(requestContent).byteLength,
    ).toBeLessThanOrEqual(ATOA_DIRECT_MESSAGE_MAX_LENGTH);
    const request = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: requestContent,
    });

    const responseContent = buildAtoaResponse({
      requestId: request.id,
      question: `${'问题😀\n'.repeat(1200)}`,
      answer: `${'协商结论😀\n'.repeat(1200)}`,
      mode: 'consult',
      grantedSources: [
        'current_chat',
        'enterprise_knowledge',
        'work_logs',
        'schedules',
      ],
    });
    expect(responseContent.length).toBeLessThanOrEqual(
      ATOA_DIRECT_MESSAGE_MAX_LENGTH,
    );
    expect(
      new TextEncoder().encode(responseContent).byteLength,
    ).toBeLessThanOrEqual(ATOA_DIRECT_MESSAGE_MAX_LENGTH);
    expect(() =>
      db.sendDirectMessage({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        senderAccountId: bob.id,
        recipientAccountId: alice.id,
        content: responseContent,
      }),
    ).not.toThrow();
  });

  it('A2A 收件箱只返回尚未由当前 Otto 回复的请求', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'atoa-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'atoa-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const request = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: buildAtoaRequest('方便开会吗？', { id: 'client-1' }),
    });

    expect(
      db.listPendingAtoaRequests({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        accountId: bob.id,
        requestPrefix: 'OTTO_ATOA_REQUEST ',
        responsePrefix: 'OTTO_ATOA_RESPONSE ',
      }),
    ).toEqual([
      expect.objectContaining({
        id: request.id,
        peerAccountId: alice.id,
      }),
    ]);

    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: alice.id,
      content: buildAtoaResponse({
        requestId: request.id,
        question: '方便开会吗？',
        answer: '可以先约 15:00。',
      }),
    });
    expect(
      db.listPendingAtoaRequests({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        accountId: bob.id,
        requestPrefix: 'OTTO_ATOA_REQUEST ',
        responsePrefix: 'OTTO_ATOA_RESPONSE ',
      }),
    ).toEqual([]);
  });

  it('A2A pending 只由反向同伴发出的合法精确 response 消除', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'atoa-strict-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'atoa-strict-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const charlie = db.createAccount({
      username: 'atoa-strict-charlie',
      password: 'charlie-password-123',
      name: 'Charlie',
    });
    const request = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: buildAtoaRequest('请给出评审建议', {
        id: 'strict-client-request',
      }),
    });
    const pending = () =>
      db.listPendingAtoaRequests({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        accountId: bob.id,
        requestPrefix: ATOA_REQUEST_PREFIX,
        responsePrefix: ATOA_RESPONSE_PREFIX,
      });

    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: alice.id,
      content: `${ATOA_RESPONSE_PREFIX}{bad-json-${request.id}`,
    });
    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: alice.id,
      content: `${ATOA_RESPONSE_PREFIX}${JSON.stringify({
        requestId: request.id,
      })}`,
    });
    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: alice.id,
      content: buildAtoaResponse({
        requestId: `prefix-${request.id}-suffix`,
        question: '请给出评审建议',
        answer: '这不是精确 requestId。',
      }),
    });
    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: charlie.id,
      content: buildAtoaResponse({
        requestId: request.id,
        question: '请给出评审建议',
        answer: '这是发给另一位成员的回复。',
      }),
    });

    expect(pending()).toEqual([
      expect.objectContaining({ id: request.id, peerAccountId: alice.id }),
    ]);

    db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: bob.id,
      recipientAccountId: alice.id,
      content: buildAtoaResponse({
        requestId: request.id,
        question: '请给出评审建议',
        answer: '这是合法精确回复。',
      }),
    });
    expect(pending()).toEqual([]);
  });

  it('A2A 成功响应只精确标记对应原请求已读，不误标其它请求或普通消息', async () => {
    const db = await freshDb();
    const alice = db.createAccount({
      username: 'atoa-read-alice',
      password: 'alice-password-123',
      name: 'Alice',
    });
    const bob = db.createAccount({
      username: 'atoa-read-bob',
      password: 'bob-password-123',
      name: 'Bob',
    });
    const charlie = db.createAccount({
      username: 'atoa-read-charlie',
      password: 'charlie-password-123',
      name: 'Charlie',
    });
    const answeredRequest = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: buildAtoaRequest('请评审第一份方案', { id: 'read-request-1' }),
    });
    const pendingRequest = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: buildAtoaRequest('请评审第二份方案', { id: 'read-request-2' }),
    });
    const ordinaryMessage = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: alice.id,
      recipientAccountId: bob.id,
      content: '这是一条普通未读消息',
    });
    const otherPeerRequest = db.sendDirectMessage({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      senderAccountId: charlie.id,
      recipientAccountId: bob.id,
      content: buildAtoaRequest('Charlie 的独立请求', { id: 'read-request-3' }),
    });
    const responseContent = buildAtoaResponse({
      requestId: answeredRequest.id,
      question: '请评审第一份方案',
      answer: '第一份方案已通过。',
    });

    expect(
      db.markAtoaRequestReadFromResponse({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        responderAccountId: bob.id,
        peerAccountId: alice.id,
        responseContent,
        requestPrefix: ATOA_REQUEST_PREFIX,
        responsePrefix: ATOA_RESPONSE_PREFIX,
      }),
    ).toBe(answeredRequest.id);
    expect(
      db.markAtoaRequestReadFromResponse({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        responderAccountId: bob.id,
        peerAccountId: charlie.id,
        responseContent,
        requestPrefix: ATOA_REQUEST_PREFIX,
        responsePrefix: ATOA_RESPONSE_PREFIX,
      }),
    ).toBeNull();

    const rows = db
      .getDB()
      .prepare(
        'SELECT id, read_at FROM direct_messages WHERE id IN (?, ?, ?, ?)',
      )
      .all(
        answeredRequest.id,
        pendingRequest.id,
        ordinaryMessage.id,
        otherPeerRequest.id,
      ) as Array<{ id: string; read_at: string | null }>;
    const readAt = new Map(rows.map((row) => [row.id, row.read_at]));
    expect(readAt.get(answeredRequest.id)).not.toBeNull();
    expect(readAt.get(pendingRequest.id)).toBeNull();
    expect(readAt.get(ordinaryMessage.id)).toBeNull();
    expect(readAt.get(otherPeerRequest.id)).toBeNull();
  });
});

describe('企业邀请码原子更新', () => {
  it('只填写部门和职位名称时生成稳定组织节点 ID，并写入账号与员工档案', async () => {
    const db = await freshDb();
    const now = Date.now();
    const first = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      {
        defaultDepartment: '研发部',
        positionTitle: '开发工程师',
        defaultRole: '成员',
        maxUses: 2,
      },
    );
    expect(first).toMatchObject({
      defaultDepartment: '研发部',
      departmentId: expect.stringMatching(/^dept_[a-f0-9]{20}$/),
      positionTitle: '开发工程师',
      positionId: expect.stringMatching(/^pos_[a-f0-9]{20}$/),
    });

    const resolved = db.resolveOrganizationInviteWithDefaults(
      first.code,
      now + 1,
    );
    expect(resolved).toMatchObject({
      departmentId: first.departmentId,
      positionId: first.positionId,
    });
    db.updateOrganizationPosition({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      positionId: first.positionId!,
      roleMapping: 'enterprise_admin',
    });
    const account = db.createSelfRegisteredAccount({
      organizationId: db.DEFAULT_ORGANIZATION_ID,
      phone: '13800138001',
      name: '岗位员工',
      password: 'registered-password',
      department: resolved!.defaultDepartment,
      departmentId: resolved!.departmentId,
      role: resolved!.defaultRole,
      positionId: resolved!.positionId,
      positionTitle: resolved!.positionTitle,
      organizationInviteId: resolved!.inviteId,
    });
    expect(account).toMatchObject({
      department: '研发部',
      departmentId: first.departmentId,
      positionTitle: '开发工程师',
      positionId: first.positionId,
      employeeId: expect.stringMatching(/^emp_/),
      role: '企业管理员',
      isAdmin: true,
    });
    expect(
      db.getEmployee(account.employeeId!, db.DEFAULT_ORGANIZATION_ID),
    ).toMatchObject({
      department: '研发部',
      department_id: first.departmentId,
      position_title: '开发工程师',
      position_id: first.positionId,
      role: '企业管理员',
    });

    const second = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now + 2,
      null,
      {
        defaultDepartment: ' 研发部 ',
        positionTitle: ' 开发工程师 ',
      },
    );
    expect(second.departmentId).toBe(first.departmentId);
    expect(second.positionId).toBe(first.positionId);
  });

  it('管理员直接创建和调岗账号时同步稳定部门职位 ID 与员工档案', async () => {
    const db = await freshDb();
    const created = db.createAccount({
      username: 'assignment-member',
      password: 'assignment-password',
      name: '岗位成员',
      department: '产品部',
      positionTitle: '产品经理',
    });
    expect(created).toMatchObject({
      employeeId: expect.stringMatching(/^emp_/),
      departmentId: expect.stringMatching(/^dept_[a-f0-9]{20}$/),
      positionId: expect.stringMatching(/^pos_[a-f0-9]{20}$/),
    });
    expect(
      db.getEmployee(created.employeeId!, db.DEFAULT_ORGANIZATION_ID),
    ).toMatchObject({
      department: '产品部',
      department_id: created.departmentId,
      position_title: '产品经理',
      position_id: created.positionId,
    });

    const updated = db.updateAccount(
      created.id,
      {
        department: '研发部',
        positionTitle: '开发工程师',
      },
      db.DEFAULT_ORGANIZATION_ID,
    );
    expect(updated.departmentId).toMatch(/^dept_[a-f0-9]{20}$/);
    expect(updated.positionId).toMatch(/^pos_[a-f0-9]{20}$/);
    expect(updated.departmentId).not.toBe(created.departmentId);
    expect(updated.positionId).not.toBe(created.positionId);
    expect(
      db.getEmployee(created.employeeId!, db.DEFAULT_ORGANIZATION_ID),
    ).toMatchObject({
      department: '研发部',
      department_id: updated.departmentId,
      position_title: '开发工程师',
      position_id: updated.positionId,
    });
  });

  it('个人账号加入企业时以职位当前权限映射为账号与员工权限真值', async () => {
    const db = await freshDb();
    const organization = db.createOrganization({
      name: '职位权限企业',
      slug: 'join-role-mapping',
    });
    const department = db.createOrganizationDepartment({
      organizationId: organization.id,
      name: '管理部',
    });
    const position = db.createOrganizationPosition({
      organizationId: organization.id,
      departmentId: department.id,
      title: '企业负责人',
      roleMapping: 'enterprise_admin',
    });
    const invite = db.issueOrganizationInvite(
      organization.id,
      Date.now(),
      null,
      {
        departmentId: department.id,
        defaultDepartment: department.name,
        positionId: position.id,
        positionTitle: position.title,
        defaultRole: '成员',
        maxUses: 1,
      },
    );
    const personal = db.createPersonalRegisteredAccount({
      phone: '13700137000',
      name: '待升级负责人',
      password: 'personal-admin-password',
    });

    const joined = db.joinOrganizationWithInvite(personal.id, invite.code);

    expect(joined).toMatchObject({
      organizationId: organization.id,
      departmentId: department.id,
      department: '管理部',
      positionId: position.id,
      positionTitle: '企业负责人',
      role: '企业管理员',
      isAdmin: true,
    });
    expect(db.getEmployee(joined.employeeId!, organization.id)).toMatchObject({
      department_id: department.id,
      position_id: position.id,
      role: '企业管理员',
    });
  });

  it('个人账号加入企业时拒绝邀请码引用已删除职位并原子保留个人身份', async () => {
    const db = await freshDb();
    const organization = db.createOrganization({
      name: '删除职位企业',
      slug: 'join-deleted-position',
    });
    const department = db.createOrganizationDepartment({
      organizationId: organization.id,
      name: '产品部',
    });
    const position = db.createOrganizationPosition({
      organizationId: organization.id,
      departmentId: department.id,
      title: '产品经理',
    });
    const invite = db.issueOrganizationInvite(
      organization.id,
      Date.now(),
      null,
      {
        departmentId: department.id,
        defaultDepartment: department.name,
        positionId: position.id,
        positionTitle: position.title,
        maxUses: 1,
      },
    );
    db.deleteOrganizationPosition({
      organizationId: organization.id,
      positionId: position.id,
    });
    const personal = db.createPersonalRegisteredAccount({
      phone: '13600136000',
      name: '删除职位受邀人',
      password: 'deleted-position-password',
    });

    expect(() =>
      db.joinOrganizationWithInvite(personal.id, invite.code),
    ).toThrow('职位不存在');
    expect(db.getAccount(personal.id)).toMatchObject({
      accountType: 'personal',
    });
    expect(db.getOrganizationInvite(organization.id)?.usedCount).toBe(0);
    expect(db.listEmployees(undefined, organization.id)).toEqual([]);
  });

  it('个人账号加入企业时拒绝职位与邀请码部门不一致并原子回滚', async () => {
    const db = await freshDb();
    const organization = db.createOrganization({
      name: '跨部门职位企业',
      slug: 'join-cross-department',
    });
    const product = db.createOrganizationDepartment({
      organizationId: organization.id,
      name: '产品部',
    });
    const engineering = db.createOrganizationDepartment({
      organizationId: organization.id,
      name: '研发部',
    });
    const position = db.createOrganizationPosition({
      organizationId: organization.id,
      departmentId: product.id,
      title: '产品经理',
      roleMapping: 'department_admin',
    });
    const invite = db.issueOrganizationInvite(
      organization.id,
      Date.now(),
      null,
      {
        departmentId: product.id,
        defaultDepartment: product.name,
        positionId: position.id,
        positionTitle: position.title,
        maxUses: 1,
      },
    );
    db.getDB()
      .prepare(
        `UPDATE organization_invites
       SET department_id = ?, default_department = ? WHERE id = ?`,
      )
      .run(engineering.id, engineering.name, invite.id);
    const personal = db.createPersonalRegisteredAccount({
      phone: '13500135000',
      name: '跨部门受邀人',
      password: 'cross-department-password',
    });

    expect(() =>
      db.joinOrganizationWithInvite(personal.id, invite.code),
    ).toThrow('职位与部门不一致');
    expect(db.getAccount(personal.id)).toMatchObject({
      accountType: 'personal',
    });
    expect(db.getOrganizationInvite(organization.id)?.usedCount).toBe(0);
    expect(db.listEmployees(undefined, organization.id)).toEqual([]);
  });

  it('审计写入失败时回滚新邀请码，并保持旧邀请码继续有效', async () => {
    const db = await freshDb();
    const oldInvite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      1_000,
    );
    const beforeCount = (
      db
        .getDB()
        .prepare('SELECT COUNT(*) AS count FROM organization_invites')
        .get() as { count: number }
    ).count;
    db.getDB().exec(`
      CREATE TRIGGER fail_invite_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.event = 'organization_invite_issue'
      BEGIN
        SELECT RAISE(ABORT, 'forced audit failure');
      END;
    `);

    expect(() =>
      db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, 2_000),
    ).toThrow(/forced audit failure/);

    const afterCount = (
      db
        .getDB()
        .prepare('SELECT COUNT(*) AS count FROM organization_invites')
        .get() as { count: number }
    ).count;
    expect(afterCount).toBe(beforeCount);
    expect(
      db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, 2_000)?.id,
    ).toBe(oldInvite.id);
    expect(db.inspectOrganizationInvite(oldInvite.code, 2_000).status).toBe(
      'active',
    );
  });

  it('两个已签发短信挑战竞争单人邀请码时只允许一个账号落库', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    const firstChallenge = db.createSmsRegistrationChallenge(
      '13800138000',
      '123456',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    const secondChallenge = db.createSmsRegistrationChallenge(
      '13900139000',
      '654321',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    expect(firstChallenge.ok).toBe(true);
    expect(secondChallenge.ok).toBe(true);
    if (!firstChallenge.ok || !secondChallenge.ok) {
      throw new Error('registration challenges should be issued');
    }

    const firstVerified = db.verifySmsRegistrationChallenge(
      firstChallenge.challengeId,
      '123456',
      now + 1_000,
    );
    const secondVerified = db.verifySmsRegistrationChallenge(
      secondChallenge.challengeId,
      '654321',
      now + 1_000,
    );
    expect(firstVerified.ok).toBe(true);
    expect(secondVerified.ok).toBe(true);
    if (!firstVerified.ok || !secondVerified.ok) {
      throw new Error('registration challenges should verify');
    }

    const firstAccount = db.createSelfRegisteredAccount({
      organizationId: firstVerified.organizationId,
      phone: firstVerified.phone,
      name: '第一位员工',
      password: 'first-registered-password',
      organizationInviteId: firstVerified.organizationInviteId,
    });
    expect(firstAccount.phone).toBe('+8613800138000');

    expect(() =>
      db.createSelfRegisteredAccount({
        organizationId: secondVerified.organizationId,
        phone: secondVerified.phone,
        name: '第二位员工',
        password: 'second-registered-password',
        organizationInviteId: secondVerified.organizationInviteId,
      }),
    ).toThrow('企业邀请码可用名额已用完，请联系管理员重新生成');

    expect(db.findAccountByPhone(secondVerified.phone)).toBeNull();
    expect(
      db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, now + 1_000),
    ).toMatchObject({ id: invite.id, maxUses: 1, usedCount: 1 });
  });

  it('短信挑战签发后邀请码被撤销时拒绝创建账号且不核销名额', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    const challenge = db.createSmsRegistrationChallenge(
      '13600136000',
      '123456',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok)
      throw new Error('registration challenge should be issued');
    const verified = db.verifySmsRegistrationChallenge(
      challenge.challengeId,
      '123456',
      now + 200,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('registration challenge should verify');

    db.issueOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, now + 300);
    expect(db.inspectOrganizationInvite(invite.code, now + 300).status).toBe(
      'revoked',
    );

    expect(() =>
      db.createSelfRegisteredAccount({
        organizationId: verified.organizationId,
        phone: verified.phone,
        name: '撤销后注册员工',
        password: 'registered-password',
        organizationInviteId: verified.organizationInviteId,
      }),
    ).toThrow('企业邀请码可用名额已用完，请联系管理员重新生成');

    expect(db.findAccountByPhone(verified.phone)).toBeNull();
    expect(
      db
        .getDB()
        .prepare(
          'SELECT used_count AS usedCount FROM organization_invites WHERE id = ?',
        )
        .get(invite.id),
    ).toMatchObject({ usedCount: 0 });
  });

  it('短信挑战签发后邀请码过期时拒绝创建账号且不核销名额', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    const challenge = db.createSmsRegistrationChallenge(
      '13500135000',
      '654321',
      db.DEFAULT_ORGANIZATION_ID,
      { now: now + 100, organizationInviteId: invite.id },
    );
    expect(challenge.ok).toBe(true);
    if (!challenge.ok)
      throw new Error('registration challenge should be issued');
    const verified = db.verifySmsRegistrationChallenge(
      challenge.challengeId,
      '654321',
      now + 200,
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('registration challenge should verify');

    db.getDB()
      .prepare('UPDATE organization_invites SET expires_at_ms = ? WHERE id = ?')
      .run(Date.now() - 1, invite.id);
    expect(db.inspectOrganizationInvite(invite.code, Date.now()).status).toBe(
      'expired',
    );

    expect(() =>
      db.createSelfRegisteredAccount({
        organizationId: verified.organizationId,
        phone: verified.phone,
        name: '过期后注册员工',
        password: 'registered-password',
        organizationInviteId: verified.organizationInviteId,
      }),
    ).toThrow('企业邀请码可用名额已用完，请联系管理员重新生成');

    expect(db.findAccountByPhone(verified.phone)).toBeNull();
    expect(
      db
        .getDB()
        .prepare(
          'SELECT used_count AS usedCount FROM organization_invites WHERE id = ?',
        )
        .get(invite.id),
    ).toMatchObject({ usedCount: 0 });
  });

  it('账号创建失败时回滚账号和已占用的邀请码名额', async () => {
    const db = await freshDb();
    const now = Date.now();
    const invite = db.issueOrganizationInvite(
      db.DEFAULT_ORGANIZATION_ID,
      now,
      null,
      { maxUses: 1 },
    );
    db.getDB().exec(`
      CREATE TRIGGER fail_self_registered_account_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.event = 'account_create'
      BEGIN
        SELECT RAISE(ABORT, 'forced account audit failure');
      END;
    `);

    expect(() =>
      db.createSelfRegisteredAccount({
        organizationId: db.DEFAULT_ORGANIZATION_ID,
        phone: '13700137000',
        name: '失败员工',
        password: 'registered-password',
        organizationInviteId: invite.id,
      }),
    ).toThrow(/forced account audit failure/);

    expect(db.findAccountByPhone('13700137000')).toBeNull();
    expect(
      db.getOrganizationInvite(db.DEFAULT_ORGANIZATION_ID, now + 1_000),
    ).toMatchObject({ id: invite.id, maxUses: 1, usedCount: 0 });
  });
});

describe('report 边界：0 任务不崩/不 NaN/不除零', () => {
  it('空库返回全 0，且所有数值字段有限（无 NaN/Infinity）', async () => {
    const db = await freshDb();
    const r = db.getReport(30);
    expect(r.totalTasks).toBe(0);
    expect(r.totalMinutes).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(r.timeSavedHours).toBe(0);
    expect(r.laborSavedCNY).toBe(0);
    expect(r.netBenefitCNY).toBe(0);
    expect(r.tokenCostCNY).toBe(0);
    // 除零口径：totalCost=0 时 laborPerToken 必须是 0，不是 NaN/Infinity。
    expect(r.laborPerTokenCNY).toBe(0);
    expect(r.laborPerTokenCapped).toBe(false);
    for (const v of [
      r.totalMinutes,
      r.totalTokens,
      r.timeSavedHours,
      r.laborSavedCNY,
      r.netBenefitCNY,
      r.tokenCostCNY,
      r.laborPerTokenCNY,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // 图表兜底：空数据下 trend/bottlenecks 不崩。
    expect(r.trend).toEqual([]);
    expect(r.bottlenecks).toEqual({
      slowestTotal: null,
      mostFrequent: null,
      slowestAvg: null,
    });
    expect(r.byType).toEqual([]);
  });
});

describe('timeSaved 口径：ottoMinutes × (mult − 1)，不双算', () => {
  function seedOneEmployeeTasks(db: DbModule, mins: number[]): void {
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    for (const m of mins) {
      db.logTask({
        employee_id: 'e1',
        task_type: 'contract_review',
        duration_min: m,
      });
    }
  }

  it('默认 mult=2：省时 = ottoMin × (2−1) = ottoMin', async () => {
    const db = await freshDb(); // 默认 mult=2
    seedOneEmployeeTasks(db, [30, 30]); // ottoMin=60
    const r = db.getReport(30);
    expect(r.totalMinutes).toBe(60);
    // savedMin = 60 × (2-1) = 60min = 1.0h
    expect(r.timeSavedHours).toBe(1);
  });

  it('mult 可配：改 OTTO_ESTIMATE_MANUAL_MULT=3 生效，省时 = ottoMin × 2', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_MANUAL_MULT: '3' });
    seedOneEmployeeTasks(db, [30, 30]); // ottoMin=60
    const r = db.getReport(30);
    expect(r.assumptions.manualTimeMultiplier).toBe(3);
    // savedMin = 60 × (3-1) = 120min = 2.0h（若双算成 ottoMin×mult=180min=3h 就错了）
    expect(r.timeSavedHours).toBe(2);
  });

  it('mult=1 时省时为 0（人工与 Otto 同速，无净节省）', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_MANUAL_MULT: '1' });
    seedOneEmployeeTasks(db, [60]);
    const r = db.getReport(30);
    expect(r.timeSavedHours).toBe(0);
    expect(r.laborSavedCNY).toBe(0);
  });
});

describe('trend 累积正确', () => {
  it('按任务逐条累积 cumTasks 与 cumSavedHours（同日数据也成立）', async () => {
    const db = await freshDb(); // mult=2 → 每分钟省 1 分钟
    db.createEmployee({ id: 'e1', name: '张三', department: 'ops' });
    db.logTask({ employee_id: 'e1', task_type: 'a', duration_min: 30 });
    db.logTask({ employee_id: 'e1', task_type: 'b', duration_min: 90 });
    const r = db.getReport(30);
    expect(r.trend.length).toBe(2);
    expect(r.trend[0].cumTasks).toBe(1);
    expect(r.trend[1].cumTasks).toBe(2);
    // 累计省时（小时）：第1点 30×1/60=0.5h；第2点 (30+90)×1/60=2.0h
    expect(r.trend[0].cumSavedHours).toBeCloseTo(0.5, 5);
    expect(r.trend[1].cumSavedHours).toBeCloseTo(2.0, 5);
    // 单调不减
    expect(r.trend[1].cumSavedHours).toBeGreaterThanOrEqual(
      r.trend[0].cumSavedHours,
    );
  });
});

describe('bottlenecks 选取正确（最耗时/最频繁/单次最慢）', () => {
  it('三类分别挑对 task_type', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'ops' });
    // frequent: 3 次、总时长小、单次快
    for (let i = 0; i < 3; i++)
      db.logTask({ employee_id: 'e1', task_type: 'frequent', duration_min: 5 });
    // heavy: 2 次、总时长最大
    db.logTask({ employee_id: 'e1', task_type: 'heavy', duration_min: 40 });
    db.logTask({ employee_id: 'e1', task_type: 'heavy', duration_min: 40 }); // 总 80，单次均 40
    // slowSingle: 1 次、单次最慢
    db.logTask({
      employee_id: 'e1',
      task_type: 'slowSingle',
      duration_min: 100,
    });
    const r = db.getReport(30);
    const b = r.bottlenecks;
    expect(b.slowestTotal?.taskType).toBe('slowSingle'); // 100 > 80 > 15
    expect(b.slowestTotal?.minutes).toBe(100);
    expect(b.mostFrequent?.taskType).toBe('frequent');
    expect(b.mostFrequent?.count).toBe(3);
    expect(b.slowestAvg?.taskType).toBe('slowSingle'); // 单次 100 最慢
    expect(b.slowestAvg?.avgMinutes).toBe(100);
  });
});

describe('P1 修复：laborPerToken 在 cost=0 场景不再爆表', () => {
  it('修复前会爆表的 2 任务场景（1 任务 cost=0、1 任务真实 cost）现在被兜底+封顶', async () => {
    // 复现 task 描述的实测场景：多数 cost=0、少数有真实 cost。
    const db = await freshDb(); // mult=2, cnyPerHour=50, cap=50
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 任务1：显式上报 cost_cny=0（旧口径会存 0）、耗时 60min
    db.logTask({
      employee_id: 'e1',
      task_type: 't1',
      duration_min: 60,
      tokens_used: 3000,
      cost_cny: 0,
    });
    // 任务2：真实 cost 0.03、耗时 60min
    db.logTask({
      employee_id: 'e1',
      task_type: 't2',
      duration_min: 60,
      tokens_used: 3000,
      cost_cny: 0.03,
    });
    const r = db.getReport(30);
    // 兜底后：totalCost = 0.028(兜底) + 0.03 = 0.058，而非旧口径的 0.03。
    // laborSaved = (120×1/60)×50 = 100 元。旧：100/0.03≈3333；新裸算 100/0.058≈1724 → 仍超 50，封顶到 50。
    expect(r.laborPerTokenCapped).toBe(true);
    expect(r.laborPerTokenCNY).toBe(50);
    // 关键断言：绝不再出现 ¥1000+/token 的天文数字。
    expect(r.laborPerTokenCNY).toBeLessThanOrEqual(50);
    expect(Number.isFinite(r.laborPerTokenCNY)).toBe(true);
  });

  it('正常成本区间不封顶，返回真实可解释倍率', async () => {
    // cnyPerHour 调低让 laborSaved 变小，落在封顶线以内。
    const db = await freshDb({
      OTTO_ESTIMATE_CNY_PER_HOUR: '50',
      OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP: '50',
    });
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 耗时 12min、真实 cost 1 元 → laborSaved=(12×1/60)×50=10；10/1=10 ≤ 50，不封顶。
    db.logTask({
      employee_id: 'e1',
      task_type: 't',
      duration_min: 12,
      cost_cny: 1,
    });
    const r = db.getReport(30);
    expect(r.laborPerTokenCapped).toBe(false);
    expect(r.laborPerTokenCNY).toBe(10);
  });

  it('cap 可配：OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP 生效', async () => {
    const db = await freshDb({ OTTO_ESTIMATE_LABOR_PER_TOKEN_CAP: '20' });
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    // 造一个裸算远超 20 的场景：耗时 600min、cost 0.028 兜底 → laborSaved=(600×1/60)×50=500；500/0.028≈17857 → 封顶 20。
    db.logTask({
      employee_id: 'e1',
      task_type: 't',
      duration_min: 600,
      cost_cny: 0,
    });
    const r = db.getReport(30);
    expect(r.assumptions.laborPerTokenCap).toBe(20);
    expect(r.laborPerTokenCapped).toBe(true);
    expect(r.laborPerTokenCNY).toBe(20);
  });
});

describe('成本/token 归一化（normalizeCostCNY / normalizeTokens）', () => {
  it('非正/非法值回落默认，正值透传', async () => {
    const db = await freshDb();
    // cost
    expect(db.normalizeCostCNY(0)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(-5)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(undefined)).toBe(
      db.ESTIMATE.defaultCostPerTaskCNY,
    );
    expect(db.normalizeCostCNY(NaN)).toBe(db.ESTIMATE.defaultCostPerTaskCNY);
    expect(db.normalizeCostCNY(0.05)).toBe(0.05);
    // tokens
    expect(db.normalizeTokens(0)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(-1)).toBe(db.ESTIMATE.defaultTokensPerTask);
    expect(db.normalizeTokens(undefined)).toBe(
      db.ESTIMATE.defaultTokensPerTask,
    );
    expect(db.normalizeTokens(1234)).toBe(1234);
  });

  it('logTask 落库时 cost=0 被兜底为默认成本（totalCost 不再塌 0）', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.logTask({
      employee_id: 'e1',
      task_type: 't',
      duration_min: 10,
      cost_cny: 0,
      tokens_used: 0,
    });
    const r = db.getReport(30);
    // 单任务 cost 兜底 0.028、tokens 兜底 2000。tokenCostCNY 经 round 到 2 位 → 0.03（关键：非 0）。
    expect(r.tokenCostCNY).toBe(0.03);
    expect(r.totalTokens).toBe(2000);
  });
});

describe('report 期窗与部门过滤', () => {
  it('periodDays 之外的任务不计入', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.logTask({ employee_id: 'e1', task_type: 't', duration_min: 30 });
    // 把这条改成 40 天前，落在 30 天窗外。
    db.getDB()
      .prepare(
        "UPDATE task_logs SET created_at = datetime('now','-40 days') WHERE employee_id='e1'",
      )
      .run();
    const r = db.getReport(30);
    expect(r.totalTasks).toBe(0);
    // 放宽到 60 天窗则能看到。
    expect(db.getReport(60).totalTasks).toBe(1);
  });

  it('department 过滤只统计该部门任务', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'e1', name: '张三', department: 'legal' });
    db.createEmployee({ id: 'e2', name: '李四', department: 'ops' });
    db.logTask({ employee_id: 'e1', task_type: 'a', duration_min: 10 });
    db.logTask({ employee_id: 'e2', task_type: 'b', duration_min: 10 });
    expect(db.getReport(30, 'legal').totalTasks).toBe(1);
    expect(db.getReport(30).totalTasks).toBe(2);
  });
});

describe('企业工作日志持久化边界', () => {
  it('非默认企业必须显式绑定租户，且不能从其他企业读取历史', async () => {
    const db = await freshDb();
    const organization = db.createOrganization({
      name: '工作日志租户',
      slug: 'worklog-tenant',
    });
    db.createEmployee({
      id: 'tenant-worker',
      name: '租户员工',
      department: '研发部',
      organizationId: organization.id,
    });

    expect(() =>
      db.logTask({ employee_id: 'tenant-worker', task_type: '越界写入' }),
    ).toThrow('Employee not found');
    expect(
      db.getTaskHistory('tenant-worker', 20, db.DEFAULT_ORGANIZATION_ID),
    ).toEqual([]);

    db.logTask({
      organizationId: organization.id,
      employee_id: 'tenant-worker',
      task_type: '正确写入',
      duration_min: 5,
    });
    expect(db.getReport(30, undefined, organization.id).totalTasks).toBe(1);
    expect(db.getReport(30).totalTasks).toBe(0);

    db.getDB()
      .prepare('UPDATE organizations SET status = ? WHERE id = ?')
      .run('disabled', organization.id);
    expect(() =>
      db.logTask({
        organizationId: organization.id,
        employee_id: 'tenant-worker',
        task_type: '停用企业写入',
      }),
    ).toThrow('Organization is disabled');
    expect(() => db.getReport(30, undefined, organization.id)).toThrow(
      'Organization is disabled',
    );
  });

  it('离职员工不能新增日志，但历史仍进入企业和原部门报表', async () => {
    const db = await freshDb();
    db.createEmployee({
      id: 'offboarded-worker',
      name: '离职员工',
      department: '交付部',
    });
    db.logTask({
      employee_id: 'offboarded-worker',
      task_type: '交付任务',
      duration_min: 20,
    });
    expect(db.offboardEmployee('offboarded-worker')).toBe(true);

    expect(() =>
      db.logTask({
        employee_id: 'offboarded-worker',
        task_type: '离职后任务',
      }),
    ).toThrow('Employee not found');
    expect(db.getTaskHistory('offboarded-worker')).toHaveLength(1);
    expect(db.getReport(30).totalTasks).toBe(1);
    expect(db.getReport(30, '交付部')).toMatchObject({
      totalTasks: 1,
      activeEmployees: 0,
    });
  });

  it('审计写入失败会回滚任务日志，不留下无法解释的孤儿记录', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'atomic-worker', name: '原子员工' });
    db.getDB().exec(`
      CREATE TRIGGER fail_worklog_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.event = 'learn'
      BEGIN
        SELECT RAISE(ABORT, 'forced worklog audit failure');
      END;
    `);

    expect(() =>
      db.logTask({ employee_id: 'atomic-worker', task_type: '原子任务' }),
    ).toThrow(/forced worklog audit failure/);
    expect(
      db.getDB().prepare('SELECT COUNT(*) AS count FROM task_logs').get(),
    ).toMatchObject({ count: 0 });
  });

  it('严格校验文本和数值边界，并限制历史条数与报表周期', async () => {
    const db = await freshDb();
    db.createEmployee({ id: 'bounded-worker', name: '边界员工' });
    const task = {
      employee_id: 'bounded-worker',
      task_type: '边界任务',
      duration_min: 1,
    };

    expect(() => db.logTask({ ...task, task_type: 't'.repeat(161) })).toThrow(
      'task_type 不能超过 160 个字符',
    );
    expect(() => db.logTask({ ...task, context: 'c'.repeat(20_001) })).toThrow(
      'context 不能超过 20000 个字符',
    );
    expect(() => db.logTask({ ...task, result: 'r'.repeat(40_001) })).toThrow(
      'result 不能超过 40000 个字符',
    );
    expect(() => db.logTask({ ...task, duration_min: -1 })).toThrow(
      'duration_min 必须是非负数字',
    );
    expect(() => db.logTask({ ...task, tokens_used: 1_000_000_001 })).toThrow(
      'tokens_used 不能超过 1000000000',
    );
    expect(() => db.logTask({ ...task, cost_cny: 10_000_001 })).toThrow(
      'cost_cny 不能超过 10000000',
    );

    db.logTask(task);
    db.logTask({ ...task, task_type: '第二项' });
    expect(db.getTaskHistory('bounded-worker', 0)).toHaveLength(1);
    expect(db.getTaskHistory('bounded-worker', 1_000)).toHaveLength(2);
    expect(db.getReport(-30).period).toBe('1d');
    expect(db.getReport(1_000).period).toBe('365d');
  });

  it('使用 SQLite datetime 比较完整时间，正确处理 30 天同日边界', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    try {
      const db = await freshDb();
      db.createEmployee({ id: 'time-worker', name: '时间员工' });
      db.logTask({ employee_id: 'time-worker', task_type: '窗口内' });
      db.logTask({ employee_id: 'time-worker', task_type: '窗口外' });
      db.getDB()
        .prepare('UPDATE task_logs SET created_at = ? WHERE task_type = ?')
        .run('2026-06-16 13:00:00', '窗口内');
      db.getDB()
        .prepare('UPDATE task_logs SET created_at = ? WHERE task_type = ?')
        .run('2026-06-16 11:59:59', '窗口外');

      expect(db.getReport(30)).toMatchObject({
        totalTasks: 1,
        byType: [expect.objectContaining({ taskType: '窗口内' })],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('企业备份聚合', () => {
  it('保留离职员工、限制任务历史并严格隔离企业数据', async () => {
    const db = await freshDb();
    const otherOrganization = db.createOrganization({
      name: '备份隔离企业',
      slug: 'backup-isolation',
    });
    db.createEmployee({ id: 'backup-former', name: '历史员工' });
    db.createEmployee({
      id: 'backup-other',
      name: '其他企业员工',
      organizationId: otherOrganization.id,
    });
    expect(db.offboardEmployee('backup-former')).toBe(true);

    const database = db.getDB();
    const insertTask = database.prepare(
      `INSERT INTO task_logs
           (organization_id, employee_id, task_type, created_at)
         VALUES (?, ?, ?, ?)`,
    );
    database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 1_001; index += 1) {
        insertTask.run(
          db.DEFAULT_ORGANIZATION_ID,
          'backup-former',
          `task-${index}`,
          String(index).padStart(4, '0'),
        );
      }
      insertTask.run(
        otherOrganization.id,
        'backup-other',
        'other-tenant-task',
        '9999',
      );
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const snapshot = db.exportAll();
    expect(Object.keys(snapshot)).toEqual([
      'employees',
      'taskLogs',
      'knowledge',
      'inviteCodes',
      'auditLogs',
      'accounts',
      'accountTags',
      'tickets',
      'ticketDeliveries',
    ]);
    expect(snapshot.employees).toEqual([
      expect.objectContaining({ id: 'backup-former', status: 'offboarded' }),
    ]);
    expect(snapshot.taskLogs).toHaveLength(1_000);
    expect(snapshot.taskLogs[0]).toMatchObject({ task_type: 'task-1000' });
    expect(snapshot.taskLogs.at(-1)).toMatchObject({ task_type: 'task-1' });
    expect(snapshot.taskLogs).not.toContainEqual(
      expect.objectContaining({ task_type: 'other-tenant-task' }),
    );

    const otherSnapshot = db.exportAll(otherOrganization.id);
    expect(otherSnapshot.employees).toEqual([
      expect.objectContaining({ id: 'backup-other' }),
    ]);
    expect(otherSnapshot.taskLogs).toEqual([
      expect.objectContaining({ task_type: 'other-tenant-task' }),
    ]);
  });
});
