/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 装配层：把 schema/repository/runtime/routes 组合成根服务器服务。
 */

import { generateKeyPairSync } from 'node:crypto';

import type { Database } from '../data_platform/index.js';
import type {
  MeshNatSession,
  MeshPathReceipt,
  MeshQuotaBucket,
  SignedMeshRendezvousRecord,
} from './meshContracts.js';
import { LocalMeshSigner, validateSignedRendezvousRecord } from './meshCrypto.js';
import {
  addQuotaUsageInRepository,
  clearQuotaBucketsInRepository,
  destroyNatSessionInRepository,
  getDdosDecisionInRepository,
  getNatSessionInRepository,
  getQuotaBucketInRepository,
  getRendezvousRecordInRepository,
  listActiveDdosDecisionsInRepository,
  listPathReceiptsInRepository,
  listRendezvousRecordsInRepository,
  newReceiptId,
  saveNatSessionInRepository,
  savePathReceiptInRepository,
  setDdosDecisionInRepository,
  sweepExpiredNatSessionsInRepository,
  upsertRendezvousRecordInRepository,
} from './meshRepository.js';
import {
  MeshRendezvousRuntime,
  issueRelayTicket,
  newMeshChunkId,
  newMeshSessionId,
  type MeshRuntimeOptions,
} from './meshRuntime.js';

export interface MeshRendezvousCompositionOptions {
  db(): Database;
  now?(): number;
  /** 根服务器自身的签名 key（用于签发 relay ticket）；未提供则自动生成。 */
  signingKey?: string;
  runtimeOptions?: MeshRuntimeOptions;
}

export interface MeshRendezvousComposition {
  now(): number;
  publishRendezvous(input: { signed: unknown; source: string }): {
    nodeId: string;
    expiresAt: string;
  };
  lookupRendezvous(nodeId: string): SignedMeshRendezvousRecord | null;
  listRendezvous(): SignedMeshRendezvousRecord[];
  createRelaySession(input: {
    nodeA: string;
    nodeB: string;
    tenantA: string | null;
    tenantB: string | null;
    requester: string;
    source: string;
    maxBytes: number;
  }): Promise<{
    sessionId: string;
    ticket: unknown;
    expiresAt: string;
  }>;
  putRelayChunk(input: {
    sessionId: string;
    from: string;
    ciphertext: string;
    source: string;
  }): { chunkId: string };
  takeRelayChunks(input: {
    sessionId: string;
    node: string;
    limit?: number;
    source: string;
  }): { chunks: unknown[] };
  declareP2P(input: {
    sessionId: string;
    node: string;
    source: string;
  }): { receipt: MeshPathReceipt } | null;
  closeRelaySession(input: { sessionId: string; node: string; source: string }): boolean;
  status(source: string): unknown;
  getRuntime(): MeshRendezvousRuntime;
  getRepositoryFunctions(): {
    getQuotaBucket(scope: string, windowMs: number): MeshQuotaBucket;
    clearQuotaBuckets(): void;
    sweepExpiredSessions(): number;
  };
}

const PUBLIC_SESSION_SCOPE = 'mesh:public';

function makeSigningKey(existing?: string): LocalMeshSigner {
  if (existing) return new LocalMeshSigner(existing);
  const { privateKey } = generateKeyPairSync('ed25519');
  return new LocalMeshSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
}

