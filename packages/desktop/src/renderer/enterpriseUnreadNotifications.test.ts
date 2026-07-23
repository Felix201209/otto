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
  it('shows only the latest unread message per sender and does not repeat notifications', async () => {
    const show = vi.fn(async () => undefined);
    const markRead = vi.fn(async () => undefined);
    const onUnreadCountsChange = vi.fn();
    const tracker = new EnterpriseUnreadNotificationTracker({ show, markRead, onUnreadCountsChange });
    const notifications = [
      message(),
      message({ id: 'msg-2', preview: '最新进度' }),
      message({ id: 'msg-bob', senderAccountId: 'bob', senderName: 'Bob' }),
    ];

    await tracker.reconcile(notifications);
    await tracker.reconcile(notifications);

    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledWith({
      sessionId: 'enterprise:message:alice',
      source: 'enterprise',
      sender: 'Alice',
      preview: '最新进度',
    });
    expect(onUnreadCountsChange).toHaveBeenLastCalledWith({
      'enterprise:message:alice': 2,
      'enterprise:message:bob': 1,
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('updates OS notification for new messages and clears local unread markers after backend read', async () => {
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

  it('shows OS notifications for both ATOA requests and responses without exposing protocol JSON', async () => {
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

    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenNthCalledWith(1, {
      sessionId: 'enterprise:message:alice',
      source: 'atoa',
      sender: 'Alice',
      preview: '对方正在请求你的 Otto 协作',
    });
    expect(show).toHaveBeenNthCalledWith(2, {
      sessionId: 'enterprise:message:bob',
      source: 'atoa',
      sender: 'Bob',
      preview: '对方 Otto 已回复你的企业协作请求',
    });
  });

  it('plain direct messages use enterprise source so desktop can show toast and sound', async () => {
    const show = vi.fn(async () => undefined);
    const tracker = new EnterpriseUnreadNotificationTracker({
      show,
      markRead: vi.fn(async () => undefined),
    });

    await tracker.reconcile([message({ id: 'direct-1', preview: '下午方便同步吗？' })]);

    expect(show).toHaveBeenCalledWith({
      sessionId: 'enterprise:message:alice',
      source: 'enterprise',
      sender: 'Alice',
      preview: '下午方便同步吗？',
    });
  });

  it('clears local unread markers when switching enterprise accounts', async () => {
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

  it('clears unread counts when switching enterprise accounts', async () => {
    const onUnreadCountsChange = vi.fn();
    const tracker = new EnterpriseUnreadNotificationTracker({
      show: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
      onUnreadCountsChange,
    });

    await tracker.reconcile([message()]);
    await tracker.clear();

    expect(onUnreadCountsChange).toHaveBeenLastCalledWith({});
  });
});
