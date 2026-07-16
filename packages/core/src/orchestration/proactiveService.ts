/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Proactive Service — 主动服务引擎。
 *
 * 从"被动响应"升级为"主动提醒"：
 * - 检测到周五下午4点小王还没发周报 → 主动提醒
 * - 检测到刚结束会议 → 主动问"要整理纪要吗"
 * - 检测到被拉进新项目群 → 主动提供背景资料
 *
 * 基于 LangGraph 的定时触发 + 行为模式统计。
 */

import type { Config } from '../config/config.js';
import { getWorkLogger } from './workLog.js';

/** 飞书推送接口（由 CLI gateway 注入） */
export interface ProactiveFeishuSender {
  /** 发送飞书卡片消息给用户 */
  sendCard(userId: string, message: string): Promise<void>;
  /** 发送飞书文本消息给用户 */
  sendMessage(userId: string, message: string): Promise<void>;
}

/** 本地通知接口（由 otto-server 注入，无飞书时也能推送） */
export interface ProactiveLocalNotifier {
  /** 推送一条主动提醒，server 广播给所有连接的客户端 */
  notify(message: string, priority: 'low' | 'medium' | 'high', ruleId: string): Promise<void>;
}

/** 日历轮询检查器（用于检测最近结束的会议） */
export interface CalendarMeetingResult {
  meetingId: string;
  topic: string;
  endTime: string; // ISO 时间戳
  hostUserId: string;
  operatorId: string;
}

export type CalendarCheckerFn = () => Promise<CalendarMeetingResult[]>;

/** 主动服务规则 */
export interface ProactiveRule {
  id: string;
  name: string;
  /** 触发条件 */
  trigger: {
    type: 'cron' | 'event' | 'pattern';
    // cron: 定时表达式 (如 "0 16 * * 5" = 每周五16:00)
    cron?: string;
    // event: 事件类型 (如 "meeting_ended", "added_to_group")
    event?: string;
    // pattern: 行为模式 (如 "no_action_30min" = 30分钟无操作)
    pattern?: string;
  };
  /** 条件判断（额外的触发条件） */
  condition?: (ctx: ProactiveContext) => boolean;
  /** 触发后执行的动作 */
  action: {
    type: 'feishu_card' | 'feishu_message' | 'todo_create' | 'memory_check';
    message: string;
    /** 卡片内容（如果是 feishu_card） */
    cardData?: Record<string, unknown>;
    /** 优先级 */
    priority: 'low' | 'medium' | 'high';
  };
  /** 是否启用 */
  enabled: boolean;
  /** 上次触发时间（防重复） */
  lastTriggered?: string;
  /** 最小触发间隔（小时），防止过度打扰 */
  minIntervalHours: number;
}

/** 主动服务上下文 */
export interface ProactiveContext {
  userId: string;
  userName: string;
  currentDay: string; // Monday, Tuesday...
  currentTime: string; // HH:MM
  recentActions: string[]; // 最近操作
  pendingTasks: number;
  hasUpcomingMeeting: boolean;
  lastMeetingEnd?: string;
  department?: string;
  role?: string;
}

