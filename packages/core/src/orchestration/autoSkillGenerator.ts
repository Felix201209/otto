/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * AutoSkillGenerator — 从工作日志自动生成个人 Skill。
 *
 * 流程：
 * 1. 分析工作日志，发现重复模式（高频操作序列）
 * 2. 用 LLM 将模式提炼为 Skill 指令（SKILL.md 格式）
 * 3. 推送给用户确认（个人决定是否生成）
 * 4. 确认后写入 .otto/skills/<auto-skill-name>/SKILL.md
 * 5. 自动被 Skills 系统加载，成为个人 Agent 工具
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { getWorkLogger, type WorkLogEntry, type DailySummary } from './workLog.js';
import type { Config } from '../config/config.js';

/** 自动生成的 Skill 候选 */
export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  triggerPatterns: string[];
  /** 从日志中提取的重复操作序列 */
  detectedPattern: string;
  /** 出现次数 */
  occurrenceCount: number;
  /** 涉及的日志条目 */
  sampleEntries: WorkLogEntry[];
  /** 生成的 SKILL.md 内容 */
  skillContent: string;
  /** 生成原因（给用户看的解释） */
  reason: string;
  /** 建议的文件路径 */
  filePath: string;
}

/** 模式检测参数 */
interface PatternDetectionOptions {
  /** 最小出现次数（低于此数不生成候选） */
  minOccurrences?: number;
  /** 分析的天数范围 */
  daysToAnalyze?: number;
  /** 最小操作序列长度（几个连续操作才算一个模式） */
  minSequenceLength?: number;
}

const DEFAULT_OPTIONS: PatternDetectionOptions = {
  minOccurrences: 3,
  daysToAnalyze: 14,
  minSequenceLength: 2,
};

/**
 * 从工作日志中检测重复模式。
 *
 * 算法：
 * 1. 读取最近 N 天的日志
 * 2. 按天分段，每天的操作序列提取 N-gram（连续2-3个操作）
 * 3. 跨天对比，找到在多天中都出现的相同序列
 * 4. 按出现频率排序
 */
export async function detectPatterns(
  options: PatternDetectionOptions = {},
): Promise<Array<{ pattern: string; entries: WorkLogEntry[]; count: number }>> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = getWorkLogger();

  // 计算日期范围
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (opts.daysToAnalyze! - 1));

  const dateRange = await logger.readDateRange(
    startDate.toISOString().split('T')[0],
    endDate.toISOString().split('T')[0],
  );

  // 按天提取操作序列
  const dailySequences: Record<string, string[]> = {};
  for (const [date, entries] of Object.entries(dateRange)) {
    if (entries.length === 0) continue;
    // 每天的操作描述序列
    dailySequences[date] = entries.map((e) => e.action);
  }

  // 提取 N-gram（2-gram 和 3-gram）
  const ngramMap: Map<string, { dates: string[]; entries: WorkLogEntry[][] }> = new Map();

  for (const [date, actions] of Object.entries(dailySequences)) {
    const dayEntries = dateRange[date];

    // 2-gram
    for (let i = 0; i < actions.length - 1; i++) {
      const ngram = `${actions[i]} → ${actions[i + 1]}`;
      if (!ngramMap.has(ngram)) {
        ngramMap.set(ngram, { dates: [], entries: [] });
      }
      const entry = ngramMap.get(ngram)!;
      if (!entry.dates.includes(date)) {
        entry.dates.push(date);
        entry.entries.push([dayEntries[i], dayEntries[i + 1]]);
      }
    }

    // 3-gram
    for (let i = 0; i < actions.length - 2; i++) {
      const ngram = `${actions[i]} → ${actions[i + 1]} → ${actions[i + 2]}`;
      if (!ngramMap.has(ngram)) {
        ngramMap.set(ngram, { dates: [], entries: [] });
      }
      const entry = ngramMap.get(ngram)!;
      if (!entry.dates.includes(date)) {
        entry.dates.push(date);
        entry.entries.push([dayEntries[i], dayEntries[i + 1], dayEntries[i + 2]]);
      }
    }
  }

  // 过滤和排序
  const patterns: Array<{ pattern: string; entries: WorkLogEntry[]; count: number }> = [];
  for (const [ngram, data] of ngramMap.entries()) {
    if (data.dates.length >= opts.minOccurrences!) {
      // 取第一次出现的完整日志条目作为样本
      patterns.push({
        pattern: ngram,
        entries: data.entries[0],
        count: data.dates.length,
      });
    }
  }

  // 按出现次数降序
  patterns.sort((a, b) => b.count - a.count);

  return patterns;
}

/**
 * 从检测到的模式生成 Skill 内容（SKILL.md 格式）。
 */
