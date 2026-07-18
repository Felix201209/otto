/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Proactive Service v2 — 智能主动提醒引擎。
 *
 * 基于工作日志分析 + 行为模式识别：
 * - 昨天提过的任务今天没跟进 → 提醒补漏
 * - 同一任务类别连续3天 → 检测卡住
 * - 本地日程即将开始 → 提前提醒
 * - 每日收盘生成工作洞察
 * - 早晨简报含日程和昨日未完成项
 */

import type { WorkLogEntry } from './workLog.js';
import { formatLocalDate, getWorkLogger } from './workLog.js';

/** 智能洞察：一条从工作日志分析出的可执行提醒 */
export interface WisdomNudge {
  type: 'unresolved' | 'stuck' | 'pattern' | 'suggestion';
  message: string;
  priority: 'low' | 'medium' | 'high';
  /** 关联的日志条目日期 */
  sourceDates: string[];
}

/** 飞书推送接口（由 CLI gateway 注入） */
export interface ProactiveFeishuSender {
  sendCard(userId: string, message: string): Promise<void>;
  sendMessage(userId: string, message: string): Promise<void>;
}

/** 本地通知接口（由 otto-server 注入，无飞书时也能推送） */
export interface ProactiveLocalNotifier {
  notify(message: string, priority: 'low' | 'medium' | 'high', ruleId: string): Promise<void>;
}

export interface CalendarMeetingResult {
  meetingId: string;
  topic: string;
  endTime: string;
  hostUserId: string;
  operatorId: string;
}

export type CalendarCheckerFn = () => Promise<CalendarMeetingResult[]>;

export interface ProactiveRule {
  id: string;
  name: string;
  trigger: {
    type: 'cron' | 'event' | 'pattern' | 'wisdom';
    cron?: string;
    event?: string;
    pattern?: string;
  };
  condition?: (ctx: ProactiveContext) => boolean;
  /** wisdom 类规则：返回 null 表示不触发 */
  generateMessage?: (ctx: ProactiveContext) => Promise<string | null>;
  action: {
    type: 'feishu_card' | 'feishu_message' | 'todo_create' | 'memory_check';
    message: string;
    cardData?: Record<string, unknown>;
    priority: 'low' | 'medium' | 'high';
  };
  enabled: boolean;
  lastTriggered?: string;
  minIntervalHours: number;
}

export interface ProactiveContext {
  userId: string;
  userName: string;
  currentDay: string;
  currentTime: string; // HH:MM
  recentActions: string[];
  pendingTasks: number;
  hasUpcomingMeeting: boolean;
  lastMeetingEnd?: string;
  department?: string;
  role?: string;
}

// ── 内置规则 ───────────────────────────────────────────────────────────

