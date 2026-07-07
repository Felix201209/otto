/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * EnterpriseSync — 飞书组织架构同步。
 *
 * 从飞书拉取部门树 + 人员列表，写入 OrgMemoryStore。
 * 员工登录时自动匹配部门/岗位。
 *
 * 同步流程：
 * 1. 企业绑定（扫码 → 获取 appId/appSecret → tenant_access_token）
 * 2. 拉取部门树 → 写入 teams
 * 3. 拉取人员列表 → 写入 users
 * 4. 岗位标准化映射 → 结构化 role
 * 5. 定时增量同步
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { homedir } from 'os';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import type {
  CompanyRecord,
  TeamRecord,
  UserProfileRecord,
  LicenseRecord,
  Permission,
  LicenseRole,
  FeatureFlag,
} from '../memory/orgMemoryTypes.js';

/** 企业配置 */
export interface EnterpriseConfig {
  companyId: string;
  companyName: string;
  appId: string;
  appSecret: string;
  adminUserId: string;
  adminUserName: string;
  boundAt: string;
  /** 上次同步时间 */
  lastSyncAt?: string;
  /** 飞书 API 域名（国内 open.feishu.cn，国际 open.larksuite.com） */
  apiDomain?: string;
}

/** 飞书部门 */
interface FeishuDepartment {
  department_id: string;
  name: string;
  parent_department_id: string;
  leader_user_id?: string;
  member_count?: number;
}

/** 飞书用户 */
interface FeishuUser {
  user_id: string;
  open_id: string;
  name: string;
  email?: string;
  employee_no?: string;
  department_ids: string[];
  job_title?: string;
  is_active: boolean;
  city?: string;
}

/** 岗位标准化映射 */
const ROLE_NORMALIZE_MAP: Record<string, string> = {
  // 研发
  '前端': 'dev.frontend', '前端工程师': 'dev.frontend', 'frontend': 'dev.frontend', 'FE': 'dev.frontend',
  '后端': 'dev.backend', '后端工程师': 'dev.backend', 'backend': 'dev.backend', 'BE': 'dev.backend',
  '全栈': 'dev.fullstack', '全栈工程师': 'dev.fullstack', 'fullstack': 'dev.fullstack',
  '测试': 'dev.qa', '测试工程师': 'dev.qa', 'QA': 'dev.qa', '测试开发': 'dev.qa',
  '运维': 'dev.ops', '运维工程师': 'dev.ops', 'DevOps': 'dev.ops', 'SRE': 'dev.ops',
  '架构师': 'dev.architect', 'architect': 'dev.architect',
  '技术经理': 'dev.lead', '技术主管': 'dev.lead', 'Tech Lead': 'dev.lead',
  // 产品
  '产品经理': 'product.manager', 'PM': 'product.manager', '产品': 'product.manager',
  '交互设计': 'product.design', 'UI设计': 'product.design', '设计师': 'product.design',
  '用户研究': 'product.research', 'UX': 'product.research',
  // 市场
  '品牌': 'marketing.brand', '品牌经理': 'marketing.brand',
  '内容': 'marketing.content', '内容运营': 'marketing.content', '文案': 'marketing.content',
  '投放': 'marketing.ads', '广告': 'marketing.ads',
  '活动': 'marketing.events', '活动策划': 'marketing.events',
  // 销售
  '客户经理': 'sales.account', '销售': 'sales.account', '销售经理': 'sales.account',
  '商务': 'sales.bd', 'BD': 'sales.bd', '商务拓展': 'sales.bd',
  '渠道': 'sales.channel', '渠道经理': 'sales.channel',
  // 人事
  '招聘': 'hr.recruit', 'HR': 'hr.recruit', '人事': 'hr.recruit', '人力资源': 'hr.recruit',
  '薪酬': 'hr.compensation', '薪酬专员': 'hr.compensation',
  '员工关系': 'hr.relations',
  // 财务
  '会计': 'finance.accountant', '财务': 'finance.accountant',
  '出纳': 'finance.cashier',
  '财务分析': 'finance.analyst', '财务经理': 'finance.analyst',
  // 运营
  '用户运营': 'ops.user', '运营': 'ops.user',
  '数据运营': 'ops.data', '数据分析': 'ops.data',
  // 管理
  'CEO': 'exec.ceo', '总经理': 'exec.ceo',
  'CTO': 'exec.cto', '技术总监': 'exec.cto',
  'CFO': 'exec.cfo', '财务总监': 'exec.cfo',
  'COO': 'exec.coo', '运营总监': 'exec.coo',
  'VP': 'exec.vp', '副总裁': 'exec.vp',
  '总监': 'exec.director', '部门负责人': 'exec.director',
};

