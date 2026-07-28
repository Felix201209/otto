/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 桌面端通知服务：OS 原生通知 + Otto 内部未读闪烁点。
 *
 * 职责：
 *   1. 收到非本地来源的消息时弹 Windows 右下角系统 toast（Electron Notification API）。
 *      macOS 走 Notification Center。
 *   2. 普通通知 7s 后自动消失；明确要求持久的业务通知保留到用户打开。
 *   3. 通知被点击 → IPC 通知 renderer 跳转到对应会话。
 *   4. 维护未读会话集合 → renderer 据此显示闪烁点。
 *   5. 权限未开启时引导用户授权。
 */

import { Notification, shell } from 'electron';

export interface NotificationPayload {
  /** 服务端真实入站消息 id，用于防重连/多路转发重复弹窗。 */
  messageId?: string;
  sessionId: string;
  source: string;
  /** 业务需要保留的原生通知标题（例如园区报修）；未提供时按 source 自动生成。 */
  title?: string;
  sender?: string;
  preview: string;
  /** 业务通知保持可见，直到用户点击、进入对应会话或主动清理。 */
  persistent?: boolean;
}

export type SystemNotificationFailureReason =
  | 'unsupported'
  | 'show-failed'
  | 'delivery-unconfirmed';

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
  closeTimer?: ReturnType<typeof setTimeout>;
  deliveryTimer: ReturnType<typeof setTimeout>;
  count: number;
  lastShownAt: number;
}

export class NotificationService {
  private static readonly CLOSE_AFTER_MS = 7_000;
  private static readonly CONFIRM_DELIVERY_AFTER_MS = 2_000;
  private static readonly MERGE_WINDOW_MS = 8_000;
  private static readonly SOUND_SOURCES = new Set([
    'enterprise',
    'atoa',
    'feishu',
    'park',
  ]);

  private active = new Map<string, NotificationEntry>();
  private unreadSessions = new Set<string>();
  private seenMessageIds = new Set<string>();
  private onUnreadChange?: (unread: string[]) => void;
  private onNotificationClick?: (sessionId: string) => void;
  private shouldPresentSystemNotification?: () => boolean;
  private onBackgroundAttention?: (payload: NotificationPayload) => void;
  private onSystemNotificationUnavailable?: (
    payload: NotificationPayload,
    reason: SystemNotificationFailureReason,
  ) => void;

  /** 注册回调：未读集合变化时通知 renderer（IPC）。 */
  registerCallbacks(opts: {
    onUnreadChange: (unread: string[]) => void;
    onNotificationClick: (sessionId: string) => void;
    shouldPresentSystemNotification?: () => boolean;
    onBackgroundAttention?: (payload: NotificationPayload) => void;
    onSystemNotificationUnavailable?: (
      payload: NotificationPayload,
      reason: SystemNotificationFailureReason,
    ) => void;
  }): void {
    this.onUnreadChange = opts.onUnreadChange;
    this.onNotificationClick = opts.onNotificationClick;
    this.shouldPresentSystemNotification = opts.shouldPresentSystemNotification;
    this.onBackgroundAttention = opts.onBackgroundAttention;
    this.onSystemNotificationUnavailable = opts.onSystemNotificationUnavailable;
  }

