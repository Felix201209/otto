/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { collectAuthorizedAtoaContext } from './a2aContext.js';

describe('A2A 授权资料收集', () => {
  it('只读取明确选择的资料，并把实际内容有界地交给隔离 Agent', async () => {
    const listMessages = vi.fn(async () => [
      {
        id: 'm1',
        senderAccountId: 'peer-1',
        recipientAccountId: 'me',
        content: '项目评审改到几点？',
        createdAt: '2026-07-20T08:00:00.000Z',
        readAt: null,
      },
    ]);
    const listKnowledge = vi.fn(async () => [
      {
        id: 'k1',
        organizationId: 'org-1',
        sourceId: null,
        department: '研发部',
        category: '项目',
        content: '评审必须预留 30 分钟。',
        contributor: 'Alice',
        confidence: 0.9,
        createdAt: '2026-07-20T07:00:00.000Z',
      },
    ]);
    const workLogRecent = vi.fn(async () => []);

    const result = await collectAuthorizedAtoaContext({
      sources: ['current_chat', 'schedules'],
      peerAccountId: 'peer-1',
      currentAccountId: 'me',
      currentAccountName: 'Bob',
      peerName: 'Alice',
      listMessages,
      listKnowledge,
      workLogRecent,
      schedules: [
        {
          id: 's1',
          title: '项目复盘',
          startAt: '2026-07-20T15:00:00.000Z',
          endAt: '2026-07-20T16:00:00.000Z',
          notes: '会议室 A',
          source: 'user',
          createdAt: '2026-07-20T00:00:00.000Z',
          updatedAt: '2026-07-20T00:00:00.000Z',
        },
      ],
    });

    expect(listMessages).toHaveBeenCalledWith('peer-1');
    expect(listKnowledge).not.toHaveBeenCalled();
    expect(workLogRecent).not.toHaveBeenCalled();
    expect(result.loadedSources).toEqual(['current_chat', 'schedules']);
    expect(result.context).toContain('Alice: 项目评审改到几点？');
    expect(result.context).toContain('项目复盘');
    expect(result.context).not.toContain('评审必须预留 30 分钟');
  });

  it('单个来源失败时不伪造已读取结果，并继续收集其他已授权来源', async () => {
    const result = await collectAuthorizedAtoaContext({
      sources: ['enterprise_knowledge', 'work_logs'],
      peerAccountId: 'peer-1',
      currentAccountId: 'me',
      currentAccountName: 'Bob',
      peerName: 'Alice',
      listMessages: vi.fn(async () => []),
      listKnowledge: vi.fn(async () => {
        throw new Error('知识服务不可用');
      }),
      workLogRecent: vi.fn(async () => [
        {
          date: '2026-07-20',
          entries: [
            {
              time: '10:00',
              category: '开发',
              action: '完成 A2A 权限测试',
              success: true,
              entryType: 'work_result' as const,
            },
          ],
        },
      ]),
      schedules: [],
    });

    expect(result.loadedSources).toEqual(['work_logs']);
    expect(result.failedSources).toEqual([
      { source: 'enterprise_knowledge', reason: '知识服务不可用' },
    ]);
    expect(result.context).toContain('完成 A2A 权限测试');
    expect(result.context).toContain('企业知识：读取失败');
  });

  it('空授权不调用任何数据源，且总上下文不超过 8000 字符', async () => {
    const listMessages = vi.fn(async () => []);
    const listKnowledge = vi.fn(async () => []);
    const workLogRecent = vi.fn(async () => []);
    const empty = await collectAuthorizedAtoaContext({
      sources: [],
      peerAccountId: 'peer-1',
      currentAccountId: 'me',
      currentAccountName: 'Bob',
      peerName: 'Alice',
      listMessages,
      listKnowledge,
      workLogRecent,
      schedules: [],
    });
    expect(empty.context).toContain('未授权任何资料');
    expect(listMessages).not.toHaveBeenCalled();
    expect(listKnowledge).not.toHaveBeenCalled();
    expect(workLogRecent).not.toHaveBeenCalled();

    const bounded = await collectAuthorizedAtoaContext({
      sources: ['enterprise_knowledge'],
      peerAccountId: 'peer-1',
      currentAccountId: 'me',
      currentAccountName: 'Bob',
      peerName: 'Alice',
      listMessages,
      listKnowledge: vi.fn(async () =>
        Array.from({ length: 100 }, (_, index) => ({
          id: `k-${index}`,
          organizationId: 'org-1',
          sourceId: null,
          department: null,
          category: '长内容',
          content: 'x'.repeat(2000),
          contributor: null,
          confidence: 1,
          createdAt: '2026-07-20T00:00:00.000Z',
        })),
      ),
      workLogRecent,
      schedules: [],
    });
    expect(bounded.context.length).toBeLessThanOrEqual(8000);
  });
});
