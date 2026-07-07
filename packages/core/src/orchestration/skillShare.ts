/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * SkillShare — 个人 Skill 分享到小组。
 *
 * 流程：
 * 1. 个人在 .otto/skills/ 下有自己创建/自动生成的 Skill
 * 2. 选择要分享的 Skill，指定目标小组
 * 3. Skill 被复制到 OrgMemoryStore 的 skills 列表，scope=team
 * 4. 小组成员各自的 Otto 能看到并安装这个共享 Skill
 *
 * 同时支持：
 * - 撤回已分享的 Skill
 * - 查看小组共享的 Skill 列表
 * - 安装小组共享 Skill 到个人目录
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { homedir } from 'os';
import type { Config } from '../config/config.js';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import type { SkillRecord } from '../memory/orgMemoryTypes.js';
import { getWorkLogger } from './workLog.js';
import { getProactiveService } from './proactiveService.js';

/** 分享状态 */
export type ShareStatus = 'active' | 'revoked' | 'deprecated';

/** 通知事件类型 */
export type SkillShareEvent =
  | 'skill_shared'      // 有人分享了新 Skill
  | 'skill_revoked'     // 有人撤回了 Skill
  | 'skill_updated';    // 分享者更新了 Skill

/** 通知消息 */
export interface SkillShareNotification {
  event: SkillShareEvent;
  shareId: string;
  skillName: string;
  sharerName: string;
  teamId: string;
  teamName: string;
  version?: number;
  changeNote?: string;
  message: string;
  timestamp: string;
}

/** 通知发送器接口 */
export interface NotificationSender {
  sendToTeamMembers(teamId: string, notification: SkillShareNotification): Promise<void>;
}

/** 个人 Skill 分享记录 */
export interface SkillShareRecord {
  id: string;
  /** 原始 Skill 名称（.otto/skills/ 下的目录名） */
  skillName: string;
  /** 原始 SKILL.md 路径 */
  sourcePath: string;
  /** SKILL.md 内容 */
  content: string;
  /** 内容哈希（用于版本追踪） */
  contentHash: string;
  /** 版本号，每次更新递增 */
  version: number;
  /** 版本历史 */
  versionHistory: Array<{
    version: number;
    hash: string;
    updatedAt: string;
    updatedBy: string;
    changeNote?: string;
  }>;
  /** 分享到哪个小组 */
  teamId: string;
  teamName: string;
  /** 分享者 */
  sharedBy: string;
  sharedByName: string;
  /** 分享时间 */
  sharedAt: string;
  /** 最后更新时间 */
  lastUpdatedAt: string;
  /** 状态 */
  status: ShareStatus;
  /** 撤回时间 */
  revokedAt?: string;
  /** 使用次数（小组成员安装数） */
  installCount: number;
  /** 评分 */
  rating: number;
  /** 评分数 */
  ratingCount: number;
  /** 分享时的备注 */
  note?: string;
  /** 自动提取的功能描述（中文，展示用） */
  featureDescription: string;
  /** 评分明细（仅存哈希用于去重，不记录可识别身份信息，确保匿名） */
  ratings: Array<{ userHash: string; score: number; ratedAt: string }>;
}

/** 已安装记录（追踪每个用户安装的版本） */
export interface InstallRecord {
  shareId: string;
  userId: string;
  installedVersion: number;
  installedAt: string;
  /** 个人目录下的 SKILL.md 路径 */
  localPath: string;
}

/** 分享请求参数 */
export interface ShareSkillParams {
  /** 个人 Skill 名称（目录名） */
  skillName: string;
  /** 目标小组 ID */
  teamId: string;
  /** 分享者用户 ID */
  userId: string;
  /** 分享者名称 */
  userName: string;
  /** 备注（可选） */
  note?: string;
}

/** 分享列表查询参数 */
export interface ListSharedSkillsParams {
  /** 按小组过滤 */
  teamId?: string;
  /** 按分享者过滤 */
  sharedBy?: string;
  /** 只看活跃的 */
  activeOnly?: boolean;
}

/**
 * Skill 分享管理器。
 */
export class SkillShareManager {
  private store: OrgMemoryStore;
  private notificationSender: NotificationSender | null = null;

  constructor(private readonly config: Config) {
    this.store = new OrgMemoryStore(config.getProjectRoot());
  }

