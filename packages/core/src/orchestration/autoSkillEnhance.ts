/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * AutoSkill 增强模块：实时触发、效果追踪、自动优化、多项目迁移。
 *
 * 四个独立模块，可单独使用也可以组合。
 */

// ─── 1. 实时触发：操作计数器 ─────────────────────────────────────

/**
 * 实时操作监视器。每完成一个工具操作就喂给它，达到阈值当场通知。
 * 比定时扫描快得多——不用等24小时。
 */
export class AutoSkillRealtimeWatcher {
  /** 最近 N 次操作 */
  private readonly buffer: Array<{ action: string; time: number; details?: string }> = [];
  /** 缓冲区最大长度 */
  private readonly maxBuffer: number;
  /** 触发阈值：同一模式出现多少次才通知 */
  private readonly threshold: number;
  /** 通知回调 */
  private onPatternDetected?: (summary: RealtimePatternSummary) => void;
  /** 已通知过的模式签名（避免重复弹窗） */
  private readonly notifiedPatterns = new Set<string>();
  /** 防抖：两次通知最短间隔（ms） */
  private readonly minNotificationIntervalMs: number;
  private lastNotificationTime = 0;

  constructor(opts: {
    maxBuffer?: number;
    threshold?: number;
    minNotificationIntervalMs?: number;
  } = {}) {
    this.maxBuffer = opts.maxBuffer ?? 50;
    this.threshold = opts.threshold ?? 3;
    this.minNotificationIntervalMs = opts.minNotificationIntervalMs ?? 30_000;
  }

  setCallback(cb: (summary: RealtimePatternSummary) => void): void {
    this.onPatternDetected = cb;
  }

  /** 每完成一个操作后调用。返回是否触发了通知。 */
  record(action: string, details?: string): boolean {
    this.buffer.push({ action, time: Date.now(), details });
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
    }

    // 提取最近的操作模式（取操作名的核心词）
    const actionCore = extractActionCore(action);
    const matchCount = this.buffer.filter(
      (e) => extractActionCore(e.action) === actionCore,
    ).length;

    if (matchCount >= this.threshold) {
      const sig = actionCore;
      // 防抖
      const now = Date.now();
      if (
        this.notifiedPatterns.has(sig) &&
        now - this.lastNotificationTime < this.minNotificationIntervalMs
      ) {
        return false;
      }

      // 收集该模式的样本
      const samples = this.buffer
        .filter((e) => extractActionCore(e.action) === actionCore)
        .slice(-matchCount);

      this.notifiedPatterns.add(sig);
      this.lastNotificationTime = now;

      const summary: RealtimePatternSummary = {
        pattern: actionCore,
        count: matchCount,
        samples: samples.map((s) => ({
          action: s.action,
          details: s.details,
          time: new Date(s.time).toISOString(),
        })),
        suggestion: `检测到你最近 ${matchCount} 次做了「${actionCore}」类操作。要我帮你把这个流程沉淀为一个可复用的 Skill 吗？`,
      };

      this.onPatternDetected?.(summary);
      return true;
    }

    return false;
  }

  /** 重置通知状态（用户确认/拒绝后清掉，下次可再触发）。 */
  reset(): void {
    this.notifiedPatterns.clear();
    this.buffer.length = 0;
  }
}

export interface RealtimePatternSummary {
  pattern: string;
  count: number;
  samples: Array<{ action: string; details?: string; time: string }>;
  suggestion: string;
}

/** 提取操作的核心语义（去掉文件名、具体参数等变化部分）。 */
function extractActionCore(action: string): string {
  // 去掉冒号后面的具体内容（如 "读取文件: server.ts" → "读取文件"）
  let core = action.split(':')[0]?.trim() || action;
  // 再去掉常见动词前缀的模式噪声
  core = core
    .replace(/^(成功|失败|完成)\s*/, '')
    .replace(/\b[A-Z]:\\[^\s]*/gi, '') // 去掉 Windows 路径
    .replace(/\/[\w/.-]+/g, '') // 去掉 Unix 路径
    .replace(/\b[\w-]+\.(ts|js|py|md|json|yaml|yml|css|html)\b/gi, '') // 去掉文件名
    .replace(/\s{2,}/g, ' ')
    .trim();
  return core || action;
}


