/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildSessionsCard,
  buildSessionsCardMarkdown,
  formatDuration,
  SESSIONS_CARD_ELEMENT_ID,
  type SessionsCardData,
} from './sessionsCard.js';

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

function data(over: Partial<SessionsCardData> = {}): SessionsCardData {
  return {
    runningTasks: [],
    discovered: [],
    discovering: false,
    now: NOW,
    ...over,
  };
}

describe('formatDuration', () => {
  it('formats seconds, minutes, hours, days', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(65_000)).toBe('1m5s');
    expect(formatDuration(3_660_000)).toBe('1h1m');
    expect(formatDuration(90_000_000)).toBe('1d1h');
    expect(formatDuration(-100)).toBe('0s');
  });
});

describe('buildSessionsCardMarkdown', () => {
  it('renders a running task with live status (tool, plan, tokens, elapsed)', () => {
    const md = buildSessionsCardMarkdown(
      data({
        runningTasks: [
          {
            id: 'abc1234',
            agentLabel: 'Claude Code',
            title: 'implement auth',
            status: 'running',
            currentTool: 'Edit auth.ts',
            toolCallCount: 4,
            planDone: 2,
            planTotal: 5,
            tokenUsed: 3000,
            tokenSize: 10000,
            startTime: NOW - 65_000,
            sessionId: 'sess-abcdef12',
          },
        ],
      }),
    );
    expect(md).toContain('🟢 运行中');
    expect(md).toContain('Claude Code');
    expect(md).toContain('implement auth');
    expect(md).toContain('🔧 Edit auth.ts');
    expect(md).toContain('📋 2/5');
    expect(md).toContain('🛠️ 4 次工具');
    expect(md).toContain('📊 30%');
    expect(md).toContain('1m5s');
    expect(md).toContain('Task `abc1234`');
    expect(md).toContain('会话 `sess-abc'); // first 8 chars
  });

  it('shows the discovering placeholder while discovery is in flight', () => {
    const md = buildSessionsCardMarkdown(data({ discovering: true }));
    expect(md).toContain('正在查询本机 CLI 的会话');
    expect(md).toContain('暂无委派任务');
  });

  it('renders discovered sessions with a resume hint per agent', () => {
    const md = buildSessionsCardMarkdown(
      data({
        discovered: [
          {
            agent: 'claude-code',
            agentLabel: 'Claude Code',
            sessionId: 'cc-123',
            title: 'Fix the parser',
            cwd: '/proj',
            updatedAt: new Date(NOW - 3_600_000).toISOString(),
          },
          {
            agent: 'codex',
            agentLabel: 'Codex',
            sessionId: 'cx-999',
            title: null,
            cwd: '/proj',
            updatedAt: null,
          },
        ],
      }),
    );
    expect(md).toContain('Fix the parser');
    expect(md).toContain('@cc:resume cc-123');
    expect(md).toContain('@codex:resume cx-999');
    // Null title falls back to a short-id label.
    expect(md).toContain('会话 cx-999');
    expect(md).toContain('1h0m前');
  });

  it('surfaces discovery errors', () => {
    const md = buildSessionsCardMarkdown(
      data({ discoverErrors: ['Codex: 未登录'] }),
    );
    expect(md).toContain('⚠️ Codex: 未登录');
  });
});

describe('buildSessionsCard', () => {
  it('produces a CardKit 2.0 card with a header and the dashboard element', () => {
    const card = buildSessionsCard(data({ runningTasks: [] })) as {
      schema: string;
      header: { title: { content: string } };
      body: { elements: Array<{ element_id: string; tag: string }> };
    };
    expect(card.schema).toBe('2.0');
    expect(card.header.title.content).toBe('本机 Agent 会话');
    expect(card.body.elements[0].element_id).toBe(SESSIONS_CARD_ELEMENT_ID);
    expect(card.body.elements[0].tag).toBe('markdown');
  });
});