/** 内置规则集 */
const BUILTIN_RULES: ProactiveRule[] = [
  {
    id: 'weekly_report_reminder',
    name: '周报提醒',
    trigger: { type: 'cron', cron: '0 16 * * 5' }, // 每周五16:00
    condition: (ctx) => {
      // 只在用户还没发周报时提醒
      return !ctx.recentActions.some(a => a.includes('周报') || a.includes('weekly report'));
    },
    action: {
      type: 'feishu_card',
      message: '今天还没发周报，要我帮你起草吗？',
      priority: 'medium',
    },
    enabled: true,
    minIntervalHours: 24,
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
    enabled: true,
    minIntervalHours: 1,
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
    enabled: true,
    minIntervalHours: 2,
  },
  {
    id: 'morning_briefing',
    name: '晨间简报',
    trigger: { type: 'cron', cron: '0 9 * * 1-5' }, // 工作日9:00
    action: {
      type: 'feishu_card',
      message: '早上好！今天的日程安排：{schedule}，待办任务：{tasks}',
      priority: 'low',
    },
    enabled: true,
    minIntervalHours: 20,
  },
  {
    id: 'daily_work_summary',
    name: '每日工作汇总推送',
    trigger: { type: 'cron', cron: '0 18 * * 1-5' }, // 工作日18:00
    condition: (ctx) => {
      // 只在有操作记录时推送
      const logger = getWorkLogger();
      return true; // checkAndTrigger 内部会调用，这里先放行，实际推送时判断有无数据
    },
    action: {
      type: 'feishu_card',
      message: '📋 今日工作汇总已生成，点击查看详情',
      priority: 'medium',
    },
    enabled: true,
    minIntervalHours: 20,
  },
  {
    id: 'tomorrow_early_schedule',
    name: '明早日程提前提醒',
    trigger: { type: 'cron', cron: '0 20 * * *' }, // 每晚20:00
    action: {
      type: 'feishu_message',
      message: '明早有日程安排，记得早做准备。',
      priority: 'medium',
    },
    enabled: true,
    minIntervalHours: 22,
  },
];

/**
 * 主动服务引擎。
 */
export class ProactiveService {
  private rules: ProactiveRule[] = [...BUILTIN_RULES];
  private actionHistory: Map<string, string[]> = new Map(); // userId -> recent actions
  private triggeredToday: Set<string> = new Set(); // 防止同一天重复触发
  private feishuSender: ProactiveFeishuSender | null = null;
  private localNotifier: ProactiveLocalNotifier | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 日历轮询检查器（fallback：飞书 WebSocket 事件不可用时使用） */
  private calendarChecker: CalendarCheckerFn | null = null;
  /** 已处理的会议 ID 集合（防重复触发） */
  private processedMeetings: Set<string> = new Set();

  /** 注入飞书发送器 */
  setFeishuSender(sender: ProactiveFeishuSender): void {
    this.feishuSender = sender;
    console.log('[ProactiveService] Feishu sender injected');
  }

  /** 注入本地通知器（无飞书时也能推送到桌面） */
  setLocalNotifier(notifier: ProactiveLocalNotifier): void {
    this.localNotifier = notifier;
    console.log('[ProactiveService] Local notifier injected');
  }

  /** 注入日历轮询检查器（用于检测最近结束的会议） */
  setCalendarChecker(checker: CalendarCheckerFn): void {
    this.calendarChecker = checker;
    console.log('[ProactiveService] Calendar checker injected');
  }

