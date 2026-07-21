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
  /** 服务端真实入站消息 id，用于防重连/多路转发重复弹窗。 */
  messageId?: string;
  sessionId: string;
  source: string;
  /** 业务需要保留的原生通知标题（例如园区报修）；未提供时按 source 自动生成。 */
  title?: string;
  sender?: string;
  preview: string;
}

export interface EnterpriseNotificationIdentity {
  id: string;
  organizationId: string;
}

/**
 * 企业身份与 main 账号级状态的统一隔离边界。身份真正提交前先清掉旧
 * toast/未读点和文件授权；同账号的租约、姓名或权限刷新不会误清，提交失败
 * 也不会把目标身份记成已生效。
 */
export class EnterpriseNotificationIdentityBoundary {
  private fingerprint = 'none';

  constructor(
    private readonly clearNotifications: () => void,
    private readonly clearFileAccessGrants: () => void,
  ) {}

  async synchronize<TIdentity extends EnterpriseNotificationIdentity>(
    account: TIdentity | null,
    apply: (account: TIdentity | null) => Promise<void>,
  ): Promise<void> {
    const nextFingerprint = account
      ? `${account.organizationId}\u0000${account.id}`
      : 'none';
    if (nextFingerprint !== this.fingerprint) {
      // 文件授权是安全边界，先撤销；旧账号已选择的路径绝不能被新账号复用。
      this.clearFileAccessGrants();
      this.clearNotifications();
    }
    await apply(account);
    this.fingerprint = nextFingerprint;
  }
}

interface NotificationEntry {
  notification: Notification;
  sessionId: string;
  closeTimer: ReturnType<typeof setTimeout>;
}

export class NotificationService {
  private active = new Map<string, NotificationEntry>();
  private unreadSessions = new Set<string>();
  private seenMessageIds = new Set<string>();
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
    if (payload.messageId) {
      const dedupeKey = `${payload.source}:${payload.messageId}`;
      if (this.seenMessageIds.has(dedupeKey)) return;
      this.seenMessageIds.add(dedupeKey);
      while (this.seenMessageIds.size > 512) {
        const oldest = this.seenMessageIds.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.seenMessageIds.delete(oldest);
      }
    }
    // 未读态属于 Otto 自己，不能依赖系统通知权限/平台支持。即使用户关闭了 OS toast，
    // 聊天侧栏和托盘徽标仍必须提示，直到真正打开该会话。
    this.unreadSessions.add(payload.sessionId);
    this.emitUnread();

    let supported = false;
    try {
      supported = Notification.isSupported();
    } catch {
      supported = false;
    }
    if (!supported) return;

    const previous = this.active.get(payload.sessionId);
    if (previous) {
      clearTimeout(previous.closeTimer);
      try { previous.notification.close(); } catch { /* ignore */ }
      this.active.delete(payload.sessionId);
    }

    const title = payload.title?.trim().slice(0, 80)
      || this.formatTitle(payload.source, payload.sender);
    const body = payload.preview.slice(0, 200);

    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => {
      // 企业私聊/A2A 用合成会话 id：点 toast 只能证明用户打开了 Otto，
      // 不代表他已打开真正的企业会话或完成授权。其未读点由业务已读回执清除。
      if (!payload.sessionId.startsWith('enterprise:')) {
        this.markRead(payload.sessionId);
      }
      this.onNotificationClick?.(payload.sessionId);
    });

    // 5 秒后只关闭系统弹窗；Otto 内未读点继续保留。
    const closeTimer = setTimeout(() => {
      try { notification.close(); } catch { /* ignore */ }
      const current = this.active.get(payload.sessionId);
      if (current?.notification === notification) {
        this.active.delete(payload.sessionId);
      }
    }, 5000);

    this.active.set(payload.sessionId, {
      notification,
      sessionId: payload.sessionId,
      closeTimer,
    });
    try {
      notification.show();
    } catch {
      clearTimeout(closeTimer);
      this.active.delete(payload.sessionId);
      // OS 弹窗失败不影响上面已写入的 Otto 未读态。
    }
  }

  /** 标记某会话已读（用户点进该会话时 renderer 调用）。 */
  markRead(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (entry) {
      clearTimeout(entry.closeTimer);
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
      clearTimeout(entry.closeTimer);
      try { entry.notification.close(); } catch { /* ignore */ }
    }
    this.active.clear();
    this.unreadSessions.clear();
    this.seenMessageIds.clear();
    this.emitUnread();
  }

  getUnreadSessions(): string[] {
    return [...this.unreadSessions];
  }

  /** 权限未开启时返回 false → renderer 弹引导。 */
  checkPermission(): boolean {
    try {
      return Notification.isSupported();
    } catch {
      return false;
    }
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