const BUILTIN_RULES: ProactiveRule[] = [
  {
    id: 'morning_briefing',
    name: '晨间简报',
    trigger: { type: 'cron', cron: '0 9 * * 1-5' },
    action: { type: 'feishu_card', message: '', priority: 'low' },
    enabled: true, minIntervalHours: 20,
    generateMessage: async (ctx) => {
      const now = new Date();
      const today = formatLocalDate(now);
      const nudges = await generateWisdomNudges(ctx);

      let msg = '☀️ 早上好！\n';

      // 今日日程
      try {
        const { listLocalSchedules: ls } = await import('../tools/local-schedule.js');
        const schedules = ls(today);
        if (schedules.length > 0) {
          msg += '\n📅 今日日程：\n';
          for (const s of schedules.slice(0, 5)) {
            msg += `  ${formatLocalTime(s.startAt)} ${s.title}\n`;
          }
        } else {
          msg += '\n📅 今日暂无日程安排。\n';
        }
      } catch {
        // 本地日程不可用时仍可继续生成工作日志简报。
      }

      // 昨日未完成洞察
      if (nudges.length > 0) {
        const topNudges = nudges.filter(n => n.priority === 'high' || n.priority === 'medium').slice(0, 3);
        if (topNudges.length > 0) {
          msg += '\n💡 待关注：\n';
          for (const n of topNudges) {
            const icon = n.priority === 'high' ? '⚠️' : '📌';
            msg += `  ${icon} ${n.message}\n`;
          }
        }
      }

      return msg;
    },
  },
  {
    id: 'daily_work_insight',
    name: '每日收盘洞察',
    trigger: { type: 'cron', cron: '0 18 * * 1-5' },
    action: { type: 'feishu_card', message: '', priority: 'medium' },
    enabled: true, minIntervalHours: 20,
    generateMessage: async (ctx) => {
      const nudges = await generateWisdomNudges(ctx);
      const today = formatLocalDate(new Date());
      const logger = getWorkLogger();
      const summary = await logger.generateDailySummary(today);

      if (summary.totalActions === 0 && nudges.length === 0) {
        return null; // 无内容，不推送
      }

      let msg = `📋 今日收盘（${today}）\n`;

      if (summary.totalActions > 0) {
        msg += `\n📊 今日工作：${summary.totalActions} 次操作\n`;
        // Top highlights 摘要
        if (summary.highlights && summary.highlights.length > 0) {
          for (const r of summary.highlights.slice(0, 3)) {
            msg += `  ✅ ${r}\n`;
          }
        }
      }

      if (nudges.length > 0) {
        msg += '\n🔔 智能提醒：\n';
        for (const n of nudges.slice(0, 5)) {
          const icon = n.priority === 'high' ? '⚠️' : n.priority === 'medium' ? '📌' : '💬';
          msg += `  ${icon} ${n.message}\n`;
        }
      }

      return msg;
    },
  },
  {
    id: 'weekly_report_reminder',
    name: '周报提醒',
    trigger: { type: 'cron', cron: '0 16 * * 5' },
    condition: (ctx) => !ctx.recentActions.some(a => a.includes('周报') || a.includes('weekly report')),
    action: {
      type: 'feishu_card',
      message: '今天还没发周报，要我帮你起草吗？',
      priority: 'medium',
    },
    enabled: true, minIntervalHours: 24,
  },
  {
    id: 'meeting_summary_offer',
    name: '会议纪要提议',
    trigger: { type: 'event', event: 'meeting_ended' },
    condition: (ctx) => ctx.lastMeetingEnd !== undefined,
    action: {
      type: 'feishu_card',
      message: '刚结束一个会议，要我把纪要整理成飞书文档发到群里吗？',
      priority: 'high',
    },
    enabled: true, minIntervalHours: 1,
  },
  {
    id: 'idle_reminder',
    name: '空闲提醒',
    trigger: { type: 'pattern', pattern: 'no_action_30min' },
    condition: (ctx) => ctx.pendingTasks > 0,
    action: {
      type: 'feishu_message',
      message: '你有 {pendingTasks} 个待办任务，需要我帮忙处理吗？',
      priority: 'low',
    },
    enabled: true, minIntervalHours: 2,
  },
  {
    id: 'tomorrow_early_schedule',
    name: '明早日程提前提醒',
    trigger: { type: 'cron', cron: '0 20 * * *' },
    action: { type: 'feishu_message', message: '', priority: 'medium' },
    enabled: true, minIntervalHours: 22,
    generateMessage: async () => {
      try {
        const { listLocalSchedules: ls } = await import('../tools/local-schedule.js');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = formatLocalDate(tomorrow);
        const schedules = ls(tomorrowStr);
        const earlySchedules = schedules.filter((s) => {
          const hour = new Date(s.startAt).getHours();
          return hour >= 6 && hour <= 9;
        });
        if (earlySchedules.length === 0) return null;
        const titles = earlySchedules.map((s) => {
          const time = formatLocalTime(s.startAt);
          return `${time} ${s.title}`;
        }).join('；');
        return `📅 明早日程提醒：${titles}。记得早做准备哦。`;
      } catch {
        return null;
      }
    },
  },
  {
    id: 'wisdom_nudge',
    name: '智能工作洞察',
    trigger: { type: 'cron', cron: '0 10,15 * * 1-5' }, // 工作日上午10点和下午3点
    action: { type: 'feishu_card', message: '', priority: 'medium' },
    enabled: true, minIntervalHours: 4,
    generateMessage: async (ctx) => {
      const nudges = await generateWisdomNudges(ctx);
      const urgent = nudges.filter(n => n.priority === 'high');
      if (urgent.length === 0 && nudges.length < 2) return null;

      let msg = '🧠 智能工作洞察\n\n';
      const toShow = [...urgent, ...nudges.filter(n => n.priority !== 'high').slice(0, 3)];
      for (const n of toShow) {
        const icon = n.priority === 'high' ? '⚠️' : n.priority === 'medium' ? '📌' : '💬';
        msg += `${icon} ${n.message}\n`;
      }
      return msg;
    },
  },
];

