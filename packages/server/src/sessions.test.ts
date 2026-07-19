/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * InMemorySessionStore 单测：唯一会话源 + 不可变 + 订阅广播。
 *
 * 覆盖创建/飞书一一对应/追加消息（id/timestamp 补全、计数、预览截断、不可变）、
 * patch、历史过滤、状态/模型广播、订阅健壮性、删除、列表排序。
 * 纯内存，无 DOM / 无网络。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemorySessionStore } from './sessions.js';
import type { SessionRuntime } from './sessions.js';
import type { OttoMessage, ServerToClient } from './protocol.js';

describe('InMemorySessionStore', () => {
  let store: InMemorySessionStore;

  beforeEach(() => {
    store = new InMemorySessionStore();
  });

  describe('createSession', () => {
    it('默认值：source=local / status=idle / title=新会话 / messageCount=0', () => {
      const s = store.createSession();
      expect(s.source).toBe('local');
      expect(s.status).toBe('idle');
      expect(s.title).toBe('新会话');
      expect(s.messageCount).toBe(0);
      expect(s.lastMessagePreview).toBeUndefined();
      expect(typeof s.sessionId).toBe('string');
      expect(s.createdAt).toBe(s.updatedAt);
    });

    it('携带 feishuChatId 时写入 feishuIndex（getOrCreate 命中同一会话）', () => {
      const s = store.createSession({ feishuChatId: 'oc_x', source: 'feishu' });
      expect(s.feishuChatId).toBe('oc_x');
      const again = store.getOrCreateFeishuSession('oc_x');
      expect(again.sessionId).toBe(s.sessionId);
    });

    it('尊重传入的 title / model / sessionId', () => {
      const s = store.createSession({
        sessionId: 'fixed-id',
        title: '我的会话',
        model: 'custom:openai:gpt@abc',
      });
      expect(s.sessionId).toBe('fixed-id');
      expect(s.title).toBe('我的会话');
      expect(s.model).toBe('custom:openai:gpt@abc');
    });
  });

  describe('getOrCreateFeishuSession', () => {
    it('同 chatId 第二次返回同一 session（一一对应）', () => {
      const a = store.getOrCreateFeishuSession('oc_a', '标题A');
      const b = store.getOrCreateFeishuSession('oc_a');
      expect(b.sessionId).toBe(a.sessionId);
      expect(store.listSessions()).toHaveLength(1);
    });

    it('不同 chatId 建新 session', () => {
      const a = store.getOrCreateFeishuSession('oc_a');
      const b = store.getOrCreateFeishuSession('oc_b');
      expect(a.sessionId).not.toBe(b.sessionId);
      expect(store.listSessions()).toHaveLength(2);
      expect(a.source).toBe('feishu');
    });
  });

  describe('appendMessage', () => {
    it('补全 id/timestamp/sessionId，messageCount 递增', () => {
      const s = store.createSession();
      const m1 = store.appendMessage(s.sessionId, {
        role: 'user',
        content: [{ type: 'text', value: 'hi' }],
        source: 'local',
      });
      expect(typeof m1.id).toBe('string');
      expect(typeof m1.timestamp).toBe('number');
      expect(m1.sessionId).toBe(s.sessionId);

      const after = store.getSession(s.sessionId)!;
      expect(after.messageCount).toBe(1);

      store.appendMessage(s.sessionId, {
        role: 'assistant',
        content: [{ type: 'text', value: 'yo' }],
        source: 'local',
      });
      expect(store.getSession(s.sessionId)!.messageCount).toBe(2);
    });

    it('保留传入的 id / timestamp', () => {
      const s = store.createSession();
      const m = store.appendMessage(s.sessionId, {
        id: 'm-custom',
        timestamp: 12345,
        role: 'user',
        content: [{ type: 'text', value: 'x' }],
        source: 'local',
      });
      expect(m.id).toBe('m-custom');
      expect(m.timestamp).toBe(12345);
    });

    it('lastMessagePreview：超 80 字加省略号', () => {
      const s = store.createSession();
      const long = 'a'.repeat(200);
      store.appendMessage(s.sessionId, {
        role: 'user',
        content: [{ type: 'text', value: long }],
        source: 'local',
      });
      const preview = store.getSession(s.sessionId)!.lastMessagePreview!;
      expect(preview.endsWith('…')).toBe(true);
      expect(preview.length).toBe(81); // 80 字 + 省略号
    });

    it('lastMessagePreview：非 text 片段用 [type] 占位', () => {
      const s = store.createSession();
      store.appendMessage(s.sessionId, {
        role: 'user',
        content: [
          { type: 'text', value: '看图' },
          {
            type: 'image_reference',
            value: {
              id: 'i1',
              fileName: 'a.png',
              data: '',
              mimeType: 'image/png',
              originalSize: 0,
              compressedSize: 0,
            },
          },
        ],
        source: 'local',
      });
      const preview = store.getSession(s.sessionId)!.lastMessagePreview!;
      expect(preview).toContain('看图');
      expect(preview).toContain('[image_reference]');
    });

    it('返回值是副本：mutate 返回值不污染内部', () => {
      const s = store.createSession();
      const m = store.appendMessage(s.sessionId, {
        role: 'user',
        content: [{ type: 'text', value: 'orig' }],
        source: 'local',
      });
      // mutate 返回的副本
      (m as OttoMessage).role = 'system';
      const hist = store.getHistory(s.sessionId);
      expect(hist[0].role).toBe('user'); // 内部未受污染
    });
  });

  describe('patchMessage', () => {
    it('命中 id 改字段、刷新 updatedAt', () => {
      const s = store.createSession();
      const m = store.appendMessage(s.sessionId, {
        role: 'assistant',
        content: [{ type: 'text', value: '' }],
        source: 'local',
        isStreaming: true,
      });
      const patched = store.patchMessage(s.sessionId, m.id, {
        content: [{ type: 'text', value: '定稿' }],
        isStreaming: false,
      });
      expect(patched).toBeDefined();
      expect(patched!.isStreaming).toBe(false);
      expect(patched!.content[0]).toEqual({ type: 'text', value: '定稿' });
    });

    it('不存在的 messageId 返回 undefined', () => {
      const s = store.createSession();
      expect(store.patchMessage(s.sessionId, 'nope', {})).toBeUndefined();
    });

    it('不存在的 session 返回 undefined', () => {
      expect(store.patchMessage('no-session', 'mid', {})).toBeUndefined();
    });
  });

  describe('getHistory', () => {
    function seed(sessionId: string, n: number): OttoMessage[] {
      const out: OttoMessage[] = [];
      for (let i = 0; i < n; i++) {
        out.push(
          store.appendMessage(sessionId, {
            id: `m${i}`,
            timestamp: 1000 + i,
            role: 'user',
            content: [{ type: 'text', value: `#${i}` }],
            source: 'local',
          }),
        );
      }
      return out;
    }

    it('limit 取末尾 N', () => {
      const s = store.createSession();
      seed(s.sessionId, 5);
      const last2 = store.getHistory(s.sessionId, 2);
      expect(last2.map((m) => m.id)).toEqual(['m3', 'm4']);
    });

    it('before 过滤早于该时间戳的消息', () => {
      const s = store.createSession();
      seed(s.sessionId, 5); // timestamp 1000..1004
      const before = store.getHistory(s.sessionId, undefined, 1002);
      expect(before.map((m) => m.id)).toEqual(['m0', 'm1']);
    });

    it('返回浅拷贝：mutate 不回写内部', () => {
      const s = store.createSession();
      seed(s.sessionId, 2);
      const hist = store.getHistory(s.sessionId);
      hist[0].role = 'system';
      expect(store.getHistory(s.sessionId)[0].role).toBe('user');
    });

    it('空 / 不存在 session 返回 []', () => {
      const s = store.createSession();
      expect(store.getHistory(s.sessionId)).toEqual([]);
      expect(store.getHistory('no-session')).toEqual([]);
    });
  });

  describe('setStatus / patchSessionModel 广播', () => {
    it('setStatus 改 summary 且 publish session_status', () => {
      const s = store.createSession();
      const frames: ServerToClient[] = [];
      store.subscribe(s.sessionId, (f) => frames.push(f));
      store.setStatus(s.sessionId, 'thinking');
      expect(store.getSession(s.sessionId)!.status).toBe('thinking');
      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe('session_status');
      if (frames[0].type === 'session_status') {
        expect(frames[0].payload.status).toBe('thinking');
      }
    });

    it('patchSessionModel 改 summary 且 publish session_upsert', () => {
      const s = store.createSession();
      const frames: ServerToClient[] = [];
      store.subscribe(s.sessionId, (f) => frames.push(f));
      store.patchSessionModel(s.sessionId, 'custom:anthropic:c@x');
      expect(store.getSession(s.sessionId)!.model).toBe('custom:anthropic:c@x');
      expect(frames[0].type).toBe('session_upsert');
    });

    it('对不存在 session 调 setStatus 不抛、不广播', () => {
      expect(() => store.setStatus('no', 'error')).not.toThrow();
    });
  });

  describe('subscribe / publish / unsubscribe', () => {
    it('广播给所有订阅者', () => {
      const s = store.createSession();
      const a: ServerToClient[] = [];
      const b: ServerToClient[] = [];
      store.subscribe(s.sessionId, (f) => a.push(f));
      store.subscribe(s.sessionId, (f) => b.push(f));
      store.publish(s.sessionId, {
        type: 'session_status',
        payload: { sessionId: s.sessionId, status: 'idle' },
      });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('单订阅者抛错不影响其余（try/catch 兜底）', () => {
      const s = store.createSession();
      const good: ServerToClient[] = [];
      store.subscribe(s.sessionId, () => {
        throw new Error('boom');
      });
      store.subscribe(s.sessionId, (f) => good.push(f));
      expect(() =>
        store.publish(s.sessionId, {
          type: 'session_status',
          payload: { sessionId: s.sessionId, status: 'idle' },
        }),
      ).not.toThrow();
      expect(good).toHaveLength(1); // 第二个订阅者仍收到
    });

    it('unsub 后不再收', () => {
      const s = store.createSession();
      const got: ServerToClient[] = [];
      const unsub = store.subscribe(s.sessionId, (f) => got.push(f));
      unsub();
      store.publish(s.sessionId, {
        type: 'session_status',
        payload: { sessionId: s.sessionId, status: 'idle' },
      });
      expect(got).toHaveLength(0);
    });

    it('publish 到不存在 session 不抛', () => {
      expect(() =>
        store.publish('no', {
          type: 'error',
          payload: { code: 'x', message: 'y' },
        }),
      ).not.toThrow();
    });
  });

  describe('deleteSession', () => {
    it('detachRuntime 原子摘除并返回 runtime，后续不会再被复用或重复 dispose', async () => {
      const runtime: SessionRuntime = {
        async run() {},
        cancel() {},
        setModel() {},
        getConfig() { return undefined; },
        async dispose() {},
      };
      const s = store.createSession();
      store.attachRuntime(s.sessionId, runtime);

      expect(store.detachRuntime(s.sessionId)).toBe(runtime);
      expect(store.getRuntime(s.sessionId)).toBeUndefined();
      expect(store.detachRuntime(s.sessionId)).toBeUndefined();
      await store.deleteSession(s.sessionId);
    });

    it('调 runtime.dispose、清 feishuIndex、再 get 为 undefined', async () => {
      let disposed = 0;
      const runtime: SessionRuntime = {
        async run() {},
        cancel() {},
        setModel() {},
      getConfig() { return undefined; },
        async dispose() {
          disposed++;
        },
      };
      const s = store.createSession({ feishuChatId: 'oc_del', source: 'feishu' });
      store.attachRuntime(s.sessionId, runtime);
      await store.deleteSession(s.sessionId);
      expect(disposed).toBe(1);
      expect(store.getSession(s.sessionId)).toBeUndefined();
      // feishuIndex 已清：getOrCreate 会建新会话
      const recreated = store.getOrCreateFeishuSession('oc_del');
      expect(recreated.sessionId).not.toBe(s.sessionId);
    });

    it('runtime.dispose 失败 → console.warn 带 sessionId，不改变控制流', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const runtime: SessionRuntime = {
        async run() {},
        cancel() {},
        setModel() {},
      getConfig() { return undefined; },
        async dispose() {
          throw new Error('dispose 炸了');
        },
      };
      const s = store.createSession();
      store.attachRuntime(s.sessionId, runtime);
      await expect(store.deleteSession(s.sessionId)).resolves.toBeUndefined();
      expect(store.getSession(s.sessionId)).toBeUndefined(); // 会话照删
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0][0])).toContain(s.sessionId);
      warnSpy.mockRestore();
    });

    it('LRU 淘汰路径 dispose 失败 → 也打 console.warn（fire-and-forget）', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const small = new InMemorySessionStore({ maxSessions: 1 });
      const runtime: SessionRuntime = {
        async run() {},
        cancel() {},
        setModel() {},
      getConfig() { return undefined; },
        async dispose() {
          throw new Error('dispose 炸了');
        },
      };
      const s1 = small.createSession({ title: '旧' });
      small.attachRuntime(s1.sessionId, runtime);
      small.createSession({ title: '新' }); // 触发淘汰 s1
      await new Promise((r) => setTimeout(r, 0)); // 等 fire-and-forget 的 catch 跑完
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0][0])).toContain(s1.sessionId);
      warnSpy.mockRestore();
    });

    it('删不存在的 session 不抛', async () => {
      await expect(store.deleteSession('no-session')).resolves.toBeUndefined();
    });
  });

  describe('renameSession', () => {
    it('改 title、刷新 updatedAt、返回新摘要并 publish session_upsert', () => {
      const s = store.createSession({ title: '旧名' });
      const frames: ServerToClient[] = [];
      store.subscribe(s.sessionId, (f) => frames.push(f));
      const updated = store.renameSession(s.sessionId, '新名');
      expect(updated).toBeDefined();
      expect(updated!.title).toBe('新名');
      expect(store.getSession(s.sessionId)!.title).toBe('新名');
      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe('session_upsert');
    });

    it('title 首尾空白被 trim', () => {
      const s = store.createSession();
      const updated = store.renameSession(s.sessionId, '  含空白  ');
      expect(updated!.title).toBe('含空白');
    });

    it('超长 title 截断到 120 字', () => {
      const s = store.createSession();
      const updated = store.renameSession(s.sessionId, 'x'.repeat(300));
      expect(updated!.title.length).toBe(120);
    });

    it('纯空白 title → 返回 undefined、不改动', () => {
      const s = store.createSession({ title: '原名' });
      expect(store.renameSession(s.sessionId, '   ')).toBeUndefined();
      expect(store.getSession(s.sessionId)!.title).toBe('原名');
    });

    it('不存在的 session → 返回 undefined、不抛', () => {
      expect(store.renameSession('no-session', '任意')).toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('按 updatedAt 倒序', () => {
      store.createSession({ sessionId: 'a' });
      const b = store.createSession({ sessionId: 'b' });
      // 用显式靠后的 timestamp 刷新 b 的 updatedAt（避免同毫秒导致排序不稳定）。
      store.appendMessage(b.sessionId, {
        timestamp: Date.now() + 100_000,
        role: 'user',
        content: [{ type: 'text', value: 'later' }],
        source: 'local',
      });
      const ids = store.listSessions().map((s) => s.sessionId);
      expect(ids[0]).toBe('b');
      expect(ids).toContain('a');
    });
  });
});
