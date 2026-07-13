/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Otto Session Manager — 多会话处理引擎。
 *
 * 核心能力：
 *   1. 会话分区: 按主题/项目/渠道自动路由到独立 session
 *   2. 会话合并: 用户可手动合并多个相关 session
 *   3. 会话分割: 过长的会话自动按主题分割
 *   4. 会话切换: /session list|switch|merge|split 命令支持
 *   5. 上下文桥梁: 跨 session 引用和共享上下文
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

// ============================================================
// 类型定义
// ============================================================

/** 会话元数据 */
export interface SessionMeta {
  /** 唯一会话 ID */
  id: string;
  /** 会话标题（自动生成或用户指定） */
  title: string;
  /** 会话主题标签 */
  topics: string[];
  /** 渠道来源: cli | feishu | desktop | vscode */
  channel: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后活跃时间 */
  lastActiveAt: string;
  /** 消息总数 */
  messageCount: number;
  /** 会话状态 */
  status: SessionStatus;
  /** 关联项目路径（如果有） */
  projectRoot?: string;
  /** 父 session ID（由分割产生时指向原 session） */
  parentId?: string;
  /** 子 session ID 列表（由分割产生） */
  childIds?: string[];
  /** 合并来源 session ID 列表（由合并产生） */
  mergedFrom?: string[];
  /** 飞书 chatId（如果来自飞书） */
  feishuChatId?: string;
  /** 令牌估算总量 */
  estimatedTokens?: number;
  /** 自定义标签 */
  tags: string[];
  /** 临时标记: 是否可回收 */
  ephemeral?: boolean;
}

/** 会话状态 */
export type SessionStatus =
  | 'active'       // 当前活跃
  | 'idle'         // 休眠可恢复
  | 'archived'     // 已归档
  | 'frozen';      // 已冻结（保留上下文但不响应）

/** 会话分割策略 */
export type SplitStrategy = 'by_topic' | 'by_token_count' | 'by_time';

/** 会话合并策略 */
export type MergeStrategy = 'manual' | 'auto_same_topic' | 'auto_related_project';

/** 会话路由规则 */
export interface SessionRoutingRule {
  id: string;
  /** 匹配模式（glob/regex） */
  pattern: string;
  /** 目标 session ID */
  targetSessionId: string;
  /** 优先级（数值越高越优先） */
  priority: number;
  /** 规则说明 */
  description: string;
}

/** 上下文桥梁 — 跨 session 共享信息 */
export interface ContextBridge {
  fromSessionId: string;
  toSessionId: string;
  /** 共享的上下文载荷 */
  payload: string;
  /** 创建时间 */
  createdAt: string;
  /** 过期时间（null=永不过期） */
  expiresAt: string | null;
}

/** Session Manager 配置 */
export interface SessionManagerConfig {
  /** session 数据存储目录 */
  storageDir: string;
  /** 单个 session 最大消息数（超过则触发分割提醒） */
  maxMessagesPerSession: number;
  /** session 空闲 N 分钟后自动归档 */
  idleArchiveMinutes: number;
  /** 最多保留多少个活跃 session */
  maxActiveSessions: number;
  /** 是否启用自动路由 */
  autoRoutingEnabled: boolean;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG: SessionManagerConfig = {
  storageDir: path.join(homedir(), '.otto-user', 'sessions'),
  maxMessagesPerSession: 200,
  idleArchiveMinutes: 30,
  maxActiveSessions: 10,
  autoRoutingEnabled: true,
};

// ============================================================
// Session Manager 实现
// ============================================================

/**
 * Otto Session Manager — 多会话处理引擎。
 * 注意：与 services/sessionManager.ts 的 SessionManager 不同，
 * 后者负责会话持久化/选择，这个类负责会话的合并/分割/路由/桥梁。
 */
export class OttoSessionManager {
  private sessions = new Map<string, SessionMeta>();
  private routingRules: SessionRoutingRule[] = [];
  private bridges = new Map<string, ContextBridge[]>();
  private config: SessionManagerConfig;
  private initialized = false;