function formatLocalTime(iso: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function cloneRule(rule: ProactiveRule): ProactiveRule {
  return {
    ...rule,
    trigger: { ...rule.trigger },
    action: { ...rule.action },
  };
}

// ── 智能洞察引擎 ───────────────────────────────────────────────────────

/**
 * 分析最近 N 天的工作日志，生成可执行的智能提醒。
 *
 * 检测维度：
 * - unresolved：昨天提到的关键字今天没出现
 * - stuck：同一类别连续3天出现
 * - pattern：多天重复模式（如"每天早上都会处理邮件"）
 */
async function generateWisdomNudges(_ctx: ProactiveContext): Promise<WisdomNudge[]> {
  const nudges: WisdomNudge[] = [];
  const logger = getWorkLogger();

  // 读取最近7天日志
  const dates: string[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    dates.push(formatLocalDate(d));
  }

  const allEntries: Array<{ date: string; entry: WorkLogEntry }> = [];
  for (const date of dates) {
    const entries = await logger.readDay(date);
    for (const e of entries) {
      allEntries.push({ date, entry: e });
    }
  }

  if (allEntries.length === 0) return nudges;

  const today = dates[6];
  const yesterday = dates[5];

  const todayEntries = allEntries.filter(e => e.date === today);
  const yesterdayEntries = allEntries.filter(e => e.date === yesterday);

  // ── 1) unresolved：昨天出现的关键词今天没出现 ──
  const yesterdayKeywords = extractKeywords(yesterdayEntries);
  const todayKeywords = extractKeywords(todayEntries);

  const droppedKeywords = yesterdayKeywords.filter(
    kw => !todayKeywords.includes(kw) && kw.length >= 2
  );
  if (droppedKeywords.length > 0) {
    nudges.push({
      type: 'unresolved',
      message: `昨天提到「${droppedKeywords.slice(0, 3).join('」「')}」但今天没有跟进记录，需要继续吗？`,
      priority: 'high',
      sourceDates: [yesterday],
    });
  }

  // ── 2) stuck：同一类别连续3天出现 ──
  const categoryByDate = new Map<string, Set<string>>();
  for (const { date, entry } of allEntries) {
    if (!categoryByDate.has(date)) categoryByDate.set(date, new Set());
    categoryByDate.get(date)!.add(entry.category || 'other');
  }

  // 找最近3天都出现的类别
  const last3Dates = dates.slice(-3);
  const persistentCategories: string[] = [];
  for (const cat of ['code', 'shell', 'file', 'document', 'spreadsheet', 'task', 'message', 'debug']) {
    let count = 0;
    for (const d of last3Dates) {
      if (categoryByDate.get(d)?.has(cat)) count++;
    }
    if (count >= 3) persistentCategories.push(cat);
  }
  if (persistentCategories.length > 0) {
    const catNames: Record<string, string> = {
      code: '代码开发', shell: '命令行操作', file: '文件处理',
      document: '文档撰写', spreadsheet: '表格处理', task: '任务管理',
      message: '消息沟通', debug: '调试修复',
    };
    nudges.push({
      type: 'stuck',
      message: `已经连续3天在「${persistentCategories.map(c => catNames[c] || c).join('」「')}」——是卡住了还是接近完成？需要帮忙梳理吗？`,
      priority: 'medium',
      sourceDates: last3Dates,
    });
  }

  // ── 3) pattern：今天与昨天/前天的行为模式对比 ──
  const toolUsageByDate = new Map<string, Map<string, number>>();
  for (const { date, entry } of allEntries) {
    if (!toolUsageByDate.has(date)) toolUsageByDate.set(date, new Map());
    const tmap = toolUsageByDate.get(date)!;
    tmap.set(entry.toolName, (tmap.get(entry.toolName) || 0) + 1);
  }

  // 检查今天是否明显减产
  if (yesterdayEntries.length > 5 && todayEntries.length === 0) {
    nudges.push({
      type: 'suggestion',
      message: '今天似乎还没有开始工作记录，是新项目启动日还是需要我帮忙？',
      priority: 'low',
      sourceDates: [today],
    });
  }

  return nudges;
}

/** 从日志条目中提取关键动作词 */
function extractKeywords(entries: Array<{ date: string; entry: WorkLogEntry }>): string[] {
  const keywords = new Set<string>();
  for (const { entry } of entries) {
    const text = (entry.action || '') + ' ' + (entry.taskTitle || '') + ' ' + (entry.userInput || '');
    // 提取中文关键词（连续2个或以上汉字）
    const chineseWords = text.match(/[\u4e00-\u9fff]{2,}/g);
    if (chineseWords) {
      for (const w of chineseWords) {
        if (w.length >= 2 && w.length <= 8) keywords.add(w);
      }
    }
    // 提取英文关键词（驼峰/下划线/连字符连接的词）
    const englishWords = text.match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g);
    if (englishWords) {
      for (const w of englishWords) {
        if (w.length >= 3 && !/^\d+$/.test(w)) keywords.add(w.toLowerCase());
      }
    }
  }
  return [...keywords];
}

