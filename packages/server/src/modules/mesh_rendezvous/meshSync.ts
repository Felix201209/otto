import { createHash } from 'node:crypto';

import {
  meshCanonicalJson,
  verifyMeshSignature,
  type MeshPayloadSigner,
} from './meshCrypto.js';

export const MESH_SYNC_VERSION = 1 as const;

export type MeshObjectType = 'map' | 'text' | 'security' | 'binary';
export interface MeshChunkReference { chunkId: string; digest: string }
export interface MeshOperation { kind: 'set' | 'delete'; field: string; value?: unknown }
export interface MeshSyncEventPayload {
  version: typeof MESH_SYNC_VERSION;
  eventId: string;
  tenantId: string;
  ownerId: string;
  objectId: string;
  objectType: MeshObjectType;
  deviceId: string;
  sequence: number;
  epoch: number;
  parents: string[];
  chunks: MeshChunkReference[];
  operation: MeshOperation;
}
export interface MeshSyncEvent extends MeshSyncEventPayload {
  signingKeyId: string;
  signature: string;
}

export interface MeshMergeReceipt {
  version: typeof MESH_SYNC_VERSION;
  eventId: string;
  objectId: string;
  resultHeads: string[];
  outcome: 'applied' | 'manual_conflict';
}
export type MeshConflictReason = 'log_fork' | 'security_conflict';
export interface MeshConflict {
  objectId: string;
  eventId: string;
  reason: MeshConflictReason;
}
export type MeshApplyStatus = 'applied' | 'duplicate' | 'buffered_gap' | 'quarantined' | 'manual_conflict';
export interface MeshApplyResult { status: MeshApplyStatus; reason?: string }

export interface MeshSyncCheckpoint {
  version: typeof MESH_SYNC_VERSION;
  events: MeshSyncEvent[];
  quarantined: Array<{ eventId: string; reason: string }>;
}

export interface MeshSyncOptions {
  expectedTenantId: string;
  currentEpoch: number;
  resolveDeviceKey(deviceId: string, signingKeyId: string): string | null;
  authorize(event: MeshSyncEvent): boolean;
  hasChunk(chunkId: string, digest: string): boolean;
}

type UnsignedInput = Omit<MeshSyncEventPayload, 'version' | 'eventId'> & {
  signer: MeshPayloadSigner;
  eventId?: string;
};

function eventPayload(event: MeshSyncEvent): MeshSyncEventPayload {
  const { signingKeyId: _key, signature: _signature, ...payload } = event;
  return payload;
}

export async function createSignedMeshEvent(input: UnsignedInput): Promise<MeshSyncEvent> {
  const base = {
    version: MESH_SYNC_VERSION,
    tenantId: input.tenantId,
    ownerId: input.ownerId,
    objectId: input.objectId,
    objectType: input.objectType,
    deviceId: input.deviceId,
    sequence: input.sequence,
    epoch: input.epoch,
    parents: [...input.parents].sort(),
    chunks: input.chunks.map((chunk) => ({ ...chunk })),
    operation: { ...input.operation },
  };
  const eventId = input.eventId ?? `mev_${createHash('sha256').update(meshCanonicalJson(base)).digest('hex').slice(0, 32)}`;
  const payload: MeshSyncEventPayload = { ...base, eventId };
  return { ...payload, signingKeyId: input.signer.keyId, signature: await input.signer.sign(payload) };
}

function orderedWinner(a: MeshSyncEvent, b: MeshSyncEvent): MeshSyncEvent {
  return `${a.deviceId}\0${a.eventId}` > `${b.deviceId}\0${b.eventId}` ? a : b;
}

export class MeshSyncEngine {
  readonly #events = new Map<string, MeshSyncEvent>();
  readonly #sequence = new Map<string, Map<number, string>>();
  readonly #pending = new Map<string, Map<number, MeshSyncEvent>>();
  readonly #objects = new Map<string, Record<string, unknown>>();
  readonly #fieldWinners = new Map<string, Map<string, MeshSyncEvent>>();
  readonly #heads = new Map<string, Set<string>>();
  readonly #conflicts: MeshConflict[] = [];
  readonly #receipts: MeshMergeReceipt[] = [];
  readonly #quarantined: Array<{ eventId: string; reason: string }> = [];

  constructor(readonly options: MeshSyncOptions) {}

  static fromCheckpoint(checkpoint: MeshSyncCheckpoint, options: MeshSyncOptions): MeshSyncEngine {
    if (checkpoint.version !== MESH_SYNC_VERSION) throw new Error('mesh checkpoint version is unsupported');
    const engine = new MeshSyncEngine(options);
    for (const event of checkpoint.events) engine.apply(event);
    engine.#quarantined.push(...checkpoint.quarantined);
    return engine;
  }

