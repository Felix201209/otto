/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** PersistentSessionStore：写入 → 新建 store 读同一 DB（模拟重启）→ 原样恢复。 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentSessionStore } from './sessions-persistent.js';

const dirs: string[] = [];
/** 返回一个临时会话存储目录（store 会在其中每会话建一个 json）。 */
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'otto-sess-'));
  dirs.push(d);
  return join(d, 'sessions');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('PersistentSessionStore 落盘 + 重启恢复', () => {
  it('会话与消息重启后原样恢复（顺序、内容一致）', () => {
    const db = tmpDb();
    const a = new PersistentSessionStore(db);
    const s = a.createSession({ title: 'T1', source: 'local' });
    a.appendMessage(s.sessionId, {
      role: 'user',
      source: 'local',
      content: [{ type: 'text', value: 'hi' }],
    });
    a.appendMessage(s.sessionId, {
      role: 'assistant',
      source: 'local',
      content: [{ type: 'text', value: 'hello' }],
    });

    // 模拟重启：新 store 读同一 DB
    const b = new PersistentSessionStore(db);
    const list = b.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('T1');
    expect(list[0].messageCount).toBe(2);
    const hist = b.getHistory(list[0].sessionId);
    expect(hist.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(hist[1].content[0]).toMatchObject({ type: 'text', value: 'hello' });
  });

  it('rename 落盘、delete 落盘、重启后状态归一为 idle', async () => {
    const db = tmpDb();
    const a = new PersistentSessionStore(db);
    const keep = a.createSession({ title: 'old' });
    a.renameSession(keep.sessionId, 'new');
    a.setStatus(keep.sessionId, 'running'); // 运行态不该在重启后残留
    const gone = a.createSession({ title: 'todelete' });
    await a.deleteSession(gone.sessionId);

    const b = new PersistentSessionStore(db);
    const list = b.listSessions();
    expect(list.find((x) => x.sessionId === keep.sessionId)?.title).toBe('new');
    expect(list.find((x) => x.sessionId === keep.sessionId)?.status).toBe('idle');
    expect(list.find((x) => x.sessionId === gone.sessionId)).toBeUndefined();
  });

  it('重启后清掉「进行中」态（isStreaming=false）', () => {
    const db = tmpDb();
    const a = new PersistentSessionStore(db);
    const s = a.createSession({});
    const m = a.appendMessage(s.sessionId, {
      role: 'assistant',
      source: 'local',
      content: [{ type: 'text', value: 'streaming…' }],
      isStreaming: true,
    });
    expect(m.isStreaming).toBe(true);

    const b = new PersistentSessionStore(db);
    const hist = b.getHistory(s.sessionId);
    expect(hist[0].isStreaming).toBe(false);
  });

  it('工作目录切换后落盘并在重启后恢复', () => {
    const db = tmpDb();
    const a = new PersistentSessionStore(db);
    const session = a.createSession({});
    a.patchSessionWorkspace(session.sessionId, '/Users/test/project');
    expect(new PersistentSessionStore(db).getSession(session.sessionId)?.workspacePath)
      .toBe('/Users/test/project');
  });

  it('临时 A2A 会话只存在内存，消息与状态变化也绝不落盘', async () => {
    const db = tmpDb();
    const a = new PersistentSessionStore(db);
    const session = a.createEphemeralSession({
      title: 'A2A 临时会话',
      agentProfileId: 'otto-enterprise-a2a',
    });
    a.appendMessage(session.sessionId, {
      role: 'user',
      source: 'local',
      content: [{ type: 'text', value: '来自同事的问题' }],
    });
    a.setStatus(session.sessionId, 'thinking');
    a.flush();

    expect(a.isEphemeralSession(session.sessionId)).toBe(true);
    expect(a.getHistory(session.sessionId)).toHaveLength(1);
    expect(new PersistentSessionStore(db).listSessions()).toHaveLength(0);

    await a.deleteSession(session.sessionId);
    expect(a.isEphemeralSession(session.sessionId)).toBe(false);
  });
});