// ── 引擎主体 ───────────────────────────────────────────────────────────

export class ProactiveService {
  private rules: ProactiveRule[] = BUILTIN_RULES.map(cloneRule);
  private actionHistory: Map<string, string[]> = new Map();
  private triggeredToday: Set<string> = new Set();
  private triggeredDate = formatLocalDate(new Date());
  private feishuSender: ProactiveFeishuSender | null = null;
  private localNotifier: ProactiveLocalNotifier | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private calendarChecker: CalendarCheckerFn | null = null;
  private processedMeetings: Set<string> = new Set();
  /** 已提醒过的日程ID集合（防重复） */
  private remindedScheduleIds: Set<string> = new Set();

  setFeishuSender(sender: ProactiveFeishuSender): void {
    this.feishuSender = sender;
    console.log('[ProactiveService] Feishu sender injected');
  }

  setLocalNotifier(notifier: ProactiveLocalNotifier): void {
    this.localNotifier = notifier;
    console.log('[ProactiveService] Local notifier injected');
  }

  setCalendarChecker(checker: CalendarCheckerFn): void {
    this.calendarChecker = checker;
    console.log('[ProactiveService] Calendar checker injected');
  }

  startScheduler(getContext: () => ProactiveContext): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const ctx = getContext();

        const triggered = await this.checkAndTrigger(ctx);
        for (const rule of triggered) {
          await this.executeAndLog(rule, ctx);
        }

