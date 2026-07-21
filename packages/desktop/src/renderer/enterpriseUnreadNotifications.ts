/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 企业私聊未读轮询的纯状态层：同一成员聚合为一个持久未读点，
 * 只在新消息到达时刷新 OS 弹窗；后端真正标记已读后才清本地点。
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

interface EnterpriseUnreadNotificationTrackerOptions {
  show(payload: EnterpriseUnreadNotificationPayload): void | Promise<void>;
  markRead(sessionId: string): void | Promise<void>;
}

function sessionIdForSender(senderAccountId: string): string {
  return `enterprise:message:${senderAccountId}`;
}

function isAtoaRequest(notification: EnterpriseUnreadMessageNotification): boolean {
  return notification.preview.startsWith(ATOA_REQUEST_PREFIX);
}

function toPayload(
  notification: EnterpriseUnreadMessageNotification,
): EnterpriseUnreadNotificationPayload {
  const isAtoaResponse = notification.preview.startsWith(ATOA_RESPONSE_PREFIX);
  return {
    sessionId: sessionIdForSender(notification.senderAccountId),
    source: isAtoaResponse ? 'atoa' : 'enterprise',
    sender: notification.senderName,
    preview: isAtoaResponse
      ? '对方 Otto 已回复你的企业协作请求'
      : notification.preview,
  };
}

/**
 * reconcile 的输入是后端当前未读快照。服务端按时间升序返回，
 * 遍历覆盖后每个发送者只保留最新一条，避免启动时连弹几十个 toast。
 */
export class EnterpriseUnreadNotificationTracker {
  private latestMessageBySender = new Map<string, string>();

  constructor(private readonly options: EnterpriseUnreadNotificationTrackerOptions) {}

  async reconcile(notifications: readonly EnterpriseUnreadMessageNotification[]): Promise<void> {
    const latest = new Map<string, EnterpriseUnreadMessageNotification>();
    for (const notification of notifications) {
      // A2A 请求由 App 的授权收件箱负责弹窗和完成后已读，
      // 这里略过以免同一协作请求弹两次。
      if (isAtoaRequest(notification)) continue;
      latest.set(notification.senderAccountId, notification);
    }

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

  /** 切换/退出账号时不能把上一账号的未读点留给新账号。 */
  async clear(): Promise<void> {
    const senders = [...this.latestMessageBySender.keys()];
    this.latestMessageBySender.clear();
    await Promise.all(
      senders.map((senderAccountId) =>
        this.options.markRead(sessionIdForSender(senderAccountId))),
    );
  }
}
