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
  html?: string;
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

function cleanText(text: string | undefined, fallback = '未记录'): string {
  return (
    (text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`~|[\]()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || fallback
  );
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function categoryLabel(category: string | undefined): string {
  const labels: Record<string, string> = {
    calendar: '日程会议',
    document: '文档材料',
    spreadsheet: '数据表格',
    message: '沟通消息',
    task: '任务推进',
    email: '邮件',
    drive: '云盘文件',
    wiki: '知识库',
    code: '代码',
    shell: '命令执行',
    file: '文件处理',
    web: '网页检索',
    memory: '记忆沉淀',
    other: '其他',
  };
  return labels[category || ''] ?? category ?? '未分类';
}

function summarizeResults(results: StoredWorkLogEntry[]): string {
  if (results.length === 0) {
    return '今天主要完成了一批支撑操作，暂未识别到明确的业务成果。';
  }
  const topics = results
    .map((entry) => cleanText(entry.taskTitle || entry.action, '工作事项'))
    .filter(Boolean);
  if (topics.length === 1) return `今天重点完成了“${topics[0]}”。`;
  return `今天围绕 ${topics
    .slice(0, 3)
    .map((item) => `“${item}”`)
    .join('、')} 等事项形成了 ${results.length} 项工作成果。`;
}

function summarizeProcess(
  entries: StoredWorkLogEntry[],
  results: StoredWorkLogEntry[],
): string[] {
  const tools = entries.filter((entry) => entry.entryType !== 'work_result');
  const failed = entries.filter((entry) => entry.success === false).length;
  const categories = new Map<string, number>();
  for (const entry of entries) {
    const label = categoryLabel(entry.category);
    categories.set(label, (categories.get(label) || 0) + 1);
  }
  const topCategories = [...categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => `${label} ${count} 次`);

  const lines = [
    `共记录 ${entries.length} 条工作日志，其中成果 ${results.length} 项、支撑操作 ${tools.length} 次。`,
  ];
  if (topCategories.length > 0) {
    lines.push(`主要工作类型集中在：${topCategories.join('、')}。`);
  }
  lines.push(
    failed > 0
      ? `有 ${failed} 次操作未成功，后续可优先检查这些任务的前置条件或文件权限。`
      : '当天记录的操作整体执行顺利，未发现失败操作。',
  );
  return lines;
}

function buildReportMarkdown(
  title: string,
  date: string,
  entries: StoredWorkLogEntry[],
  workResults: StoredWorkLogEntry[],
  reportEntries: StoredWorkLogEntry[],
): string {
  const lines = [
    `# ${title}`,
    '',
    `> 日期：${date} · 成果 ${workResults.length} 项 · 支撑操作 ${entries.length - workResults.length} 次`,
    '',
    '## 今日概览',
    '',
    summarizeResults(workResults),
    '',
    ...summarizeProcess(entries, workResults).map((item) => `- ${item}`),
    '',
    '## 重点成果',
    '',
  ];

  reportEntries.slice(0, 8).forEach((entry, index) => {
    lines.push(
      `${index + 1}. **${cleanText(entry.taskTitle || entry.action, '工作事项')}**`,
      `   - 任务：${truncateText(cleanText(entry.userInput, '未记录原始任务'), 160)}`,
      `   - 摘要：${truncateText(cleanText(entry.details, '已完成相关处理'), 260)}`,
    );
  });
  if (reportEntries.length > 8) {
    lines.push(`- 另有 ${reportEntries.length - 8} 项记录已归档在当天工作日志中。`);
  }

  lines.push('', '## 后续事项', '');
  const followUps = extractFollowUps(workResults);
  if (followUps.length === 0) lines.push('- 暂未自动识别到明确待跟进事项。');
  else {
    followUps.forEach((item) =>
      lines.push(`- ${truncateText(cleanText(item), 180)}`),
    );
  }
  lines.push('', '---', '由 Otto 工作日志自动汇总。');
  return lines.join('\n');
}

function buildReportHtml(
  title: string,
  date: string,
  entries: StoredWorkLogEntry[],
  workResults: StoredWorkLogEntry[],
  reportEntries: StoredWorkLogEntry[],
): string {
  const processItems = summarizeProcess(entries, workResults);
  const followUps = extractFollowUps(workResults);
  const resultItems = reportEntries
    .slice(0, 8)
    .map(
      (entry) => `
      <article class="item">
        <h3>${escapeHtml(cleanText(entry.taskTitle || entry.action, '工作事项'))}</h3>
        <p><strong>任务：</strong>${escapeHtml(truncateText(cleanText(entry.userInput, '未记录原始任务'), 180))}</p>
        <p><strong>摘要：</strong>${escapeHtml(truncateText(cleanText(entry.details, '已完成相关处理'), 320))}</p>
      </article>`,
    )
    .join('');
  const followUpItems = (
    followUps.length > 0 ? followUps : ['暂未自动识别到明确待跟进事项。']
  )
    .map((item) => `<li>${escapeHtml(truncateText(cleanText(item), 180))}</li>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #20242a; }
    main { max-width: 880px; margin: 0 auto; padding: 40px 24px 56px; }
    header { border-bottom: 3px solid #5ab6f8; padding-bottom: 18px; margin-bottom: 24px; }
    h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.25; }
    h2 { margin-top: 30px; font-size: 20px; }
    .meta { color: #667085; font-size: 14px; }
    .overview, .item { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 18px 20px; box-shadow: 0 8px 24px rgba(15, 23, 42, .06); }
    .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 18px 0; }
    .stat { background: #eaf6ff; color: #0a4f78; border-radius: 999px; padding: 8px 12px; font-weight: 700; }
    .item { margin: 12px 0; }
    .item h3 { margin: 0 0 10px; font-size: 17px; }
    p, li { line-height: 1.75; }
    ul { padding-left: 22px; }
    footer { margin-top: 32px; color: #8a94a6; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">日期：${escapeHtml(date)}</div>
      <div class="stats">
        <span class="stat">成果 ${workResults.length} 项</span>
        <span class="stat">支撑操作 ${entries.length - workResults.length} 次</span>
        <span class="stat">总记录 ${entries.length} 条</span>
      </div>
    </header>
    <section class="overview">
      <h2>今日概览</h2>
      <p>${escapeHtml(summarizeResults(workResults))}</p>
      <ul>${processItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </section>
    <section>
      <h2>重点成果</h2>
      ${resultItems || '<p>暂无明确成果记录。</p>'}
    </section>
    <section>
      <h2>后续事项</h2>
      <ul>${followUpItems}</ul>
    </section>
    <footer>由 Otto 工作日志自动汇总。</footer>
  </main>
</body>
</html>`;
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
      html: '',
      path: '',
      message: '今天还没有工作记录，暂无可总结的内容。',
    };
  }

  const workResults = entries.filter(
    (entry) => entry.entryType === 'work_result',
  );
  const reportEntries = workResults.length > 0 ? workResults : entries;
  const title = reportTitle(reportEntries[reportEntries.length - 1]);
  const markdown = buildReportMarkdown(
    title,
    date,
    entries,
    workResults,
    reportEntries,
  );
  const html = buildReportHtml(title, date, entries, workResults, reportEntries);
  const summariesDir = path.join(worklogRoot, 'summaries');
  await fs.mkdir(summariesDir, { recursive: true });
  const reportPath = path.join(
    summariesDir,
    `${date}-${safeFileName(title)}.html`,
  );
  await fs.writeFile(reportPath, html, 'utf8');
  return {
    ok: true,
    date,
    title,
    markdown,
    html,
    path: reportPath,
    message: `已生成并保存「${title}」HTML 总结：${reportPath}`,
  };
}