  constructor(config?: Partial<SessionManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── 初始化 ──────────────────────────────────────────────

  /**
   * 从磁盘加载已有 session 元数据。
   * 应在 Otto 启动时调用。
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      const metaPath = path.join(this.config.storageDir, 'sessions.json');
      const raw = await fs.readFile(metaPath, 'utf-8');
      const data = JSON.parse(raw) as SessionMeta[];
      for (const s of data) {
        this.sessions.set(s.id, s);
      }
      console.log(`[SessionManager] Loaded ${data.length} sessions from disk`);
    } catch {
      // 首次运行或文件不存在
      console.log('[SessionManager] No existing sessions, starting fresh');
    }
    // 加载路由规则
    try {
      const rulesPath = path.join(this.config.storageDir, 'routing-rules.json');
      const raw = await fs.readFile(rulesPath, 'utf-8');
      this.routingRules = JSON.parse(raw);
    } catch { /* 无规则 */ }

    // 清理过期会话
    this.archiveStaleSessions();
    this.initialized = true;
  }

  // ── 持久化 ──────────────────────────────────────────────

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      const metaPath = path.join(this.config.storageDir, 'sessions.json');
      await fs.writeFile(
        metaPath,
        JSON.stringify(Array.from(this.sessions.values()), null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error('[SessionManager] Persist failed:', err);
    }
  }

  private async persistRules(): Promise<void> {
    try {
      const rulesPath = path.join(this.config.storageDir, 'routing-rules.json');
      await fs.writeFile(
        rulesPath,
        JSON.stringify(this.routingRules, null, 2),
        'utf-8',
      );
    } catch { /* ignore */ }
  }

  // ── 核心 CRUD ─────────────────────────────────────────

  /**
   * 创建新会话。
   * 当 Otto 收到一个不属于任何现有 session 的请求时调用。
   */
  async createSession(opts: {
    title?: string;
    channel: string;
    projectRoot?: string;
    feishuChatId?: string;
    topics?: string[];
    tags?: string[];
    ephemeral?: boolean;
  }): Promise<SessionMeta> {
    const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      title: opts.title || `Session ${new Date().toLocaleString('zh-CN')}`,
      topics: opts.topics || [],
      channel: opts.channel,
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
      status: 'active',
      projectRoot: opts.projectRoot,
      feishuChatId: opts.feishuChatId,
      tags: opts.tags || [],
      ephemeral: opts.ephemeral,
    };
    this.sessions.set(id, meta);

    // 如果活跃 session 超过上限，自动归档最旧的
    await this.enforceMaxActive();
    await this.persist();

