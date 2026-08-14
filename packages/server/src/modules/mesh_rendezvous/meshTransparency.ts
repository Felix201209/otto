/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-08] Device-local, privacy-minimized transparency audit protocol.
 */
import { createHash } from 'node:crypto';

import { meshCanonicalJson, type MeshPayloadSigner, verifyMeshSignature } from './meshCrypto.js';

export const MESH_AUDIT_EVENT_TYPES = [
  'authorization.granted', 'authorization.revoked', 'operation.executed',
  'sync.completed', 'receipt.issued',
] as const;
export type MeshAuditEventType = (typeof MESH_AUDIT_EVENT_TYPES)[number];

export interface MeshAuditEventInput {
  type: MeshAuditEventType;
  subjectId: string;
  objectId: string;
  /** Digest of the authorization scope or result; never plaintext content. */
  scopeDigest: string;
}

export interface MeshAuditEvent extends MeshAuditEventInput {
  version: 1;
  tenantId: string;
  deviceId: string;
  sequence: number;
  epoch: number;
  recordedAt: string;
  previousHash: string | null;
  eventHash: string;
}

export interface MeshTreeHead {
  version: 1;
  tenantId: string;
  deviceId: string;
  epoch: number;
  treeSize: number;
  rootHash: string;
  previousRootHash: string | null;
  issuedAt: string;
}

export interface SignedMeshTreeHead {
  treeHead: MeshTreeHead;
  signingKeyId: string;
  signature: string;
}

export interface MeshInclusionProof {
  leafIndex: number;
  treeSize: number;
  leafHash: string;
  auditPath: string[];
}

export interface MeshConsistencyProof {
  oldSize: number;
  newSize: number;
  /** Minimal event hashes only; no event payloads leave the device. */
  leafHashes: string[];
}

export interface MeshAuditCheckpoint {
  version: 1;
  tenantId: string;
  deviceId: string;
  epoch: number;
  events: MeshAuditEvent[];
  treeHead: MeshTreeHead;
  signingKeyId: string;
  signature: string;
}

