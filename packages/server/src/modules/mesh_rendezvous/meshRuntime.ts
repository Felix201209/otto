/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 运行时：relay 会话生命周期（内存短时驻留）、TTL、背压、配额、DDoS。
 *
 * relay 只做「牵线搭桥」：
 *  - 根服务器为一次会话签发短时 ticket；
 *  - 双方通过会话 ID 拉取/投递端到端密文块；
 *  - 密文块仅驻留内存，带 TTL/字节/块数上限；
 *  - P2P 成功后销毁全部 relay 状态，并落一条路径收据。
 */

import { randomBytes, randomUUID } from 'node:crypto';

import {
  MESH_RELAY_CHUNK_MAX_BYTES,
  MESH_RELAY_SESSION_MAX_BYTES,
  MESH_RELAY_SESSION_MAX_CHUNKS,
  MESH_RELAY_SESSION_TTL_MS,
  MESH_RELAY_TICKET_TTL_MS,
  type MeshBackpressureState,
  type MeshNatSession,
  type MeshPathReceipt,
  type MeshRelayTicket,
} from './meshContracts.js';

export interface MeshRelayChunk {
  chunkId: string;
  /** 发送方节点 ID（用于路由返回路径）。 */
  from: string;
  /** 端到端密文块（base64url），根服务器不解析。 */
  ciphertext: string;
  createdAt: number;
  expiresAt: number;
}

export interface MeshRuntimeOptions {
  /** 单位窗口内单 scope 最大请求数（DDoS/配额）。 */
  maxRequestsPerWindow?: number;
  /** 单位窗口内单 scope 最大字节数。 */
  maxBytesPerWindow?: number;
  /** 单 scope 最大并发会话数。 */
  maxConnectionsPerScope?: number;
  /** 配额窗口长度（毫秒）。 */
  quotaWindowMs?: number;
  /** 超过该请求数后触发 throttle（背压）。 */
  throttleThreshold?: number;
  /** 超过该请求数后触发 block。 */
  blockThreshold?: number;
  now?(): number;
}

export interface MeshRuntimeRepository {
  getNatSession(sessionId: string): MeshNatSession | null;
  saveNatSession(session: MeshNatSession): void;
  destroyNatSession(sessionId: string): boolean;
  getQuotaBucket(scope: string, windowMs: number): {
    windowStartedAt: number;
    requestCount: number;
    byteCount: number;
    connectionCount: number;
  };
  addQuotaUsage(
    scope: string,
    windowMs: number,
    usage: { requests?: number; bytes?: number; connections?: number },
  ): void;
  getDdosDecision(source: string): {
    decision: 'allow' | 'throttle' | 'block';
    reason: string;
  } | null;
  setDdosDecision(decision: {
    source: string;
    decision: 'allow' | 'throttle' | 'block';
    reason: string;
    decidedAt: number;
    expiresAt: number;
  }): void;
  savePathReceipt(receipt: MeshPathReceipt): void;
}

export interface MeshRuntimeServices extends MeshRuntimeRepository {
  newSessionId(): string;
  newChunkId(): string;
  newReceiptId(): string;
  now(): number;
}

export class MeshRendezvousRuntime {
  readonly #services: MeshRuntimeServices;
  readonly #options: Required<MeshRuntimeOptions>;
  /** sessionId -> Map<chunkId, chunk> */
  readonly #relay = new Map<string, Map<string, MeshRelayChunk>>();
  /** sessionId -> { nodeA: lastCreatedAt, nodeB: lastCreatedAt } 拉取游标 */
  readonly #cursor = new Map<string, { nodeA: number; nodeB: number }>();
  /** sessionId -> 该会话占用的 scope（用于并发计数回落） */
  readonly #sessionScope = new Map<string, string>();

