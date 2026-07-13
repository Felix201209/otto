/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Notification Service — 多渠道通知 + 逐级升级
 *
 * 场景：园区报修 → 通知维修人员 → 飞书没回 → 5分钟后发短信 → 还是没回 → 电话告警
 *
 * 核心原则：
 *   1. 飞书优先（免费、即时）
 *   2. 短信兜底（收费，但任何手机都能收）
 *   3. 逐级升级——上一级未确认，自动升级到下一级
 *   4. 全程可追踪——每一条通知的状态都可查
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

// ============================================================
// 类型定义
// ============================================================

/** 通知渠道 */
export type NotificationChannel = 'feishu' | 'sms' | 'voice';

/** 通知优先级 */
export type NotificationPriority = 'routine' | 'important' | 'urgent';

/** 单条通知记录 */
export interface NotificationRecord {
  id: string;
  /** 接收人标识（飞书 open_id 或手机号） */
  recipientId: string;
  /** 接收人姓名（用于展示） */
  recipientName: string;
  /** 通知标题 */
  title: string;
  /** 通知正文 */
  body: string;
  /** 来源（报修人姓名/ID） */
  sourceName: string;
  /** 优先级 */
  priority: NotificationPriority;
  /** 当前使用的渠道 */
  channel: NotificationChannel;
  /** 创建时间 */
  createdAt: string;
  /** 是否已确认 */
  acknowledged: boolean;
  /** 确认时间 */
  acknowledgedAt?: string;
  /** 确认方式（feishu_reply / sms_reply / manual） */
  acknowledgedVia?: string;
  /** 升级历史 */
  escalationHistory: Array<{
    channel: NotificationChannel;
    sentAt: string;
    success: boolean;
  }>;
  /** 当前升级级别（0=飞书, 1=短信, 2=电话） */
  escalationLevel: number;
}

/** 升级策略配置 */
export interface EscalationPolicy {
  /** 该渠道多久未确认后升级到下一级（毫秒） */
  timeoutMs: number;
}

/** 通知发送器接口（各渠道实现） */
export interface NotificationSender {
  channel: NotificationChannel;
  send(recipientId: string, title: string, body: string): Promise<boolean>;
}

/** 飞书发送器接口 */
export interface FeishuNotifySender extends NotificationSender {
  channel: 'feishu';
}

/** 短信发送器接口 */
export interface SmsNotifySender extends NotificationSender {
  channel: 'sms';
  /** 发送短信验证/确认码，返回是否成功 */
  sendWithCode(
    phone: string,
    templateId: string,
    params: Record<string, string>,
  ): Promise<boolean>;
}

// ============================================================
// 默认升级策略
// ============================================================

const DEFAULT_ESCALATION: Record<NotificationPriority, EscalationPolicy[]> = {
  routine: [
    { timeoutMs: 10 * 60 * 1000 },  // 飞书: 10分钟
    { timeoutMs: 30 * 60 * 1000 },  // 短信: 30分钟
  ],
  important: [
    { timeoutMs: 5 * 60 * 1000 },   // 飞书: 5分钟
    { timeoutMs: 15 * 60 * 1000 },  // 短信: 15分钟
  ],
  urgent: [
    { timeoutMs: 2 * 60 * 1000 },   // 飞书: 2分钟
    { timeoutMs: 5 * 60 * 1000 },   // 短信: 5分钟
  ],
};

const CHANNEL_ORDER: NotificationChannel[] = ['feishu', 'sms', 'voice'];

// ============================================================
// NotificationService
// ============================================================

export class NotificationService extends EventEmitter {
  /** 活跃的通知记录（pending = 已发送但未确认） */
  private activeNotifications: Map<string, NotificationRecord> = new Map();
  /** 发送器注册表 */
  private senders: Map<NotificationChannel, NotificationSender> = new Map();
  /** 升级定时器 */
  private escalationTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** 历史通知（已确认/已过期） */
  private history: NotificationRecord[] = [];
  /** 服务人员手机号映射：飞书 openId → 手机号 */
  private phoneMap: Map<string, string> = new Map();

  /** 注册一个渠道的发送器 */
  registerSender(sender: NotificationSender): void {
    this.senders.set(sender.channel, sender);
    console.log(`[NotificationService] 已注册 ${sender.channel} 渠道`);
  }

  /** 设置服务人员的手机号（用于短信兜底） */
  setPhoneMapping(openId: string, phone: string): void {
    this.phoneMap.set(openId, phone);
  }

