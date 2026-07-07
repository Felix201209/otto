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
import { homedir } from 'os';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import type {
  CompanyRecord,
  TeamRecord,
  UserProfileRecord,
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
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly projectRoot: string) {
    this.store = new OrgMemoryStore(projectRoot);
    this.configPath = path.join(homedir(), '.otto-user', 'enterprise.json');
  }

  /** 加载企业配置 */
  async loadConfig(): Promise<EnterpriseConfig | null> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8');
      this.enterpriseConfig = JSON.parse(raw);
      return this.enterpriseConfig;
    } catch {
      return null;
    }
  }

  /** 保存企业配置 */
  async saveConfig(config: EnterpriseConfig): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.enterpriseConfig = config;
  }

  /** 获取 tenant_access_token */
  async getTenantToken(): Promise<string> {
    const config = this.enterpriseConfig || await this.loadConfig();
    if (!config) throw new Error('企业未绑定，请先运行 enterprise setup');

    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
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
      const url = new URL('https://open.feishu.cn/open-apis/contact/v3/departments');
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
      const url = new URL('https://open.feishu.cn/open-apis/contact/v3/users');
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