  constructor(services: MeshRuntimeServices, options: MeshRuntimeOptions = {}) {
    this.#services = services;
    const quotaWindowMs = options.quotaWindowMs ?? 60_000;
    this.#options = {
      maxRequestsPerWindow: options.maxRequestsPerWindow ?? 1_000,
      maxBytesPerWindow: options.maxBytesPerWindow ?? 64 * 1024 * 1024,
      maxConnectionsPerScope: options.maxConnectionsPerScope ?? 256,
      quotaWindowMs,
      throttleThreshold: options.throttleThreshold ?? 400,
      blockThreshold: options.blockThreshold ?? 800,
      now: options.now ?? Date.now,
    };
  }

  get now(): number {
    return this.#options.now();
  }

  /** 当前活动会话 ID 列表（供状态统计）。 */
  listActiveSessionIds(): string[] {
    return [...this.#relay.keys()];
  }

  /** 创建 NAT 会话（relay 路径），返回会话对象。 */
  createNatSession(input: {
    sessionId: string;
    nodeA: string;
    nodeB: string;
    tenantA: string | null;
    tenantB: string | null;
    ttlMs?: number;
  }): MeshNatSession {
    const createdAt = this.now;
    const ttlMs = Math.max(30_000, Math.min(input.ttlMs ?? MESH_RELAY_SESSION_TTL_MS, 60 * 60_000));
    const session: MeshNatSession = {
      sessionId: input.sessionId,
      nodeA: input.nodeA,
      nodeB: input.nodeB,
      tenantA: input.tenantA,
      tenantB: input.tenantB,
      createdAt,
      expiresAt: createdAt + ttlMs,
      pathType: 'relay',
    };
    this.#services.saveNatSession(session);
    this.#relay.set(session.sessionId, new Map());
    this.#cursor.set(session.sessionId, { nodeA: 0, nodeB: 0 });
    return session;
  }

  /** 更新会话路径类型（P2P 成功后调用，销毁 relay 状态）。 */
  promoteToP2P(sessionId: string, nodeA: string, nodeB: string): MeshPathReceipt | null {
    const session = this.#services.getNatSession(sessionId);
    if (!session) return null;
    const relay = this.#relay.get(sessionId);
    const bytesForwarded = relay
      ? [...relay.values()].reduce((sum, chunk) => sum + chunk.ciphertext.length, 0)
      : 0;
    const chunksForwarded = relay?.size ?? 0;
    const durationMs = Math.max(0, this.now - session.createdAt);
    // 销毁 relay 状态（密文只驻留内存，drop 即删除）。
    this.#relay.delete(sessionId);
    this.#cursor.delete(sessionId);
    this.#sessionScope.delete(sessionId);
    const updated: MeshNatSession = {
      ...session,
      pathType: 'p2p',
      expiresAt: this.now,
    };
    this.#services.saveNatSession(updated);
    const receipt: MeshPathReceipt = {
      receiptId: this.#services.newReceiptId(),
      sessionId,
      pathType: 'p2p',
      nodeA,
      nodeB,
      bytesForwarded,
      chunksForwarded,
      durationMs,
      createdAt: this.now,
    };
    this.#services.savePathReceipt(receipt);
    return receipt;
  }

  /** 关闭 relay 会话（未走通 P2P 的清理路径）。 */
  closeSession(sessionId: string): boolean {
    this.#relay.delete(sessionId);
    this.#cursor.delete(sessionId);
    this.#sessionScope.delete(sessionId);
    return this.#services.destroyNatSession(sessionId);
  }

  /** 校验请求者是否为会话一方，返回 [nodeA, nodeB]。 */
  sessionPeers(sessionId: string, requester: string): [string, string] | null {
    const session = this.#services.getNatSession(sessionId);
    if (!session) return null;
    if (session.nodeA !== requester && session.nodeB !== requester) return null;
    if (session.expiresAt <= this.now) {
      this.closeSession(sessionId);
      return null;
    }
    return [session.nodeA, session.nodeB];
  }

  /** 投递一个端到端密文块。返回块 ID。 */
  putChunk(input: {
    sessionId: string;
    from: string;
    ciphertext: string;
    ttlMs?: number;
  }): string {
    const peers = this.sessionPeers(input.sessionId, input.from);
    if (!peers) throw new Error('relay session is invalid or expired');
    const queue = this.#relay.get(input.sessionId)!;
    const ciphertextLength = input.ciphertext.length;
    if (ciphertextLength > MESH_RELAY_CHUNK_MAX_BYTES) {
      throw new Error('relay chunk exceeds the maximum size');
    }
    const totalBytes = [...queue.values()].reduce((sum, c) => sum + c.ciphertext.length, 0);
    if (
      queue.size >= MESH_RELAY_SESSION_MAX_CHUNKS ||
      totalBytes + ciphertextLength > MESH_RELAY_SESSION_MAX_BYTES
    ) {
      throw new Error('relay session is under backpressure');
    }
    const createdAt = this.now;
    const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? 30_000, 5 * 60_000));
    const chunk: MeshRelayChunk = {
      chunkId: this.#services.newChunkId(),
      from: input.from,
      ciphertext: input.ciphertext,
      createdAt,
      expiresAt: createdAt + ttlMs,
    };
    queue.set(chunk.chunkId, chunk);
    return chunk.chunkId;
  }

  /** 拉取投递给本方的密文块（按创建顺序，单调游标）。 */
  takeChunks(sessionId: string, requester: string, limit = 50): MeshRelayChunk[] {
    const peers = this.sessionPeers(sessionId, requester);
    if (!peers) throw new Error('relay session is invalid or expired');
    const queue = this.#relay.get(sessionId)!;
    const now = this.now;
    // 清理过期块
    for (const [id, chunk] of queue) {
      if (chunk.expiresAt <= now) queue.delete(id);
    }
    const cursorKey = requester === peers[0] ? 'nodeA' : 'nodeB';
    const cursor = this.#cursor.get(sessionId)!;
    const ordered = [...queue.values()].sort((a, b) => a.createdAt - b.createdAt);
    const next = ordered.filter((c) => c.createdAt >= cursor[cursorKey]).slice(0, limit);
    if (next.length > 0) {
      cursor[cursorKey] = next[next.length - 1]!.createdAt + 1;
    }
    return next;
  }

  backpressure(sessionId: string): MeshBackpressureState | null {
    const queue = this.#relay.get(sessionId);
    if (!queue) return null;
    const queuedBytes = [...queue.values()].reduce((sum, c) => sum + c.ciphertext.length, 0);
    return {
      sessionId,
      queuedBytes,
      queuedChunks: queue.size,
      limitBytes: MESH_RELAY_SESSION_MAX_BYTES,
      limitChunks: MESH_RELAY_SESSION_MAX_CHUNKS,
      throttled:
        queue.size >= MESH_RELAY_SESSION_MAX_CHUNKS ||
        queuedBytes >= MESH_RELAY_SESSION_MAX_BYTES,
    };
  }

  /**
   * 配额检查 + 记数。scope 通常为租户或源 IP。
   * 返回 { allowed, reason }；countConnection 时占用并发槽位并关联会话。
   */
  checkQuota(
    scope: string,
    bytes: number,
    opts: { countConnection?: boolean; sessionId?: string } = {},
  ): { allowed: boolean; reason: string } {
    const windowMs = this.#options.quotaWindowMs;
    const bucket = this.#services.getQuotaBucket(scope, windowMs);
    const nextRequests = bucket.requestCount + 1;
    const nextBytes = bucket.byteCount + bytes;
    const activeConnections = this.#countActiveConnections(scope);
    if (nextRequests > this.#options.maxRequestsPerWindow) {
      return { allowed: false, reason: 'request quota exceeded' };
    }
    if (nextBytes > this.#options.maxBytesPerWindow) {
      return { allowed: false, reason: 'byte quota exceeded' };
    }
    if (opts.countConnection && activeConnections >= this.#options.maxConnectionsPerScope) {
      return { allowed: false, reason: 'connection quota exceeded' };
    }
    this.#services.addQuotaUsage(scope, windowMs, {
      requests: 1,
      bytes,
      ...(opts.countConnection ? { connections: 1 } : {}),
    });
    if (opts.countConnection && opts.sessionId) {
      this.#sessionScope.set(opts.sessionId, scope);
    }
    return { allowed: true, reason: 'ok' };
  }

  /** DDoS 决策查询；无记录时按请求速率推导（throttle/block 阈值）。 */
  ddosDecision(source: string): {
    decision: 'allow' | 'throttle' | 'block';
    reason: string;
  } {
    const stored = this.#services.getDdosDecision(source);
    if (stored) return stored;
    const windowMs = this.#options.quotaWindowMs;
    const bucket = this.#services.getQuotaBucket(source, windowMs);
    if (bucket.requestCount >= this.#options.blockThreshold) {
      const decidedAt = this.now;
      this.#services.setDdosDecision({
        source,
        decision: 'block',
        reason: `request rate exceeded block threshold (${bucket.requestCount})`,
        decidedAt,
        expiresAt: decidedAt + 10 * 60_000,
      });
      return { decision: 'block', reason: 'request rate exceeded block threshold' };
    }
    if (bucket.requestCount >= this.#options.throttleThreshold) {
      return { decision: 'throttle', reason: 'request rate near throttle threshold' };
    }
    return { decision: 'allow', reason: 'within rate limit' };
  }

  #countActiveConnections(scope: string): number {
    let count = 0;
    for (const mapped of this.#sessionScope.values()) {
      if (mapped === scope) count += 1;
    }
    return count;
  }
}