  /** 设置通知发送器（由外部注入，如飞书消息通道） */
  setNotificationSender(sender: NotificationSender): void {
    this.notificationSender = sender;
  }

  /** 发送通知给小组成员 */
  private async notifyTeamMembers(
    teamId: string,
    teamName: string,
    notification: Omit<SkillShareNotification, 'teamId' | 'teamName' | 'timestamp'>,
  ): Promise<void> {
    const fullNotification: SkillShareNotification = {
      ...notification,
      teamId,
      teamName,
      timestamp: new Date().toISOString(),
    };

    // 1. 通过注入的通知发送器发送（如飞书消息）
    if (this.notificationSender) {
      try {
        await this.notificationSender.sendToTeamMembers(teamId, fullNotification);
      } catch (err) {
        console.warn(`[SkillShare] Notification sender failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. 通过主动服务记录事件（下次 checkAndTrigger 时触发提醒）
    try {
      const proactive = getProactiveService();
      proactive.recordAction('team', `[skill_share] ${fullNotification.message}`);
    } catch { /* 不影响主流程 */ }
  }

  /** 分享记录存储路径 */
  private get shareStorePath(): string {
    return path.join(this.config.getProjectRoot(), '.otto', 'org', 'skill-shares.json');
  }

  /** 个人 Skills 目录 */
  private get personalSkillsDir(): string {
    return path.join(this.config.getProjectRoot(), '.otto', 'skills');
  }

  /** 安装记录存储路径 */
  private get installRecordsPath(): string {
    return path.join(this.config.getProjectRoot(), '.otto', 'org', 'skill-installs.json');
  }

  /** 计算内容哈希 */
  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /** 加载安装记录 */
  private async loadInstallRecords(): Promise<InstallRecord[]> {
    try {
      const content = await fs.readFile(this.installRecordsPath, 'utf-8');
      return JSON.parse(content) as InstallRecord[];
    } catch {
      return [];
    }
  }

  /** 保存安装记录 */
  private async saveInstallRecords(records: InstallRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.installRecordsPath), { recursive: true });
    await fs.writeFile(this.installRecordsPath, JSON.stringify(records, null, 2) + '\n', 'utf-8');
  }

  /** 加载所有分享记录 */
  private async loadShares(): Promise<SkillShareRecord[]> {
    try {
      const content = await fs.readFile(this.shareStorePath, 'utf-8');
      return JSON.parse(content) as SkillShareRecord[];
    } catch {
      return [];
    }
  }

  /** 保存分享记录 */
  private async saveShares(shares: SkillShareRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.shareStorePath), { recursive: true });
    await fs.writeFile(this.shareStorePath, JSON.stringify(shares, null, 2) + '\n', 'utf-8');
  }

  /**
   * 分享个人 Skill 到小组。
   *
   * 1. 读取 .otto/skills/<skillName>/SKILL.md
   * 2. 创建分享记录
   * 3. 同步到 OrgMemoryStore 作为 team scope skill
   * 4. 记录工作日志
   */
  async shareToTeam(params: ShareSkillParams): Promise<SkillShareRecord> {
    // 1. 读取源 Skill
    const skillDir = path.join(this.personalSkillsDir, params.skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');

    let skillContent: string;
    try {
      skillContent = await fs.readFile(skillFile, 'utf-8');
    } catch {
      throw new Error(`Skill not found: ${params.skillName} (expected at ${skillFile})`);
    }

    // 2. 获取小组名称
    const data = await this.store.load();
    const team = data.teams.find((t) => t.id === params.teamId);
    if (!team) {
      throw new Error(`Team not found: ${params.teamId}`);
    }

    // 3. 检查是否已分享
    const existing = await this.loadShares();
    const alreadyShared = existing.find(
      (s) => s.skillName === params.skillName && s.teamId === params.teamId && s.status === 'active',
    );
    if (alreadyShared) {
      throw new Error(`Skill "${params.skillName}" is already shared to team "${team.name}"`);
    }

    // 4. 创建分享记录
    const now = new Date().toISOString();
    const contentHash = this.hashContent(skillContent);
    const shareRecord: SkillShareRecord = {
      id: `share_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      skillName: params.skillName,
      sourcePath: skillFile,
      content: skillContent,
      contentHash,
      version: 1,
      versionHistory: [{
        version: 1,
        hash: contentHash,
        updatedAt: now,
        updatedBy: params.userId,
      }],
      teamId: params.teamId,
      teamName: team.name,
      sharedBy: params.userId,
      sharedByName: params.userName,
      sharedAt: now,
      lastUpdatedAt: now,
      status: 'active',
      installCount: 0,
      rating: 0,
      ratingCount: 0,
      ratings: [],
      note: params.note,
      featureDescription: extractFeature(skillContent),
    };

    // 5. 同步到 OrgMemoryStore
    const skillRecord: SkillRecord = {
      id: `team_skill_${params.skillName}`,
      companyId: team.companyId,
      teamId: params.teamId,
      name: params.skillName,
      description: extractDescription(skillContent) || `Shared by ${params.userName}`,
      scope: 'team',
      status: 'team_approved',
      triggerPatterns: extractTriggerPatterns(skillContent),
      requiredInputs: ['context'],
      workflowSteps: extractWorkflowSteps(skillContent),
      outputSchema: 'Markdown',
      examples: [],
      sourceProjectIds: [],
      sourceTaskIds: [],
      usageCount: 0,
      successRate: 1,
      avgTokenCost: 0,
      avgRevisionCount: 0,
      avgTimeSavedMinutes: 0,
      createdBy: params.userId,
      approvedBy: params.userId,
      createdAt: now,
      updatedAt: now,
    };

    // 检查是否已存在同名 skill，更新而非重复添加
    const existingSkillIdx = data.skills.findIndex(
      (s) => s.id === skillRecord.id || (s.name === skillRecord.name && s.teamId === params.teamId),
    );
    if (existingSkillIdx !== -1) {
      data.skills[existingSkillIdx] = skillRecord;
    } else {
      data.skills.push(skillRecord);
    }
    await this.store.save(data);

    // 6. 保存分享记录
    existing.push(shareRecord);
    await this.saveShares(existing);

    // 7. 记录工作日志
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'skill_share',
        action: `分享 Skill "${params.skillName}" 到小组 "${team.name}"`,
        category: 'other',
        success: true,
        details: params.note,
      });
    } catch { /* 不影响主流程 */ }