  /** 收到非本地消息 → 发 OS 通知 + 记未读。 */
  show(payload: NotificationPayload): void {
    const normalized = this.normalizePayload(payload);
    if (!normalized) return;

    if (payload.messageId) {
      const dedupeKey = `${normalized.source}:${payload.messageId}`;
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
    this.unreadSessions.add(normalized.sessionId);
    this.emitUnread();

    // Otto 正在前台时，界面本身已经承担消息反馈，不再额外打断用户。
    // 先关掉同会话此前留下的系统 toast，但保留上面的未读状态。
    if (!this.canPresentSystemNotification()) {
      this.closeActiveNotification(normalized.sessionId);
      return;
    }

    this.requestBackgroundAttention(normalized);
    this.playNotificationSound(normalized.source);

    let fallbackRequested = false;
    const requestFallback = (reason: SystemNotificationFailureReason): void => {
      if (fallbackRequested) return;
      fallbackRequested = true;
      try {
        this.onSystemNotificationUnavailable?.(normalized, reason);
      } catch {
        // 降级提醒失败也不能破坏 Otto 自己的未读状态。
      }
    };

    let supported = false;
    try {
      supported = Notification.isSupported();
    } catch {
      supported = false;
    }
    if (!supported) {
      requestFallback('unsupported');
      return;
    }

    const now = Date.now();
    const previous = this.active.get(normalized.sessionId);
    const count =
      previous && now - previous.lastShownAt <= NotificationService.MERGE_WINDOW_MS
        ? previous.count + 1
        : 1;
    if (previous) {
      if (previous.closeTimer) clearTimeout(previous.closeTimer);
      clearTimeout(previous.deliveryTimer);
      try { previous.notification.close(); } catch { /* ignore */ }
      this.active.delete(normalized.sessionId);
    }

    const title = count > 1
      ? `${normalized.title} · ${count} 条新消息`
      : normalized.title;
    const body = count > 1
      ? `最新：${normalized.preview}`
      : normalized.preview;

    let notification: Notification;
    try {
      notification = new Notification({
        title,
        body,
        silent: false,
        urgency: 'normal',
        timeoutType: normalized.persistent ? 'never' : 'default',
      });
    } catch {
      requestFallback('show-failed');
      return;
    }
    let deliveryConfirmed = false;
    const confirmDelivery = (): void => {
      deliveryConfirmed = true;
      const current = this.active.get(normalized.sessionId);
      if (current?.notification === notification) clearTimeout(current.deliveryTimer);
    };
    notification.on('click', () => {
      confirmDelivery();
      // 企业私聊/A2A 用合成会话 id：点 toast 只能证明用户打开了 Otto，
      // 不代表他已打开真正的企业会话或完成授权。其未读点由业务已读回执清除。
      if (!normalized.sessionId.startsWith('enterprise:')) {
        this.markRead(normalized.sessionId);
      }
      this.onNotificationClick?.(normalized.sessionId);
    });
    notification.on('show', confirmDelivery);
    notification.on('failed', () => {
      const current = this.active.get(normalized.sessionId);
      if (current?.notification === notification) {
        if (current.closeTimer) clearTimeout(current.closeTimer);
        clearTimeout(current.deliveryTimer);
        this.active.delete(normalized.sessionId);
        requestFallback('show-failed');
      }
    });

    // 只关闭系统弹窗；Otto 内未读点继续保留。
    const closeTimer = normalized.persistent
      ? undefined
      : setTimeout(() => {
        try { notification.close(); } catch { /* ignore */ }
        const current = this.active.get(normalized.sessionId);
        if (current?.notification === notification) {
          this.active.delete(normalized.sessionId);
        }
      }, NotificationService.CLOSE_AFTER_MS);
    const deliveryTimer = setTimeout(() => {
      if (!deliveryConfirmed) requestFallback('delivery-unconfirmed');
    }, NotificationService.CONFIRM_DELIVERY_AFTER_MS);

    this.active.set(normalized.sessionId, {
      notification,
      sessionId: normalized.sessionId,
      closeTimer,
      deliveryTimer,
      count,
      lastShownAt: now,
    });
    try {
      notification.show();
    } catch {
      if (closeTimer) clearTimeout(closeTimer);
      clearTimeout(deliveryTimer);
      this.active.delete(normalized.sessionId);
      // OS 弹窗失败不影响上面已写入的 Otto 未读态。
      requestFallback('show-failed');
    }
  }

  /** 标记某会话已读（用户点进该会话时 renderer 调用）。 */
  markRead(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (entry) {
      if (entry.closeTimer) clearTimeout(entry.closeTimer);
      clearTimeout(entry.deliveryTimer);
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
      if (entry.closeTimer) clearTimeout(entry.closeTimer);
      clearTimeout(entry.deliveryTimer);
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
    };
    const label = labels[source] ?? '新消息';
    return sender ? `${label} · ${sender}` : label;
  }

  private normalizePayload(payload: NotificationPayload): NotificationPayload | null {
    const sessionId = this.compactText(payload.sessionId, 160);
    if (!sessionId) return null;
    const source = this.compactText(payload.source, 40) || 'unknown';
    const sender = this.compactText(payload.sender ?? '', 40);
    const title =
      this.compactText(payload.title ?? '', 80) ||
      this.formatTitle(source, sender || undefined);
    const preview =
      this.compactText(payload.preview, 180) ||
      '你收到了一条新消息。';
    return {
      ...payload,
      sessionId,
      source,
      sender: sender || undefined,
      title,
      preview,
    };
  }

  private compactText(value: string, maxLength: number): string {
    const compact = value
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  private playNotificationSound(source: string): void {
    if (!NotificationService.SOUND_SOURCES.has(source)) return;
    try {
      shell.beep();
    } catch {
      // 系统声音失败不影响弹窗和 Otto 内部未读点。
    }
  }

  private canPresentSystemNotification(): boolean {
    try {
      return this.shouldPresentSystemNotification?.() ?? true;
    } catch {
      // 窗口状态读取失败时按后台处理，避免真正的后台消息完全无提示。
      return true;
    }
  }

  private requestBackgroundAttention(payload: NotificationPayload): void {
    try {
      this.onBackgroundAttention?.(payload);
    } catch {
      // 任务栏/Dock 提醒失败不影响系统通知与未读状态。
    }
  }

  private closeActiveNotification(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    if (entry.closeTimer) clearTimeout(entry.closeTimer);
    clearTimeout(entry.deliveryTimer);
    try { entry.notification.close(); } catch { /* ignore */ }
    this.active.delete(sessionId);
  }

  private emitUnread(): void {
    this.onUnreadChange?.(this.getUnreadSessions());
  }
}