export function newMeshSessionId(): string {
  return `mns_${randomUUID().replaceAll('-', '')}`;
}

export function newMeshChunkId(): string {
  return `mch_${randomBytes(16).toString('hex')}`;
}

/** 签发短时 relay ticket（根服务器签名）。 */
export async function issueRelayTicket(input: {
  sessionId: string;
  requesterNodeId: string;
  peerNodeId: string;
  tenantId: string | null;
  maxBytes: number;
  signer: { keyId: string; sign(payload: unknown): Promise<string> };
  now?(): number;
  ttlMs?: number;
}): Promise<MeshRelayTicket & { signingKeyId: string; signature: string }> {
  const now = input.now?.() ?? Date.now();
  const ttlMs = Math.max(30_000, Math.min(input.ttlMs ?? MESH_RELAY_TICKET_TTL_MS, 30 * 60_000));
  const ticket: MeshRelayTicket = {
    version: 1,
    ticketId: `mtk_${randomUUID().replaceAll('-', '')}`,
    sessionId: input.sessionId,
    requesterNodeId: input.requesterNodeId,
    peerNodeId: input.peerNodeId,
    tenantId: input.tenantId,
    maxBytes: input.maxBytes,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  return {
    ...ticket,
    signingKeyId: input.signer.keyId,
    signature: await input.signer.sign(ticket),
  };
}
