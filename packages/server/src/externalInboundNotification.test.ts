/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ServerToClient, SessionSummary } from './protocol.js';
import { externalInboundNotificationFromFrame } from './externalInboundNotification.js';

const session: SessionSummary = {
  sessionId: 'feishu-session',
  source: 'feishu',
  title: '项目群',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messageCount: 1,
};

function start(source: 'local' | 'feishu', role: 'user' | 'assistant'): ServerToClient {
  return {
    type: 'message_start',
    payload: {
      message: {
        id: 'm1', sessionId: session.sessionId, role,
        content: [{ type: 'text', value: '请看一下' }],
        timestamp: 1, source,
      },
    },
  };
}

describe('externalInboundNotificationFromFrame', () => {
  it('飞书 user 入站生成独立通知帧并带 messageId 去重键', () => {
    expect(externalInboundNotificationFromFrame(start('feishu', 'user'), session)).toEqual({
      type: 'external_inbound_notification',
      payload: {
        messageId: 'm1',
        sessionId: 'feishu-session',
        source: 'feishu',
        sender: '项目群',
        preview: '请看一下',
      },
    });
  });

  it('本地 user 和外部 assistant 都不产生入站通知', () => {
    expect(externalInboundNotificationFromFrame(start('local', 'user'), session)).toBeNull();
    expect(externalInboundNotificationFromFrame(start('feishu', 'assistant'), session)).toBeNull();
  });
});
