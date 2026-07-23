/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Enterprise direct-message unread reconciliation:
 * group unread items by sender, show one OS notification for the latest item,
 * and keep Otto's unread marker until the backend reports the message as read.
 */

const ATOA_REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
const ATOA_RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';

export interface EnterpriseUnreadMessageNotification {
  id: string;
  source: 'enterprise';
  title: string;
  senderAccountId: string;
  senderName: string;
  preview: string;
  createdAt: string;
}

export interface EnterpriseUnreadNotificationPayload {
  sessionId: string;
  source: 'enterprise' | 'atoa';
  sender: string;
  preview: string;
}

export type EnterpriseUnreadCounts = Record<string, number>;

interface EnterpriseUnreadNotificationTrackerOptions {
  show(payload: EnterpriseUnreadNotificationPayload): void | Promise<void>;
  markRead(sessionId: string): void | Promise<void>;
  onUnreadCountsChange?: (counts: EnterpriseUnreadCounts) => void;
}

function sessionIdForSender(senderAccountId: string): string {
  return `enterprise:message:${senderAccountId}`;
}

function isAtoaRequest(notification: EnterpriseUnreadMessageNotification): boolean {
  return notification.preview.startsWith(ATOA_REQUEST_PREFIX);
}

function isAtoaResponse(notification: EnterpriseUnreadMessageNotification): boolean {
  return notification.preview.startsWith(ATOA_RESPONSE_PREFIX);
}

function toPayload(
  notification: EnterpriseUnreadMessageNotification,
): EnterpriseUnreadNotificationPayload {
  const atoaRequest = isAtoaRequest(notification);
  const atoaResponse = isAtoaResponse(notification);
  return {
    sessionId: sessionIdForSender(notification.senderAccountId),
    source: atoaRequest || atoaResponse ? 'atoa' : 'enterprise',
    sender: notification.senderName,
    preview: atoaRequest
      ? '对方正在请求你的 Otto 协作'
      : atoaResponse
        ? '对方 Otto 已回复你的企业协作请求'
        : notification.preview,
  };
}

/**
 * The input is the backend's current unread snapshot. The backend returns
 * messages in time order; by overwriting in the map, each sender keeps only the
 * latest unread notification so startup does not create a notification storm.
 */
export class EnterpriseUnreadNotificationTracker {
  private latestMessageBySender = new Map<string, string>();

  constructor(private readonly options: EnterpriseUnreadNotificationTrackerOptions) {}

  async reconcile(notifications: readonly EnterpriseUnreadMessageNotification[]): Promise<void> {
    const latest = new Map<string, EnterpriseUnreadMessageNotification>();
    const counts: EnterpriseUnreadCounts = {};
    for (const notification of notifications) {
      latest.set(notification.senderAccountId, notification);
      const sessionId = sessionIdForSender(notification.senderAccountId);
      counts[sessionId] = (counts[sessionId] ?? 0) + 1;
    }
    this.options.onUnreadCountsChange?.(counts);

    for (const senderAccountId of [...this.latestMessageBySender.keys()]) {
      if (latest.has(senderAccountId)) continue;
      await this.options.markRead(sessionIdForSender(senderAccountId));
      this.latestMessageBySender.delete(senderAccountId);
    }

    for (const [senderAccountId, notification] of latest) {
      if (this.latestMessageBySender.get(senderAccountId) === notification.id) continue;
      await this.options.show(toPayload(notification));
      this.latestMessageBySender.set(senderAccountId, notification.id);
    }
  }

  /** Clear local unread markers when switching or logging out of an enterprise account. */
  async clear(): Promise<void> {
    const senders = [...this.latestMessageBySender.keys()];
    this.latestMessageBySender.clear();
    this.options.onUnreadCountsChange?.({});
    await Promise.all(
      senders.map((senderAccountId) =>
        this.options.markRead(sessionIdForSender(senderAccountId))),
    );
  }
}
