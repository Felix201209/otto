/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  EnterpriseUnreadNotificationTracker,
  type EnterpriseUnreadMessageNotification,
} from './enterpriseUnreadNotifications.js';

function message(over: Partial<EnterpriseUnreadMessageNotification> = {}): EnterpriseUnreadMessageNotification {
  return {
    id: 'msg-1',
    source: 'enterprise',
    title: 'Alice 发来消息',
    senderAccountId: 'alice',
    senderName: 'Alice',
    preview: '项目进度怎么样？',
    createdAt: '2026-07-21T12:00:00.000Z',
    ...over,
  };
}

describe('EnterpriseUnreadNotificationTracker', () => {
  it('同一成员多条未读只弹最新一条，且重复轮询不重复弹窗', async () => {
    const show = vi.fn(async () => undefined);
    const markRead = vi.fn(async () => undefined);
    const tracker = new EnterpriseUnreadNotificationTracker({ show, markRead });
    const notifications = [
      message(),
      message({ id: 'msg-2', preview: '最新进度' }),
    ];

    await tracker.reconcile(notifications);
    await tracker.reconcile(notifications);

    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({
      sessionId: 'enterprise:message:alice',
      source: 'enterprise',
      sender: 'Alice',
      preview: '最新进度',
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('同一成员出现新消息时更新系统弹窗，后端已读后才清本地闪烁点', async () => {
    const show = vi.fn(async () => undefined);
    const markRead = vi.fn(async () => undefined);
    const tracker = new EnterpriseUnreadNotificationTracker({ show, markRead });

    await tracker.reconcile([message()]);
    await tracker.reconcile([message({ id: 'msg-2', preview: '又有新消息' })]);
    await tracker.reconcile([]);

    expect(show).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenCalledOnce();
    expect(markRead).toHaveBeenCalledWith('enterprise:message:alice');
  });

  it('A2A 请求交给专用收件箱弹窗，A2A 回复用可读提醒而不暴露协议 JSON', async () => {
    const show = vi.fn(async () => undefined);
    const tracker = new EnterpriseUnreadNotificationTracker({
      show,
      markRead: vi.fn(async () => undefined),
    });

    await tracker.reconcile([
      message({ id: 'request', preview: 'OTTO_ATOA_REQUEST {"v":1}' }),
      message({
        id: 'response',
        senderAccountId: 'bob',
        senderName: 'Bob',
        preview: 'OTTO_ATOA_RESPONSE {"v":1,"answer":"已完成"}',
      }),
    ]);

    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith({
      sessionId: 'enterprise:message:bob',
      source: 'atoa',
      sender: 'Bob',
      preview: '对方 Otto 已回复你的企业协作请求',
    });
  });

  it('账号切换时清理该账号的本地未读标记', async () => {
    const markRead = vi.fn(async () => undefined);
    const tracker = new EnterpriseUnreadNotificationTracker({
      show: vi.fn(async () => undefined),
      markRead,
    });
    await tracker.reconcile([message(), message({ senderAccountId: 'bob', id: 'msg-bob' })]);

    await tracker.clear();

    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead.mock.calls.flat()).toEqual(expect.arrayContaining([
      'enterprise:message:alice',
      'enterprise:message:bob',
    ]));
  });
});