        if (this.calendarChecker) {
          try {
            const meetings = await this.calendarChecker();
            for (const m of meetings) {
              if (this.processedMeetings.has(m.meetingId)) continue;
              this.processedMeetings.add(m.meetingId);

              const meetingCtx: ProactiveContext = {
                ...ctx,
                lastMeetingEnd: m.endTime,
              };
              await this.onEvent('meeting_ended', meetingCtx);
            }
            if (this.processedMeetings.size > 200) {
              const entries = [...this.processedMeetings];
              this.processedMeetings = new Set(entries.slice(-100));
            }
          } catch (err) {
            console.warn(`[ProactiveService] Calendar polling error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 3. 会议/日程提前提醒：检查接下来 10 分钟内开始的日程
        try {
          const { listLocalSchedules: ls } = await import('../tools/local-schedule.js');
          const now = new Date();
          const today = formatLocalDate(now);
          const schedules = ls(today);
          const nowMs = now.getTime();
          const advanceMs = 10 * 60 * 1000; // 提前10分钟提醒

          for (const s of schedules) {
            if (this.remindedScheduleIds.has(s.id)) continue;
            const startMs = new Date(s.startAt).getTime();
            const timeUntilStart = startMs - nowMs;

            if (timeUntilStart > 0 && timeUntilStart <= advanceMs) {
              this.remindedScheduleIds.add(s.id);
              const minutesUntil = Math.ceil(timeUntilStart / 60000);
              const timeStr = formatLocalTime(s.startAt);
              let reminderMsg = `⏰ 日程提醒：${minutesUntil}分钟后「${s.title}」开始（${timeStr}）`;
              if (s.notes) reminderMsg += `\n📝 ${s.notes}`;
              const rule: ProactiveRule = {
                id: `meeting_reminder_${s.id}`,
                name: '日程提前提醒',
                trigger: { type: 'pattern' },
                action: { type: 'feishu_message', message: reminderMsg, priority: 'high' },
                enabled: true,
                minIntervalHours: 0,
              };
              await this.executeAndLog(rule, ctx);
            }
          }

          // 清理过旧提醒ID（保留最近200个）
          if (this.remindedScheduleIds.size > 200) {
            const entries = [...this.remindedScheduleIds];
            this.remindedScheduleIds = new Set(entries.slice(-100));
          }
        } catch {
          // 本地日程不可用时跳过
        }
      } catch (err) {
        console.warn(`[ProactiveService] Scheduler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 60 * 1000);
    console.log('[ProactiveService] Scheduler started (1min interval)');
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[ProactiveService] Scheduler stopped');
    }
  }

  private async executeAndLog(rule: ProactiveRule, ctx: ProactiveContext): Promise<void> {
    let messageDelivered = false;
    const finalMessage = rule.action.message;

    if (!finalMessage) return;

    if (this.feishuSender) {
      try {
        if (rule.action.type === 'feishu_card') {
          await this.feishuSender.sendCard(ctx.userId, finalMessage);
        } else {
          await this.feishuSender.sendMessage(ctx.userId, finalMessage);
        }
        messageDelivered = true;
      } catch (err) {
        console.warn(`[ProactiveService] Feishu send failed for rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!messageDelivered && this.localNotifier) {
      try {
        await this.localNotifier.notify(finalMessage, rule.action.priority, rule.id);
      } catch (err) {
        console.warn(`[ProactiveService] Local notify failed for rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'proactive_service',
        action: `[主动提醒] ${rule.name}: ${finalMessage.substring(0, 100)}`,
        category: 'other',
        success: true,
        details: `rule: ${rule.id} | priority: ${rule.action.priority} | user: ${ctx.userName}`,
      });
    } catch { /* 不影响主流程 */ }
  }

  addRule(rule: ProactiveRule): void {
    this.rules.push(rule);
  }

  recordAction(userId: string, action: string): void {
    const history = this.actionHistory.get(userId) || [];
    history.push(`[${new Date().toISOString()}] ${action}`);
    this.actionHistory.set(userId, history.slice(-30));
  }

  async checkAndTrigger(ctx: ProactiveContext): Promise<ProactiveRule[]> {
    const triggered: ProactiveRule[] = [];
    const now = new Date();
    this.resetDedupeIfNewDay(now);

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      if (rule.lastTriggered) {
        const hoursSince = (Date.now() - new Date(rule.lastTriggered).getTime()) / (1000 * 60 * 60);
        if (hoursSince < rule.minIntervalHours) continue;
      }

      const triggerSlot =
        rule.trigger.type === 'cron'
          ? `${formatLocalDate(now)}_${now.getHours()}`
          : formatLocalDate(now);
      const triggerKey = `${ctx.userId}_${rule.id}_${triggerSlot}`;
      if (this.triggeredToday.has(triggerKey)) continue;

      if (rule.condition && !rule.condition(ctx)) continue;

      if (!this.matchTrigger(rule, ctx)) continue;

      if (rule.generateMessage) {
        const dynamicMsg = await rule.generateMessage(ctx);
        if (!dynamicMsg) continue;
        rule.action.message = dynamicMsg;
      }

      triggered.push(rule);
      rule.lastTriggered = now.toISOString();
      this.triggeredToday.add(triggerKey);
    }

