/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] Otto 根服务器低负载 rendezvous、NAT 穿透与短时密文中继 —— 契约与类型。
 *
 * 设计约束（与 issue #319 保持一致）：
 *  - 根服务器只做发现（rendezvous）、NAT 穿透协调与短时密文 relay；P2P 成功后立即退出数据路径。
 *  - 根服务器不得保存员工明文 prompt/output、私聊或文件；relay 只转发端到端密文。
 *  - relay ticket 短期有效、绑定双方节点/租户/大小/TTL；root 仅记录计数、时延、字节、TTL、路径类型、配额与错误类别。
 */

export const MESH_PROTOCOL_VERSION = 1 as const;

/** 候选地址类型：本地局域网 / 主机(直连) / server-reflexive(反射) / relay(中继)。 */
export const MESH_CANDIDATE_TYPES = [
  'lan',
  'host',
  'server_reflexive',
  'relay',
] as const;
export type MeshCandidateType = (typeof MESH_CANDIDATE_TYPES)[number];

/** 已记录的路径类型：P2P 直连 / 短时 relay。 */
export const MESH_PATH_TYPES = ['p2p', 'relay'] as const;
export type MeshPathType = (typeof MESH_PATH_TYPES)[number];

export const MESH_CANDIDATE_MAX = 16;
export const MESH_RENDEZVOUS_TTL_MS = 24 * 60 * 60_000;
export const MESH_RELAY_TICKET_TTL_MS = 5 * 60_000;
export const MESH_RELAY_SESSION_TTL_MS = 15 * 60_000;
export const MESH_RELAY_CHUNK_MAX_BYTES = 64 * 1024;
export const MESH_RELAY_SESSION_MAX_CHUNKS = 256;
export const MESH_RELAY_SESSION_MAX_BYTES = 4 * 1024 * 1024;
export const MESH_MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** 单个节点（员工设备 = 私有 Otto 节点）的 rendezvous 记录。 */
export interface MeshRendezvousRecord {
  version: typeof MESH_PROTOCOL_VERSION;
  nodeId: string;
  issuedAt: string;
  expiresAt: string;
  /** 由节点设备私钥签名，证明记录确由该节点发布。 */
  candidates: MeshPeerCandidate[];
}

export interface MeshPeerCandidate {
  type: MeshCandidateType;
  /** transport://host:port，如 stun://192.168.1.10:3478、turn://public.example.com:3478 */
  address: string;
  priority: number;
  /** 可选的指纹/有效性提示，由节点自证。 */
  expiresAt?: string;
}

export interface SignedMeshRendezvousRecord {
  record: MeshRendezvousRecord;
  signingKeyId: string;
  signature: string;
}

/** NAT 会话：两个节点之间的短时协调状态。 */
export interface MeshNatSession {
  sessionId: string;
  nodeA: string;
  nodeB: string;
  tenantA: string | null;
  tenantB: string | null;
  createdAt: number;
  expiresAt: number;
  pathType: MeshPathType;
}

/** 根服务器签发的短时 relay ticket。 */
export interface MeshRelayTicket {
  version: typeof MESH_PROTOCOL_VERSION;
  ticketId: string;
  sessionId: string;
  requesterNodeId: string;
  peerNodeId: string;
  tenantId: string | null;
  maxBytes: number;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedMeshRelayTicket {
  ticket: MeshRelayTicket;
  signingKeyId: string;
  signature: string;
}

/** 配额桶（按租户/源聚合的滑动窗口）。 */
export interface MeshQuotaBucket {
  scope: string;
  windowStartedAt: number;
  requestCount: number;
  byteCount: number;
  connectionCount: number;
}

/** 背压状态：relay 会话接近/达到容量上限。 */
export interface MeshBackpressureState {
  sessionId: string;
  queuedBytes: number;
  queuedChunks: number;
  limitBytes: number;
  limitChunks: number;
  throttled: boolean;
}

/** DDoS 防护决策：拒绝反射/放大/未授权探测。 */
export interface MeshDdosDecision {
  source: string;
  decision: 'allow' | 'throttle' | 'block';
  reason: string;
  decidedAt: number;
  expiresAt: number;
}

/** 路径收据：P2P 成功后销毁 relay 状态并记录路径。 */
export interface MeshPathReceipt {
  receiptId: string;
  sessionId: string;
  pathType: MeshPathType;
  nodeA: string;
  nodeB: string;
  bytesForwarded: number;
  chunksForwarded: number;
  durationMs: number;
  createdAt: number;
}