/** 岗位 → 部门映射 */
const ROLE_TO_DEPT: Record<string, string> = {
  'dev': '研发部',
  'product': '产品部',
  'marketing': '市场部',
  'sales': '销售部',
  'hr': '人事部',
  'finance': '财务部',
  'ops': '运营部',
  'exec': '管理层',
};

/**
 * 企业同步器。
 */
export class EnterpriseSync {
  private store: OrgMemoryStore;
  private enterpriseConfig: EnterpriseConfig | null = null;
  private configPath: string;
  private keyPath: string;
  private static readonly GCM_PREFIX = 'gcm:';
  private static readonly GCM_IV_BYTES = 12;
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  /** 获取飞书 API 域名（国内默认 open.feishu.cn，国际版 open.larksuite.com） */
  private getApiDomain(): string {
    return this.enterpriseConfig?.apiDomain || 'https://open.feishu.cn';
  }

  constructor(private readonly projectRoot: string) {
    this.store = new OrgMemoryStore(projectRoot);
    this.configPath = path.join(homedir(), '.otto-user', 'enterprise.json');
    this.keyPath = path.join(homedir(), '.otto-user', 'enterprise.key');
  }

  /** 加载企业配置 */
  /** 加载或创建加密密钥 */
  private async loadOrCreateKey(): Promise<Buffer> {
    await fs.mkdir(path.dirname(this.keyPath), { recursive: true });
    try {
      return await fs.readFile(this.keyPath);
    } catch {
      const key = crypto.randomBytes(32);
      await fs.writeFile(this.keyPath, key, { mode: 0o600 });
      return key;
    }
  }

