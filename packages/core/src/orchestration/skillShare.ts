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
import type { Config } from '../config/config.js';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import type { SkillRecord } from '../memory/orgMemoryTypes.js';
import { getWorkLogger } from './workLog.js';
import { getProactiveService } from './proactiveService.js';
import { getEnterpriseSync } from './enterpriseSync.js';
import type { Permission } from '../memory/orgMemoryTypes.js';

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
  /** 实际使用次数（安装后执行了 Skill 的次数） */
  usageCount: number;
  /** 使用成功次数 */
  successCount: number;
  /** 使用失败次数 */
  failureCount: number;
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
  /** 评论列表 */
  comments: SkillComment[];
  /** 是否发布到公司 Skill 市场（跨小组可见） */
  publishedToMarketplace: boolean;
}

/** Skill 评论 */
export interface SkillComment {
  id: string;
  /** 评论者用户哈希（匿名） */
  userHash: string;
  /** 评论者显示名（可选，不填则匿名） */
  displayName?: string;
  /** 评论内容 */
  content: string;
  /** 评论时间 */
  createdAt: string;
  /** 是否是分享者的回复 */
  isReply: boolean;
  /** 如果是回复，指向被回复的评论 ID */
  replyTo?: string;
  /** 点赞数 */
  likes: number;
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
  /** 检查用户是否有指定权限 */
  private async requirePermission(userId: string, permission: Permission): Promise<void> {
    try {
      const sync = getEnterpriseSync(this.config.getProjectRoot());
      const has = await sync.checkPermission(userId, permission);
      if (!has) {
        throw new Error(`权限不足：需要 ${permission} 权限`);
      }
    } catch (err) {
      // 如果权限系统不可用（企业未绑定），降级为允许（向后兼容）
      if (err instanceof Error && err.message.startsWith('权限不足')) {
        throw err;
      }
      // 企业未绑定等异常，降级放行
    }
  }