const EMPTY_ROOT = hash('mesh-audit-empty-v1');

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('base64url')}`;
}

function eventHash(event: Omit<MeshAuditEvent, 'eventHash'>): string {
  return hash(`event:v1:${meshCanonicalJson(event)}`);
}

function parentHash(left: string, right: string): string {
  return hash(`node:v1:${left}:${right}`);
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? parentHash(level[index], level[index + 1]) : level[index]);
    }
    level = next;
  }
  return level[0];
}

function treeHead(input: { tenantId: string; deviceId: string; epoch: number; leaves: string[]; issuedAt: string }): MeshTreeHead {
  const rootHash = merkleRoot(input.leaves);
  return {
    version: 1, tenantId: input.tenantId, deviceId: input.deviceId, epoch: input.epoch,
    treeSize: input.leaves.length, rootHash,
    previousRootHash: input.leaves.length > 0 ? merkleRoot(input.leaves.slice(0, -1)) : null,
    issuedAt: input.issuedAt,
  };
}

export class MeshTransparencyLog {
  readonly #tenantId: string;
  readonly #deviceId: string;
  readonly #epoch: number;
  readonly #now: () => number;
  #events: MeshAuditEvent[];
  readonly #observedHeads = new Map<number, string>();

  constructor(input: { tenantId: string; deviceId: string; epoch?: number; now?: () => number; events?: MeshAuditEvent[] }) {
    this.#tenantId = input.tenantId;
    this.#deviceId = input.deviceId;
    this.#epoch = input.epoch ?? 1;
    this.#now = input.now ?? Date.now;
    this.#events = [...(input.events ?? [])];
  }

  append(input: MeshAuditEventInput): MeshAuditEvent {
    if (!MESH_AUDIT_EVENT_TYPES.includes(input.type) || !input.scopeDigest.startsWith('sha256:')) {
      throw new Error('audit event must contain a supported type and digest-only scope');
    }
    const unsigned: Omit<MeshAuditEvent, 'eventHash'> = {
      version: 1, tenantId: this.#tenantId, deviceId: this.#deviceId,
      sequence: this.#events.length + 1, epoch: this.#epoch,
      recordedAt: new Date(this.#now()).toISOString(),
      previousHash: this.#events.at(-1)?.eventHash ?? null, ...input,
    };
    const event = { ...unsigned, eventHash: eventHash(unsigned) };
    this.#events.push(event);
    return event;
  }

  import(event: MeshAuditEvent): void {
    if (this.#events.some((item) => item.eventHash === event.eventHash)) throw new Error('audit event replay');
    const result = this.verifyChain([...this.#events, event]);
    if (!result.valid) throw new Error(`audit event rejected: ${result.reason}`);
    this.#events.push(event);
  }

  events(): MeshAuditEvent[] { return this.#events.map((event) => ({ ...event })); }

  verifyChain(events = this.#events): { valid: true } | { valid: false; reason: string; sequence: number } {
    let previous: string | null = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.tenantId !== this.#tenantId || event.deviceId !== this.#deviceId || event.sequence !== index + 1) {
        return { valid: false, reason: 'chain_identity_or_sequence_mismatch', sequence: index + 1 };
      }
      const { eventHash: claimed, ...unsigned } = event;
      if (claimed !== eventHash(unsigned)) return { valid: false, reason: 'event_hash_mismatch', sequence: index + 1 };
      if (event.previousHash !== previous) return { valid: false, reason: 'hash_link_mismatch', sequence: index + 1 };
      previous = claimed;
    }
    return { valid: true };
  }

  checkpoint(): MeshTreeHead {
    return treeHead({ tenantId: this.#tenantId, deviceId: this.#deviceId, epoch: this.#epoch, leaves: this.#events.map((event) => event.eventHash), issuedAt: new Date(this.#now()).toISOString() });
  }

  verifyCheckpoint(checkpoint: MeshTreeHead): { valid: boolean; reason?: string } {
    if (checkpoint.treeSize < this.#events.length) return { valid: false, reason: 'checkpoint_rollback' };
    if (checkpoint.treeSize !== this.#events.length || checkpoint.rootHash !== this.checkpoint().rootHash) {
      return { valid: false, reason: 'checkpoint_mismatch' };
    }
    return { valid: true };
  }

  async signedTreeHead(size: number, signer: MeshPayloadSigner): Promise<SignedMeshTreeHead> {
    if (!Number.isInteger(size) || size < 0 || size > this.#events.length) throw new Error('tree size is invalid');
    const value = treeHead({ tenantId: this.#tenantId, deviceId: this.#deviceId, epoch: this.#epoch, leaves: this.#events.slice(0, size).map((event) => event.eventHash), issuedAt: new Date(this.#now()).toISOString() });
    return { treeHead: value, signingKeyId: signer.keyId, signature: await signer.sign(value) };
  }

  inclusionProof(leafIndex: number, size = this.#events.length): MeshInclusionProof {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= size || size > this.#events.length) throw new Error('leaf index is invalid');
    let index = leafIndex;
    let level = this.#events.slice(0, size).map((event) => event.eventHash);
    const auditPath: string[] = [];
    while (level.length > 1) {
      const sibling = index % 2 === 0 ? index + 1 : index - 1;
      if (sibling < level.length) auditPath.push(level[sibling]);
      const next: string[] = [];
      for (let cursor = 0; cursor < level.length; cursor += 2) next.push(cursor + 1 < level.length ? parentHash(level[cursor], level[cursor + 1]) : level[cursor]);
      index = Math.floor(index / 2); level = next;
    }
    return { leafIndex, treeSize: size, leafHash: this.#events[leafIndex].eventHash, auditPath };
  }

  consistencyProof(oldSize: number, newSize = this.#events.length): MeshConsistencyProof {
    if (!Number.isInteger(oldSize) || oldSize < 0 || oldSize > newSize || newSize > this.#events.length) throw new Error('consistency range is invalid');
    return { oldSize, newSize, leafHashes: this.#events.slice(0, newSize).map((event) => event.eventHash) };
  }

  observeTreeHead(head: MeshTreeHead): { status: 'accepted' | 'quarantined'; reason?: string } {
    if (head.tenantId !== this.#tenantId || head.deviceId !== this.#deviceId || head.epoch !== this.#epoch) return { status: 'quarantined', reason: 'head_scope_mismatch' };
    const known = this.#observedHeads.get(head.treeSize);
    if (known && known !== head.rootHash) return { status: 'quarantined', reason: 'root_conflict' };
    const largest = Math.max(0, ...this.#observedHeads.keys());
    if (head.treeSize < largest) return { status: 'quarantined', reason: 'root_rollback' };
    this.#observedHeads.set(head.treeSize, head.rootHash);
    return { status: 'accepted' };
  }

  async signedCheckpoint(signer: MeshPayloadSigner): Promise<MeshAuditCheckpoint> {
    const payload = { version: 1 as const, tenantId: this.#tenantId, deviceId: this.#deviceId, epoch: this.#epoch, events: this.events(), treeHead: this.checkpoint() };
    return { ...payload, signingKeyId: signer.keyId, signature: await signer.sign(payload) };
  }

  static fromCheckpoint(checkpoint: MeshAuditCheckpoint, publicKeyPem: string): MeshTransparencyLog {
    const { signingKeyId: _key, signature, ...payload } = checkpoint;
    verifyMeshSignature({ payload, signature, publicKeyPem });
    const log = new MeshTransparencyLog({ tenantId: checkpoint.tenantId, deviceId: checkpoint.deviceId, epoch: checkpoint.epoch, events: checkpoint.events });
    if (!log.verifyChain().valid || log.checkpoint().rootHash !== checkpoint.treeHead.rootHash) throw new Error('audit checkpoint is inconsistent');
    return log;
  }
}

export function verifySignedTreeHead(signed: SignedMeshTreeHead, publicKeyPem: string): boolean {
  try { verifyMeshSignature({ payload: signed.treeHead, signature: signed.signature, publicKeyPem }); return true; } catch { return false; }
}

export function verifyInclusionProof(proof: MeshInclusionProof, head: MeshTreeHead): boolean {
  if (proof.treeSize !== head.treeSize || proof.leafIndex >= proof.treeSize) return false;
  let value = proof.leafHash;
  let index = proof.leafIndex;
  let width = proof.treeSize;
  for (const sibling of proof.auditPath) {
    value = index % 2 === 0 && index + 1 < width ? parentHash(value, sibling) : parentHash(sibling, value);
    index = Math.floor(index / 2); width = Math.ceil(width / 2);
  }
  return value === head.rootHash;
}

export function verifyConsistencyProof(proof: MeshConsistencyProof, oldHead: MeshTreeHead, newHead: MeshTreeHead): boolean {
  return proof.oldSize === oldHead.treeSize && proof.newSize === newHead.treeSize && proof.leafHashes.length === proof.newSize
    && merkleRoot(proof.leafHashes.slice(0, proof.oldSize)) === oldHead.rootHash
    && merkleRoot(proof.leafHashes) === newHead.rootHash;
}
