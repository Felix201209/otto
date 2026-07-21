/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  supported: true,
  instances: [] as Array<{
    options: { title: string; body: string; silent: boolean };
    handlers: Record<string, () => void>;
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('electron', () => ({
  Notification: class MockNotification {
    static isSupported(): boolean {
      return electron.supported;
    }

    handlers: Record<string, () => void> = {};
    show = vi.fn();
    close = vi.fn();

    constructor(public options: { title: string; body: string; silent: boolean }) {
      electron.instances.push(this);
    }

    on(event: string, handler: () => void): void {
      this.handlers[event] = handler;
    }
  },
}));

import {
  EnterpriseNotificationIdentityBoundary,
  NotificationService,
} from './notification-service.js';

describe('NotificationService', () => {
  beforeEach(() => {
    electron.supported = true;
    electron.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('系统通知不可用时仍保留 Otto 内未读闪烁点', () => {
    electron.supported = false;
    const onUnreadChange = vi.fn();
    const service = new NotificationService();
    service.registerCallbacks({ onUnreadChange, onNotificationClick: vi.fn() });

    service.show({ sessionId: 's1', source: 'atoa', preview: '请查看消息' });

    expect(electron.instances).toHaveLength(0);
    expect(service.getUnreadSessions()).toEqual(['s1']);
    expect(onUnreadChange).toHaveBeenLastCalledWith(['s1']);
  });

  it('系统弹窗五秒后消失，但未读点保留到用户真正读过', () => {
    const service = new NotificationService();
    service.show({ sessionId: 's1', source: 'feishu', sender: '小王', preview: '开会吗？' });
    expect(electron.instances).toHaveLength(1);
    expect(electron.instances[0].options.title).toBe('飞书消息 · 小王');
    expect(electron.instances[0].show).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(5_000);
    expect(electron.instances[0].close).toHaveBeenCalledOnce();
    expect(service.getUnreadSessions()).toEqual(['s1']);
  });

  it('点击系统弹窗会清未读并把会话交给 renderer 打开', () => {
    const onUnreadChange = vi.fn();
    const onNotificationClick = vi.fn();
    const service = new NotificationService();
    service.registerCallbacks({ onUnreadChange, onNotificationClick });
    service.show({ sessionId: 's1', source: 'enterprise', preview: '新消息' });

    electron.instances[0].handlers.click();

    expect(service.getUnreadSessions()).toEqual([]);
    expect(onUnreadChange).toHaveBeenLastCalledWith([]);
    expect(onNotificationClick).toHaveBeenCalledWith('s1');
  });

  it('企业合成通知点击只打开 Otto，未真正读取会话前保留未读', () => {
    const onUnreadChange = vi.fn();
    const onNotificationClick = vi.fn();
    const service = new NotificationService();
    service.registerCallbacks({ onUnreadChange, onNotificationClick });
    service.show({
      sessionId: 'enterprise:message:alice',
      source: 'enterprise',
      preview: '新消息',
    });

    electron.instances[0].handlers.click();

    expect(service.getUnreadSessions()).toEqual(['enterprise:message:alice']);
    expect(onNotificationClick).toHaveBeenCalledWith('enterprise:message:alice');
  });

  it('同一条外部入站 messageId 只进 main 通知一次', () => {
    const onUnreadChange = vi.fn();
    const service = new NotificationService();
    service.registerCallbacks({ onUnreadChange, onNotificationClick: vi.fn() });
    const payload = {
      messageId: 'feishu-message-1',
      sessionId: 'feishu-session-1',
      source: 'feishu',
      preview: '同一条飞书消息',
    };

    service.show(payload);
    service.show(payload);

    expect(electron.instances).toHaveLength(1);
    expect(onUnreadChange).toHaveBeenCalledTimes(1);
    expect(service.getUnreadSessions()).toEqual(['feishu-session-1']);
  });

  it('园区系统通知进入统一服务，退出或切换身份时可连 toast 和未读一起清理', () => {
    const service = new NotificationService();
    service.show({
      sessionId: 'park:service',
      source: 'park',
      title: 'Otto 待处理提醒 · 园区服务',
      preview: 'A 座空调报修',
    });

    expect(electron.instances[0].options.title).toBe('Otto 待处理提醒 · 园区服务');
    expect(service.getUnreadSessions()).toEqual(['park:service']);

    service.clearAll();

    expect(electron.instances[0].close).toHaveBeenCalledOnce();
    expect(service.getUnreadSessions()).toEqual([]);
  });

  it('企业身份仅在账号或组织变化时清通知和文件授权，并且失败提交不前移身份指纹', async () => {
    const clearNotifications = vi.fn();
    const clearFileAccessGrants = vi.fn();
    const boundary = new EnterpriseNotificationIdentityBoundary(
      clearNotifications,
      clearFileAccessGrants,
    );
    const apply = vi.fn(async () => undefined);
    const accountA = { id: 'account-a', organizationId: 'org-a', leaseExpiresAt: 'first' };

    await boundary.synchronize(null, apply);
    await boundary.synchronize(accountA, apply);
    await boundary.synchronize({ ...accountA, leaseExpiresAt: 'refreshed' }, apply);
    expect(clearNotifications).toHaveBeenCalledTimes(1);
    expect(clearFileAccessGrants).toHaveBeenCalledTimes(1);

    const failedApply = vi.fn(async () => {
      throw new Error('identity sync failed');
    });
    await expect(boundary.synchronize(
      { id: 'account-b', organizationId: 'org-b' },
      failedApply,
    )).rejects.toThrow('identity sync failed');
    expect(clearNotifications).toHaveBeenCalledTimes(2);
    expect(clearFileAccessGrants).toHaveBeenCalledTimes(2);

    await boundary.synchronize({ ...accountA, leaseExpiresAt: 'still-a' }, apply);
    expect(clearNotifications).toHaveBeenCalledTimes(2);
    await boundary.synchronize(null, apply);
    expect(clearNotifications).toHaveBeenCalledTimes(3);
    expect(clearFileAccessGrants).toHaveBeenCalledTimes(3);
  });
});