    return triggered;
  }

  async onEvent(event: string, ctx: ProactiveContext): Promise<ProactiveRule[]> {
    const triggered: ProactiveRule[] = [];
    const now = new Date();
    this.resetDedupeIfNewDay(now);
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== 'event') continue;
      if (rule.trigger.event !== event) continue;
      if (rule.condition && !rule.condition(ctx)) continue;

      const triggerKey = `${ctx.userId}_${rule.id}_${event}_${formatLocalDate(now)}`;
      if (this.triggeredToday.has(triggerKey)) continue;

      triggered.push(rule);
      rule.lastTriggered = now.toISOString();
      this.triggeredToday.add(triggerKey);
      await this.executeAndLog(rule, ctx);
    }
    return triggered;
  }

  dailyReset(): void {
    this.triggeredToday.clear();
    this.triggeredDate = formatLocalDate(new Date());
  }

  private resetDedupeIfNewDay(now: Date): void {
    const currentDate = formatLocalDate(now);
    if (currentDate === this.triggeredDate) return;
    this.triggeredToday.clear();
    this.triggeredDate = currentDate;
  }

  getActionStats(userId: string): {
    totalActions: number; mostFrequent: string; lastAction: string;
  } {
    const history = this.actionHistory.get(userId) || [];
    if (history.length === 0) {
      return { totalActions: 0, mostFrequent: 'none', lastAction: 'none' };
    }
    const actionCounts: Record<string, number> = {};
    for (const h of history) {
      const action = h.replace(/^\[[^\]]+\]\s*/, '').split(':')[0].trim();
      actionCounts[action] = (actionCounts[action] || 0) + 1;
    }
    const mostFrequent = Object.entries(actionCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'none';
    return {
      totalActions: history.length,
      mostFrequent,
      lastAction: history[history.length - 1],
    };
  }

  private matchTrigger(rule: ProactiveRule, ctx: ProactiveContext): boolean {
    switch (rule.trigger.type) {
      case 'cron': {
        if (!rule.trigger.cron) return false;
        const now = new Date();
        const day = now.getDay();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const parts = rule.trigger.cron.split(/\s+/);
        if (parts.length >= 5) {
          const cronMinutes = parseCronValues(parts[0], 0, 59);
          const cronHours = parseCronValues(parts[1], 0, 23);
          const cronDays = parseCronDays(parts[4]);
          return (
            cronMinutes.includes(minute) &&
            cronHours.includes(hour) &&
            cronDays.includes(day)
          );
        }
        return false;
      }
      case 'pattern': {
        if (rule.trigger.pattern === 'no_action_30min') {
          const history = this.actionHistory.get(ctx.userId) || [];
          if (history.length === 0) return false;
          const lastActionTime = new Date(history[history.length - 1].match(/^\[([^\]]+)\]/)?.[1] || 0);
          const minutesSince = (Date.now() - lastActionTime.getTime()) / (1000 * 60);
          return minutesSince >= 30;
        }
        return false;
      }
      case 'wisdom':
        return true; // wisdom 规则始终尝试，由 generateMessage 决定是否产出
      case 'event':
        return false;
      default:
        return false;
    }
  }
}

let globalProactive: ProactiveService | null = null;
export function getProactiveService(): ProactiveService {
  if (!globalProactive) {
    globalProactive = new ProactiveService();
  }
  return globalProactive;
}

function parseCronDays(field: string): number[] {
  if (field === '*') return [0, 1, 2, 3, 4, 5, 6];
  const days: number[] = [];
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed
        .split('-')
        .map((d) => parseInt(d.trim(), 10));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) days.push(i);
      }
    } else {
      const d = parseInt(trimmed, 10);
      if (!isNaN(d)) days.push(d);
    }
  }
  return days;
}

function parseCronValues(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }

  const values = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed
        .split('-')
        .map((value) => Number.parseInt(value.trim(), 10));
      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= min &&
        end <= max &&
        start <= end
      ) {
        for (let value = start; value <= end; value++) values.add(value);
      }
      continue;
    }

    const value = Number.parseInt(trimmed, 10);
    if (Number.isInteger(value) && value >= min && value <= max) {
      values.add(value);
    }
  }
  return [...values];
}