// ─── 2. Skill 效果追踪 ──────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Config } from '../config/config.js';
import { SceneType, SceneManager } from '../core/sceneManager.js';
import { getResponseText } from '../utils/partUtils.js';
import { redactSensitiveText } from '../utils/redaction.js';

/** 单次 Skill 使用记录 */
export interface SkillUsageRecord {
  skillName: string;
  timestamp: string;
  success: boolean;
  durationMs: number;
  toolCalls: number;
  userFeedback?: 'good' | 'bad' | 'skipped';
  errorMessage?: string;
  projectDir?: string;
}

let usageHistory: SkillUsageRecord[] = [];
const MAX_USAGE_HISTORY = 500;
let loadedUsagePath = '';
let usagePersistQueue: Promise<void> = Promise.resolve();

function resolveSkillUsagePath(): string {
  const configured = process.env['OTTO_USER_DIR']?.trim();
  const userDir = configured
    || (process.env['NODE_ENV'] === 'test' || process.env['VITEST']
      ? path.join(tmpdir(), 'otto-auto-skill-tests', String(process.pid))
      : path.join(homedir(), '.otto-user'));
  return path.join(userDir, 'memory', 'worklog', 'skill_usage.jsonl');
}

function isSkillUsageRecord(value: unknown): value is SkillUsageRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SkillUsageRecord>;
  return typeof item.skillName === 'string'
    && typeof item.timestamp === 'string'
    && typeof item.success === 'boolean'
    && typeof item.durationMs === 'number'
    && typeof item.toolCalls === 'number'
    && (item.userFeedback === undefined
      || item.userFeedback === 'good'
      || item.userFeedback === 'bad'
      || item.userFeedback === 'skipped')
    && (item.errorMessage === undefined || typeof item.errorMessage === 'string')
    && (item.projectDir === undefined || typeof item.projectDir === 'string');
}

