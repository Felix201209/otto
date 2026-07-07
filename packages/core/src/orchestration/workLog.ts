/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * WorkLog — 员工工作日志自动记录系统。
 *
 * 三个能力：
 * 1. 自动记录：监听 AfterTool 事件，每次工具调用后自动追加日志
 * 2. 每日汇总：下班前自动推送"今日工作汇总"到飞书
 * 3. 周报生成：自动生成周报并对比上周趋势
 *
 * 日志存储：~/.otto-user/memory/worklog/
 *   ├── daily/<date>.jsonl     — 每日操作流水（JSONL 格式，每行一条）
 *   ├── summaries/<date>.md    — 每日汇总
 *   └── weekly/<week>.md       — 周报
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

/** 工作日志根目录 */
const WORKLOG_DIR = path.join(homedir(), '.otto-user', 'memory', 'worklog');
const DAILY_DIR = path.join(WORKLOG_DIR, 'daily');
const SUMMARIES_DIR = path.join(WORKLOG_DIR, 'summaries');
const WEEKLY_DIR = path.join(WORKLOG_DIR, 'weekly');

/** 单条日志记录 */
export interface WorkLogEntry {
  timestamp: string;
  toolName: string;
  action: string;          // 人类可读的操作描述
  category: LogCategory;   // 操作分类
  success: boolean;
  durationMs?: number;
  details?: string;        // 操作详情摘要
  userId?: string;
  sessionId?: string;
}

/** 日志分类 */
export type LogCategory =
  | 'calendar'    // 日历/会议
  | 'document'    // 文档创建/编辑
  | 'spreadsheet' // 表格
  | 'message'     // 消息/沟通
  | 'task'        // 任务
  | 'email'       // 邮件
  | 'drive'       // 云盘
  | 'wiki'        // 知识库
  | 'code'        // 代码操作
  | 'shell'       // 命令执行
  | 'file'        // 文件操作
  | 'web'         // 网络操作
  | 'memory'      // 记忆操作
  | 'other';      // 其他

/** 每日汇总 */
export interface DailySummary {
  date: string;
  totalActions: number;
  byCategory: Record<string, number>;
  byHour: Record<string, number>;
  firstAction: string;
  lastAction: string;
  totalDurationMs: number;
  topActions: Array<{ action: string; count: number }>;
  highlights: string[];   // 重要操作摘要
  errors: number;
}

/** 周报 */
export interface WeeklyReport {
  weekStart: string;
  weekEnd: string;
  totalActions: number;
  dailyAverages: { date: string; count: number }[];
  byCategory: Record<string, number>;
  topActions: Array<{ action: string; count: number }>;
  comparisonToLastWeek: {
    actionDelta: number;
    categoryChanges: Record<string, number>;
  };
  highlights: string[];
  busiestDay: { date: string; count: number };
  quietestDay: { date: string; count: number };
}

/**
 * 工作日志记录器。
 */
export class WorkLogger {
  private initialized = false;

  /** 确保目录存在 */
  private async ensureDirs(): Promise<void> {
    if (this.initialized) return;
    for (const dir of [WORKLOG_DIR, DAILY_DIR, SUMMARIES_DIR, WEEKLY_DIR]) {
      await fs.mkdir(dir, { recursive: true }).catch(() => {});
    }
    this.initialized = true;
  }

