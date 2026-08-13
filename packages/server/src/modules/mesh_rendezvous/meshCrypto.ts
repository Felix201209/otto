/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * [MESH-05] 签名与校验：rendezvous record（节点签名）、relay ticket（根服务器签名）。
 * 全部使用 Ed25519，沿用 commercial_control 的 canonical JSON + base64url 签名惯例，
 * 但这里保持模块自洽，不依赖其他业务模块。
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import {
  MESH_CANDIDATE_MAX,
  MESH_CANDIDATE_TYPES,
  MESH_MAX_CLOCK_SKEW_MS,
  MESH_RELAY_TICKET_TTL_MS,
  type MeshCandidateType,
  type MeshPeerCandidate,
  type MeshRendezvousRecord,
  type MeshRelayTicket,
  type SignedMeshRendezvousRecord,
  type SignedMeshRelayTicket,
} from './meshContracts.js';

export const MESH_SIGNATURE_PREFIX = 'mesh_sig_v1:';
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9+.-]*:\/\/[^\s]{1,511}$/u;

/** 确定性 canonical JSON（稳定键序），保证跨端签名一致。 */
export function meshCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => meshCanonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${meshCanonicalJson(v)}`)
    .join(',')}}`;
}

function normalizePrivateKey(value: string): KeyObject {
  const normalized = value.trim().replace(/\\n/gu, '\n');
  const key = normalized.includes('BEGIN PRIVATE KEY')
    ? createPrivateKey(normalized)
    : createPrivateKey({
        key: Buffer.from(normalized, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('mesh signing key must be Ed25519');
  }
  return key;
}

/** 从公钥派生 keyId（与 federation 相同策略：SPKI DER 的 sha256 前 16 字节）。 */
export function meshPublicKeyId(publicKey: KeyObject | string): string {
  const key =
    typeof publicKey === 'string'
      ? createPublicKey(publicKey.trim().replace(/\\n/gu, '\n'))
      : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('mesh verification key must be Ed25519');
  }
  const der = key.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export interface MeshPayloadSigner {
  keyId: string;
  publicKeyPem: string;
  sign(payload: unknown): Promise<string>;
}

/** 本地 Ed25519 签名器（供节点/根服务器使用）。 */
export class LocalMeshSigner implements MeshPayloadSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly #privateKey: KeyObject;

  constructor(privateKey: string) {
    this.#privateKey = normalizePrivateKey(privateKey);
    const publicKey = createPublicKey(this.#privateKey);
    this.keyId = meshPublicKeyId(publicKey);
    this.publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  }

  async sign(payload: unknown): Promise<string> {
    const signature = sign(null, Buffer.from(meshCanonicalJson(payload)), this.#privateKey);
    return `${MESH_SIGNATURE_PREFIX}${signature.toString('base64url')}`;
  }
}

export function verifyMeshSignature(input: {
  payload: unknown;
  signature: string;
  publicKeyPem: string;
}): void {
  if (!input.signature.startsWith(MESH_SIGNATURE_PREFIX)) {
    throw new Error('mesh signature must use Ed25519');
  }
  const signature = Buffer.from(
    input.signature.slice(MESH_SIGNATURE_PREFIX.length),
    'base64url',
  );
  const publicKey = createPublicKey(input.publicKeyPem);
  if (
    publicKey.asymmetricKeyType !== 'ed25519' ||
    signature.length !== 64 ||
    !verify(null, Buffer.from(meshCanonicalJson(input.payload)), publicKey, signature)
  ) {
    throw new Error('mesh signature is invalid');
  }
}

/** 校验并规整一个 peer candidate。 */
function validateCandidate(value: unknown, label: string): MeshPeerCandidate {
  if (!value || typeof value !== 'object') throw new Error(`${label} is invalid`);
  const candidate = value as Partial<MeshPeerCandidate>;
  if (
    typeof candidate.type !== 'string' ||
    !(MESH_CANDIDATE_TYPES as readonly string[]).includes(candidate.type)
  ) {
    throw new Error(`${label} type is invalid`);
  }
  if (typeof candidate.address !== 'string' || !ADDRESS.test(candidate.address)) {
    throw new Error(`${label} address is invalid`);
  }
  const priority = Number(candidate.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) {
    throw new Error(`${label} priority is invalid`);
  }
  if (
    candidate.expiresAt !== undefined &&
    (typeof candidate.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.expiresAt)))
  ) {
    throw new Error(`${label} expiresAt is invalid`);
  }
  return {
    type: candidate.type as MeshCandidateType,
    address: candidate.address,
    priority,
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
  };
}

function nodeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !NODE_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'string' || value.length > 64) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must use canonical UTC ISO format`);
  }
  return parsed;
}

/** 校验并规整一个签名 rendezvous record。 */
export function validateSignedRendezvousRecord(
  raw: unknown,
  now: number,
): SignedMeshRendezvousRecord {
  if (!raw || typeof raw !== 'object') {
    throw new Error('rendezvous record is invalid');
  }
  const signed = raw as Partial<SignedMeshRendezvousRecord>;
  const record = signed.record as Partial<MeshRendezvousRecord> | undefined;
  if (!record || typeof record !== 'object') {
    throw new Error('rendezvous record is invalid');
  }
  if (record.version !== 1) throw new Error('rendezvous record version is unsupported');
  const validatedNodeId = nodeId(record.nodeId, 'node id');
  const issuedAt = canonicalTimestamp(record.issuedAt, 'issued at');
  const expiresAt = canonicalTimestamp(record.expiresAt, 'expires at');
  if (issuedAt > now + MESH_MAX_CLOCK_SKEW_MS || expiresAt <= now) {
    throw new Error('rendezvous record is expired or issued in the future');
  }
  if (expiresAt <= issuedAt) throw new Error('rendezvous record lifetime is invalid');
  if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
    throw new Error('rendezvous record requires at least one candidate');
  }
  if (record.candidates.length > MESH_CANDIDATE_MAX) {
    throw new Error('rendezvous record has too many candidates');
  }
  const candidates = record.candidates.map((candidate, index) =>
    validateCandidate(candidate, `candidate[${index}]`),
  );
  if (typeof signed.signingKeyId !== 'string' || signed.signingKeyId.length === 0) {
    throw new Error('rendezvous signing key id is invalid');
  }
  if (typeof signed.signature !== 'string' || !signed.signature.startsWith(MESH_SIGNATURE_PREFIX)) {
    throw new Error('rendezvous signature is invalid');
  }
  return {
    record: {
      version: 1,
      nodeId: validatedNodeId,
      issuedAt: record.issuedAt as string,
      expiresAt: record.expiresAt as string,
      candidates,
    },
    signingKeyId: signed.signingKeyId,
    signature: signed.signature,
  };
}

/** 校验并规整一个根服务器签发的 relay ticket。 */
export function validateRelayTicket(raw: unknown, now: number): MeshRelayTicket {
  if (!raw || typeof raw !== 'object') throw new Error('relay ticket is invalid');
  const ticket = raw as Partial<MeshRelayTicket>;
  if (ticket.version !== 1) throw new Error('relay ticket version is unsupported');
  const ticketId = nodeId(ticket.ticketId ?? '', 'ticket id');
  const sessionId = nodeId(ticket.sessionId ?? '', 'session id');
  const requesterNodeId = nodeId(ticket.requesterNodeId ?? '', 'requester node id');
  const peerNodeId = nodeId(ticket.peerNodeId ?? '', 'peer node id');
  if (requesterNodeId === peerNodeId) {
    throw new Error('relay ticket must cross node boundaries');
  }
  let tenantId: string | null = null;
  if (ticket.tenantId !== null && ticket.tenantId !== undefined) {
    if (typeof ticket.tenantId !== 'string' || !ticket.tenantId.trim() || ticket.tenantId.length > 128) {
      throw new Error('relay ticket tenant id is invalid');
    }
    tenantId = ticket.tenantId;
  }
  const maxBytes = Number(ticket.maxBytes);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1024 * 1024 * 1024) {
    throw new Error('relay ticket maxBytes is invalid');
  }
  const issuedAt = canonicalTimestamp(ticket.issuedAt ?? '', 'issued at');
  const expiresAt = canonicalTimestamp(ticket.expiresAt ?? '', 'expires at');
  if (issuedAt > now + MESH_MAX_CLOCK_SKEW_MS || expiresAt <= now) {
    throw new Error('relay ticket is expired or issued in the future');
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MESH_RELAY_TICKET_TTL_MS) {
    throw new Error('relay ticket lifetime is invalid');
  }
  return {
    version: 1,
    ticketId,
    sessionId,
    requesterNodeId,
    peerNodeId,
    tenantId,
    maxBytes,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}
