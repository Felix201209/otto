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
import { homedir } from 'os';
import type { Config } from '../config/config.js';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import type { SkillRecord } from '../memory/orgMemoryTypes.js';
import { getWorkLogger } from './workLog.js';

/** 分享状态 */
export type ShareStatus = 'active' | 'revoked' | 'deprecated';

/** 个人 Skill 分享记录 */
export interface SkillShareRecord {
  id: string;
  /** 原始 Skill 名称（.otto/skills/ 下的目录名） */
  skillName: string;
  /** 原始 SKILL.md 路径 */
  sourcePath: string;
  /** SKILL.md 内容 */
  content: string;
  /** 分享到哪个小组 */
  teamId: string;
  teamName: string;
  /** 分享者 */
  sharedBy: string;
  sharedByName: string;
  /** 分享时间 */
  sharedAt: string;
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

  constructor(private readonly config: Config) {
    this.store = new OrgMemoryStore(config.getProjectRoot());
  }

  /** 分享记录存储路径 */
  private get shareStorePath(): string {
    return path.join(this.config.getProjectRoot(), '.otto', 'org', 'skill-shares.json');
  }

  /** 个人 Skills 目录 */
  private get personalSkillsDir(): string {
    return path.join(this.config.getProjectRoot(), '.otto', 'skills');
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
    const shareRecord: SkillShareRecord = {
      id: `share_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      skillName: params.skillName,
      sourcePath: skillFile,
      content: skillContent,
      teamId: params.teamId,
      teamName: team.name,
      sharedBy: params.userId,
      sharedByName: params.userName,
      sharedAt: now,
      status: 'active',
      installCount: 0,
      rating: 0,
      ratingCount: 0,
      note: params.note,
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
  }

  /**
   * 查看小组共享的 Skill 列表。
   */
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

    // 在内容头部添加来源信息
    const contentWithMeta = share.content.replace(
      /^---\n/,
      `---\n# Shared from team "${share.teamName}" by ${share.sharedByName}\n# Installed at ${new Date().toISOString()}\n`,
    );
    await fs.writeFile(targetFile, contentWithMeta, 'utf-8');

    // 更新安装计数
    share.installCount++;
    await this.saveShares(shares);

    // 记录工作日志
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'skill_install',
        action: `安装小组共享 Skill "${share.skillName}"（来自 ${share.sharedByName}）`,
        category: 'other',
        success: true,
      });
    } catch { /* 不影响主流程 */ }

    return targetFile;
  }

  /**
   * 评价已安装的共享 Skill。
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

    // 简单平均评分
    const totalScore = share.rating * share.ratingCount + rating;
    share.ratingCount++;
    share.rating = totalScore / share.ratingCount;
    await this.saveShares(shares);
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
   */
  formatSharedSkillsForDisplay(shares: SkillShareRecord[]): string {
    if (shares.length === 0) {
      return '小组暂无共享 Skill。';
    }

    const lines: string[] = ['📋 小组共享 Skill 列表', ''];

    for (const share of shares) {
      const status = share.status === 'active' ? '✅' : share.status === 'revoked' ? '❌' : '⚠️';
      const stars = '⭐'.repeat(Math.round(share.rating));
      lines.push(`${status} ${share.skillName}`);
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