  /** AES-256-GCM 加密 */
  private encryptSecret(plain: string, key: Buffer): string {
    const iv = crypto.randomBytes(EnterpriseSync.GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${EnterpriseSync.GCM_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /** AES-256-GCM 解密 */
  private decryptSecret(payload: string, key: Buffer): string {
    const body = payload.slice(EnterpriseSync.GCM_PREFIX.length);
    const [ivHex, tagHex, encHex] = body.split(':');
    if (!ivHex || !tagHex || !encHex) throw new Error('Malformed GCM payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
  }

  async loadConfig(): Promise<EnterpriseConfig | null> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // 解密 appSecret
      if (parsed.appSecret && parsed.appSecret.startsWith(EnterpriseSync.GCM_PREFIX)) {
        const key = await this.loadOrCreateKey();
        parsed.appSecret = this.decryptSecret(parsed.appSecret, key);
      }
      this.enterpriseConfig = parsed;
      return this.enterpriseConfig;
    } catch {
      return null;
    }
  }

  /** 保存企业配置（appSecret 加密存储） */
  async saveConfig(config: EnterpriseConfig): Promise<void> {
    const key = await this.loadOrCreateKey();
    const toSave = {
      ...config,
      appSecret: this.encryptSecret(config.appSecret, key),
    };
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    // 内存里保留明文版本（运行时用）
    this.enterpriseConfig = config;
  }

  /** 获取 tenant_access_token */
  async getTenantToken(): Promise<string> {
    const config = this.enterpriseConfig || await this.loadConfig();
    if (!config) throw new Error('企业未绑定，请先运行 enterprise setup');

    const res = await fetch(`${this.getApiDomain()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    if (!res.ok) throw new Error(`获取 token 失败: HTTP ${res.status}`);
    const data = await res.json() as { tenant_access_token?: string; code?: number; msg?: string };
    if (!data.tenant_access_token) {
      throw new Error(`获取 token 失败: ${data.msg || 'unknown error'}`);
    }
    return data.tenant_access_token;
  }

  /**
   * 全量同步组织架构。
   * 拉取所有部门 + 所有在职人员，写入 OrgMemoryStore。
   */
  async syncAll(): Promise<{ departments: number; users: number }> {
    const config = this.enterpriseConfig || await this.loadConfig();
    if (!config) throw new Error('企业未绑定');

    const token = await this.getTenantToken();

    // 1. 确保 company 记录存在
    const data = await this.store.load();
    if (!data.companies.find((c) => c.id === config.companyId)) {
      const company: CompanyRecord = {
        id: config.companyId,
        name: config.companyName,
        ownerUserId: config.adminUserId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.companies.push(company);
    }

    // 2. 拉取部门树
    const departments = await this.fetchAllDepartments(token);
    const teams: TeamRecord[] = departments.map((dept) => ({
      id: dept.department_id,
      companyId: config.companyId,
      name: dept.name,
      managerUserIds: dept.leader_user_id ? [dept.leader_user_id] : [],
      memberUserIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    // 3. 拉取在职人员
    const feishuUsers = await this.fetchAllUsers(token);

    // 4. 转换为 UserProfileRecord
    const users: UserProfileRecord[] = feishuUsers
      .filter((u) => u.is_active)
      .map((u) => {
        const normalizedRole = normalizeRole(u.job_title || '');
        const deptId = u.department_ids[0] || 'general';
        return {
          id: u.open_id,
          companyId: config.companyId,
          teamIds: u.department_ids,
          name: u.name,
          role: normalizedRole,
          selfMemory: '',
          workStyle: undefined,
          strengths: undefined,
          commonTasks: undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });

    // 5. 更新 teams 的 memberUserIds
    const teamMap = new Map(teams.map((t) => [t.id, t]));
    for (const user of users) {
      for (const teamId of user.teamIds) {
        const team = teamMap.get(teamId);
        if (team && !team.memberUserIds.includes(user.id)) {
          team.memberUserIds.push(user.id);
        }
      }
    }

    // 6. 写入 store（全量替换）
    data.teams = teams;
    data.users = users;

    // 6.5 自动生成权限许可（基于飞书组织架构角色推断）
    //    离职用户（不在本次同步的 users 列表中）的 License 标记为 revoked
    const activeUserIds = new Set(users.map((u) => u.id));
    const now = new Date().toISOString();
    const oldLicenses = data.licenses || [];

    // 保留旧 License 但撤销离职用户的
    const preservedLicenses = oldLicenses.map((lic) => {
      if (!activeUserIds.has(lic.assigneeUserId) && !lic.revokedAt) {
        return { ...lic, revokedAt: now };
      }
      return lic;
    });

    // 为在职用户生成新 License（如果已有则更新，不重复创建）
    const existingLicenseUserIds = new Set(preservedLicenses.map((l) => l.assigneeUserId));
    const newLicenses = users
      .filter((user) => !existingLicenseUserIds.has(user.id))
      .map((user) => {
        const isAdmin = user.id === config.adminUserId;
        const userRole = inferUserRole(user.id, isAdmin, teams, user.role);
        return createLicenseForUser(user.id, config.companyId, userRole, user.teamIds[0]);
      });

    // 更新已有在职用户的 License（角色可能变了）
    for (const user of users) {
      const isAdmin = user.id === config.adminUserId;
      const userRole = inferUserRole(user.id, isAdmin, teams, user.role);
      const newPermissions = PERMISSION_SETS[userRole];
      const newFeatures = FEATURE_SETS[userRole];
      const newLicenseRole = LICENSE_ROLE_MAP[userRole];

      const existingIdx = preservedLicenses.findIndex(
        (l) => l.assigneeUserId === user.id && !l.revokedAt,
      );
      if (existingIdx !== -1) {
        const lic = preservedLicenses[existingIdx];
        // 权限或角色变了才更新
        if (lic.role !== newLicenseRole ||
            lic.permissions.length !== newPermissions.length ||
            !lic.permissions.every((p, i) => p === newPermissions[i])) {
          preservedLicenses[existingIdx] = {
            ...lic,
            role: newLicenseRole,
            permissions: newPermissions,
            features: newFeatures,
            scope: userRole === 'company_admin' ? 'company' : 'team',
            teamId: user.teamIds[0],
          };
        }
      }
    }

    data.licenses = [...preservedLicenses, ...newLicenses];

    await this.store.save(data);

    // 7. 更新同步时间
    config.lastSyncAt = new Date().toISOString();
    await this.saveConfig(config);

    console.log(`[EnterpriseSync] 同步完成: ${departments.length} 个部门, ${users.length} 名员工`);
    return { departments: departments.length, users: users.length };
  }

  /**
   * 根据用户 open_id 获取其部门/岗位。
   * 用于员工登录时自动匹配。
   */
  async getUserDepartment(openId: string): Promise<{
    department: string;
    departmentId: string;
    role: string;
    normalizedRole: string;
    name: string;
  } | null> {
    const data = await this.store.load();
    const user = data.users.find((u) => u.id === openId);
    if (!user) return null;

    const team = data.teams.find((t) => t.id === user.teamIds[0]);
    return {
      department: team?.name || '未分配',
      departmentId: user.teamIds[0] || 'general',
      role: user.role,
      normalizedRole: user.role,
      name: user.name,
    };
  }

  /**
   * 获取用户的角色和权限信息。
   */
  async getUserRoleAndPermissions(openId: string): Promise<{
    role: UserRole;
    roleLabel: string;
    permissions: Permission[];
    features: FeatureFlag[];
    department: string;
    name: string;
  } | null> {
    const data = await this.store.load();
    const user = data.users.find((u) => u.id === openId);
    if (!user) return null;

    const config = this.enterpriseConfig || await this.loadConfig();
    const isAdmin = user.id === config?.adminUserId;
    const team = data.teams.find((t) => t.id === user.teamIds[0]);
    const userRole = inferUserRole(user.id, isAdmin, data.teams, user.role);

    // 从 license 记录读取权限
    const license = data.licenses.find((l) => l.assigneeUserId === openId && !l.revokedAt);
    const permissions = license?.permissions || PERMISSION_SETS[userRole];
    const features = license?.features || FEATURE_SETS[userRole];

    return {
      role: userRole,
      roleLabel: getRoleLabel(userRole),
      permissions,
      features,
      department: team?.name || '未分配',
      name: user.name,
    };
  }

  /**
   * 检查用户是否有某项权限。
   */
  async checkPermission(openId: string, permission: Permission): Promise<boolean> {
    const data = await this.store.load();
    const license = data.licenses.find(
      (l) => l.assigneeUserId === openId && !l.revokedAt,
    );
    return checkUserPermission(license || null, permission);
  }

  /**
   * 启动定时增量同步（每小时一次）。
   */
  startAutoSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncAll();
        console.log('[EnterpriseSync] 定时同步完成');
      } catch (err) {
        console.warn(`[EnterpriseSync] 定时同步失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 60 * 60 * 1000); // 1小时
    console.log('[EnterpriseSync] 自动同步已启动 (1h interval)');
  }

  /** 停止自动同步 */
  stopAutoSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log('[EnterpriseSync] 自动同步已停止');
    }
  }