  /**
   * 发送一条通知，自动按升级策略执行。
   *
   * @returns 通知 ID，可用于后续查询/确认
   */
  async notify(params: {
    recipientId: string;
    recipientName: string;
    title: string;
    body: string;
    sourceName: string;
    priority: NotificationPriority;
    /** 接收人手机号（短信兜底用，可选） */
    phone?: string;
  }): Promise<string> {
    const id = `notif_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const policy = DEFAULT_ESCALATION[params.priority];

    const record: NotificationRecord = {
      id,
      recipientId: params.recipientId,
      recipientName: params.recipientName,
      title: params.title,
      body: params.body,
      sourceName: params.sourceName,
      priority: params.priority,
      channel: 'feishu',
      createdAt: now,
      acknowledged: false,
      escalationHistory: [],
      escalationLevel: 0,
    };

    // 存储手机号映射
    if (params.phone) {
      this.phoneMap.set(params.recipientId, params.phone);
    }

    // 级别 0：发飞书
    const feishuSender = this.senders.get('feishu');
    if (feishuSender) {
      const sent = await feishuSender.send(
        params.recipientId,
        `🔔 ${params.title}`,
        `${params.body}\n\n— 来自 ${params.sourceName} 的${params.priority === 'urgent' ? '紧急' : ''}报修`,
      );
      record.escalationHistory.push({ channel: 'feishu', sentAt: now, success: sent });
    }

    this.activeNotifications.set(id, record);

    // 设置升级定时器
    if (policy.length > 0) {
      this.scheduleEscalation(id, 0, policy);
    }

    this.emit('notification:sent', record);
    console.log(`[NotificationService] 通知已发送: ${id} → ${params.recipientName} (飞书)`);

    return id;
  }

  /** 安排下一级升级定时器 */
  private scheduleEscalation(id: string, level: number, policy: EscalationPolicy[]): void {
    if (level >= policy.length) return; // 没有更多级别了

    const timeout = policy[level].timeoutMs;
    const nextChannel = CHANNEL_ORDER[level + 1];

    const timer = setTimeout(async () => {
      const record = this.activeNotifications.get(id);
      if (!record) return;
      if (record.acknowledged) return; // 已确认，不再升级

      console.log(`[NotificationService] ${record.priority}通知超时，升级到 ${nextChannel}: ${id}`);

      // 升级到下一渠道
      const sender = nextChannel ? this.senders.get(nextChannel) : null;
      if (sender && nextChannel) {
        const phone = this.phoneMap.get(record.recipientId);

        let sent = false;
        if (nextChannel === 'sms' && phone) {
          sent = await sender.send(
            phone,
            record.title,
            `[${record.priority === 'urgent' ? '紧急' : ''}] ${record.body}\n— ${record.sourceName}\n回复"确认"以标记已处理`,
          );
        } else if (nextChannel === 'voice' && phone) {
          // 电话通道：发语音通知
          sent = await sender.send(phone, record.title, record.body);
        }

        record.escalationLevel = level + 1;
        record.channel = nextChannel;
        record.escalationHistory.push({
          channel: nextChannel,
          sentAt: new Date().toISOString(),
          success: sent,
        });

        this.emit('notification:escalated', record);
      }

      // 递归安排下一级
      this.scheduleEscalation(id, level + 1, policy);
    }, timeout);

    this.escalationTimers.set(id, timer);
  }

  /**
   * 确认一条通知（维修人回复/处理了）。
   *
   * @param id 通知 ID
   * @param via 确认方式
   */
  acknowledge(id: string, via: string = 'manual'): boolean {
    const record = this.activeNotifications.get(id);
    if (!record) return false;

    record.acknowledged = true;
    record.acknowledgedAt = new Date().toISOString();
    record.acknowledgedVia = via;

    // 清除升级定时器
    const timer = this.escalationTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(id);
    }

    this.history.push(record);
    this.activeNotifications.delete(id);

    this.emit('notification:acknowledged', record);
    console.log(`[NotificationService] 通知已确认: ${id} via ${via}`);
    return true;
  }

  /** 查询通知状态 */
  getStatus(id: string): NotificationRecord | null {
    return this.activeNotifications.get(id)
      || this.history.find((r) => r.id === id)
      || null;
  }

  /** 获取所有待确认通知 */
  getPending(): NotificationRecord[] {
    return [...this.activeNotifications.values()];
  }

  /** 获取某人的所有待确认通知 */
  getPendingFor(recipientId: string): NotificationRecord[] {
    return [...this.activeNotifications.values()]
      .filter((r) => r.recipientId === recipientId);
  }

  /** 按优先级获取待确认通知数 */
  getPendingCounts(): Record<NotificationPriority, number> {
    const counts: Record<NotificationPriority, number> = { routine: 0, important: 0, urgent: 0 };
    for (const r of this.activeNotifications.values()) {
      counts[r.priority]++;
    }
    return counts;
  }

  /** 清理资源 */
  destroy(): void {
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
    this.activeNotifications.clear();
    this.removeAllListeners();
  }
}

// ============================================================
// 全局单例
// ============================================================

let globalNotification: NotificationService | null = null;

export function getNotificationService(): NotificationService {
  if (!globalNotification) {
    globalNotification = new NotificationService();
  }
  return globalNotification;
}