  /**
   * 启动定时驱动器（每5分钟检查一次 cron 规则 + 日历轮询）。
   * 由 CLI gateway 或桌面端 main 进程调用。
   */
  startScheduler(getContext: () => ProactiveContext): void {
    if (this.timer) return; // 已启动
    // 每5分钟检查一次
    this.timer = setInterval(async () => {
      try {
        const ctx = getContext();

        // 1. 检查 cron/pattern 规则
        const triggered = await this.checkAndTrigger(ctx);
        for (const rule of triggered) {
          await this.executeAndLog(rule, ctx);
        }

        // 2. 日历轮询：检测最近结束的会议（WebSocket 事件的 fallback）
        if (this.calendarChecker) {
          try {
            const meetings = await this.calendarChecker();
            for (const m of meetings) {
              if (this.processedMeetings.has(m.meetingId)) continue;
              this.processedMeetings.add(m.meetingId);

              // 构建带会议信息的上下文
              const meetingCtx: ProactiveContext = {
                ...ctx,
                lastMeetingEnd: m.endTime,
              };
              await this.onEvent('meeting_ended', meetingCtx);
            }

            // 清理旧会议 ID（保留最近 200 个）
            if (this.processedMeetings.size > 200) {
              const entries = [...this.processedMeetings];
              this.processedMeetings = new Set(entries.slice(-100));
            }
          } catch (err) {
            console.warn(`[ProactiveService] Calendar polling error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        // 定时器出错不能崩溃
        console.warn(`[ProactiveService] Scheduler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 5 * 60 * 1000);
    console.log('[ProactiveService] Scheduler started (5min interval)');
  }

  /** 停止定时驱动器 */
  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[ProactiveService] Scheduler stopped');
    }
  }

  /**
   * 执行触发的规则：发飞书消息 + 记工作日志（标注主动服务）。
   */
  private async executeAndLog(rule: ProactiveRule, ctx: ProactiveContext): Promise<void> {
    let messageDelivered = false;

    // 1. 优先走飞书
    if (this.feishuSender) {
      try {
        if (rule.action.type === 'feishu_card') {
          await this.feishuSender.sendCard(ctx.userId, rule.action.message);
        } else if (rule.action.type === 'feishu_message') {
          await this.feishuSender.sendMessage(ctx.userId, rule.action.message);
        }
        messageDelivered = true;
      } catch (err) {
        console.warn(`[ProactiveService] Feishu send failed for rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. 回退到本地通知
    if (!messageDelivered && this.localNotifier) {
      try {
        await this.localNotifier.notify(rule.action.message, rule.action.priority, rule.id);
      } catch (err) {
        console.warn(`[ProactiveService] Local notify failed for rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. 记工作日志（标注主动服务，与普通操作区分）
    try {
      const logger = getWorkLogger();
      await logger.log({
        toolName: 'proactive_service',
        action: `[主动服务] ${rule.name}：${rule.action.message.substring(0, 100)}`,
        category: 'other',
        success: true,
        details: `触发规则：${rule.id} | 优先级：${rule.action.priority} | 用户：${ctx.userName}`,
      });
    } catch { /* 不影响主流程 */ }
  }

  /**
   * 添加自定义规则。
   */
  addRule(rule: ProactiveRule): void {
    this.rules.push(rule);
  }

  /**
   * 记录用户行为（用于模式检测）。
   */
  recordAction(userId: string, action: string): void {
    const history = this.actionHistory.get(userId) || [];
    history.push(`[${new Date().toISOString()}] ${action}`);
    // 只保留最近20条
    this.actionHistory.set(userId, history.slice(-20));
  }

  /**
   * 检查并触发主动服务。
   * 由定时器或事件驱动调用。
   */
  async checkAndTrigger(ctx: ProactiveContext): Promise<ProactiveRule[]> {
    const triggered: ProactiveRule[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      // 检查最小间隔
      if (rule.lastTriggered) {
        const hoursSince = (Date.now() - new Date(rule.lastTriggered).getTime()) / (1000 * 60 * 60);
        if (hoursSince < rule.minIntervalHours) continue;
      }

      // 检查防重复
      const triggerKey = `${ctx.userId}_${rule.id}`;
      if (this.triggeredToday.has(triggerKey)) continue;

      // 检查条件
      if (rule.condition && !rule.condition(ctx)) continue;

      // 匹配触发条件
      if (this.matchTrigger(rule, ctx)) {
        // 每日工作汇总：生成当日汇总内容替换 message
        if (rule.id === 'daily_work_summary') {
          try {
            const logger = getWorkLogger();
            const today = new Date().toISOString().split('T')[0];
            const summary = await logger.generateDailySummary(today);
            if (summary.totalActions === 0) {
              continue; // 今天没有操作记录，不推送
            }
            rule.action.message = logger.formatDailySummaryForFeishu(summary);
          } catch {
            continue; // 生成汇总失败，跳过
          }
        }

        // 明早日程提醒：读取本地日程，检查明早6-9点是否有安排
        if (rule.id === 'tomorrow_early_schedule') {
          try {
            const { listLocalSchedules: ls } = await import('../tools/local-schedule.js');
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = tomorrow.toISOString().split('T')[0];
            const schedules = ls(tomorrowStr);
            const earlySchedules = schedules.filter((s) => {
              const hour = parseInt(s.startAt.slice(11, 13), 10);
              return hour >= 6 && hour <= 9;
            });
            if (earlySchedules.length === 0) {
              continue;
            }
            const titles = earlySchedules.map((s) => {
              const time = s.startAt.slice(11, 16);
              return `${time} ${s.title}`;
            }).join('；');
            rule.action.message = `📅 明早日程提醒：${titles}。记得早做准备哦。`;
          } catch {
            continue;
          }
        }

        // 晨间简报：读取今日本地日程，注入到消息中
        if (rule.id === 'morning_briefing') {
          try {
            const { listLocalSchedules: ls } = await import('../tools/local-schedule.js');
            const today = new Date().toISOString().split('T')[0];
            const schedules = ls(today);
            if (schedules.length > 0) {
              const lines = schedules.map((s) => {
                const time = s.startAt.slice(11, 16);
                return `${time} ${s.title}`;
              }).join('\n');
              rule.action.message = `早上好！今日日程安排：\n${lines}\n祝你工作顺利！`;
            } else {
              rule.action.message = '早上好！今日暂无日程安排，祝你工作顺利！';
            }
          } catch {
            // 读不到也没关系，用默认消息
          }
        }

        triggered.push(rule);
        rule.lastTriggered = new Date().toISOString();
        this.triggeredToday.add(triggerKey);
      }
    }

    return triggered;
  }

  /**
   * 触发事件驱动型规则。
   */
  async onEvent(event: string, ctx: ProactiveContext): Promise<ProactiveRule[]> {
    const triggered: ProactiveRule[] = [];

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== 'event') continue;
      if (rule.trigger.event !== event) continue;

      if (rule.condition && !rule.condition(ctx)) continue;

      const triggerKey = `${ctx.userId}_${rule.id}_${event}`;
      if (this.triggeredToday.has(triggerKey)) continue;

      triggered.push(rule);
      rule.lastTriggered = new Date().toISOString();
      this.triggeredToday.add(triggerKey);

      // 执行：发飞书 + 记工作日志
      await this.executeAndLog(rule, ctx);
    }

    return triggered;
  }

  /**
   * 每日重置（清除防重复标记）。
   */
  dailyReset(): void {
    this.triggeredToday.clear();
  }

  /**
   * 获取用户行为统计（用于报告）。
   */
  getActionStats(userId: string): {
    totalActions: number;
    mostFrequent: string;
    lastAction: string;
  } {
    const history = this.actionHistory.get(userId) || [];
    if (history.length === 0) {
      return { totalActions: 0, mostFrequent: 'none', lastAction: 'none' };
    }

    // 统计最频繁的行为
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

  /** 检查是否匹配触发条件 */
  private matchTrigger(rule: ProactiveRule, ctx: ProactiveContext): boolean {
    switch (rule.trigger.type) {
      case 'cron': {
        // 简化的 cron 匹配：检查当前时间是否匹配
        // 实际实现可用 node-cron 库
        if (!rule.trigger.cron) return false;
        const now = new Date();
        const day = now.getDay(); // 0=Sunday, 5=Friday
        const hour = now.getHours();
        const minute = now.getMinutes();

        // 解析简化 cron: "M H * * D"
        // D 支持: * / 1,3,5 / 1-5
        const parts = rule.trigger.cron.split(/\s+/);
        if (parts.length >= 5) {
          const cronMin = parseInt(parts[0]);
          const cronHour = parseInt(parts[1]);
          const cronDays = parseCronDays(parts[4]);

          return minute === cronMin && hour === cronHour && cronDays.includes(day);
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

      case 'event':
        // 事件驱动型由 onEvent 处理
        return false;

      default:
        return false;
    }
  }
}

/**
 * 全局单例。
 */
let globalProactive: ProactiveService | null = null;

export function getProactiveService(): ProactiveService {
  if (!globalProactive) {
    globalProactive = new ProactiveService();
  }
  return globalProactive;
}

/**
 * 解析 cron 的 day-of-week 字段，支持: * / 1,3,5 / 1-5
 */
function parseCronDays(field: string): number[] {
  if (field === '*') return [0, 1, 2, 3, 4, 5, 6];
  const days: number[] = [];
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(d => parseInt(d.trim()));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) days.push(i);
      }
    } else {
      const d = parseInt(trimmed);
      if (!isNaN(d)) days.push(d);
    }
  }
  return days;
}