    console.log(`[SessionManager] Created session: ${id} (${meta.title})`);
    return meta;
  }

  /**
   * 获取 session 元数据。
   */
  getSession(sessionId: string): SessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 列出所有 session（按最后活跃时间降序）。
   */
  listSessions(filter?: {
    status?: SessionStatus;
    channel?: string;
    topic?: string;
  }): SessionMeta[] {
    let result = Array.from(this.sessions.values());
    if (filter?.status) {
      result = result.filter(s => s.status === filter.status);
    }
    if (filter?.channel) {
      result = result.filter(s => s.channel === filter.channel);
    }
    if (filter?.topic) {
      result = result.filter(s =>
        s.topics.some(t => t.includes(filter!.topic!)),
      );
    }
    return result.sort(
      (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
    );
  }

  /**
   * 更新会话活跃时间 + 消息计数。
   * 每次用户发消息时调用。
   */
  touchSession(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.lastActiveAt = new Date().toISOString();
    meta.messageCount += 1;
    meta.status = 'active';
  }

  /**
   * 更新 session 标题（由 LLM 或用户命令触发）。
   */
  async updateTitle(sessionId: string, title: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.title = title;
    await this.persist();
  }

  /**
   * 为 session 添加主题标签（由 topic 分类器调用）。
   */
  async addTopic(sessionId: string, topic: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    if (!meta.topics.includes(topic)) {
      meta.topics.push(topic);
    }
    await this.persist();
  }

  // ── 会话切换 ─────────────────────────────────────────

  /**
   * 切换到指定 session（将目标设为 active，原 session 设为 idle）。
   * 主流程调用后，后续消息路由到新 session。
   */
  async switchToSession(sessionId: string): Promise<SessionMeta | null> {
    const target = this.sessions.get(sessionId);
    if (!target) return null;

    // 将当前所有 active 设为 idle
    for (const [, meta] of this.sessions) {
      if (meta.status === 'active' && meta.id !== sessionId) {
        meta.status = 'idle';
      }
    }

    target.status = 'active';
    target.lastActiveAt = new Date().toISOString();
    await this.persist();
    return target;
  }

  // ── 会话分割 ─────────────────────────────────────────

  /**
   * 将 session 按策略分割为两个 session。
   *
   * 使用场景:
   *   - session 消息数超过 maxMessagesPerSession
   *   - 单 session 涵盖多个不相关主题
   *   - 用户显式请求 /session split
   */
  async splitSession(
    sessionId: string,
    strategy: SplitStrategy,
    /** 分割点描述（用于 by_topic / by_time） */
    splitPoint?: string,
  ): Promise<{ original: SessionMeta; fork: SessionMeta } | null> {
    const original = this.sessions.get(sessionId);
    if (!original) return null;

    const forkId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const fork: SessionMeta = {
      id: forkId,
      title: `${original.title} (fork)`,
      topics: [...original.topics],
      channel: original.channel,
      createdAt: now,
      lastActiveAt: now,
      messageCount: 0,
      status: 'idle',
      parentId: sessionId,
      projectRoot: original.projectRoot,
      feishuChatId: original.feishuChatId,
      tags: [...original.tags],
    };

    // 更新原始 session
    original.childIds = [...(original.childIds || []), forkId];
    original.status = 'idle';

    this.sessions.set(forkId, fork);
    await this.persist();

    // 创建分割记录文件
    const splitLog = {
      originalId: sessionId,
      forkId,
      strategy,
      splitPoint: splitPoint || 'manual',
      timestamp: now,
      originalMessageCount: original.messageCount,
    };
    const logPath = path.join(
      this.config.storageDir,
      `split_${forkId}.json`,
    );
    await fs.writeFile(logPath, JSON.stringify(splitLog, null, 2), 'utf-8');

    console.log(
      `[SessionManager] Split session ${sessionId} → ${forkId} (${strategy})`,
    );
    return { original, fork };
  }

  // ── 会话合并 ─────────────────────────────────────────

  /**
   * 将多个 session 合并为一个新的 session。
   *
   * 使用场景:
   *   - 用户手动选择要合并的 session (/session merge)
   *   - 自动检测同一主题的多段对话
   */
  async mergeSessions(
    sessionIds: string[],
    newTitle?: string,
  ): Promise<SessionMeta | null> {
    if (sessionIds.length < 2) return null;

    const sources: SessionMeta[] = [];
    for (const id of sessionIds) {
      const meta = this.sessions.get(id);
      if (meta) sources.push(meta);
    }
    if (sources.length < 2) return null;

    const mergedId = `sess_${Date.now()}_merged_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    // 合并 topics 和 tags
    const allTopics = [...new Set(sources.flatMap(s => s.topics))];
    const allTags = [...new Set(sources.flatMap(s => s.tags))];

    const merged: SessionMeta = {
      id: mergedId,
      title: newTitle || `Merged: ${sources.map(s => s.title).join(' + ')}`,
      topics: allTopics,
      channel: sources[0].channel, // 以第一个为准
      createdAt: now,
      lastActiveAt: now,
      messageCount: sources.reduce((sum, s) => sum + s.messageCount, 0),
      status: 'active',
      mergedFrom: sessionIds,
      tags: allTags,
    };

    // 标记源 session
    for (const s of sources) {
      s.status = 'archived';
    }

    this.sessions.set(mergedId, merged);
    await this.persist();

    // 创建合并记录
    const mergeLog = {
      mergedId,
      sourceIds: sessionIds,
      timestamp: now,
    };
    const logPath = path.join(
      this.config.storageDir,
      `merge_${mergedId}.json`,
    );
    await fs.writeFile(logPath, JSON.stringify(mergeLog, null, 2), 'utf-8');

    console.log(
      `[SessionManager] Merged ${sessionIds.length} sessions → ${mergedId}`,
    );
    return merged;
  }

  // ── 自动路由 ─────────────────────────────────────────

  /**
   * 根据输入内容自动路由到最合适的 session。
   * 如果无匹配则返回 undefined，由调用方创建新 session。
   */
  autoRoute(input: string, channel: string): SessionMeta | undefined {
    if (!this.config.autoRoutingEnabled) return undefined;

    // 1. 先匹配自定义路由规则
    const sortedRules = [...this.routingRules].sort(
      (a, b) => b.priority - a.priority,
    );
    for (const rule of sortedRules) {
      try {
        const regex = new RegExp(rule.pattern);
        if (regex.test(input)) {
          const target = this.sessions.get(rule.targetSessionId);
          if (target && target.status !== 'archived') {
            return target;
          }
        }
      } catch {
        // pattern 非正则,当作字符串匹配
        if (input.includes(rule.pattern) || rule.pattern.includes(input)) {
          const target = this.sessions.get(rule.targetSessionId);
          if (target && target.status !== 'archived') {
            return target;
          }
        }
      }
    }

    // 2. 尝试匹配最近活跃的同渠道 session
    const sameChannel = this.listSessions({ status: 'active', channel });
    if (sameChannel.length > 0) {
      return sameChannel[0]; // 最活跃的那个
    }

    return undefined;
  }

  /**
   * 添加路由规则。
   */
  async addRoutingRule(rule: Omit<SessionRoutingRule, 'id'>): Promise<void> {
    const id = `rule_${Date.now()}`;
    this.routingRules.push({ ...rule, id });
    await this.persistRules();
  }

  /**
   * 删除路由规则。
   */
  async removeRoutingRule(ruleId: string): Promise<void> {
    this.routingRules = this.routingRules.filter(r => r.id !== ruleId);
    await this.persistRules();
  }

  // ── 上下文桥梁 ───────────────────────────────────────

  /**
   * 在两个 session 之间建立上下文桥梁。
   * 使用场景: 用户在一个 session 中提到了另一个 session 的上下文。
   */
  async createBridge(
    fromSessionId: string,
    toSessionId: string,
    payload: string,
    expiresAfterMinutes?: number,
  ): Promise<void> {
    const bridge: ContextBridge = {
      fromSessionId,
      toSessionId,
      payload,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAfterMinutes
        ? new Date(Date.now() + expiresAfterMinutes * 60_000).toISOString()
        : null,
    };

    const key = [fromSessionId, toSessionId].sort().join('::');
    const existing = this.bridges.get(key) || [];
    existing.push(bridge);
    this.bridges.set(key, existing);
  }

  /**
   * 获取两个 session 之间的所有有效桥梁。
   */
  getBridges(sessionA: string, sessionB: string): ContextBridge[] {
    const key = [sessionA, sessionB].sort().join('::');
    const bridges = this.bridges.get(key) || [];
    const now = new Date();
    return bridges.filter(b => {
      if (!b.expiresAt) return true;
      return new Date(b.expiresAt) > now;
    });
  }

  // ── 归档与管理 ───────────────────────────────────────

  /**
   * 归档空闲 session。
   */
  async archiveSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.status = 'archived';
    await this.persist();
    console.log(`[SessionManager] Archived session: ${sessionId}`);
  }

  /**
   * 恢复归档 session。
   */
  async unarchiveSession(sessionId: string): Promise<void> {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.status = 'idle';
    await this.persist();
  }

  /**
   * 清理过期 session 数据。
   */
  async cleanExpiredSessions(olderThanDays: number = 30): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const [id, meta] of this.sessions) {
      if (new Date(meta.lastActiveAt).getTime() < cutoff && meta.status !== 'active') {
        this.sessions.delete(id);
        count++;
      }
    }
    if (count > 0) await this.persist();
    return count;
  }

  // ── 内部工具 ─────────────────────────────────────────

  /**
   * 自动归档空闲 session。
   */
  private archiveStaleSessions(): void {
    const cutoff = Date.now() - this.config.idleArchiveMinutes * 60 * 1000;
    for (const [, meta] of this.sessions) {
      if (
        meta.status === 'idle' &&
        new Date(meta.lastActiveAt).getTime() < cutoff
      ) {
        meta.status = 'archived';
      }
    }
  }

  /**
   * 确保活跃 session 不超过上限。
   */
  private async enforceMaxActive(): Promise<void> {
    const active = Array.from(this.sessions.values()).filter(
      s => s.status === 'active',
    );
    if (active.length > this.config.maxActiveSessions) {
      // 归档最久未活跃的
      const sorted = active.sort(
        (a, b) => new Date(a.lastActiveAt).getTime() - new Date(b.lastActiveAt).getTime(),
      );
      const toArchive = sorted.slice(0, active.length - this.config.maxActiveSessions);
      for (const s of toArchive) {
        s.status = 'archived';
      }
      await this.persist();
    }
  }

  /**
   * 获取 session 总览统计。
   */
  getStats(): {
    total: number;
    active: number;
    idle: number;
    archived: number;
    frozen: number;
  } {
    const all = Array.from(this.sessions.values());
    return {
      total: all.length,
      active: all.filter(s => s.status === 'active').length,
      idle: all.filter(s => s.status === 'idle').length,
      archived: all.filter(s => s.status === 'archived').length,
      frozen: all.filter(s => s.status === 'frozen').length,
    };
  }

  /**
   * 删除 session 及相关数据。
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const existed = this.sessions.delete(sessionId);
    if (existed) await this.persist();
    return existed;
  }

  /**
   * 获取主题分类建议。
   * 根据输入文本推断主题，供调用方决定路由。
   */
  inferTopics(input: string): string[] {
    const topics: string[] = [];
    const hints: Array<[RegExp, string]> = [
      [/代码|编程|函数|bug|debug|error/i, 'coding'],
      [/项目|架构|设计|重构/i, 'architecture'],
      [/飞书|日历|文档|会议/i, 'feishu'],
      [/部署|上线|发布|ci|cd/i, 'devops'],
      [/需求|PRD|产品|功能/i, 'product'],
      [/数据|分析|报表|统计/i, 'analytics'],
      [/学习|教程|文档|知识/i, 'learning'],
    ];
    for (const [pattern, topic] of hints) {
      if (pattern.test(input) && !topics.includes(topic)) {
        topics.push(topic);
      }
    }
    return topics.length > 0 ? topics : ['general'];
  }

  /**
   * 获取 session 文件路径（存储对话消息的文件）。
   */
  getSessionFilePath(sessionId: string): string {
    return path.join(this.config.storageDir, `${sessionId}.jsonl`);
  }

  /**
   * 获取 session 数量 — 是否达到自动分割阈值。
   */
  shouldSplit(sessionId: string): boolean {
    const meta = this.sessions.get(sessionId);
    if (!meta) return false;
    return meta.messageCount >= this.config.maxMessagesPerSession;
  }
}

// ============================================================
// 全局单例
// ============================================================

let globalSessionManager: OttoSessionManager | null = null;

export function getSessionManager(
  config?: Partial<SessionManagerConfig>,
): OttoSessionManager {
  if (!globalSessionManager) {
    globalSessionManager = new OttoSessionManager(config);
  }
  return globalSessionManager;
}