    // 8. 通知小组成员
    await this.notifyTeamMembers(params.teamId, team.name, {
      event: 'skill_shared',
      shareId: shareRecord.id,
      skillName: params.skillName,
      sharerName: params.userName,
      message: `${params.userName} 向小组 "${team.name}" 分享了 Skill "${params.skillName}"${params.note ? '：' + params.note : ''}`,
    });

    return shareRecord;
  }

  /**
   * 撤回已分享的 Skill。
   */
  async revokeShare(shareId: string, userId: string): Promise<void> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) {
      throw new Error(`Share not found: ${shareId}`);
    }
    if (share.sharedBy !== userId) {
      throw new Error('Only the original sharer can revoke');
    }
    if (share.status !== 'active') {
      throw new Error(`Share is already ${share.status}`);
    }

    share.status = 'revoked';
    share.revokedAt = new Date().toISOString();
    await this.saveShares(shares);

    // 从 OrgMemoryStore 移除
    const data = await this.store.load();
    data.skills = data.skills.filter(
      (s) => !(s.name === share.skillName && s.teamId === share.teamId),
    );
    await this.store.save(data);

    // 通知小组成员
    await this.notifyTeamMembers(share.teamId, share.teamName, {
      event: 'skill_revoked',
      shareId: share.id,
      skillName: share.skillName,
      sharerName: share.sharedByName,
      message: `${share.sharedByName} 撤回了 Skill "${share.skillName}"，已从小组共享中移除。已安装的版本不受影响。`,
    });
  }
  async listSharedSkills(params: ListSharedSkillsParams = {}): Promise<SkillShareRecord[]> {
    let shares = await this.loadShares();

    if (params.teamId) {
      shares = shares.filter((s) => s.teamId === params.teamId);
    }
    if (params.sharedBy) {
      shares = shares.filter((s) => s.sharedBy === params.sharedBy);
    }
    if (params.activeOnly) {
      shares = shares.filter((s) => s.status === 'active');
    }

    return shares.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
  }

  /**
   * 安装小组共享的 Skill 到个人目录。
   *
   * 小组成员调用此方法，将团队共享的 Skill 复制到自己的 .otto/skills/ 下。
   * 记录安装的版本号，用于后续更新检查。
   */
  async installSharedSkill(shareId: string, userId: string): Promise<string> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId && s.status === 'active');
    if (!share) {
      throw new Error(`Active share not found: ${shareId}`);
    }

    // 写入个人 skills 目录
    const targetDir = path.join(this.personalSkillsDir, share.skillName);
    const targetFile = path.join(targetDir, 'SKILL.md');
    await fs.mkdir(targetDir, { recursive: true });

    // 在内容头部添加来源信息和版本
    const contentWithMeta = share.content.replace(
      /^---\n/,
      `---\n# Shared from team "${share.teamName}" by ${share.sharedByName}\n# Version: ${share.version} (hash: ${share.contentHash})\n# Installed at ${new Date().toISOString()}\n`,
    );
    await fs.writeFile(targetFile, contentWithMeta, 'utf-8');

    // 更新安装计数
    share.installCount++;
    await this.saveShares(shares);

    // 记录安装版本（用于更新检查）
    const installs = await this.loadInstallRecords();
    const existingInstall = installs.find(
      (r) => r.shareId === shareId && r.userId === userId,
    );
    if (existingInstall) {
      existingInstall.installedVersion = share.version;
      existingInstall.installedAt = new Date().toISOString();
      existingInstall.localPath = targetFile;
    } else {
      installs.push({
        shareId,
        userId,
        installedVersion: share.version,
        installedAt: new Date().toISOString(),
        localPath: targetFile,
      });
    }
    await this.saveInstallRecords(installs);

    // 记录工作日志
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'skill_install',
        action: `安装小组共享 Skill "${share.skillName}" v${share.version}（来自 ${share.sharedByName}）`,
        category: 'other',
        success: true,
      });
    } catch { /* 不影响主流程 */ }

    return targetFile;
  }

  /**
   * 分享者更新已分享的 Skill。
   *
   * 重新读取源 SKILL.md，计算新哈希。如果内容变化，版本号递增，
   * 记录到版本历史，同步更新 OrgMemoryStore。
   * 已安装的成员在下次 checkForUpdates 时会发现新版本。
   */
  async updateSharedSkill(shareId: string, userId: string, changeNote?: string): Promise<SkillShareRecord> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) {
      throw new Error(`Share not found: ${shareId}`);
    }
    if (share.sharedBy !== userId) {
      throw new Error('Only the original sharer can update');
    }
    if (share.status !== 'active') {
      throw new Error(`Cannot update ${share.status} share`);
    }

    // 重新读取源文件
    let newContent: string;
    try {
      newContent = await fs.readFile(share.sourcePath, 'utf-8');
    } catch {
      throw new Error(`Source skill file not found: ${share.sourcePath}`);
    }

    const newHash = this.hashContent(newContent);
    if (newHash === share.contentHash) {
      // 内容未变化
      return share;
    }

    // 内容有变化，递增版本
    const now = new Date().toISOString();
    const newVersion = share.version + 1;
    share.content = newContent;
    share.contentHash = newHash;
    share.version = newVersion;
    share.lastUpdatedAt = now;
    share.versionHistory.push({
      version: newVersion,
      hash: newHash,
      updatedAt: now,
      updatedBy: userId,
      changeNote,
    });

    await this.saveShares(shares);

    // 同步更新 OrgMemoryStore 中的 SkillRecord
    const data = await this.store.load();
    const skillIdx = data.skills.findIndex(
      (s) => s.name === share.skillName && s.teamId === share.teamId,
    );
    if (skillIdx !== -1) {
      data.skills[skillIdx].description = extractDescription(newContent) || data.skills[skillIdx].description;
      data.skills[skillIdx].triggerPatterns = extractTriggerPatterns(newContent);
      data.skills[skillIdx].workflowSteps = extractWorkflowSteps(newContent);
      data.skills[skillIdx].updatedAt = now;
      await this.store.save(data);
    }

    // 记录工作日志
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'skill_update',
        action: `更新共享 Skill "${share.skillName}" 到 v${newVersion}`,
        category: 'other',
        success: true,
        details: changeNote,
      });
    } catch { /* 不影响主流程 */ }

    // 通知小组成员有新版本
    await this.notifyTeamMembers(share.teamId, share.teamName, {
      event: 'skill_updated',
      shareId: share.id,
      skillName: share.skillName,
      sharerName: share.sharedByName,
      version: newVersion,
      changeNote,
      message: `${share.sharedByName} 更新了 Skill "${share.skillName}" 到 v${newVersion}${changeNote ? '：' + changeNote : ''}。可在共享列表中查看更新。`,
    });

    return share;
  }

  /**
   * 检查已安装的 Skill 是否有更新。
   *
   * 小组成员调用此方法，对比自己安装的版本和分享者最新版本。
   * 返回需要更新的列表，用户决定是否更新。
   */
  async checkForUpdates(userId: string): Promise<Array<{
    shareId: string;
    skillName: string;
    sharedByName: string;
    teamName: string;
    installedVersion: number;
    latestVersion: number;
    changeNote?: string;
    isUpdateAvailable: boolean;
  }>> {
    const shares = await this.loadShares();
    const installs = await this.loadInstallRecords();
    const userInstalls = installs.filter((r) => r.userId === userId);

    const results: Array<{
      shareId: string;
      skillName: string;
      sharedByName: string;
      teamName: string;
      installedVersion: number;
      latestVersion: number;
      changeNote?: string;
      isUpdateAvailable: boolean;
    }> = [];

    for (const install of userInstalls) {
      const share = shares.find((s) => s.id === install.shareId && s.status === 'active');
      if (!share) continue;

      const isUpdateAvailable = share.version > install.installedVersion;
      const lastVersionEntry = share.versionHistory[share.versionHistory.length - 1];

      results.push({
        shareId: share.id,
        skillName: share.skillName,
        sharedByName: share.sharedByName,
        teamName: share.teamName,
        installedVersion: install.installedVersion,
        latestVersion: share.version,
        changeNote: lastVersionEntry?.changeNote,
        isUpdateAvailable,
      });
    }

    return results;
  }

  /**
   * 更新已安装的 Skill 到最新版本。
   *
   * 用户从 checkForUpdates 发现更新后，调用此方法拉取最新版本。
   */
  async updateInstalledSkill(shareId: string, userId: string): Promise<string> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId && s.status === 'active');
    if (!share) {
      throw new Error(`Active share not found: ${shareId}`);
    }

    const installs = await this.loadInstallRecords();
    const install = installs.find((r) => r.shareId === shareId && r.userId === userId);
    if (!install) {
      throw new Error('Skill not installed. Use installSharedSkill first.');
    }

    if (install.installedVersion >= share.version) {
      return install.localPath; // 已是最新
    }

    // 写入最新版本
    const targetFile = install.localPath;
    const contentWithMeta = share.content.replace(
      /^---\n/,
      `---\n# Shared from team "${share.teamName}" by ${share.sharedByName}\n# Version: ${share.version} (hash: ${share.contentHash})\n# Updated at ${new Date().toISOString()}\n`,
    );
    await fs.writeFile(targetFile, contentWithMeta, 'utf-8');

    // 更新安装记录
    install.installedVersion = share.version;
    install.installedAt = new Date().toISOString();
    await this.saveInstallRecords(installs);

    // 记录工作日志
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'skill_update_install',
        action: `更新 Skill "${share.skillName}" 到 v${share.version}`,
        category: 'other',
        success: true,
      });
    } catch { /* 不影响主流程 */ }

    return targetFile;
  }

  /**
   * 评价共享 Skill。
   *
   * 每个用户只能打一次分，再次打分则更新已有评分。
   * 打分范围 1-5 星。
   */
  async rateSharedSkill(shareId: string, rating: number, userId: string): Promise<void> {
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be 1-5');
    }

    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) {
      throw new Error(`Share not found: ${shareId}`);
    }

    if (!share.ratings) {
      share.ratings = [];
    }

    // 用 userId 的哈希做去重，不存原始 userId，确保匿名
    const userHash = this.hashContent(userId + share.id);

    const existing = share.ratings.find((r) => r.userHash === userHash);
    if (existing) {
      existing.score = rating;
      existing.ratedAt = new Date().toISOString();
    } else {
      share.ratings.push({
        userHash,
        score: rating,
        ratedAt: new Date().toISOString(),
      });
    }

    // 重新计算平均分
    share.ratingCount = share.ratings.length;
    share.rating = share.ratings.reduce((sum, r) => sum + r.score, 0) / share.ratingCount;

    await this.saveShares(shares);

    // 记录工作日志（不记录是谁打的分，保护匿名）
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'skill_rate',
        action: `为 Skill "${share.skillName}" 打了 ${rating} 星（匿名）`,
        category: 'other',
        success: true,
      });
    } catch { /* 不影响主流程 */ }
  }

  /**
   * 列出当前用户可分享的个人 Skill（.otto/skills/ 下的）。
   */
  async listPersonalSkills(): Promise<Array<{ name: string; path: string; description: string }>> {
    const skills: Array<{ name: string; path: string; description: string }> = [];

    try {
      const entries = await fs.readdir(this.personalSkillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(this.personalSkillsDir, entry.name, 'SKILL.md');
        try {
          const content = await fs.readFile(skillFile, 'utf-8');
          const desc = extractDescription(content) || '';
          skills.push({ name: entry.name, path: skillFile, description: desc });
        } catch {
          // 没有 SKILL.md 的目录跳过
        }
      }
    } catch {
      // 目录不存在
    }

    return skills;
  }

  /**
   * 格式化分享列表为可读文本（用于飞书卡片展示）。
   * 自动从 SKILL.md 提取功能描述，直接展示中文说明。
   */
  formatSharedSkillsForDisplay(shares: SkillShareRecord[]): string {
    if (shares.length === 0) {
      return '小组暂无共享 Skill。';
    }

    const lines: string[] = ['📋 小组共享 Skill 列表', ''];

    for (const share of shares) {
      const status = share.status === 'active' ? '✅' : share.status === 'revoked' ? '❌' : '⚠️';
      const stars = '⭐'.repeat(Math.round(share.rating));
      const feature = share.featureDescription || extractFeature(share.content);

      lines.push(`${status} ${share.skillName} (v${share.version})`);
      lines.push(`   功能：${feature}`);
      lines.push(`   分享者：${share.sharedByName}`);
      lines.push(`   小组：${share.teamName}`);
      lines.push(`   安装数：${share.installCount}  评分：${stars || '暂无'}`);
      if (share.note) {
        lines.push(`   备注：${share.note}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 从 SKILL.md 内容提取 description */
function extractDescription(content: string): string | null {
  const match = content.match(/^---[\s\S]*?description:\s*(.+?)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * 从 SKILL.md 内容提取功能描述（中文，直接可读）。
 * 按优先级尝试：YAML description → 一级标题 → 第一段正文。
 */
function extractFeature(content: string): string {
  // 1. YAML frontmatter 的 description（最准确）
  const desc = extractDescription(content);
  if (desc) return desc;

  // 2. 第一个一级标题（# 标题）
  const titleMatch = content.match(/^#\s+(.+?)$/m);
  if (titleMatch) return titleMatch[1].trim();

  // 3. 正文第一段（去掉 frontmatter 和注释后的第一行非空文本）
  const body = content.replace(/^---[\s\S]*?---\n/, '').trim();
  const firstLine = body.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>'));
  if (firstLine) return firstLine.trim();

  return '暂无功能描述';
}

/** 从 SKILL.md 内容提取 name */
function extractName(content: string): string | null {
  const match = content.match(/^---[\s\S]*?name:\s*(.+?)$/m);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** 从 SKILL.md 内容提取触发模式（从 description 中） */
function extractTriggerPatterns(content: string): string[] {
  const desc = extractDescription(content) || '';
  // 提取中文关键词作为触发模式
  return desc.split(/[，,。.；;！!？?]+/).filter((s) => s.length > 2).slice(0, 5);
}

/** 从 SKILL.md 内容提取工作流步骤 */
function extractWorkflowSteps(content: string): string[] {
  const steps: string[] = [];
  const lines = content.split('\n');
  let inStepsSection = false;

  for (const line of lines) {
    if (line.match(/^##\s*(操作步骤|步骤|Steps)/i)) {
      inStepsSection = true;
      continue;
    }
    if (inStepsSection && line.match(/^##\s/)) {
      break;
    }
    if (inStepsSection && line.match(/^\d+\.\s/)) {
      steps.push(line.replace(/^\d+\.\s*/, '').trim());
    }
  }

  return steps.length > 0 ? steps : ['Review context', 'Execute task', 'Validate result'];
}

/**
 * 全局单例。
 */
let globalSkillShare: SkillShareManager | null = null;

export function getSkillShareManager(config: Config): SkillShareManager {
  if (!globalSkillShare) {
    globalSkillShare = new SkillShareManager(config);
  }
  return globalSkillShare;
}
