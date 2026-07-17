/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * AutoSkillGenerator — 从工作日志自动生成个人 Skill。
 *
 * 流程：
 * 1. 分析工作日志，发现重复模式（高频操作序列）
 * 2. 用 LLM 将模式提炼为 Skill 指令（SKILL.md 格式）
 * 3. 推送给用户确认（个人决定是否生成）
 * 4. 确认后写入 ~/.otto-user/skills/<auto-skill-name>/SKILL.md
 * 5. 自动被 Skills 系统加载，成为个人 Agent 工具
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'os';
import { getWorkLogger, type WorkLogEntry } from './workLog.js';
import type { Config } from '../config/config.js';
import { SceneType, SceneManager } from '../core/sceneManager.js';
import { getResponseText } from '../utils/partUtils.js';

/** 飞书通知接口（用于检测到候选时推送给用户） */
export interface AutoSkillFeishuNotifier {
  /** 推送 Skill 候选通知给用户 */
  notifyCandidate(userId: string, candidates: SkillCandidate[]): Promise<void>;
}

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
export interface PatternDetectionOptions {
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
 * 自动 Skill 的用户数据根目录。测试/企业隔离可通过 OTTO_USER_DIR 重定向，
 * 绝不再默认写入当前项目。
 */
export function resolveAutoSkillUserDir(): string {
  const configured = process.env['OTTO_USER_DIR']?.trim();
  if (configured) return configured;
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) {
    return path.join(tmpdir(), 'otto-auto-skill-tests', String(process.pid));
  }
  return path.join(homedir(), '.otto-user');
}

/** 用户级 Skill 安装目录（与 SkillLoader 的 USER_GLOBAL 来源一致）。 */
export function resolveAutoSkillSkillsDir(): string {
  return path.join(resolveAutoSkillUserDir(), 'skills');
}

function pendingCandidatesPath(): string {
  return path.join(
    resolveAutoSkillUserDir(),
    'memory',
    'worklog',
    'pending_skills.json',
  );
}

