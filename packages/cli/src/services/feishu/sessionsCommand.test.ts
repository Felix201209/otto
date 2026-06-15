/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getBackgroundTaskManager,
  resetBackgroundTaskManager,
  type ListExternalSessionsOptions,
  type ListExternalSessionsResult,
} from 'otto-core';
import {
  handleSessionsCommand,
  taskToRunningView,
  type SessionsCardGateway,
} from './sessionsCommand.js';

/** Captures every card op so tests can assert on the rendered markdown. */
class FakeGateway implements SessionsCardGateway {
  created: Array<Record<string, unknown>> = [];
  sentCardIds: string[] = [];
  updates: Array<{ cardId: string; card: Record<string, unknown>; seq: number }> = [];
  messages: string[] = [];
  cardIdToReturn: string | null = 'card-1';

  async createCardKitCard(card: Record<string, unknown>): Promise<string | null> {
    this.created.push(card);
    return this.cardIdToReturn;
  }
  async sendCardKitMessage(_chatId: string, cardId: string): Promise<string | null> {
    this.sentCardIds.push(cardId);
    return 'msg-1';
  }
  async updateCardKitCard(
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<boolean> {
    this.updates.push({ cardId, card, seq: sequence });
    return true;
  }
  async sendMessage(_chatId: string, text: string): Promise<unknown> {
    this.messages.push(text);
    return 'msg-2';
  }
}

function bodyOf(card: Record<string, unknown>): string {
  const body = card['body'] as { elements: Array<{ content: string }> };
  return body.elements[0].content;
}

function discoverStub(
  byAgent: Partial<Record<string, ListExternalSessionsResult>>,
): (opts: ListExternalSessionsOptions) => Promise<ListExternalSessionsResult> {
  return async (opts) =>
    byAgent[opts.agent] ?? {
      agent: opts.agent,
      agentLabel: opts.agent,
      supported: true,
      sessions: [],
    };
}

beforeEach(() => {
  resetBackgroundTaskManager();
});

describe('taskToRunningView', () => {
  it('strips the [label] prefix and derives plan progress', () => {
    const mgr = getBackgroundTaskManager();
    const task = mgr.createTask('[Codex] do the thing', '/p', 'codex');
    task.plan = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ];
    const view = taskToRunningView(task);
    expect(view.agentLabel).toBe('Codex');
    expect(view.title).toBe('do the thing');
    expect(view.planDone).toBe(1);
    expect(view.planTotal).toBe(2);
  });
});

describe('handleSessionsCommand', () => {
  it('sends an instant card then updates it with discovered sessions', async () => {
    const mgr = getBackgroundTaskManager();
    mgr.createTask('[Claude Code] implement X', '/p', 'claude-code');

    const gw = new FakeGateway();
    await handleSessionsCommand({
      gateway: gw,
      chatId: 'c1',
      disableLiveRefresh: true,
      discover: discoverStub({
        'claude-code': {
          agent: 'claude-code',
          agentLabel: 'Claude Code',
          supported: true,
          sessions: [
            {
              agent: 'claude-code',
              agentLabel: 'Claude Code',
              sessionId: 'cc-1',
              title: 'Old session',
              cwd: '/p',
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      }),
    });

    // Initial card sent.
    expect(gw.created.length).toBe(1);
    expect(gw.sentCardIds).toEqual(['card-1']);
    expect(bodyOf(gw.created[0])).toContain('正在查询本机 CLI 的会话');
    expect(bodyOf(gw.created[0])).toContain('implement X');

    // Updated card carries discovered sessions and drops the placeholder.
    expect(gw.updates.length).toBeGreaterThanOrEqual(1);
    const last = gw.updates[gw.updates.length - 1];
    expect(last.seq).toBeGreaterThanOrEqual(1);
    const finalBody = bodyOf(last.card);
    expect(finalBody).toContain('Old session');
    expect(finalBody).toContain('@cc:resume cc-1');
    expect(finalBody).not.toContain('正在查询本机 CLI 的会话');
  });

  it('falls back to a plain message when CardKit is unavailable', async () => {
    const gw = new FakeGateway();
    gw.cardIdToReturn = null;
    await handleSessionsCommand({
      gateway: gw,
      chatId: 'c1',
      disableLiveRefresh: true,
      discover: discoverStub({}),
    });
    expect(gw.sentCardIds).toEqual([]);
    expect(gw.messages.length).toBe(1);
    expect(gw.messages[0]).toContain('本机任务');
  });

  it('surfaces a discovery error (e.g. CLI not logged in)', async () => {
    const gw = new FakeGateway();
    await handleSessionsCommand({
      gateway: gw,
      chatId: 'c1',
      disableLiveRefresh: true,
      discover: discoverStub({
        codex: {
          agent: 'codex',
          agentLabel: 'Codex',
          supported: false,
          sessions: [],
          error: 'Codex exited before answering session/list.',
        },
      }),
    });
    const last = gw.updates[gw.updates.length - 1];
    expect(bodyOf(last.card)).toContain('⚠️');
    expect(bodyOf(last.card)).toContain('Codex');
  });
});
