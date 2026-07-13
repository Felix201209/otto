/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 工作日志的纯数据层：不依赖 Electron，便于用真实文件做单元测试。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface StoredWorkLogEntry {
  timestamp: string;
  toolName: string;
  action: string;
  category: string;
  success: boolean;
  durationMs?: number;
  details?: string;
  userId?: string;
  sessionId?: string;
  entryType?: 'tool' | 'work_result';
  taskTitle?: string;
  userInput?: string;
}

export interface WorkLogDisplayEntry {
  time: string;
  category: string;
  action: string;
  success: boolean;
  details?: string;
  entryType: 'tool' | 'work_result';
  taskTitle?: string;
}

export interface WorkLogDay {
  date: string;
  entries: WorkLogDisplayEntry[];
}

export interface WorkLogSummary {
  summary: string;
  date: string;
  totalActions: number;
  workResults: number;
}

export interface WorkLogReportResult {
  ok: boolean;
  date: string;
  title: string;
  markdown: string;
  path: string;
  message: string;
}

/** 与 UI 月历一致的本地日期键。 */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export async function readWorkLogEntries(
  worklogRoot: string,
  date: string,
): Promise<StoredWorkLogEntry[]> {
  try {
    const raw = await fs.readFile(
      path.join(worklogRoot, 'daily', `${date}.jsonl`),
      'utf8',
    );
    const entries: StoredWorkLogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as StoredWorkLogEntry);
      } catch {
        // 单行损坏不应让整天日志变空。
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export async function readRecentWorkLogs(
  worklogRoot: string,
  days = 31,
  now = new Date(),
): Promise<WorkLogDay[]> {
  const dayCount = Math.min(Math.max(Number(days) || 31, 1), 92);
  const out: WorkLogDay[] = [];
  for (let i = 0; i < dayCount; i++) {
    const localDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - i,
      12,
    );
    const date = localDateKey(localDay);
    const entries = await readWorkLogEntries(worklogRoot, date);
    if (entries.length === 0) continue;
    out.push({
      date,
      entries: entries.map((entry) => ({
        time: localTime(entry.timestamp),
        category: entry.category || '未分类',
        action: entry.taskTitle || entry.action || '操作',
        success: entry.success !== false,
        details: entry.details,
        entryType: entry.entryType === 'work_result' ? 'work_result' : 'tool',
        taskTitle: entry.taskTitle,
      })),
    });
  }
  return out;
}

export function summarizeWorkLog(
  date: string,
  entries: StoredWorkLogEntry[],
): WorkLogSummary {
  if (entries.length === 0) {
    return {
      summary: '今天还没有工作记录。完成一轮对话后，最终成果会自动出现在这里。',
      date,
      totalActions: 0,
      workResults: 0,
    };
  }

  const workResults = entries.filter(
    (entry) => entry.entryType === 'work_result',
  );
  const tools = entries.filter((entry) => entry.entryType !== 'work_result');
  const successful = entries.filter((entry) => entry.success !== false).length;
  const failed = entries.length - successful;
  const categoryCounts = new Map<string, number>();
  for (const entry of entries) {
    const category = entry.category || '未分类';
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
  }

  const lines = [
    `今日工作日志 (${date})`,
    '',
    `工作成果：${workResults.length} 项`,
    `支撑操作：${tools.length} 次`,
    `成功：${successful}  失败：${failed}`,
  ];
  if (workResults.length > 0) {
    lines.push('', '成果一览：');
    workResults.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.taskTitle || entry.action}`);
    });
  }
  lines.push(
    '',
    `分类：${[...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${category}:${count}`)
      .join(' | ')}`,
  );
  return {
    summary: lines.join('\n'),
    date,
    totalActions: entries.length,
    workResults: workResults.length,
  };
}

function reportTitle(entry: StoredWorkLogEntry | undefined): string {
  const raw = (entry?.taskTitle || entry?.action || '当日工作')
    .trim()
    .replace(/^完成[：:]?\s*/, '');
  if (raw.endsWith('报告')) return raw;
  if (raw.includes('调研')) return `${raw}报告`;
  return `${raw}工作报告`;
}

function markdownSafe(text: string | undefined): string {
  return (text || '').trim() || '未记录';
}

function extractFollowUps(results: StoredWorkLogEntry[]): string[] {
  const candidates = results.flatMap((entry) =>
    (entry.details || '')
      .split('\n')
      .map((line) => line.replace(/^[-*\d.、\s]+/, '').trim())
      .filter((line) => /待跟进|下一步|后续|TODO|未完成/i.test(line)),
  );
  return [...new Set(candidates)].slice(0, 8);
}

function safeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export async function generateAndSaveWorkReport(
  worklogRoot: string,
  date: string,
): Promise<WorkLogReportResult> {
  const entries = await readWorkLogEntries(worklogRoot, date);
  if (entries.length === 0) {
    return {
      ok: false,
      date,
      title: '',
      markdown: '',
      path: '',
      message: '今天还没有工作记录，暂无可总结的内容。',
    };
  }

  const workResults = entries.filter(
    (entry) => entry.entryType === 'work_result',
  );
  const reportEntries = workResults.length > 0 ? workResults : entries;
  const title = reportTitle(reportEntries[reportEntries.length - 1]);
  const lines = [
    `# ${title}`,
    '',
    `> 日期：${date} · 成果 ${workResults.length} 项 · 支撑操作 ${entries.length - workResults.length} 次`,
    '',
    '## 工作成果',
    '',
  ];

  reportEntries.forEach((entry, index) => {
    lines.push(
      `### ${index + 1}. ${entry.taskTitle || entry.action || '工作事项'}`,
      '',
    );
    if (entry.userInput)
      lines.push(`- **任务：** ${markdownSafe(entry.userInput)}`);
    lines.push(`- **结果：** ${markdownSafe(entry.details)}`, '');
  });

  lines.push('## 待跟进事项', '');
  const followUps = extractFollowUps(workResults);
  if (followUps.length === 0) lines.push('- 暂无自动识别的待跟进事项。');
  else followUps.forEach((item) => lines.push(`- ${item}`));
  lines.push('', '---', '由 Otto 工作日志自动汇总。');

  const markdown = lines.join('\n');
  const summariesDir = path.join(worklogRoot, 'summaries');
  await fs.mkdir(summariesDir, { recursive: true });
  const reportPath = path.join(
    summariesDir,
    `${date}-${safeFileName(title)}.md`,
  );
  await fs.writeFile(reportPath, markdown, 'utf8');
  return {
    ok: true,
    date,
    title,
    markdown,
    path: reportPath,
    message: `已生成并保存「${title}」：${reportPath}`,
  };
}