function ensureUsageHistoryLoaded(): void {
  const usagePath = resolveSkillUsagePath();
  if (loadedUsagePath === usagePath) return;

  loadedUsagePath = usagePath;
  usageHistory = [];
  try {
    const records = fsSync.readFileSync(usagePath, 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          return isSkillUsageRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
    usageHistory = records.slice(-MAX_USAGE_HISTORY);
  } catch {
    // First use and temporarily unavailable files must not block Skill execution.
  }
}

function sanitizeSkillUsageRecord(record: SkillUsageRecord): SkillUsageRecord {
  return {
    ...record,
    skillName: record.skillName.trim().slice(0, 160),
    durationMs: Math.max(0, Math.round(record.durationMs)),
    toolCalls: Math.max(0, Math.round(record.toolCalls)),
    errorMessage: record.errorMessage
      ? redactSensitiveText(record.errorMessage).slice(0, 500)
      : undefined,
    projectDir: record.projectDir ? path.basename(record.projectDir) : undefined,
  };
}

/** 记录一次 Skill 调用。 */
export function recordSkillUsage(record: SkillUsageRecord): void {
  ensureUsageHistoryLoaded();
  const safeRecord = sanitizeSkillUsageRecord(record);
  if (!safeRecord.skillName) return;

  usageHistory.push(safeRecord);
  const shouldCompact = usageHistory.length > MAX_USAGE_HISTORY;
  if (usageHistory.length > MAX_USAGE_HISTORY) {
    usageHistory = usageHistory.slice(-MAX_USAGE_HISTORY);
  }

  const usagePath = resolveSkillUsagePath();
  const retainedRecords = [...usageHistory];
  usagePersistQueue = usagePersistQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(usagePath), { recursive: true, mode: 0o700 });
      if (shouldCompact) {
        await fs.writeFile(
          usagePath,
          `${retainedRecords.map((item) => JSON.stringify(item)).join('\n')}\n`,
          { encoding: 'utf8', mode: 0o600 },
        );
      } else {
        await fs.appendFile(usagePath, `${JSON.stringify(safeRecord)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
    })
    .catch(() => undefined);
}

/** Wait for best-effort usage writes during shutdown and tests. */
export async function flushSkillUsageWrites(): Promise<void> {
  await usagePersistQueue;
}

/** 获取某个 Skill 的使用统计。 */
export function getSkillStats(skillName: string): {
  totalUses: number;
  successRate: number;
  avgDurationMs: number;
  avgToolCalls: number;
  lastUsed: string | null;
  trend: 'increasing' | 'stable' | 'declining';
  topErrors: string[];
} {
  ensureUsageHistoryLoaded();
  const records = usageHistory.filter((r) => r.skillName === skillName);
  if (records.length === 0) {
    return {
      totalUses: 0, successRate: 1, avgDurationMs: 0, avgToolCalls: 0,
      lastUsed: null, trend: 'stable', topErrors: [],
    };
  }

  const successes = records.filter((r) => r.success).length;
  const durations = records.map((r) => r.durationMs).filter((d) => d > 0);
  const toolCalls = records.map((r) => r.toolCalls);

  const half = Math.ceil(records.length / 2);
  const recent = records.slice(-half);
  const older = records.slice(0, half);
  const trend =
    recent.length === 0 ? 'stable'
    : recent.filter((r) => r.success).length / recent.length > 0.9 ? 'increasing'
    : older.length > 0 && recent.filter((r) => r.success).length / recent.length < 0.5 ? 'declining'
    : 'stable';

  const topErrors = [...new Set(
    records.filter((r) => r.errorMessage).map((r) => r.errorMessage!)
  )].slice(0, 3);

  return {
    totalUses: records.length,
    successRate: records.length > 0 ? successes / records.length : 1,
    avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    avgToolCalls: toolCalls.length > 0 ? Math.round(toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length) : 0,
    lastUsed: records[records.length - 1]?.timestamp ?? null,
    trend,
    topErrors,
  };
}

/** 获取所有 Skill 的统计排行（按使用次数降序）。 */
export function getSkillRankings(): Array<{ skillName: string; stats: ReturnType<typeof getSkillStats> }> {
  ensureUsageHistoryLoaded();
  const names = [...new Set(usageHistory.map((r) => r.skillName))];
  return names
    .map((name) => ({ skillName: name, stats: getSkillStats(name) }))
    .sort((a, b) => b.stats.totalUses - a.stats.totalUses);
}


// ─── 3. 自动优化 ────────────────────────────────────────────────

/**
 * 让 LLM 回顾 Skill 的使用日志，输出改进建议或新版 SKILL.md。
 * config 从调用方注入。
 */
export async function optimizeExistingSkill(
  config: Config,
  skillName: string,
  skillContent: string,
  usageRecords: SkillUsageRecord[],
): Promise<{ improvedContent: string | null; suggestions: string[] }> {
  const client = config.getOttoClient();
  if (!client || usageRecords.length === 0) {
    return { improvedContent: null, suggestions: [] };
  }

  const stats = getSkillStats(skillName);

  const usageSummary = [
    `总使用：${stats.totalUses}次`,
    `成功率：${Math.round(stats.successRate * 100)}%`,
    `平均耗时：${stats.avgDurationMs}ms`,
    `趋势：${stats.trend}`,
    `最近错误：${stats.topErrors.join('; ') || '无'}`,
  ].join(' | ');

  const usageLog = usageRecords
    .slice(-20)
    .map((r) => `[${r.timestamp.slice(0, 16)}] ${r.success ? '✅' : '❌'} ${r.durationMs}ms, ${r.toolCalls} tools${r.errorMessage ? ` | ${r.errorMessage}` : ''}`)
    .join('\n');

  const prompt = [
    '你是一位 Skill 优化专家。分析下面的 Skill 和它的使用数据，提出改进建议。',
    '',
    '## 当前 Skill',
    skillContent.slice(0, 3000),
    '',
    '## 使用统计',
    usageSummary,
    '',
    '## 最近使用日志',
    usageLog,
    '',
    '## 要求',
    '1. 分析成功/失败模式，找出步骤中的瓶颈或冗余',
    '2. 如果使用频率高但成功率低，给出具体改进建议',
    '3. 如果有新的注意事项（从错误中总结），补充进去',
    '4. 输出 JSON：',
    '```json',
    '{',
    '  "improvedContent": "改进后的完整 SKILL.md，如果没有明显改进则填 null",',
    '  "suggestions": ["建议1", "建议2"]',
    '}',
    '```',
    '只输出 JSON，用中文。如果 Skill 表现很好无需改进，improvedContent 填 null，suggestions 可以填一个正面评价。',
  ].join('\n');

  try {
    const chat = await client.createTemporaryChat(
      SceneType.CHAT_CONVERSATION,
      SceneManager.getModelForScene(SceneType.CHAT_CONVERSATION),
      { type: 'sub', agentId: 'SkillOptimizer' },
      { emptySystemPrompt: true },
    );

    const response = await chat.sendMessage(
      { message: prompt, config: { maxOutputTokens: 8192 } },
      `optimize-${skillName}-${Date.now()}`,
      SceneType.CHAT_CONVERSATION,
    );

    const text = getResponseText(response)
      ?.replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    if (!text) return { improvedContent: null, suggestions: [] };

    let parsed: { improvedContent?: string | null; suggestions?: string[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      const fb = text.indexOf('{');
      const lb = text.lastIndexOf('}');
      parsed = JSON.parse(text.slice(fb, lb + 1));
    }

    return {
      improvedContent: parsed.improvedContent || null,
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  } catch {
    return { improvedContent: null, suggestions: [] };
  }
}

/**
 * 批量优化所有 Skill。建议每周跑一次。
 */
export async function optimizeAllSkills(
  config: Config,
  getSkillContent: (skillName: string) => Promise<string | null>,
  onOptimized?: (skillName: string, result: Awaited<ReturnType<typeof optimizeExistingSkill>>) => void,
): Promise<void> {
  const rankings = getSkillRankings().filter((r) => r.stats.totalUses >= 3);
  for (const { skillName } of rankings) {
    const content = await getSkillContent(skillName);
    if (!content) continue;
    const records = usageHistory.filter((r) => r.skillName === skillName);
    const result = await optimizeExistingSkill(config, skillName, content, records);
    if (result.improvedContent || result.suggestions.length > 0) {
      onOptimized?.(skillName, result);
    }
  }
}


// ─── 4. 多项目迁移 ──────────────────────────────────────────────

/**
 * 用 LLM 把 Skill 适配到新项目。
 * 原 Skill 中的具体文件名/路径/项目名会被替换为新项目的对应内容。
 */
export async function adaptSkillForProject(
  config: Config,
  skillName: string,
  skillContent: string,
  newProjectContext: {
    projectRoot: string;
    projectName: string;
    projectDesc: string;
    /** 关键文件映射：旧路径 → 新路径 */
    fileMap?: Record<string, string>;
  },
): Promise<string> {
  const client = config.getOttoClient();
  if (!client) return skillContent; // 无 LLM 就直接返回原文

  const fileMapSection = newProjectContext.fileMap
    ? ['', '## 文件映射（旧 → 新）', ...Object.entries(newProjectContext.fileMap).map(([old, nw]) => `- ${old} → ${nw}`)].join('\n')
    : '';

  const prompt = [
    '你是一位 Skill 迁移专家。请把下面的 Skill 从原项目适配到新项目。',
    '',
    '## 新项目信息',
    `- 项目名：${newProjectContext.projectName}`,
    `- 根目录：${newProjectContext.projectRoot}`,
    `- 描述：${newProjectContext.projectDesc}`,
    fileMapSection,
    '',
    '## 原始 Skill',
    skillContent,
    '',
    '## 要求',
    '1. 把 Skill 中所有旧项目的具体文件名、路径、项目名换成新项目的',
    '2. 如果旧 Skill 引用了新项目不存在的文件类型，改为通用的占位符',
    '3. 保持 Skill 的结构和风格不变',
    '4. 直接输出适配后的 SKILL.md 全文（含 YAML frontmatter），不要任何解释',
  ].join('\n');

  try {
    const chat = await client.createTemporaryChat(
      SceneType.CHAT_CONVERSATION,
      SceneManager.getModelForScene(SceneType.CHAT_CONVERSATION),
      { type: 'sub', agentId: 'SkillAdapter' },
      { emptySystemPrompt: true },
    );

    const response = await chat.sendMessage(
      { message: prompt, config: { maxOutputTokens: 8192 } },
      `adapt-${skillName}-${Date.now()}`,
      SceneType.CHAT_CONVERSATION,
    );

    const text = getResponseText(response);
    return text || skillContent;
  } catch {
    return skillContent;
  }
}