  apply(event: MeshSyncEvent): MeshApplyResult {
    const invalid = this.#validate(event);
    if (invalid) return this.#quarantine(event.eventId, invalid);
    if (this.#events.has(event.eventId)) return { status: 'duplicate' };
    const bySequence = this.#sequence.get(event.deviceId) ?? new Map<number, string>();
    const cursor = Math.max(0, ...bySequence.keys());
    if (event.sequence < cursor) return this.#quarantine(event.eventId, 'sequence_rollback');
    const existingAtSequence = bySequence.get(event.sequence);
    if (existingAtSequence) {
      this.#conflicts.push({ objectId: event.objectId, eventId: event.eventId, reason: 'log_fork' });
      return this.#quarantine(event.eventId, 'log_fork');
    }
    if (event.sequence > cursor + 1) {
      const pending = this.#pending.get(event.deviceId) ?? new Map<number, MeshSyncEvent>();
      pending.set(event.sequence, event);
      this.#pending.set(event.deviceId, pending);
      return { status: 'buffered_gap' };
    }
    if (event.parents.some((parent) => !this.#events.has(parent))) {
      return this.#quarantine(event.eventId, 'missing_parent');
    }
    const result = this.#commit(event);
    this.#drain(event.deviceId);
    return result;
  }

  #validate(event: MeshSyncEvent): string | null {
    if (event.version !== MESH_SYNC_VERSION) return 'unsupported_version';
    if (event.tenantId !== this.options.expectedTenantId) return 'tenant_mismatch';
    if (event.epoch !== this.options.currentEpoch) return 'epoch_mismatch';
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return 'invalid_sequence';
    const key = this.options.resolveDeviceKey(event.deviceId, event.signingKeyId);
    if (!key) return 'unknown_device';
    try { verifyMeshSignature({ payload: eventPayload(event), signature: event.signature, publicKeyPem: key }); }
    catch { return 'invalid_signature'; }
    if (!this.options.authorize(event)) return 'unauthorized';
    if (event.chunks.some((chunk) => !this.options.hasChunk(chunk.chunkId, chunk.digest))) return 'missing_chunk';
    return null;
  }

  #commit(event: MeshSyncEvent): MeshApplyResult {
    this.#events.set(event.eventId, event);
    const bySequence = this.#sequence.get(event.deviceId) ?? new Map<number, string>();
    bySequence.set(event.sequence, event.eventId);
    this.#sequence.set(event.deviceId, bySequence);
    const heads = this.#heads.get(event.objectId) ?? new Set<string>();
    event.parents.forEach((parent) => heads.delete(parent));
    heads.add(event.eventId);
    this.#heads.set(event.objectId, heads);

    const object = this.#objects.get(event.objectId) ?? {};
    const winners = this.#fieldWinners.get(event.objectId) ?? new Map<string, MeshSyncEvent>();
    const previous = winners.get(event.operation.field);
    const concurrent = previous && !event.parents.includes(previous.eventId) && !previous.parents.includes(event.eventId);
    if (event.objectType === 'security' && concurrent) {
      this.#conflicts.push({ objectId: event.objectId, eventId: event.eventId, reason: 'security_conflict' });
      this.#receipts.push({ version: 1, eventId: event.eventId, objectId: event.objectId, resultHeads: [...heads].sort(), outcome: 'manual_conflict' });
      return { status: 'manual_conflict', reason: 'security_conflict' };
    }
    const causallyAfterPrevious = previous ? event.parents.includes(previous.eventId) : false;
    if (!previous || causallyAfterPrevious || (concurrent && orderedWinner(previous, event) === event)) {
      if (event.operation.kind === 'delete') delete object[event.operation.field];
      else object[event.operation.field] = event.operation.value;
      winners.set(event.operation.field, event);
    }
    this.#objects.set(event.objectId, object);
    this.#fieldWinners.set(event.objectId, winners);
    this.#receipts.push({ version: 1, eventId: event.eventId, objectId: event.objectId, resultHeads: [...heads].sort(), outcome: 'applied' });
    return { status: 'applied' };
  }

  #drain(deviceId: string): void {
    const pending = this.#pending.get(deviceId);
    if (!pending) return;
    while (true) {
      const sequence = this.#sequence.get(deviceId)?.size ?? 0;
      const next = pending.get(sequence + 1);
      if (!next) break;
      pending.delete(sequence + 1);
      if (!this.#validate(next)) this.#commit(next);
    }
  }

  #quarantine(eventId: string, reason: string): MeshApplyResult {
    this.#quarantined.push({ eventId, reason });
    return { status: 'quarantined', reason };
  }

  object(objectId: string): Record<string, unknown> | null { return this.#objects.get(objectId) ?? null; }
  heads(objectId: string): string[] { return [...(this.#heads.get(objectId) ?? [])].sort(); }
  conflicts(): MeshConflict[] { return this.#conflicts.map((item) => ({ ...item })); }
  receipts(): MeshMergeReceipt[] { return this.#receipts.map((item) => ({ ...item, resultHeads: [...item.resultHeads] })); }
  checkpoint(): MeshSyncCheckpoint { return { version: 1, events: [...this.#events.values()], quarantined: this.#quarantined.map((item) => ({ ...item })) }; }
}