  // ============================================================
  // 飞书 API 调用
  // ============================================================

  /** 拉取所有部门 */
  private async fetchAllDepartments(token: string): Promise<FeishuDepartment[]> {
    const departments: FeishuDepartment[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.getApiDomain()}/open-apis/contact/v3/departments`);
      url.searchParams.set('page_size', '50');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      url.searchParams.set('fetch_child', 'true');

      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`拉取部门失败: HTTP ${res.status}`);

      const data = await res.json() as {
        code?: number;
        msg?: string;
        data?: {
          items?: FeishuDepartment[];
          page_token?: string;
          has_more?: boolean;
        };
      };

      if (data.code !== 0 && data.code !== undefined) {
        throw new Error(`拉取部门失败: ${data.msg}`);
      }

      if (data.data?.items) {
        departments.push(...data.data.items);
      }
      pageToken = data.data?.has_more ? data.data.page_token : undefined;
    } while (pageToken);

    return departments;
  }

  /** 拉取所有在职用户 */
  private async fetchAllUsers(token: string): Promise<FeishuUser[]> {
    const users: FeishuUser[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${this.getApiDomain()}/open-apis/contact/v3/users`);
      url.searchParams.set('page_size', '50');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`拉取用户失败: HTTP ${res.status}`);

      const data = await res.json() as {
        code?: number;
        msg?: string;
        data?: {
          items?: FeishuUser[];
          page_token?: string;
          has_more?: boolean;
        };
      };

      if (data.code !== 0 && data.code !== undefined) {
        throw new Error(`拉取用户失败: ${data.msg}`);
      }

      if (data.data?.items) {
        users.push(...data.data.items);
      }
      pageToken = data.data?.has_more ? data.data.page_token : undefined;
    } while (pageToken);

    return users;
  }
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 岗位标准化：把飞书的自由文本岗位映射成结构化枚举。
 */