function rejectedSkillsDir(): string {
  return path.join(
    resolveAutoSkillUserDir(),
    'memory',
    'worklog',
    'rejected_skills',
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

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
/** 旧版模板生成（LLM 不可用时的回退）。 */
export function generateLegacySkillContent(
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
 * 1. N-gram 检测模式（快速初筛）
 * 2. 调 LLM 对原始日志做语义分组与模式提炼
 * 3. LLM 生成有意义的 SKILL.md 内容
 * 4. 返回候选列表（由 UI 层展示给用户确认）
 *
 * LLM 失败时自动回退为旧的模板模式，确保 scanner 不崩溃。
 */
export async function generateSkillCandidates(
  config: Config,
  options: PatternDetectionOptions = {},
): Promise<SkillCandidate[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const logger = getWorkLogger();

  // 读取原始日志
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (opts.daysToAnalyze! - 1));

  const dateRange = await logger.readDateRange(
    startDate.toISOString().split('T')[0],
    endDate.toISOString().split('T')[0],
  );

  // 汇总所有日志条目，按日期排序
  const allEntries: Array<{ date: string; entry: WorkLogEntry }> = [];
  for (const [date, entries] of Object.entries(dateRange)) {
    for (const entry of entries) {
      if (entry.success && entry.entryType !== 'work_result') {
        allEntries.push({ date, entry });
      }
    }
  }

  // N-gram 预筛：至少检出基础模式才继续（纯随机操作不调 LLM）
  const patterns = await detectPatterns(options);
  if (patterns.length < opts.minOccurrences!) {
    return [];
  }

  const rejected = await getRejectedSkills();
  const skillsDir = getSkillsDir(config);

  // ── 调 LLM 做语义分析 ──────────────────────────────────────
  try {
    const llmCandidates = await callLLMForSkillCandidates(
      config,
      allEntries,
      patterns.slice(0, 10),
      rejected,
      skillsDir,
    );
    if (llmCandidates.length > 0) return llmCandidates;
  } catch (err) {
    console.warn(
      `[AutoSkill] LLM analysis failed, falling back to template: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── 回退：旧模板方式 ──────────────────────────────────────
  const candidates: SkillCandidate[] = [];
  for (const { pattern, entries, count } of patterns.slice(0, 5)) {
    const skillContent = generateLegacySkillContent(pattern, entries, count);
    const steps = pattern.split(' → ');
    const skillName = generateSkillName(steps);
    const filePath = path.join(skillsDir, skillName, 'SKILL.md');
    if (rejected.has(skillName) || await fileExists(filePath)) continue;
    candidates.push({
      id: `auto_skill_${createHash('sha256').update(pattern).digest('hex').slice(0, 16)}`,
      name: skillName,
      description: generateDescription(steps, count),
      triggerPatterns: [steps[0]],
      detectedPattern: pattern,
      occurrenceCount: count,
      sampleEntries: entries,
      skillContent,
      reason: `检测到你在过去 ${count} 天中重复执行"${pattern}"，出现 ${count} 次。生成此 Skill 后，Otto 会在你说"${steps[0]}"时自动按此流程执行。`,
      filePath,
    });
  }
  return candidates;
}

// ── 日志预分析（给 LLM 喂结构化的质量数据，而不是扔原始日志让它猜）──

interface PatternAnalytics {
  ngramKey: string;
  /** 跨多少天出现 */
  daysSeen: number;
  /** 总出现次数 */
  totalOps: number;
  /** 近 3 天出现次数（抓近期趋势） */
  recentOps: number;
  /** 趋势方向 */
  trend: 'accelerating' | 'stable' | 'declining' | 'sporadic';
  /** 成功率 */
  successRate: number;
  /** 主要发生的时段 */
  peakHour: string;
  /** 涉及的类别 */
  categories: string[];
  /** 平均耗时（ms） */
  avgDurationMs: number;
  /** 综合质量分 0-100 */
  qualityScore: number;
}

/** 分析单个 N-gram模式的深度指标。 */
function analyzePattern(
  ngram: { pattern: string; entries: WorkLogEntry[]; count: number },
  allEntries: Array<{ date: string; entry: WorkLogEntry }>,
  allDates: string[],
): PatternAnalytics {
  const ops = allEntries.filter(({ entry }) => {
    const actions = ngram.pattern.split(' → ');
    return actions.some((a) => entry.action.includes(a.trim().split(':')[0]?.slice(0, 20) ?? a.trim().slice(0, 20)));
  });

  const dates = new Set(ops.map((o) => o.date));
  const totalOps = ops.length;
  const sortedDates = [...dates].sort();

  // 近 3 天
  const recentDays = new Set(allDates.slice(-3));
  const recentOps = ops.filter((o) => recentDays.has(o.date)).length;

  // 趋势
  const half = Math.ceil(sortedDates.length / 2);
  const firstHalf = sortedDates.slice(0, half).length;
  const secondHalf = sortedDates.slice(half).length;
  const trend: PatternAnalytics['trend'] =
    totalOps < 3
      ? 'sporadic'
      : secondHalf > firstHalf * 1.5
        ? 'accelerating'
        : firstHalf > secondHalf * 1.5
          ? 'declining'
          : 'stable';

  // 成功率
  const successes = ops.filter((o) => o.entry.success).length;
  const successRate = totalOps > 0 ? successes / totalOps : 1;

  // 高峰时段
  const hourBuckets: Record<string, number> = {};
  for (const op of ops) {
    const h = new Date(op.entry.timestamp).getHours();
    const key = `${String(h).padStart(2, '0')}:00`;
    hourBuckets[key] = (hourBuckets[key] || 0) + 1;
  }
  const peakHour = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

  // 类别
  const categories = [...new Set(ops.map((o) => o.entry.category))];

  // 平均耗时
  const durations = ops.map((o) => o.entry.durationMs).filter((d): d is number => typeof d === 'number' && d > 0);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  // 综合质量分（0-100）
  const frequencyScore = Math.min(40, totalOps * 8); // 0-40
  const consistencyScore = Math.min(20, ngram.count * 5); // 0-20
  const trendScore = trend === 'accelerating' ? 20 : trend === 'stable' ? 15 : trend === 'sporadic' ? 5 : 10;
  const successScore = Math.round(successRate * 20); // 0-20
  const qualityScore = Math.min(100, frequencyScore + consistencyScore + trendScore + successScore);

  return {
    ngramKey: ngram.pattern,
    daysSeen: dates.size,
    totalOps,
    recentOps,
    trend,
    successRate,
    peakHour,
    categories,
    avgDurationMs,
    qualityScore,
  };
}

/** 读取项目 OTTO.md（如果存在）。 */
function readProjectContext(cwd?: string): string {
  try {
    const fsSync = require('fs');
    const dir = cwd ?? process.cwd();
    const p = require('path').join(dir, 'OTTO.md');
    if (fsSync.existsSync(p)) {
      return fsSync.readFileSync(p, 'utf8').slice(0, 2000);
    }
  } catch { /* not found, ok */ }
  return '';
}

/** 列出已有 Skill名称（用于去重提示 LLM）。 */
function listExistingSkillNames(skillsDir?: string): string[] {
  try {
    const fsSync = require('fs');
    const dir = skillsDir ?? resolveAutoSkillSkillsDir();
    if (!fsSync.existsSync(dir)) return [];
    return fsSync.readdirSync(dir).filter((f: string) => {
      try {
        const stat = fsSync.statSync(require('path').join(dir, f));
        return stat.isDirectory() && !f.startsWith('.');
      } catch { return false; }
    });
  } catch { return []; }
}

/**
 * 调 LLM 分析工作日志，按语义分组提炼 Skill。
 *
 * 升级版：先对日志做预分析（频次趋势、成功率、时段分布、质量分），
 * 然后把结构化的分析结果 + 项目上下文 + 已有 Skill 清单一起喂给 LLM，
 * 让 LLM 产出有深度、可排名、可追溯的 Skill 候选。
 */
async function callLLMForSkillCandidates(
  config: Config,
  allEntries: Array<{ date: string; entry: WorkLogEntry }>,
  ngramPatterns: Array<{ pattern: string; entries: WorkLogEntry[]; count: number }>,
  rejected: Set<string>,
  skillsDir: string,
): Promise<SkillCandidate[]> {
  const client = config.getOttoClient();
  if (!client) throw new Error('LLM client unavailable');

  const allDates = [...new Set(allEntries.map((e) => e.date))].sort();

  // 预分析：为每个 N-gram模式生成质量报告
  const analytics = ngramPatterns
    .slice(0, 10)
    .map((ngram) => analyzePattern(ngram, allEntries, allDates))
    .filter((a) => a.daysSeen >= 2)
    .sort((a, b) => b.qualityScore - a.qualityScore);

  // OTTO.md 项目上下文
  const projectContext = readProjectContext(config.getTargetDir?.() ?? undefined);

  // 已有 Skill 清单
  const existingSkills = listExistingSkillNames(skillsDir);

  // 构建日志摘要（限制总 token）
  const entrySummaries = allEntries
    .slice(-200)
    .map(
      ({ date, entry }) =>
        `[${date}] ${entry.category} | ${entry.action}${entry.details ? ` | ${entry.details.slice(0, 100)}` : ''}${entry.success ? '' : ' ⚠️失败'}`,
    );

  const analyticsSection = analytics.length > 0
    ? [
      '',
      '# 预分析报告（系统自动计算的模式质量指标）',
      '',
      '| 模式 | 天数 | 总次数 | 近3天 | 趋势 | 成功率 | 高峰 | 质量分 |',
      '|------|------|--------|-------|------|--------|------|--------|',
      ...analytics.map((a) => {
        const trendIcon = { accelerating: '📈上升', stable: '➡️稳定', declining: '📉下降', sporadic: '🔀散落' }[a.trend];
        return `| ${a.ngramKey.slice(0, 50)} | ${a.daysSeen}d | ${a.totalOps} | ${a.recentOps} | ${trendIcon} | ${Math.round(a.successRate * 100)}% | ${a.peakHour} | ${a.qualityScore}/100 |`;
      }),
      '',
      `> 质量分综合了频次(0-40)、跨天一致性(0-20)、趋势(0-20)、成功率(0-20)。`,
      `> 优先关注 📈上升 + 高分 的模式。📉下降 的模式可能已不需要。`,
    ].join('\n')
    : '';

  const projectSection = projectContext
    ? ['', '# 项目上下文（来自 OTTO.md）', '```', projectContext, '```'].join('\n')
    : '';

  const existingSection = existingSkills.length > 0
    ? `\n\n# 已有 Skill（避免重复）\n${existingSkills.map((s) => `- ${s}`).join('\n')}\n> 如果新发现的模式可以改进某个已有 Skill，请在 skillMarkdown 里注明"建议替换已有 Skill: xxx"。`
    : '';

  const prompt = [
    '你是 Otto 的工作习惯分析师。以下是用户的深度分析报告，请做语义建模：',
    '',
    '# 任务',
    '1. 重点看**质量分 > 40 且趋势为上升或稳定**的模式',
    '2. 识别语义相同的操作变体（不同文件名/不同参数的同类型操作应归为一类）',
    '3. 结合项目上下文，理解用户在做什么，为每个有价值的模式生成可复用的 Skill',
    '4. 按质量高低排序（最好的放前面），只输出 JSON',
    '',
    projectSection,
    '',
    '# 日志条目（日期 + 类别 + 操作 + 详情）',
    ...entrySummaries,
    '',
    analyticsSection,
    existingSection,
    '',
    '# 输出格式（严格 JSON，不要任何解释）',
    '```json',
    '{',
    '  "skills": [',
    '    {',
    '      "name": "kebab-case 名称，如 auto-code-review",',
    '      "title": "人类可读标题，如 代码审查工作流",',
    '      "description": "一句话描述，如 读取源码、按规范编辑后提交的完整审查流程。成功率 95%，工作日 14-16点执行",',
    '      "triggerHint": "用户什么意图触发，如 帮我审查代码 / review 一下这个 PR",',
    '      "occurrenceNote": "频次 + 趋势说明，如 过去 7 天内出现 6 次，趋势上升。质量分 78",',
    '      "skillMarkdown": "完整的 SKILL.md 正文（Markdown），包含: name/description YAML头、触发场景（2-3个典型例子）、操作步骤（每步简明扼要，标注成功关键前置条件）、注意事项（从失败日志中总结的坑和边界情况）、期望输出格式。中文，简介专业，至少 20 行。"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '硬性要求：',
    '- 只输出 JSON 大括号，不要任何额外文字或代码块标记',
    '- 质量分 < 30 的模式直接跳过，不要生成 Skill',
    '- 与已有 Skill 高度重叠的，在 skillMarkdown 里标注"建议合并到已有 Skill: xxx"',
    '- skillMarkdown 必须包含从失败日志中总结的注意事项（如果有失败记录的话）',
    '- 每步操作必须标注前置条件或输入要求（如"确认目标文件已存在""确认有写入权限"）',
    '- 中文书写，最多 5 个候选',
  ].join('\n');

  const chat = await client.createTemporaryChat(
    SceneType.CHAT_CONVERSATION,
    SceneManager.getModelForScene(SceneType.CHAT_CONVERSATION),
    { type: 'sub', agentId: 'AutoSkillGenerator' },
    { disableSystemPrompt: true },
  );

  const response = await chat.sendMessage(
    { message: prompt, config: { maxOutputTokens: 16384 } },
    `auto-skill-${Date.now()}`,
    SceneType.CHAT_CONVERSATION,
  );

  const text = getResponseText(response);
  if (!text) throw new Error('LLM returned empty response');

  // 解析 JSON（容错）
  let jsonText = text
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: { skills?: Array<{
    name: string;
    title: string;
    description: string;
    triggerHint: string;
    occurrenceNote: string;
    skillMarkdown: string;
  }> };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const firstBrace = jsonText.indexOf('{');
    const lastBrace = jsonText.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
    } else {
      throw new Error('LLM output is not valid JSON');
    }
  }

  if (!Array.isArray(parsed.skills) || parsed.skills.length === 0) {
    return [];
  }

  const candidates: SkillCandidate[] = [];
  for (const s of parsed.skills.slice(0, 5)) {
    const cleanName = s.name?.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'auto-workflow';
    const skillName = cleanName.startsWith('auto-') ? cleanName : `auto-${cleanName}`;
    const filePath = path.join(skillsDir, skillName, 'SKILL.md');

    if (rejected.has(skillName) || await fileExists(filePath)) continue;

    const mdContent = s.skillMarkdown?.trim() || s.description || s.title;
    const fullSkillContent = mdContent.startsWith('---')
      ? mdContent
      : `---\nname: ${skillName}\ndescription: ${s.description || ''}\n---\n\n# ${s.title || skillName}\n\n${mdContent}`;

    candidates.push({
      id: `auto_skill_${createHash('sha256').update(s.name + s.title).digest('hex').slice(0, 16)}`,
      name: skillName,
      description: s.description || s.title || skillName,
      triggerPatterns: s.triggerHint ? [s.triggerHint] : [],
      detectedPattern: s.title || skillName,
      occurrenceCount: parseInt(String(s.occurrenceNote).match(/\d+/)?.[0] || '3', 10),
      sampleEntries: allEntries.slice(0, 5).map((e) => e.entry),
      skillContent: fullSkillContent,
      reason: s.occurrenceNote || `Otto 从你的工作习惯中发现了模式"${s.title || skillName}"`,
      filePath,
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
  const skillsRoot = path.resolve(resolveAutoSkillSkillsDir());
  const safePath = path.resolve(candidate.filePath);
  const relative = path.relative(skillsRoot, safePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('自动 Skill 只能写入用户级 skills 目录');
  }

  const skillDir = path.dirname(safePath);
  await fs.mkdir(skillDir, { recursive: true, mode: 0o700 });
  const tempPath = `${safePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, candidate.skillContent, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, safePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }

  console.log(`[AutoSkill] Saved: ${safePath}`);

  // 记工作日志（标注自动 Skill，与普通操作区分）
  try {
    const logger = getWorkLogger();
    await logger.log({
      toolName: 'auto_skill_confirm',
      action: `[自动Skill] 用户确认生成 Skill "${candidate.name}"（检测到 ${candidate.occurrenceCount} 次重复模式）`,
      category: 'other',
      success: true,
      details: `模式：${candidate.detectedPattern} | 路径：${safePath}`,
    });
  } catch { /* 不影响主流程 */ }

  // 🆕 自动孵化专家：Skill写盘后生成 AgentProfile
  try {
    const { generateProfilePipeline } = await import("./autoSkillProfile.js");
    await generateProfilePipeline([
      { skillName: candidate.name, skillDir, skillContent: candidate.skillContent },
    ]);
  } catch {
    // 专家孵化可选，Skill已就绪即可
  }


  return safePath;
}

/** 读取等待用户确认的候选。损坏/不存在时按空列表处理，不影响 Otto 启动。 */
export async function listPendingSkillCandidates(): Promise<SkillCandidate[]> {
  try {
    const raw = await fs.readFile(pendingCandidatesPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSkillCandidate);
  } catch {
    return [];
  }
}

async function savePendingSkillCandidates(candidates: SkillCandidate[]): Promise<void> {
  await writeJsonAtomic(pendingCandidatesPath(), candidates);
}

async function removePendingSkill(candidateId: string): Promise<void> {
  const candidates = await listPendingSkillCandidates();
  await savePendingSkillCandidates(
    candidates.filter((candidate) => candidate.id !== candidateId),
  );
}

/**
 * 用户从待确认区明确点下确认后才调用；成功后移出待确认区。
 */
export async function confirmPendingSkill(candidateId: string): Promise<string> {
  const candidate = (await listPendingSkillCandidates()).find(
    (item) => item.id === candidateId,
  );
  if (!candidate) throw new Error('自动 Skill 候选不存在或已处理');
  const savedPath = await confirmAndSaveSkill(candidate);
  await removePendingSkill(candidateId);
  return savedPath;
}

/** 用户从待确认区明确拒绝；记录抑制规则后移出待确认区。 */
export async function rejectPendingSkill(candidateId: string): Promise<void> {
  const candidate = (await listPendingSkillCandidates()).find(
    (item) => item.id === candidateId,
  );
  if (!candidate) throw new Error('自动 Skill 候选不存在或已处理');
  await rejectSkill(candidate);
  await removePendingSkill(candidateId);
}

/**
 * 用户拒绝候选（记录拒绝，避免短期内重复推荐）。
 */
export async function rejectSkill(candidate: SkillCandidate): Promise<void> {
  // 记录到拒绝列表，避免短期内重复推荐
  const rejectDir = rejectedSkillsDir();
  await fs.mkdir(rejectDir, { recursive: true });
  const rejectFile = path.join(rejectDir, `${candidate.name}.json`);
  await writeJsonAtomic(rejectFile, {
    name: candidate.name,
    pattern: candidate.detectedPattern,
    rejectedAt: new Date().toISOString(),
  });

  // 记工作日志（标注自动 Skill 拒绝）
  try {
    const logger = getWorkLogger();
    await logger.log({
      toolName: 'auto_skill_reject',
      action: `[自动Skill] 用户拒绝生成 Skill "${candidate.name}"`,
      category: 'other',
      success: true,
      details: `模式：${candidate.detectedPattern}`,
    });
  } catch { /* 不影响主流程 */ }
}

/**
 * 获取已拒绝的 Skill 列表（避免重复推荐）。
 */
async function getRejectedSkills(): Promise<Set<string>> {
  const rejectDir = rejectedSkillsDir();
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
  // 保留 Config 参数以兼容既有调用方；个人自动 Skill 始终属于用户级能力。
  void config;
  return resolveAutoSkillSkillsDir();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isSkillCandidate(value: unknown): value is SkillCandidate {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SkillCandidate>;
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.description === 'string'
    && Array.isArray(item.triggerPatterns)
    && typeof item.detectedPattern === 'string'
    && typeof item.occurrenceCount === 'number'
    && Array.isArray(item.sampleEntries)
    && typeof item.skillContent === 'string'
    && typeof item.reason === 'string'
    && typeof item.filePath === 'string';
}

function generateSkillName(steps: string[]): string {
  // 从操作步骤生成 kebab-case 名称
  const firstStep = steps[0] || 'workflow';
  // 提取关键词
  const keywords = firstStep
    .replace(/[：:（）()【】[\]""'']/g, '')
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

// ============================================================
// 飞书通知器 + 定时扫描
// ============================================================

let globalFeishuNotifier: AutoSkillFeishuNotifier | null = null;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let initialScanTimer: ReturnType<typeof setTimeout> | null = null;
let scanInFlight = false;

// ── 实时触发监视器 ──
let realtimeWatcher: any = null;
export function setRealtimeWatcher(watcher: any): void { realtimeWatcher = watcher; }
export function getRealtimeWatcher(): any { return realtimeWatcher; }

export { AutoSkillRealtimeWatcher, RealtimePatternSummary } from "./autoSkillEnhance.js";


export interface AutoSkillScannerOptions {
  /** 首次扫描延迟；避免与桌面首屏初始化争抢磁盘。 */
  initialDelayMs?: number;
  /** 周期，生产默认 24 小时；测试可缩短。 */
  intervalMs?: number;
  /** 每轮候选原子落盘后通知桌面/飞书刷新；不代表安装。 */
  onCandidatesStaged?: (candidates: SkillCandidate[]) => void | Promise<void>;
}

/** 注入飞书通知器 */
export function setAutoSkillFeishuNotifier(notifier: AutoSkillFeishuNotifier): void {
  globalFeishuNotifier = notifier;
  console.log('[AutoSkill] Feishu notifier injected');
}

/**
 * 执行一次扫描并把结果放进待确认区。这里只保存候选 JSON，绝不会写 SKILL.md；
 * 真正安装必须走 confirmPendingSkill / confirmAndSaveSkill。
 */
export async function scanAndStageSkillCandidates(
  config: Config,
  getUserId: () => string,
): Promise<SkillCandidate[]> {
  const candidates = await generateSkillCandidates(config);
  await savePendingSkillCandidates(candidates);

  if (candidates.length === 0) return candidates;

  if (globalFeishuNotifier) {
    await globalFeishuNotifier.notifyCandidate(getUserId(), candidates);
  }

  // 记工作日志（候选态，不代表已生成 Skill）。
  try {
    const logger = getWorkLogger();
    await logger.log({
      toolName: 'auto_skill_scan',
      action: `[自动Skill] 检测到 ${candidates.length} 个候选模式，等待用户确认`,
      category: 'other',
      success: true,
      details: candidates.map((c) => `${c.name}(${c.occurrenceCount}次)`).join(', '),
    });
  } catch { /* 不影响候选暂存 */ }

  return candidates;
}

/**
 * 启动定时扫描（每天扫描一次工作日志，发现新模式时推送飞书通知）。
 * 由 CLI gateway 或桌面端调用。
 */
export function startAutoSkillScanner(
  config: Config,
  getUserId: () => string,
  options: AutoSkillScannerOptions = {},
): boolean {
  if (scanTimer || initialScanTimer) return false;
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 15_000;

  const scan = async (): Promise<void> => {
    // 慢磁盘/大量日志时不叠加第二轮扫描。
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const candidates = await scanAndStageSkillCandidates(config, getUserId);
      await options.onCandidatesStaged?.(candidates);
    } catch (err) {
      console.warn(`[AutoSkill] Scanner error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      scanInFlight = false;
    }
  };

  initialScanTimer = setTimeout(async () => {
    initialScanTimer = null;
    await scan();
  }, initialDelayMs);
  initialScanTimer.unref?.();

  scanTimer = setInterval(() => void scan(), intervalMs);
  scanTimer.unref?.();
  console.log('[AutoSkill] Scanner started (24h interval)');
  return true;
}

/** 停止定时扫描 */
export function stopAutoSkillScanner(): void {
  if (initialScanTimer) {
    clearTimeout(initialScanTimer);
    initialScanTimer = null;
  }
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  scanInFlight = false;
  console.log('[AutoSkill] Scanner stopped');
}
