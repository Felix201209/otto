import { describe, expect, it } from 'vitest';
import {
  parseEnterpriseMessageTimestamp,
  positionEnterpriseTrayPopover,
  renderEnterpriseTrayPopoverHtml,
  summarizeEnterpriseTrayContacts,
} from './enterprise-tray-popover.js';

function unread(input: Partial<{
  id: string;
  senderAccountId: string;
  senderName: string;
  preview: string;
  createdAt: string;
  count: number;
}> = {}) {
  return {
    id: 'message-1',
    source: 'enterprise' as const,
    title: 'Alice 发来消息',
    senderAccountId: 'alice',
    senderName: 'Alice',
    preview: '项目方案我已经发给你了，请查收。',
    createdAt: '2026-07-26T08:00:00.000Z',
    ...input,
  };
}

describe('enterprise tray message popover', () => {
  it('treats legacy SQLite timestamps without a timezone as UTC', () => {
    expect(parseEnterpriseMessageTimestamp('2026-07-28 03:51:00')).toBe(
      Date.parse('2026-07-28T03:51:00.000Z'),
    );
  });

  it('按发送人聚合未读数量并保留最新的真实消息', () => {
    expect(summarizeEnterpriseTrayContacts([
      unread({ id: 'older', preview: '旧消息', createdAt: '2026-07-26T07:00:00.000Z' }),
      unread({ id: 'latest', preview: '最新消息内容', createdAt: '2026-07-26T09:00:00.000Z' }),
      unread({
        id: 'bob-message',
        senderAccountId: 'bob',
        senderName: 'Bob',
        preview: '请看一下附件',
        createdAt: '2026-07-26T08:30:00.000Z',
      }),
    ])).toEqual([
      expect.objectContaining({
        accountId: 'alice',
        name: 'Alice',
        preview: '最新消息内容',
        count: 2,
      }),
      expect.objectContaining({
        accountId: 'bob',
        preview: '请看一下附件',
        count: 1,
      }),
    ]);
  });

  it('preserves the backend unread count for an encrypted federation contact', () => {
    expect(summarizeEnterpriseTrayContacts([
      unread({
        senderAccountId: 'federation:contact-remote',
        senderName: '远程同事',
        preview: '收到一条端到端加密的跨服务器消息',
        count: 7,
      }),
    ])).toEqual([
      expect.objectContaining({
        accountId: 'federation:contact-remote',
        count: 7,
      }),
    ]);
  });

  it('渲染美化后的消息摘要并转义不可信内容', () => {
    const html = renderEnterpriseTrayPopoverHtml([
      {
        accountId: 'alice/研发',
        name: '<Alice>',
        preview: '<img src=x onerror=alert(1)> 项目方案已更新',
        count: 3,
        createdAt: '2026-07-26T08:00:00.000Z',
      },
    ], { now: Date.parse('2026-07-26T08:05:00.000Z') });

    expect(html).toContain('未读提醒');
    expect(html).toContain('5 分钟前');
    expect(html).toContain('&lt;Alice&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; 项目方案已更新');
    expect(html).toContain('otto-tray://message/alice%2F%E7%A0%94%E5%8F%91');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('把浮窗约束在托盘所在显示器的工作区内', () => {
    expect(positionEnterpriseTrayPopover(
      { x: 1880, y: 1040, width: 24, height: 24 },
      { x: 0, y: 0, width: 1920, height: 1040 },
      { width: 392, height: 420 },
    )).toEqual({ x: 1516, y: 608 });
  });
});