export function normalizeRole(jobTitle: string): string {
  if (!jobTitle) return 'general';

  // 精确匹配
  const trimmed = jobTitle.trim();
  if (ROLE_NORMALIZE_MAP[trimmed]) return ROLE_NORMALIZE_MAP[trimmed];

  // 模糊匹配（包含关键词）
  for (const [keyword, role] of Object.entries(ROLE_NORMALIZE_MAP)) {
    if (trimmed.includes(keyword)) return role;
  }

  // 无法匹配，返回原始文本
  return trimmed;
}

/**
 * 从标准化岗位推断部门名称。
 */
export function getDepartmentFromRole(normalizedRole: string): string {
  const prefix = normalizedRole.split('.')[0];
  return ROLE_TO_DEPT[prefix] || '通用';
}

// ============================================================
// 权限映射
// ============================================================

/** 用户角色类型（从飞书组织架构推断） */
export type UserRole = 'company_admin' | 'team_manager' | 'hr' | 'employee';

/** 权限集定义 */
const PERMISSION_SETS: Record<UserRole, Permission[]> = {
  // 企业管理员：全权限
  company_admin: [
    'memory:self:read', 'memory:self:write',
    'memory:project:read', 'memory:project:write',
    'memory:team:read', 'memory:team:write',
    'memory:company:read', 'memory:company:write',
    'skill:team:read', 'skill:team:write', 'skill:team:approve',
    'skill:company:read', 'skill:company:approve',
    'analytics:self:read', 'analytics:team:read', 'analytics:company:read',
    'license:assign', 'license:revoke',
  ],
  // 部门负责人：管理部门级
  team_manager: [
    'memory:self:read', 'memory:self:write',
    'memory:project:read', 'memory:project:write',
    'memory:team:read', 'memory:team:write',
    'skill:team:read', 'skill:team:write', 'skill:team:approve',
    'skill:company:read',
    'analytics:self:read', 'analytics:team:read',
  ],
  // 人事部：可调换人员部门 + 管理人员
  hr: [
    'memory:self:read', 'memory:self:write',
    'memory:team:read', 'memory:team:write',
    'memory:company:read',
    'skill:team:read', 'skill:team:write',
    'skill:company:read',
    'analytics:self:read', 'analytics:team:read', 'analytics:company:read',
    'license:assign', 'license:revoke',
  ],
  // 普通员工：个人级 + 部门只读
  employee: [
    'memory:self:read', 'memory:self:write',
    'memory:project:read', 'memory:project:write',
    'memory:team:read',
    'skill:team:read',
    'skill:company:read',
    'analytics:self:read',
  ],
};