  /**
   * 记录一条工作日志。
   * 由 AfterTool Hook 调用。
   */
  async log(entry: Omit<WorkLogEntry, 'timestamp'>): Promise<void> {
    await this.ensureDirs();

    const fullEntry: WorkLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    const date = fullEntry.timestamp.split('T')[0];
    const filePath = path.join(DAILY_DIR, `${date}.jsonl`);
    const line = JSON.stringify(fullEntry) + '\n';

    await fs.appendFile(filePath, line, 'utf-8').catch((err) => {
      console.warn(`[WorkLog] Failed to write log: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * 读取某天的所有日志。
   */
  async readDay(date: string): Promise<WorkLogEntry[]> {
    const filePath = path.join(DAILY_DIR, `${date}.jsonl`);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as WorkLogEntry);
    } catch {
      return [];
    }
  }

  /**
   * 读取多天的日志（用于周报）。
   */
  async readDateRange(startDate: string, endDate: string): Promise<Record<string, WorkLogEntry[]>> {
    const result: Record<string, WorkLogEntry[]> = {};
    const current = new Date(startDate);
    const end = new Date(endDate);

    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      result[dateStr] = await this.readDay(dateStr);
      current.setDate(current.getDate() + 1);
    }

    return result;
  }

  /**
   * 生成每日汇总。
   */
  async generateDailySummary(date: string): Promise<DailySummary> {
    const entries = await this.readDay(date);

    if (entries.length === 0) {
      return {
        date,
        totalActions: 0,
        byCategory: {},
        byHour: {},
        firstAction: '',
        lastAction: '',
        totalDurationMs: 0,
        topActions: [],
        highlights: [],
        errors: 0,
      };
    }

    const byCategory: Record<string, number> = {};
    const byHour: Record<string, number> = {};
    const actionCounts: Record<string, number> = {};
    const highlights: string[] = [];
    let totalDurationMs = 0;
    let errors = 0;

    for (const entry of entries) {
      // 按分类统计
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;

      // 按小时统计
      const hour = new Date(entry.timestamp).getHours().toString().padStart(2, '0');
      byHour[hour] = (byHour[hour] || 0) + 1;

      // 按操作统计
      const actionKey = entry.action;
      actionCounts[actionKey] = (actionCounts[actionKey] || 0) + 1;

      // 耗时
      if (entry.durationMs) {
        totalDurationMs += entry.durationMs;
      }

      // 错误统计
      if (!entry.success) {
        errors++;
      }

      // 重要操作（非记忆/文件类）
      if (['calendar', 'document', 'spreadsheet', 'message', 'task', 'email'].includes(entry.category) && entry.success) {
        highlights.push(entry.action);
      }
    }

    // Top 操作
    const topActions = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }));

    const summary: DailySummary = {
      date,
      totalActions: entries.length,
      byCategory,
      byHour,
      firstAction: entries[0].timestamp,
      lastAction: entries[entries.length - 1].timestamp,
      totalDurationMs,
      topActions,
      highlights: highlights.slice(0, 20),
      errors,
    };

    // 保存汇总
    const summaryPath = path.join(SUMMARIES_DIR, `${date}.md`);
    const summaryText = this.formatDailySummary(summary);
    await fs.writeFile(summaryPath, summaryText, 'utf-8').catch(() => {});

    return summary;
  }

  /**
   * 生成周报。
   */
  async generateWeeklyReport(weekStart: string): Promise<WeeklyReport> {
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // 本周数据
    const thisWeekData = await this.readDateRange(weekStart, weekEndStr);
    const thisWeekEntries = Object.values(thisWeekData).flat();

    // 上周数据（用于对比）
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart);
    lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
    const lastWeekData = await this.readDateRange(
      lastWeekStart.toISOString().split('T')[0],
      lastWeekEnd.toISOString().split('T')[0],
    );
    const lastWeekEntries = Object.values(lastWeekData).flat();

    // 统计
    const byCategory: Record<string, number> = {};
    const actionCounts: Record<string, number> = {};
    const dailyAverages: { date: string; count: number }[] = [];
    let busiestDay = { date: '', count: 0 };
    let quietestDay = { date: '', count: Infinity };

    for (const [date, entries] of Object.entries(thisWeekData)) {
      dailyAverages.push({ date, count: entries.length });
      if (entries.length > busiestDay.count) {
        busiestDay = { date, count: entries.length };
      }
      if (entries.length < quietestDay.count) {
        quietestDay = { date, count: entries.length };
      }
    }

    if (quietestDay.count === Infinity) {
      quietestDay = { date: weekStart, count: 0 };
    }

    for (const entry of thisWeekEntries) {
      byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
      actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
    }

    // 上周分类对比
    const lastByCategory: Record<string, number> = {};
    for (const entry of lastWeekEntries) {
      lastByCategory[entry.category] = (lastByCategory[entry.category] || 0) + 1;
    }
    const categoryChanges: Record<string, number> = {};
    for (const cat of new Set([...Object.keys(byCategory), ...Object.keys(lastByCategory)])) {
      categoryChanges[cat] = (byCategory[cat] || 0) - (lastByCategory[cat] || 0);
    }

    const topActions = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([action, count]) => ({ action, count }));

    const highlights = thisWeekEntries
      .filter((e) => ['calendar', 'document', 'spreadsheet', 'message', 'task', 'email'].includes(e.category) && e.success)
      .slice(-30)
      .map((e) => e.action);

    const report: WeeklyReport = {
      weekStart,
      weekEnd: weekEndStr,
      totalActions: thisWeekEntries.length,
      dailyAverages,
      byCategory,
      topActions,
      comparisonToLastWeek: {
        actionDelta: thisWeekEntries.length - lastWeekEntries.length,
        categoryChanges,
      },
      highlights,
      busiestDay,
      quietestDay,
    };

    // 保存周报
    const weekKey = weekStart.replace(/-/g, '');
    const reportPath = path.join(WEEKLY_DIR, `week_${weekKey}.md`);
    const reportText = this.formatWeeklyReport(report);
    await fs.writeFile(reportPath, reportText, 'utf-8').catch(() => {});

    return report;
  }

  /**
   * 格式化每日汇总为可读文本（用于飞书卡片推送）。
   */
  formatDailySummary(summary: DailySummary): string {
    const lines: string[] = [];
    lines.push(`# 工作日志 — ${summary.date}`);
    lines.push('');
    lines.push(`## 概览`);
    lines.push(`- 总操作数：${summary.totalActions}`);
    lines.push(`- 工作时长：约 ${(summary.totalDurationMs / 60000).toFixed(1)} 分钟`);
    lines.push(`- 首次操作：${summary.firstAction || '—'}`);
    lines.push(`- 最后操作：${summary.lastAction || '—'}`);
    lines.push(`- 失败操作：${summary.errors}`);
    lines.push('');

    if (Object.keys(summary.byCategory).length > 0) {
      lines.push('## 按类别');
      const sortedCats = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
      for (const [cat, count] of sortedCats) {
        lines.push(`- ${cat}: ${count} 次`);
      }
      lines.push('');
    }

    if (summary.topActions.length > 0) {
      lines.push('## 高频操作 Top 10');
      for (const { action, count } of summary.topActions) {
        lines.push(`- ${action}: ${count} 次`);
      }
      lines.push('');
    }

    if (summary.highlights.length > 0) {
      lines.push('## 今日工作要点');
      for (const h of summary.highlights.slice(0, 10)) {
        lines.push(`- ${h}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 格式化每日汇总为飞书 CardKit 卡片内容。
   */
  formatDailySummaryForFeishu(summary: DailySummary): string {
    if (summary.totalActions === 0) {
      return `今天还没有操作记录。`;
    }

    const duration = (summary.totalDurationMs / 60000).toFixed(1);
    const cats = Object.entries(summary.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `${cat}: ${count}`)
      .join(' · ');

    const top3 = summary.topActions.slice(0, 3)
      .map((a, i) => `${i + 1}. ${a.action} (${a.count}次)`)
      .join('\n');

    return `📋 今日工作汇总 (${summary.date})

📊 总操作：${summary.totalActions} 次
⏱ 工作时长：约 ${duration} 分钟
📂 分类：${cats}
✅ 成功：${summary.totalActions - summary.errors}  ❌ 失败：${summary.errors}

🔥 高频操作：
${top3}`;
  }

  /**
   * 格式化周报为可读文本。
   */
  formatWeeklyReport(report: WeeklyReport): string {
    const lines: string[] = [];
    lines.push(`# 周报 — ${report.weekStart} 至 ${report.weekEnd}`);
    lines.push('');
    lines.push('## 本周概览');
    lines.push(`- 总操作数：${report.totalActions}`);
    const delta = report.comparisonToLastWeek.actionDelta;
    lines.push(`- 较上周：${delta > 0 ? '+' : ''}${delta}（${delta > 0 ? '增加' : delta < 0 ? '减少' : '持平'}）`);
    lines.push(`- 最忙的一天：${report.busiestDay.date}（${report.busiestDay.count} 次）`);
    lines.push(`- 最闲的一天：${report.quietestDay.date}（${report.quietestDay.count} 次）`);
    lines.push('');

    lines.push('## 每日明细');
    for (const { date, count } of report.dailyAverages) {
      const bar = '█'.repeat(Math.min(Math.ceil(count / 5), 20));
      lines.push(`${date} ${bar} ${count}`);
    }
    lines.push('');

    if (Object.keys(report.byCategory).length > 0) {
      lines.push('## 按类别');
      const sortedCats = Object.entries(report.byCategory).sort((a, b) => b[1] - a[1]);
      for (const [cat, count] of sortedCats) {
        const change = report.comparisonToLastWeek.categoryChanges[cat] || 0;
        const changeStr = change > 0 ? ` (+${change})` : change < 0 ? ` (${change})` : '';
        lines.push(`- ${cat}: ${count} 次${changeStr}`);
      }
      lines.push('');
    }

    if (report.topActions.length > 0) {
      lines.push('## 高频操作 Top 15');
      for (const { action, count } of report.topActions) {
        lines.push(`- ${action}: ${count} 次`);
      }
    }

    return lines.join('\n');
  }
}

/**
 * 从工具名和输入推断操作分类。
 */
export function inferCategory(toolName: string, toolInput: Record<string, unknown>): LogCategory {
  const name = toolName.toLowerCase();
  const input = JSON.stringify(toolInput).toLowerCase();

  // 飞书工具
  if (name.includes('calendar') || name.includes('agenda') || input.includes('calendar')) return 'calendar';
  if (name.includes('doc') || name.includes('document')) return 'document';
  if (name.includes('sheet') || name.includes('spreadsheet') || name.includes('base')) return 'spreadsheet';
  if (name.includes('message') || name.includes('chat') || name.includes('im')) return 'message';
  if (name.includes('task') || name.includes('todo')) return 'task';
  if (name.includes('mail') || name.includes('email')) return 'email';
  if (name.includes('drive') || name.includes('file') && input.includes('upload')) return 'drive';
  if (name.includes('wiki') || name.includes('knowledge')) return 'wiki';

  // 开发工具
  if (name.includes('shell') || name.includes('run_shell')) return 'shell';
  if (name.includes('read_file') || name.includes('write_file') || name.includes('edit') || name.includes('replace')) return 'file';
  if (name.includes('grep') || name.includes('glob') || name.includes('search')) return 'code';
  if (name.includes('web') || name.includes('fetch')) return 'web';
  if (name.includes('memory') || name.includes('save_memory')) return 'memory';

  return 'other';
}

/**
 * 从工具名和输入生成人类可读的操作描述。
 */
export function describeAction(toolName: string, toolInput: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  const input = toolInput as Record<string, any>;

  // 飞书操作
  if (name.includes('calendar')) {
    if (name.includes('create') || name.includes('agenda') && input.command?.includes('create')) return '创建日历事件';
    if (name.includes('find') || name.includes('freebusy')) return '查询空闲时间';
    if (name.includes('room')) return '查找会议室';
    return '操作日历';
  }
  if (name.includes('doc')) {
    if (name.includes('create')) return `创建文档: ${input.title || input.content?.substring(0, 30) || ''}`;
    if (name.includes('fetch') || name.includes('read')) return '读取文档';
    if (name.includes('update')) return '更新文档';
    if (name.includes('search')) return '搜索文档';
    return '操作文档';
  }
  if (name.includes('sheet') || name.includes('base')) {
    if (name.includes('create')) return '创建表格';
    if (name.includes('write') || name.includes('append')) return '写入表格数据';
    if (name.includes('read')) return '读取表格';
    return '操作表格';
  }
  if (name.includes('message') || name.includes('chat')) {
    if (name.includes('send')) return `发送消息: ${(input.content || input.text || '').substring(0, 30)}`;
    if (name.includes('search')) return '搜索消息';
    if (name.includes('list')) return '查看聊天列表';
    return '操作消息';
  }
  if (name.includes('task')) {
    if (name.includes('create')) return `创建任务: ${input.summary || ''}`;
    if (name.includes('complete')) return '完成任务';
    if (name.includes('search') || name.includes('list')) return '查看任务';
    return '操作任务';
  }
  if (name.includes('mail')) {
    if (name.includes('send')) return `发送邮件: ${input.subject || ''}`;
    if (name.includes('reply')) return '回复邮件';
    if (name.includes('read') || name.includes('message')) return '阅读邮件';
    return '操作邮件';
  }

  // 开发操作
  if (name.includes('shell')) return `执行命令: ${(input.command || '').substring(0, 50)}`;
  if (name.includes('read_file')) return `读取文件: ${(input.absolute_path || input.path || '').split(/[\\/]/).pop() || ''}`;
  if (name.includes('write_file')) return `写入文件: ${(input.absolute_path || input.file_path || '').split(/[\\/]/).pop() || ''}`;
  if (name.includes('replace')) return `编辑文件: ${(input.file_path || '').split(/[\\/]/).pop() || ''}`;
  if (name.includes('grep')) return `搜索代码: ${input.pattern || ''}`;
  if (name.includes('glob')) return `查找文件: ${input.pattern || ''}`;
  if (name.includes('web_fetch')) return `抓取网页: ${(input.url || '').substring(0, 50)}`;
  if (name.includes('web_search')) return `网络搜索: ${input.query || ''}`;
  if (name.includes('memory')) return `保存记忆: ${(input.fact || '').substring(0, 50)}`;

  return toolName;
}

/**
 * 全局单例。
 */
let globalWorkLogger: WorkLogger | null = null;

export function getWorkLogger(): WorkLogger {
  if (!globalWorkLogger) {
    globalWorkLogger = new WorkLogger();
  }
  return globalWorkLogger;
}