export function createMeshRendezvousComposition(
  options: MeshRendezvousCompositionOptions,
): MeshRendezvousComposition {
  const now = options.now ?? Date.now;
  const signer = makeSigningKey(options.signingKey);
  const db = () => options.db();

  const runtime = new MeshRendezvousRuntime(
    {
      getNatSession: (sessionId) => getNatSessionInRepository({ db, now }, sessionId),
      saveNatSession: (session) => saveNatSessionInRepository({ db, now }, session),
      destroyNatSession: (sessionId) =>
        destroyNatSessionInRepository({ db, now }, sessionId),
      getQuotaBucket: (scope, windowMs) =>
        getQuotaBucketInRepository({ db, now }, scope, windowMs),
      addQuotaUsage: (scope, windowMs, usage) =>
        addQuotaUsageInRepository({ db, now }, scope, windowMs, usage),
      getDdosDecision: (source) => {
        const decision = getDdosDecisionInRepository({ db, now }, source);
        return decision ? { decision: decision.decision, reason: decision.reason } : null;
      },
      setDdosDecision: (decision) => setDdosDecisionInRepository({ db, now }, decision),
      savePathReceipt: (receipt) => savePathReceiptInRepository({ db, now }, receipt),
      newSessionId: newMeshSessionId,
      newChunkId: newMeshChunkId,
      newReceiptId,
      now,
    },
    options.runtimeOptions,
  );

  const sessionScope = (sessionId: string): string | null => {
    const session = getNatSessionInRepository({ db, now }, sessionId);
    return session ? session.tenantA ?? session.tenantB ?? null : null;
  };

  return {
    now,
    publishRendezvous(input) {
      // 校验结构、TTL 与规范化；目录级验签依赖 MESH-01 设备身份（此处仅校验自证签名格式）。
      const signed = validateSignedRendezvousRecord(input.signed, now());
      upsertRendezvousRecordInRepository({ db, now }, signed);
      return {
        nodeId: signed.record.nodeId,
        expiresAt: signed.record.expiresAt,
      };
    },
    lookupRendezvous(nodeId) {
      return getRendezvousRecordInRepository({ db, now }, nodeId);
    },
    listRendezvous() {
      return listRendezvousRecordsInRepository({ db, now });
    },
    async createRelaySession(input) {
      const sourceQuota = runtime.checkQuota(input.source, 128);
      if (!sourceQuota.allowed) {
        throw new Error(`source quota exceeded: ${sourceQuota.reason}`);
      }
      const sessionId = newMeshSessionId();
      const scope = input.tenantA ?? input.tenantB ?? PUBLIC_SESSION_SCOPE;
      const sessionQuota = runtime.checkQuota(scope, 128, {
        countConnection: true,
        sessionId,
      });
      if (!sessionQuota.allowed) {
        throw new Error(`connection quota exceeded: ${sessionQuota.reason}`);
      }
      const session = runtime.createNatSession({
        sessionId,
        nodeA: input.nodeA,
        nodeB: input.nodeB,
        tenantA: input.tenantA,
        tenantB: input.tenantB,
      });
      const ticket = await issueRelayTicket({
        sessionId,
        requesterNodeId: input.requester,
        peerNodeId: input.requester === session.nodeA ? session.nodeB : session.nodeA,
        tenantId: input.tenantA ?? input.tenantB,
        maxBytes: input.maxBytes,
        signer: { keyId: signer.keyId, sign: (p) => signer.sign(p) },
        now,
      });
      return {
        sessionId,
        ticket,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    },
    putRelayChunk(input) {
      const quota = runtime.checkQuota(input.source, input.ciphertext.length);
      if (!quota.allowed) {
        throw new Error(`quota exceeded: ${quota.reason}`);
      }
      return {
        chunkId: runtime.putChunk({
          sessionId: input.sessionId,
          from: input.from,
          ciphertext: input.ciphertext,
        }),
      };
    },
    takeRelayChunks(input) {
      const quota = runtime.checkQuota(input.source, 0);
      if (!quota.allowed) {
        throw new Error(`quota exceeded: ${quota.reason}`);
      }
      return {
        chunks: runtime.takeChunks(input.sessionId, input.node, input.limit),
      };
    },
    declareP2P(input) {
      const receipt = runtime.promoteToP2P(input.sessionId, input.node, input.node);
      if (!receipt) return null;
      return { receipt };
    },
    closeRelaySession(input) {
      return runtime.closeSession(input.sessionId);
    },
    status(source) {
      const ddos = runtime.ddosDecision(source);
      return {
        protocolVersion: 1,
        privacy: {
          payloadStorage: 'ciphertext-only-in-memory',
          plaintextNeverStored: true,
        },
        ddosDecision: ddos,
        activeDdosDecisions: listActiveDdosDecisionsInRepository({ db, now }),
        pathReceipts: listPathReceiptsInRepository({ db, now }, 10),
        rendezvousCount: listRendezvousRecordsInRepository({ db, now }).length,
        activeSessions: runtime.listActiveSessionIds().length,
        signingKeyId: signer.keyId,
        serverTime: new Date(now()).toISOString(),
      };
    },
    getRuntime() {
      return runtime;
    },
    getRepositoryFunctions() {
      return {
        getQuotaBucket: (scope, windowMs) =>
          getQuotaBucketInRepository({ db, now }, scope, windowMs),
        clearQuotaBuckets: () => clearQuotaBucketsInRepository({ db, now }),
        sweepExpiredSessions: () => sweepExpiredNatSessionsInRepository({ db, now }),
      };
    },
  };
}