/** 功能开关定义 */
const FEATURE_SETS: Record<UserRole, FeatureFlag[]> = {
  company_admin: ['desktop', 'feishu-bot', 'voice-input', 'browser', 'ide', 'ppt', 'docs', 'data-analysis', 'custom-skills', 'company-dashboard', 'team-dashboard'],
  team_manager: ['desktop', 'feishu-bot', 'voice-input', 'browser', 'ide', 'ppt', 'docs', 'data-analysis', 'custom-skills', 'team-dashboard'],
  hr: ['desktop', 'feishu-bot', 'voice-input', 'browser', 'ide', 'ppt', 'docs', 'data-analysis', 'custom-skills', 'company-dashboard'],
  employee: ['desktop', 'feishu-bot', 'voice-input', 'browser', 'ide', 'ppt', 'docs', 'data-analysis', 'custom-skills'],
};

/** LicenseRole 映射 */
const LICENSE_ROLE_MAP: Record<UserRole, LicenseRole> = {
  company_admin: 'owner',
  team_manager: 'manager',
  hr: 'manager',
  employee: 'employee',
};

/**
 * 推断用户角色：企业管理员 / 部门负责人 / 人事 / 普通员工。
 *
 * 判断逻辑：
 * 1. 飞书管理员 → company_admin
 * 2. 部门 leader_user_id 匹配 → team_manager
 * 3. 岗位属于 hr.* → hr
 * 4. 其他 → employee
 */
export function inferUserRole(
  userId: string,
  isAdmin: boolean,
  teams: TeamRecord[],
  normalizedRole: string,
): UserRole {
  // 1. 飞书管理员
  if (isAdmin) return 'company_admin';

  // 2. 部门负责人
  const isManager = teams.some(
    (t) => t.managerUserIds.includes(userId),
  );
  if (isManager) return 'team_manager';

  // 3. 人事部
  if (normalizedRole.startsWith('hr.')) return 'hr';

  // 4. 普通员工
  return 'employee';
}

/**
 * 为用户生成 LicenseRecord（权限许可）。
 * 根据 inferUserRole 的结果自动分配权限。
 */
export function createLicenseForUser(
  userId: string,
  companyId: string,
  role: UserRole,
  teamId?: string,
): LicenseRecord {
  const now = new Date().toISOString();
  return {
    id: `license_${userId}_${Date.now()}`,
    companyId,
    issuerUserId: 'system', // 自动分配
    assigneeUserId: userId,
    scope: role === 'company_admin' ? 'company' : 'team',
    teamId,
    role: LICENSE_ROLE_MAP[role],
    permissions: PERMISSION_SETS[role],
    tokenQuota: {
      monthlyLimit: role === 'company_admin' ? 10000000 : role === 'team_manager' || role === 'hr' ? 5000000 : 1000000,
      usedThisMonth: 0,
      hardLimit: role === 'employee',
    },
    allowedModels: [], // 空表示允许所有已配置的模型
    allowedSkillIds: [], // 空表示允许所有已安装的 Skill
    allowedKnowledgeScopes: role === 'company_admin'
      ? ['self', 'session', 'project', 'team', 'company', 'skill']
      : role === 'team_manager' || role === 'hr'
        ? ['self', 'session', 'project', 'team', 'skill']
        : ['self', 'session', 'project', 'skill'],
    features: FEATURE_SETS[role],
    startsAt: now,
  };
}

/**
 * 检查用户是否拥有某项权限。
 */
export function checkUserPermission(license: LicenseRecord | null, permission: Permission): boolean {
  if (!license) return false;
  if (license.revokedAt) return false;
  if (license.expiresAt && new Date(license.expiresAt) < new Date()) return false;
  return license.permissions.includes(permission);
}

/**
 * 获取用户角色描述（中文，用于 UI 展示）。
 */
export function getRoleLabel(role: UserRole): string {
  const labels: Record<UserRole, string> = {
    company_admin: '企业管理员',
    team_manager: '部门负责人',
    hr: '人事管理',
    employee: '普通员工',
  };
  return labels[role];
}

/**
 * 全局单例。
 */
let globalEnterpriseSync: EnterpriseSync | null = null;

export function getEnterpriseSync(projectRoot?: string): EnterpriseSync {
  if (!globalEnterpriseSync) {
    globalEnterpriseSync = new EnterpriseSync(projectRoot || process.cwd());
  }
  return globalEnterpriseSync;
}
