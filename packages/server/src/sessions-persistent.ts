/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 落盘版会话存储（被动保存 / P1）——兑现 sessions.ts 里「落盘版实现同接口即可热替换」。
 *
 * 之前 InMemorySessionStore 只把会话/消息放内存 Map，**app 一重启聊天记录全没**。
 * 这里在其之上做**写穿透 (write-through)**：启动时从磁盘把会话灌回内存，之后每次写
 * 都落一份到磁盘，下次打开原样还在。
 *
 * 为什么用 JSON 文件而不是 SQLite：内嵌 server 跑在 Electron 主进程里，其 Node（20.x）
 * **没有 node:sqlite**（Node 22.5+ 才有），better-sqlite3 又要按 Electron ABI 重编译
 * （打包麻烦）。纯 JSON 文件零原生依赖、在 Electron 里稳，同样保证「下次打开还在」。
 * 存储：每个会话一个 `<baseDir>/<sessionId>.json`（{summary, messages}），原子写（tmp+rename）。
 * 高频的流式 patchMessage 用去抖合并写盘；结构性/回合边界（建/追加/改名/状态）立即写盘，
 * 保证每轮对话结束即落地，硬退出至多丢正在流的半句。
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  InMemorySessionStore,
  type InMemorySessionStoreLimits,
} from './sessions.js';
import type {
  OttoMessage,
  SessionStatus,
  SessionSummary,
} from './protocol.js';

/** 流式 patch 的去抖写盘间隔（ms）。 */
const WRITE_DEBOUNCE_MS = 400;

export class PersistentSessionStore extends InMemorySessionStore {
  private readonly baseDir: string;
  /** hydrate 期间为 true：复用 super 写路径重建内存时，不要回写磁盘。 */
  private hydrating = false;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(baseDir: string, limits: InMemorySessionStoreLimits = {}) {
    super(limits);
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true });
    this.loadAll();
  }

  // ── 启动加载 ──

  private loadAll(): void {
    this.hydrating = true;
    try {
      let files: string[];
      try {
        files = readdirSync(this.baseDir).filter((f) => f.endsWith('.json'));
      } catch {
        return;
      }
      let restored = 0;
      for (const f of files) {
        try {
          const raw = readFileSync(join(this.baseDir, f), 'utf8');
          const { summary, messages } = JSON.parse(raw) as {
            summary: SessionSummary;
            messages: OttoMessage[];
          };
          if (!summary?.sessionId) continue;
          summary.status = 'idle'; // 重启后没有运行时在跑
          const clean = (messages ?? []).map((m) => ({
            ...m,
            // 清掉「进行中」态，否则 UI 会一直转圈。
            isStreaming: false,
            isProcessingTools: false,
          }));
          this.hydrate(summary, clean);
          restored++;
        } catch {
          // 单个坏文件跳过，不毁整次加载
        }
      }
      if (restored > 0) {
        console.log(`[sessions] 从本地恢复 ${restored} 个会话`);
      }
    } finally {
      this.hydrating = false;
    }
  }

  // ── 写穿透：super 改内存，再落盘 ──

  override createSession(init: Partial<SessionSummary> = {}): SessionSummary {
    const s = super.createSession(init);
    this.writeNow(s.sessionId);
    return s;
  }

  override appendMessage(
    ...args: Parameters<InMemorySessionStore['appendMessage']>
  ): OttoMessage {
    const m = super.appendMessage(...args);
    if (!this.isEphemeralSession(m.sessionId)) {
      this.writeNow(m.sessionId); // 新消息（含用户消息、助手消息起点）立即落地
    }
    return m;
  }

  override patchMessage(
    ...args: Parameters<InMemorySessionStore['patchMessage']>
  ): OttoMessage | undefined {
    const m = super.patchMessage(...args);
    if (m && !this.isEphemeralSession(m.sessionId)) {
      this.scheduleWrite(m.sessionId); // 流式高频更新 → 去抖合并
    }
    return m;
  }

  override setStatus(sessionId: string, status: SessionStatus): void {
    super.setStatus(sessionId, status);
    // 回合边界（尤其结束 idle）立即写盘，把这一轮流式的最终内容落地。
    if (!this.isEphemeralSession(sessionId)) this.writeNow(sessionId);
  }

  override patchSessionModel(sessionId: string, model: string): void {
    super.patchSessionModel(sessionId, model);
    if (!this.isEphemeralSession(sessionId)) this.writeNow(sessionId);
  }

  override renameSession(
    sessionId: string,
    title: string,
  ): SessionSummary | undefined {
    const s = super.renameSession(sessionId, title);
    if (s && !this.isEphemeralSession(sessionId)) this.writeNow(sessionId);
    return s;
  }

  override async deleteSession(sessionId: string): Promise<void> {
    await super.deleteSession(sessionId);
    this.cancelPending(sessionId);
    if (this.hydrating) return;
    try {
      rmSync(this.filePath(sessionId), { force: true });
    } catch (e) {
      this.warn('deleteSession', e);
    }
  }

  /** 把所有挂起的去抖写盘立即落地（app 退出前调用，保证不丢）。 */
  flush(): void {
    for (const id of [...this.pending.keys()]) this.writeNow(id);
  }

  // ── 内部 ──

  private filePath(sessionId: string): string {
    return join(this.baseDir, `${sessionId}.json`);
  }

  private scheduleWrite(sessionId: string): void {
    if (this.hydrating) return;
    const existing = this.pending.get(sessionId);
    if (existing) clearTimeout(existing);
    this.pending.set(
      sessionId,
      setTimeout(() => this.writeNow(sessionId), WRITE_DEBOUNCE_MS),
    );
  }

  private cancelPending(sessionId: string): void {
    const t = this.pending.get(sessionId);
    if (t) clearTimeout(t);
    this.pending.delete(sessionId);
  }

  /** 立即把某会话整体（摘要 + 消息）原子写到磁盘。 */
  private writeNow(sessionId: string): void {
    this.cancelPending(sessionId);
    if (this.hydrating) return;
    const summary = this.getSession(sessionId);
    if (!summary) return;
    const messages = this.getHistory(sessionId); // 全量（浅拷贝）
    try {
      const final = this.filePath(sessionId);
      const tmp = `${final}.tmp`;
      writeFileSync(tmp, JSON.stringify({ summary, messages }), 'utf8');
      renameSync(tmp, final); // 原子替换，避免写一半崩溃损坏
    } catch (e) {
      this.warn('writeNow', e);
    }
  }

  private warn(op: string, e: unknown): void {
    console.warn(
      `[sessions] 持久化 ${op} 失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