  /** 检查用户是否为部门负责人或管理员（可管理部门 Skill） */
  private async requireManagerPermission(userId: string): Promise<void> {
    try {
      const sync = getEnterpriseSync(this.config.getProjectRoot());
      const roleInfo = await sync.getUserRoleAndPermissions(userId);
      if (roleInfo) {
        const allowed = roleInfo.permissions.includes('skill:team:approve' as Permission);
        if (!allowed) {
          throw new Error('权限不足：仅部门负责人或管理员可执行此操作');
        }
      }
      // roleInfo 为 null（企业未绑定）时降级放行
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('权限不足')) {
        throw err;
      }
    }
  }

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
    // 权限检查：需要 skill:team:write 权限
    await this.requirePermission(params.userId, 'skill:team:write' as Permission);

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
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      rating: 0,
      ratingCount: 0,
      ratings: [],
      comments: [],
      publishedToMarketplace: false,
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
    // 权限检查：需要 skill:team:write 权限
    await this.requirePermission(userId, 'skill:team:write' as Permission);

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
   * 记录 Skill 使用情况（由工具执行引擎在 Skill 被使用后调用）。
   *
   * @param skillName Skill 名称
   * @param success 是否成功
   */
  async recordSkillUsage(skillName: string, success: boolean): Promise<void> {
    const shares = await this.loadShares();
    // 找到所有活跃的、同名的分享记录（可能跨多个小组）
    const matching = shares.filter(
      (s) => s.skillName === skillName && s.status === 'active',
    );

    for (const share of matching) {
      share.usageCount++;
      if (success) {
        share.successCount++;
      } else {
        share.failureCount++;
      }
    }

    if (matching.length > 0) {
      await this.saveShares(shares);
    }
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
   * 将已分享的 Skill 发布到公司 Skill 市场（跨小组可见）。
   * 只有分享者本人可以发布。
   */
  async publishToMarketplace(shareId: string, userId: string): Promise<void> {
    // 权限检查：发布到公司市场需要 skill:company:approve 权限
    await this.requirePermission(userId, 'skill:company:approve' as Permission);

    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) throw new Error(`Share not found: ${shareId}`);
    if (share.sharedBy !== userId) throw new Error('Only the sharer can publish to marketplace');
    if (share.status !== 'active') throw new Error(`Cannot publish ${share.status} share`);

    share.publishedToMarketplace = true;
    await this.saveShares(shares);

    // 同步到 OrgMemoryStore 的 company scope
    const data = await this.store.load();
    const companySkill: SkillRecord = {
      id: `market_skill_${share.skillName}`,
      companyId: data.companies[0]?.id || 'default',
      name: share.skillName,
      description: share.featureDescription || share.skillName,
      scope: 'company',
      status: 'company_candidate',
      triggerPatterns: extractTriggerPatterns(share.content),
      requiredInputs: ['context'],
      workflowSteps: extractWorkflowSteps(share.content),
      outputSchema: 'Markdown',
      examples: [],
      sourceProjectIds: [],
      sourceTaskIds: [],
      usageCount: share.usageCount,
      successRate: share.usageCount > 0 ? share.successCount / share.usageCount : 1,
      avgTokenCost: 0,
      avgRevisionCount: 0,
      avgTimeSavedMinutes: 0,
      createdBy: share.sharedBy,
      approvedBy: share.sharedBy,
      createdAt: share.sharedAt,
      updatedAt: new Date().toISOString(),
    };

    const existingIdx = data.skills.findIndex(
      (s) => s.id === companySkill.id || (s.name === companySkill.name && s.scope === 'company'),
    );
    if (existingIdx !== -1) {
      data.skills[existingIdx] = companySkill;
    } else {
      data.skills.push(companySkill);
    }
    await this.store.save(data);
  }

  /**
   * 从公司 Skill 市场下架。
   */
  async unpublishFromMarketplace(shareId: string, userId: string): Promise<void> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share) throw new Error(`Share not found: ${shareId}`);
    if (share.sharedBy !== userId) throw new Error('Only the sharer can unpublish');

    share.publishedToMarketplace = false;
    await this.saveShares(shares);

    // 从 OrgMemoryStore 移除 company scope
    const data = await this.store.load();
    data.skills = data.skills.filter(
      (s) => !(s.name === share.skillName && s.scope === 'company'),
    );
    await this.store.save(data);
  }

  /**
   * 浏览公司 Skill 市场（跨小组，所有已发布的 Skill）。
   */
  async browseMarketplace(options: { category?: string; sortBy?: 'rating' | 'installs' | 'usage' | 'newest'; limit?: number } = {}): Promise<SkillShareRecord[]> {
    const shares = await this.loadShares();
    let marketShares = shares.filter((s) => s.publishedToMarketplace && s.status === 'active');

    // 排序
    const sortBy = options.sortBy || 'rating';
    switch (sortBy) {
      case 'rating':
        marketShares.sort((a, b) => b.rating - a.rating);
        break;
      case 'installs':
        marketShares.sort((a, b) => b.installCount - a.installCount);
        break;
      case 'usage':
        marketShares.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
        break;
      case 'newest':
        marketShares.sort((a, b) => b.sharedAt.localeCompare(a.sharedAt));
        break;
      default:
        break;
    }

    if (options.limit) marketShares = marketShares.slice(0, options.limit);
    return marketShares;
  }

  /**
   * 格式化市场列表为可读文本。
   */
  formatMarketplaceForDisplay(shares: SkillShareRecord[]): string {
    if (shares.length === 0) {
      return '公司 Skill 市场暂无已发布的 Skill。';
    }

    const lines: string[] = ['🏪 公司 Skill 市场', ''];
    for (const share of shares) {
      const stars = '⭐'.repeat(Math.round(share.rating));
      const feature = share.featureDescription || extractFeature(share.content);
      lines.push(`📌 ${share.skillName} (v${share.version})`);
      lines.push(`   功能：${feature}`);
      lines.push(`   分享者：${share.sharedByName} (${share.teamName})`);
      lines.push(`   评分：${stars || '暂无'} (${share.ratingCount}人) | 安装：${share.installCount}次 | 使用：${share.usageCount || 0}次`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * 对 Skill 发表评论或提问。
   */
  async addComment(
    shareId: string,
    userId: string,
    content: string,
    options: { displayName?: string; replyTo?: string } = {},
  ): Promise<SkillComment> {
    if (!content.trim()) {
      throw new Error('Comment content cannot be empty');
    }

    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId && s.status === 'active');
    if (!share) {
      throw new Error(`Active share not found: ${shareId}`);
    }

    if (!share.comments) share.comments = [];

    // 判断是否是分享者的回复
    const isReply = !!options.replyTo || share.sharedBy === userId;

    const comment: SkillComment = {
      id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userHash: this.hashContent(userId + share.id),
      displayName: isReply ? share.sharedByName : options.displayName,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      isReply,
      replyTo: options.replyTo,
      likes: 0,
    };

    share.comments.push(comment);
    await this.saveShares(shares);

    // 通知分享者有人评论（除非是自己回复自己）
    if (!isReply) {
      await this.notifyTeamMembers(share.teamId, share.teamName, {
        event: 'skill_shared',
        shareId: share.id,
        skillName: share.skillName,
        sharerName: share.sharedByName,
        message: `${options.displayName || '匿名用户'} 对你的 Skill "${share.skillName}" 发表了评论：${content.substring(0, 50)}`,
      });
    }

    return comment;
  }

  /**
   * 获取 Skill 的所有评论（按时间排序）。
   */
  async getComments(shareId: string): Promise<SkillComment[]> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share || !share.comments) return [];
    return share.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 点赞评论。
   */
  async likeComment(shareId: string, commentId: string): Promise<void> {
    const shares = await this.loadShares();
    const share = shares.find((s) => s.id === shareId);
    if (!share || !share.comments) return;
    const comment = share.comments.find((c) => c.id === commentId);
    if (comment) {
      comment.likes++;
      await this.saveShares(shares);
    }
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

  /**
   * 生成小组 Skill 贡献明星榜。
   *
   * 按综合贡献度排序：分享数×0.3 + 总安装数×0.3 + 平均评分×0.2 + 总评分数×0.2
   *
   * @param teamId 小组 ID
   */
  async getTeamSharerLeaderboard(teamId: string): Promise<string> {
    const shares = await this.loadShares();
    const activeShares = shares.filter((s) => s.teamId === teamId && s.status === 'active');

    if (activeShares.length === 0) {
      return `本小组暂无贡献者。`;
    }

    const teamName = activeShares[0]?.teamName || '本小组';

    // 按分享者聚合
    const contributorMap: Record<string, {
      name: string;
      skillCount: number;
      totalInstalls: number;
      totalRatingScore: number;
      ratingCount: number;
      skills: string[];
    }> = {};

    for (const share of activeShares) {
      const key = share.sharedBy;
      if (!contributorMap[key]) {
        contributorMap[key] = {
          name: share.sharedByName,
          skillCount: 0,
          totalInstalls: 0,
          totalRatingScore: 0,
          ratingCount: 0,
          skills: [],
        };
      }
      const c = contributorMap[key];
      c.skillCount++;
      c.totalInstalls += share.installCount;
      c.totalRatingScore += share.rating * share.ratingCount;
      c.ratingCount += share.ratingCount;
      c.skills.push(share.skillName);
    }

    // 计算综合贡献度
    const maxInstalls = Math.max(...Object.values(contributorMap).map((c) => c.totalInstalls), 1);
    const maxRatingCount = Math.max(...Object.values(contributorMap).map((c) => c.ratingCount), 1);

    const contributors = Object.values(contributorMap).map((c) => {
      const avgRating = c.ratingCount > 0 ? (c.totalRatingScore / c.ratingCount) : 0;
      // 标准化到 0-100
      const shareScore = (c.skillCount / Math.max(...Object.values(contributorMap).map((x) => x.skillCount), 1)) * 100;
      const installScore = (c.totalInstalls / maxInstalls) * 100;
      const ratingScore = (avgRating / 5) * 100;
      const feedbackScore = (c.ratingCount / maxRatingCount) * 100;

      const contributionScore = shareScore * 0.3 + installScore * 0.3 + ratingScore * 0.2 + feedbackScore * 0.2;

      return { ...c, avgRating, contributionScore };
    });

    contributors.sort((a, b) => b.contributionScore - a.contributionScore);

    // 格式化明星榜
    const lines: string[] = [];
    lines.push(`🌟 ${teamName} Skill 贡献明星榜`);
    lines.push('');

    const medals = ['🥇', '🥈', '🥉'];
    for (let i = 0; i < contributors.length; i++) {
      const c = contributors[i];
      const rank = i < 3 ? medals[i] : `${i + 1}.`;
      const stars = '⭐'.repeat(Math.round(c.avgRating));

      lines.push(`${rank} ${c.name}`);
      lines.push(`   分享：${c.skillCount} 个 | 安装：${c.totalInstalls} 次 | 评分：${stars || '暂无'} (${c.ratingCount}人) | 贡献度：${c.contributionScore.toFixed(0)}`);
      lines.push(`   作品：${c.skills.join('、')}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 生成小组 Skill 排行榜 + 贡献明星榜（并排展示）。
   *
   * 按综合得分排序（评分×0.6 + 安装数×0.4），
   * 只展示活跃状态的 Skill。
   *
   * @param teamId 小组 ID
   * @param limit 返回条数，默认10
   */
  async getTeamLeaderboard(teamId: string, limit: number = 10): Promise<string> {
    const shares = await this.loadShares();
    const activeShares = shares.filter((s) => s.teamId === teamId && s.status === 'active');

    if (activeShares.length === 0) {
      return `本小组暂无共享 Skill 排行榜。`;
    }

    // 获取小组名称
    const teamName = activeShares[0]?.teamName || '本小组';

    // 计算综合得分：评分×0.35 + 安装数×0.25 + 使用成功率×0.25 + 使用次数×0.15
    const maxInstalls = Math.max(...activeShares.map((s) => s.installCount), 1);
    const maxUsage = Math.max(...activeShares.map((s) => s.usageCount || 0), 1);
    const scored = activeShares.map((s) => {
      const ratingScore = (s.rating / 5) * 100;
      const installScore = (s.installCount / maxInstalls) * 100;
      const successRate = s.usageCount > 0 ? (s.successCount / s.usageCount) * 100 : 50; // 无使用记录默认50分
      const usageScore = (s.usageCount / maxUsage) * 100;
      const totalScore = ratingScore * 0.35 + installScore * 0.25 + successRate * 0.25 + usageScore * 0.15;
      return { share: s, totalScore };
    });

    // 按综合得分降序
    scored.sort((a, b) => b.totalScore - a.totalScore);

    // 取前N名
    const top = scored.slice(0, limit);

    // 格式化排行榜
    const lines: string[] = [];
    lines.push(`🏆 ${teamName} Skill 排行榜`);
    lines.push('');

    const medals = ['🥇', '🥈', '🥉'];
    for (let i = 0; i < top.length; i++) {
      const { share, totalScore } = top[i];
      const rank = i < 3 ? medals[i] : `${i + 1}.`;
      const stars = '⭐'.repeat(Math.round(share.rating));
      const feature = share.featureDescription || extractFeature(share.content);

      lines.push(`${rank} ${share.skillName} (v${share.version})`);
      lines.push(`   功能：${feature}`);
      lines.push(`   分享者：${share.sharedByName}`);
      lines.push(`   评分：${stars || '暂无'} (${share.ratingCount}人) | 安装：${share.installCount}次 | 综合：${totalScore.toFixed(0)}分`);
      lines.push('');
    }

    // 统计信息
    lines.push('📊 小组统计');
    lines.push(`   共享 Skill 总数：${activeShares.length}`);
    lines.push(`   总安装次数：${activeShares.reduce((sum, s) => sum + s.installCount, 0)}`);
    lines.push(`   总评分数：${activeShares.reduce((sum, s) => sum + s.ratingCount, 0)}`);
    const topSharers = this.getTopSharers(activeShares, 3);
    if (topSharers.length > 0) {
      lines.push(`   活跃贡献者：${topSharers.map((s) => `${s.name}(${s.count}个)`).join('、')}`);
    }

    return lines.join('\n');
  }

  /**
   * 获取小组内分享最多的成员。
   */
  private getTopSharers(shares: SkillShareRecord[], limit: number): Array<{ name: string; count: number }> {
    const counts: Record<string, number> = {};
    for (const share of shares) {
      counts[share.sharedByName] = (counts[share.sharedByName] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * 生成小组看板数据（排行榜 + 明星榜），供 UI 侧边切换展示。
   * 返回结构化数据，由前端渲染为带切换键的两个面板。
   */
  async getTeamDashboard(teamId: string): Promise<{
    leaderboard: string;
    starBoard: string;
    leaderboardData: Array<{ rank: number; skillName: string; version: number; feature: string; sharerName: string; rating: number; ratingCount: number; installCount: number; score: number }>;
    starBoardData: Array<{ rank: number; name: string; skillCount: number; totalInstalls: number; avgRating: number; ratingCount: number; score: number; skills: string[] }>;
    tabs: Array<{ id: string; label: string; icon: string }>;
  }> {
    const shares = await this.loadShares();
    const activeShares = shares.filter((s) => s.teamId === teamId && s.status === 'active');
    const teamName = activeShares[0]?.teamName || '本小组';

    // 排行榜数据
    const maxInstalls = Math.max(...activeShares.map((s) => s.installCount), 1);
    const maxUsage = Math.max(...activeShares.map((s) => s.usageCount || 0), 1);
    const leaderboardData = activeShares.map((s) => {
      const ratingScore = (s.rating / 5) * 100;
      const installScore = (s.installCount / maxInstalls) * 100;
      const successRate = s.usageCount > 0 ? (s.successCount / s.usageCount) * 100 : 50;
      const usageScore = maxUsage > 0 ? (s.usageCount / maxUsage) * 100 : 0;
      return {
        rank: 0,
        skillName: s.skillName,
        version: s.version,
        feature: s.featureDescription || extractFeature(s.content),
        sharerName: s.sharedByName,
        rating: s.rating,
        ratingCount: s.ratingCount,
        installCount: s.installCount,
        usageCount: s.usageCount,
        successRate: s.usageCount > 0 ? Math.round((s.successCount / s.usageCount) * 100) : 0,
        score: ratingScore * 0.35 + installScore * 0.25 + successRate * 0.25 + usageScore * 0.15,
      };
    }).sort((a, b) => b.score - a.score);
    leaderboardData.forEach((item, i) => { item.rank = i + 1; });

    // 明星榜数据
    const contributorMap: Record<string, { name: string; skillCount: number; totalInstalls: number; totalRatingScore: number; ratingCount: number; skills: string[] }> = {};
    for (const share of activeShares) {
      const key = share.sharedBy;
      if (!contributorMap[key]) {
        contributorMap[key] = { name: share.sharedByName, skillCount: 0, totalInstalls: 0, totalRatingScore: 0, ratingCount: 0, skills: [] };
      }
      const c = contributorMap[key];
      c.skillCount++;
      c.totalInstalls += share.installCount;
      c.totalRatingScore += share.rating * share.ratingCount;
      c.ratingCount += share.ratingCount;
      c.skills.push(share.skillName);
    }

    const maxContributorInstalls = Math.max(...Object.values(contributorMap).map((c) => c.totalInstalls), 1);
    const maxContributorRatingCount = Math.max(...Object.values(contributorMap).map((c) => c.ratingCount), 1);
    const maxSkillCount = Math.max(...Object.values(contributorMap).map((c) => c.skillCount), 1);

    const starBoardData = Object.values(contributorMap).map((c) => {
      const avgRating = c.ratingCount > 0 ? (c.totalRatingScore / c.ratingCount) : 0;
      const shareScore = (c.skillCount / maxSkillCount) * 100;
      const installScore = (c.totalInstalls / maxContributorInstalls) * 100;
      const ratingScore = (avgRating / 5) * 100;
      const feedbackScore = (c.ratingCount / maxContributorRatingCount) * 100;
      return {
        rank: 0,
        name: c.name,
        skillCount: c.skillCount,
        totalInstalls: c.totalInstalls,
        avgRating,
        ratingCount: c.ratingCount,
        score: shareScore * 0.3 + installScore * 0.3 + ratingScore * 0.2 + feedbackScore * 0.2,
        skills: c.skills,
      };
    }).sort((a, b) => b.score - a.score);
    starBoardData.forEach((item, i) => { item.rank = i + 1; });

    // 格式化文本版本（供飞书卡片等纯文本场景）
    const leaderboardText = this.formatLeaderboardText(teamName, leaderboardData);
    const starBoardText = this.formatStarBoardText(teamName, starBoardData);

    return {
      leaderboard: leaderboardText,
      starBoard: starBoardText,
      leaderboardData,
      starBoardData,
      tabs: [
        { id: 'leaderboard', label: 'Skill 排行榜', icon: '🏆' },
        { id: 'stars', label: '贡献明星榜', icon: '🌟' },
      ],
    };
  }

  /** 格式化排行榜文本 */
  private formatLeaderboardText(teamName: string, data: Array<{ rank: number; skillName: string; version: number; feature: string; sharerName: string; rating: number; ratingCount: number; installCount: number; score: number }>): string {
    if (data.length === 0) return `${teamName} 暂无共享 Skill。`;
    const medals = ['🥇', '🥈', '🥉'];
    const lines: string[] = [`🏆 ${teamName} Skill 排行榜`, ''];
    for (const item of data) {
      const rank = item.rank <= 3 ? medals[item.rank - 1] : `${item.rank}.`;
      const stars = '⭐'.repeat(Math.round(item.rating));
      lines.push(`${rank} ${item.skillName} (v${item.version})`);
      lines.push(`   功能：${item.feature}`);
      lines.push(`   分享者：${item.sharerName}`);
      lines.push(`   评分：${stars || '暂无'} (${item.ratingCount}人) | 安装：${item.installCount}次 | 综合：${item.score.toFixed(0)}分`);
      lines.push('');
    }
    return lines.join('\n');
  }

  /** 格式化明星榜文本 */
  private formatStarBoardText(teamName: string, data: Array<{ rank: number; name: string; skillCount: number; totalInstalls: number; avgRating: number; ratingCount: number; score: number; skills: string[] }>): string {
    if (data.length === 0) return `${teamName} 暂无贡献者。`;
    const medals = ['🥇', '🥈', '🥉'];
    const lines: string[] = [`🌟 ${teamName} Skill 贡献明星榜`, ''];
    for (const item of data) {
      const rank = item.rank <= 3 ? medals[item.rank - 1] : `${item.rank}.`;
      const stars = '⭐'.repeat(Math.round(item.avgRating));
      lines.push(`${rank} ${item.name}`);
      lines.push(`   分享：${item.skillCount} 个 | 安装：${item.totalInstalls} 次 | 评分：${stars || '暂无'} (${item.ratingCount}人) | 贡献度：${item.score.toFixed(0)}`);
      lines.push(`   作品：${item.skills.join('、')}`);
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
function _extractName(content: string): string | null {
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
