/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 桌面端通知服务：OS 原生通知 + Otto 内部未读闪烁点。
 *
 * 职责：
 *   1. 收到非本地来源的消息时弹 Windows 右下角系统 toast（Electron Notification API）。
 *      macOS 走 Notification Center。
 *   2. 通知 5s 后自动消失。
 *   3. 通知被点击 → IPC 通知 renderer 跳转到对应会话。
 *   4. 维护未读会话集合 → renderer 据此显示闪烁点。
 *   5. 权限未开启时引导用户授权。
 */

import { Notification } from 'electron';

export interface NotificationPayload {
  sessionId: string;
  source: string;
  sender?: string;
  preview: string;
}

interface NotificationEntry {
  notification: Notification;
  sessionId: string;
}

export class NotificationService {
  private active = new Map<string, NotificationEntry>();
  private unreadSessions = new Set<string>();
  private onUnreadChange?: (unread: string[]) => void;
  private onNotificationClick?: (sessionId: string) => void;

  /** 注册回调：未读集合变化时通知 renderer（IPC）。 */
  registerCallbacks(opts: {
    onUnreadChange: (unread: string[]) => void;
    onNotificationClick: (sessionId: string) => void;
  }): void {
    this.onUnreadChange = opts.onUnreadChange;
    this.onNotificationClick = opts.onNotificationClick;
  }

  /** 收到非本地消息 → 发 OS 通知 + 记未读。 */
  show(payload: NotificationPayload): void {
    if (!Notification.isSupported()) return;

    const title = this.formatTitle(payload.source, payload.sender);
    const body = payload.preview.slice(0, 200);

    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => {
      this.markRead(payload.sessionId);
      this.onNotificationClick?.(payload.sessionId);
    });

    // 5 秒后自动关
    setTimeout(() => {
      try { notification.close(); } catch { /* ignore */ }
    }, 5000);

    notification.show();

    this.active.set(payload.sessionId, { notification, sessionId: payload.sessionId });
    this.unreadSessions.add(payload.sessionId);
    this.emitUnread();
  }

  /** 标记某会话已读（用户点进该会话时 renderer 调用）。 */
  markRead(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (entry) {
      try { entry.notification.close(); } catch { /* ignore */ }
      this.active.delete(sessionId);
    }
    if (this.unreadSessions.delete(sessionId)) {
      this.emitUnread();
    }
  }

  /** 清除所有通知（logout 时用）。 */
  clearAll(): void {
    for (const [, entry] of this.active) {
      try { entry.notification.close(); } catch { /* ignore */ }
    }
    this.active.clear();
    this.unreadSessions.clear();
    this.emitUnread();
  }

  getUnreadSessions(): string[] {
    return [...this.unreadSessions];
  }

  /** 权限未开启时返回 false → renderer 弹引导。 */
  checkPermission(): boolean {
    return Notification.isSupported();
  }

  // ── private ──

  private formatTitle(source: string, sender?: string): string {
    const labels: Record<string, string> = {
      feishu: '飞书消息',
      atoa: '企业内部协作',
      enterprise: '企业通知',
      park: '园区服务',
      tui: 'TUI',
    };
    const label = labels[source] ?? '新消息';
    return sender ? `${label} · ${sender}` : label;
  }

  private emitUnread(): void {
    this.onUnreadChange?.(this.getUnreadSessions());
  }
}