export function generateSkillContent(
  pattern: string,
  entries: WorkLogEntry[],
  count: number,
): string {
  // 从模式中提取操作步骤
  const steps = pattern.split(' → ');

  // 生成 YAML frontmatter
  const skillName = generateSkillName(steps);
  const description = generateDescription(steps, count);

  let content = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n`;
  content += `# ${formatTitle(steps)}\n\n`;
  content += `> 此 Skill 由 Otto 从你的工作日志中自动发现并生成。\n`;
  content += `> 检测到你在过去 ${count} 天中重复执行以下操作序列，已整理为标准流程。\n\n`;

  content += `## 触发场景\n`;
  content += `当用户需要${steps[0]}时，按以下步骤完成完整工作流。\n\n`;

  content += `## 操作步骤\n`;
  for (let i = 0; i < steps.length; i++) {
    content += `${i + 1}. ${steps[i]}\n`;
  }
  content += '\n';

  // 添加从日志中提取的注意事项
  content += `## 注意事项\n`;
  const categories = new Set(entries.map((e) => e.category));
  if (categories.has('calendar')) {
    content += `- 涉及日历操作时，先确认参会人日程空闲\n`;
  }
  if (categories.has('document') || categories.has('spreadsheet')) {
    content += `- 涉及文档/表格操作时，确认目标文件夹和权限\n`;
  }
  if (categories.has('message')) {
    content += `- 涉及消息发送时，先拟稿等用户确认\n`;
  }
  const hasFailures = entries.some((e) => !e.success);
  if (hasFailures) {
    content += `- 历史日志中有失败记录，注意检查前置条件\n`;
  }
  content += `- 每步完成后向用户报告进度\n`;
  content += `- 全部完成后输出汇总\n\n`;

  content += `## 输出\n`;
  content += `完成所有步骤后，提供一份简要汇总：做了什么、结果如何、耗时多久。\n`;

  return content;
}

/**
 * 完整的自动 Skill 生成流程。
 *
 * 1. 检测模式
 * 2. 生成 Skill 内容
 * 3. 返回候选列表（由 UI 层展示给用户确认）
 */
export async function generateSkillCandidates(
  config: Config,
  options: PatternDetectionOptions = {},
): Promise<SkillCandidate[]> {
  const patterns = await detectPatterns(options);
  const candidates: SkillCandidate[] = [];

  for (const { pattern, entries, count } of patterns.slice(0, 5)) { // 最多5个候选
    const skillContent = generateSkillContent(pattern, entries, count);
    const steps = pattern.split(' → ');
    const skillName = generateSkillName(steps);

    const skillsDir = getSkillsDir(config);

    candidates.push({
      id: `auto_skill_${Date.now()}_${candidates.length}`,
      name: skillName,
      description: generateDescription(steps, count),
      triggerPatterns: [steps[0]],
      detectedPattern: pattern,
      occurrenceCount: count,
      sampleEntries: entries,
      skillContent,
      reason: `检测到你在过去 ${count} 天中重复执行"${pattern}"，出现 ${count} 次。生成此 Skill 后，Otto 会在你说"${steps[0]}"时自动按此流程执行。`,
      filePath: path.join(skillsDir, skillName, 'SKILL.md'),
    });
  }

  return candidates;
}

/**
 * 用户确认后，将 Skill 写入磁盘。
 *
 * 写入后 Skills 系统会在下次加载时自动发现它。
 */
export async function confirmAndSaveSkill(candidate: SkillCandidate): Promise<string> {
  const skillDir = path.dirname(candidate.filePath);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(candidate.filePath, candidate.skillContent, 'utf-8');

  console.log(`[AutoSkill] Saved: ${candidate.filePath}`);
  return candidate.filePath;
}

/**
 * 用户拒绝候选（记录拒绝，避免短期内重复推荐）。
 */
export async function rejectSkill(candidate: SkillCandidate): Promise<void> {
  // 记录到拒绝列表，避免短期内重复推荐
  const rejectDir = path.join(require('os').homedir(), '.otto-user', 'memory', 'worklog', 'rejected_skills');
  await fs.mkdir(rejectDir, { recursive: true });
  const rejectFile = path.join(rejectDir, `${candidate.name}.json`);
  await fs.writeFile(rejectFile, JSON.stringify({
    name: candidate.name,
    pattern: candidate.detectedPattern,
    rejectedAt: new Date().toISOString(),
  }), 'utf-8');
}

/**
 * 获取已拒绝的 Skill 列表（避免重复推荐）。
 */
async function getRejectedSkills(): Promise<Set<string>> {
  const rejectDir = path.join(require('os').homedir(), '.otto-user', 'memory', 'worklog', 'rejected_skills');
  try {
    const files = await fs.readdir(rejectDir);
    const rejected: string[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(rejectDir, file), 'utf-8');
        const data = JSON.parse(content);
        rejected.push(data.name);
      }
    }
    return new Set(rejected);
  } catch {
    return new Set();
  }
}

// ============================================================
// 辅助函数
// ============================================================

function getSkillsDir(config: Config): string {
  // 项目级 skills 目录
  const projectRoot = config.getProjectRoot?.() || process.cwd();
  return path.join(projectRoot, '.otto', 'skills');
}

function generateSkillName(steps: string[]): string {
  // 从操作步骤生成 kebab-case 名称
  const firstStep = steps[0] || 'workflow';
  // 提取关键词
  const keywords = firstStep
    .replace(/[：:（）()【】\[\]""'']/g, '')
    .replace(/^(创建|操作|执行|发送|读取|写入|编辑|搜索|查看|查找|操作)\s*/, '')
    .split(/[\s,，、/]+/)
    .filter((s) => s.length > 0)
    .slice(0, 3)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '-'));

  const name = keywords.join('-') || 'auto-workflow';
  return `auto-${name}`;
}

function generateDescription(steps: string[], count: number): string {
  const firstStep = steps[0] || '工作';
  const lastStep = steps[steps.length - 1] || '完成';
  return `从你的工作习惯中自动发现：${firstStep}到${lastStep}的完整流程。在过去${count}天中重复出现。当用户需要${firstStep}时使用。`;
}

function formatTitle(steps: string[]): string {
  return steps.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' → ');
}
