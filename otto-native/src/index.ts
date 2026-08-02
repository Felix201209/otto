/**
 * @otto/native - Rust native bindings for Otto
 *
 * Provides high-performance implementations of:
 * - Session Store (sled-based KV with LRU cache)
 * - Encryption Store (AES-256-GCM)
 * - Tokenizer (tiktoken-based local token counting)
 * - Agent Pool (memory-managed concurrent agent pool)
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ============ Types ============

export interface SessionMeta {
  id: string;
  title: string;
  updated_at: number;
  message_count: number;
}

export interface Message {
  role: string;
  content: string;
  timestamp: number;
  metadata?: string;
}

export interface SessionData {
  meta: SessionMeta;
  messages: Message[];
}

export interface AgentInfo {
  id: string;
  memory_mb: number;
  log_count: number;
  pending_count: number;
  created_secs_ago: number;
  last_accessed_secs_ago: number;
}

interface JsonRpcRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: string;
}

// ============ Native Process Manager ============

class NativeProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private binaryPath: string;

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath || this.findBinary();
  }

  private findBinary(): string {
    // Check common locations
    const candidates = [
      path.join(__dirname, '..', 'bin', 'otto-native.exe'),
      path.join(__dirname, '..', 'bin', 'otto-native'),
      path.join(__dirname, '..', 'target', 'release', 'otto-native.exe'),
      path.join(__dirname, '..', 'target', 'release', 'otto-native'),
      path.join(
        __dirname,
        '..',
        'target',
        'x86_64-pc-windows-gnu',
        'release',
        'otto-native.exe',
      ),
      path.join(
        __dirname,
        '..',
        'target',
        'x86_64-unknown-linux-gnu',
        'release',
        'otto-native',
      ),
      path.join(
        __dirname,
        '..',
        'target',
        'x86_64-apple-darwin',
        'release',
        'otto-native',
      ),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Fall back to PATH
    return 'otto-native';
  }

  async start(): Promise<void> {
    if (this.process) return;

    this.process = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // Rust diagnostics must never become an unhandled EventEmitter "error"
      // that terminates the desktop main process. Consumers may subscribe to
      // the non-fatal diagnostic channel when they need native stderr.
      this.emit('diagnostic', data.toString());
    });

    this.process.on('error', (error) => {
      this.process = null;
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.emit('exit', code);
      // Reject all pending requests
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Process exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Wait for process to be ready
    await this.call('ping');
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response: JsonRpcResponse = JSON.parse(line);
          if (response.id !== undefined && this.pending.has(response.id)) {
            const { resolve, reject } = this.pending.get(response.id)!;
            this.pending.delete(response.id);
            if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response.result);
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.process) {
      await this.start();
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.stdin?.end();
      this.process = null;
    }
  }
}

// ============ Session Store ============

export class SessionStore {
  private native: NativeProcess;
  private initialized = false;

  constructor(
    private dbPath: string,
    private cacheSize?: number,
    binaryPath?: string,
  ) {
    this.native = new NativeProcess(binaryPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('session_store.open', {
      path: this.dbPath,
      cache_size: this.cacheSize,
    });
    this.initialized = true;
  }

  async save(id: string, title: string, messages: Message[]): Promise<void> {
    await this.init();
    await this.native.call('session_store.save', { id, title, messages });
  }

  async load(id: string): Promise<SessionData | null> {
    await this.init();
    const result = await this.native.call('session_store.load', { id });
    return result as SessionData | null;
  }

  async delete(id: string): Promise<boolean> {
    await this.init();
    const result = await this.native.call('session_store.delete', { id });
    return (result as { deleted: boolean }).deleted;
  }

  async list(): Promise<SessionMeta[]> {
    await this.init();
    const result = await this.native.call('session_store.list');
    return result as SessionMeta[];
  }

  async sizeBytes(): Promise<number> {
    await this.init();
    const result = await this.native.call('session_store.size_bytes');
    return (result as { size: number }).size;
  }

  async close(): Promise<void> {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Encryption Store ============

export class EncryptionStore {
  private native: NativeProcess;
  private initialized = false;

  constructor(
    private dbPath: string,
    private key: string,
    binaryPath?: string,
  ) {
    this.native = new NativeProcess(binaryPath);
  }

  static generateKey(): string {
    return randomBytes(32).toString('hex');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('encryption.open', {
      path: this.dbPath,
      key: this.key,
    });
    this.initialized = true;
  }

  async save(id: string, data: string): Promise<void> {
    await this.init();
    await this.native.call('encryption.save', { id, data });
  }

  async load(id: string): Promise<string | null> {
    await this.init();
    const result = await this.native.call('encryption.load', { id });
    return (result as { data: string | null }).data;
  }

  async delete(id: string): Promise<boolean> {
    await this.init();
    const result = await this.native.call('encryption.delete', { id });
    return (result as { deleted: boolean }).deleted;
  }

  async listIds(): Promise<string[]> {
    await this.init();
    const result = await this.native.call('encryption.list_ids');
    return (result as { ids: string[] }).ids;
  }

  async close(): Promise<void> {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ OpenMLS Kernel ============

export interface MlsDeviceScope {
  serverUrl: string;
  organizationId: string;
  accountId: string;
  deviceId: string;
}

export interface MlsKeyPackage {
  protocol: 'mls10-openmls-0.8';
  ciphersuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
  reference: string;
  key_package: string;
}

export interface MlsGroupState {
  protocol: 'mls10-openmls-0.8';
  conversation_id: string;
  group_id: string;
  epoch: number;
  member_count: number;
}

export interface MlsMemberInvitation {
  protocol: 'mls10-openmls-0.8';
  conversation_id: string;
  group_id: string;
  epoch: number;
  key_package_reference: string;
  recipient_device_id: string;
  commit: string;
  welcome: string;
}

export interface MlsGroupInspection extends MlsGroupState {
  pending_commit: boolean;
  pending_invitation: MlsMemberInvitation | null;
}

export interface MlsApplicationCiphertext {
  protocol: 'mls10-openmls-0.8';
  conversation_id: string;
  group_id: string;
  epoch: number;
  ciphertext: string;
}

export interface MlsPendingApplication extends MlsApplicationCiphertext {
  event_id: string;
  peer_account_id: string;
}

export interface MlsDecryptedApplication {
  protocol: 'mls10-openmls-0.8';
  conversationId: string;
  groupId: string;
  epoch: number;
  senderDeviceScope: string;
  plaintext: Uint8Array;
}

export interface MlsStatePersistence {
  load(): Promise<{
    stateKey: Uint8Array;
    encryptedState: string;
  } | null>;
  create(stateKey: Uint8Array, encryptedState: string): Promise<void>;
  save(encryptedState: string): Promise<void>;
  clear(): Promise<void>;
}

export interface FileMlsStatePersistenceOptions {
  filePath: string;
  protectStateKey(stateKeyBase64: string): string | Promise<string>;
  unprotectStateKey(protectedStateKey: string): string | Promise<string>;
}

interface FileMlsStateManifest {
  format: 1;
  keyProtection: 'os-secure-storage';
  protectedStateKey: string;
  encryptedState: string;
}

function mlsDeviceScope(scope: MlsDeviceScope): string {
  let server: URL;
  try {
    server = new URL(scope.serverUrl.trim());
  } catch {
    throw new Error('MLS server URL is invalid');
  }
  if (
    (server.protocol !== 'https:' && server.protocol !== 'http:') ||
    server.username ||
    server.password ||
    server.search ||
    server.hash
  ) {
    throw new Error('MLS server URL is invalid');
  }
  const identifiers = [
    scope.organizationId,
    scope.accountId,
    scope.deviceId,
  ].map((value) => value.trim());
  if (
    identifiers.some(
      (value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value),
    )
  ) {
    throw new Error('MLS device identity is invalid');
  }
  const serverScope = createHash('sha256')
    .update(`${server.origin}${server.pathname.replace(/\/+$/, '')}`)
    .digest('hex');
  return [serverScope, ...identifiers].join('/');
}

function mlsConversationId(value: string): string {
  const conversationId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(conversationId)) {
    throw new Error('MLS conversation id is invalid');
  }
  return conversationId;
}

function isBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}

function parseMlsStateManifest(value: unknown): FileMlsStateManifest {
  const manifest = value as Partial<FileMlsStateManifest>;
  if (
    manifest.format !== 1 ||
    manifest.keyProtection !== 'os-secure-storage' ||
    typeof manifest.protectedStateKey !== 'string' ||
    !manifest.protectedStateKey ||
    typeof manifest.encryptedState !== 'string' ||
    !manifest.encryptedState ||
    manifest.encryptedState.length > 96 * 1024 * 1024
  ) {
    throw new Error('MLS persistent state manifest is invalid');
  }
  return manifest as FileMlsStateManifest;
}

async function writePrivateFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFile: fs.promises.FileHandle | null = null;
  try {
    temporaryFile = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await temporaryFile.writeFile(content, { encoding: 'utf8' });
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = null;
    await fs.promises.rename(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      await fs.promises.chmod(filePath, 0o600);
      const directory = await fs.promises.open(path.dirname(filePath), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await temporaryFile?.close().catch(() => undefined);
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Atomic encrypted-state file. The wrapping key is protected by a caller such
 * as Electron safeStorage; only the already encrypted native snapshot is stored
 * beside it. The implementation deliberately has no plaintext-key fallback.
 */
export class FileMlsStatePersistence implements MlsStatePersistence {
  constructor(private readonly options: FileMlsStatePersistenceOptions) {}

  async load(): Promise<{
    stateKey: Uint8Array;
    encryptedState: string;
  } | null> {
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(this.options.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const manifest = parseMlsStateManifest(JSON.parse(serialized));
    const encodedKey = await this.options.unprotectStateKey(
      manifest.protectedStateKey,
    );
    if (!isBase64(encodedKey)) {
      throw new Error('MLS state key from secure storage is invalid');
    }
    const key = Buffer.from(encodedKey, 'base64');
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new Error('MLS state key from secure storage has an invalid size');
    }
    const stateKey = new Uint8Array(key);
    key.fill(0);
    return {
      stateKey,
      encryptedState: manifest.encryptedState,
    };
  }

  async create(stateKey: Uint8Array, encryptedState: string): Promise<void> {
    if (stateKey.byteLength !== 32) {
      throw new Error('MLS state key must contain exactly 32 bytes');
    }
    if (await this.exists()) {
      throw new Error('MLS persistent state already exists');
    }
    const protectedStateKey = await this.options.protectStateKey(
      Buffer.from(stateKey).toString('base64'),
    );
    const manifest = parseMlsStateManifest({
      format: 1,
      keyProtection: 'os-secure-storage',
      protectedStateKey,
      encryptedState,
    });
    await writePrivateFileAtomic(
      this.options.filePath,
      `${JSON.stringify(manifest)}\n`,
    );
  }

  async save(encryptedState: string): Promise<void> {
    const serialized = await fs.promises.readFile(
      this.options.filePath,
      'utf8',
    );
    const current = parseMlsStateManifest(JSON.parse(serialized));
    const next = parseMlsStateManifest({ ...current, encryptedState });
    await writePrivateFileAtomic(
      this.options.filePath,
      `${JSON.stringify(next)}\n`,
    );
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.options.filePath, { force: true });
  }

  private async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.options.filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function validateGroupState(
  result: unknown,
  conversationId: string,
): MlsGroupState {
  const state = result as Partial<MlsGroupState>;
  if (
    state.protocol !== 'mls10-openmls-0.8' ||
    state.conversation_id !== conversationId ||
    !isBase64(state.group_id) ||
    !Number.isSafeInteger(state.epoch) ||
    (state.epoch ?? -1) < 0 ||
    !Number.isSafeInteger(state.member_count) ||
    (state.member_count ?? 0) < 1
  ) {
    throw new Error('native MLS group response is invalid');
  }
  return state as MlsGroupState;
}

function validatePendingApplication(
  result: unknown,
  conversationId: string,
  peerAccountId: string,
): MlsPendingApplication {
  const pending = result as Partial<MlsPendingApplication>;
  if (
    pending.protocol !== 'mls10-openmls-0.8' ||
    pending.conversation_id !== conversationId ||
    pending.peer_account_id !== peerAccountId ||
    typeof pending.event_id !== 'string' ||
    !/^mls-[0-9a-f]{64}$/.test(pending.event_id) ||
    !isBase64(pending.group_id) ||
    !Number.isSafeInteger(pending.epoch) ||
    (pending.epoch ?? -1) < 0 ||
    !isBase64(pending.ciphertext) ||
    pending.ciphertext.length > 2 * 1024 * 1024
  ) {
    throw new Error('native MLS pending application response is invalid');
  }
  return pending as MlsPendingApplication;
}

/**
 * Thin typed client for the native OpenMLS process. Signature keys, HPKE init
 * private keys and epoch secrets remain inside Rust. When persistence is
 * configured, only an authenticated encrypted snapshot leaves the process and
 * its state-encryption key must be protected by OS secure storage.
 */
export class OpenMlsNativeKernel {
  private native: NativeProcess;
  private scope: string;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private persistenceFailed = false;

  constructor(
    deviceScope: MlsDeviceScope,
    binaryPath?: string,
    private readonly persistence?: MlsStatePersistence,
  ) {
    this.scope = mlsDeviceScope(deviceScope);
    this.native = new NativeProcess(binaryPath);
  }

  async init(): Promise<void> {
    if (this.persistenceFailed) {
      throw new Error('MLS persistence is locked after a storage failure');
    }
    if (this.initialized) return;
    this.initializing ??= this.initializeOnce();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async createKeyPackage(): Promise<MlsKeyPackage> {
    await this.init();
    const result = await this.native.call('mls.key_package.create', {
      device_scope: this.scope,
    });
    await this.persistState();
    const keyPackage = result as Partial<MlsKeyPackage>;
    if (
      keyPackage.protocol !== 'mls10-openmls-0.8' ||
      keyPackage.ciphersuite !==
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' ||
      typeof keyPackage.reference !== 'string' ||
      !/^[0-9a-f]{64}$/.test(keyPackage.reference) ||
      !isBase64(keyPackage.key_package)
    ) {
      throw new Error('native MLS KeyPackage response is invalid');
    }
    return keyPackage as MlsKeyPackage;
  }

  async listKeyPackages(): Promise<MlsKeyPackage[]> {
    await this.init();
    const result = await this.native.call('mls.key_package.list', {
      device_scope: this.scope,
    });
    if (!Array.isArray(result)) {
      throw new Error('native MLS KeyPackage list response is invalid');
    }
    const references = new Set<string>();
    return result.map((value) => {
      const keyPackage = value as Partial<MlsKeyPackage>;
      if (
        keyPackage.protocol !== 'mls10-openmls-0.8' ||
        keyPackage.ciphersuite !==
          'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' ||
        typeof keyPackage.reference !== 'string' ||
        !/^[0-9a-f]{64}$/.test(keyPackage.reference) ||
        references.has(keyPackage.reference) ||
        !isBase64(keyPackage.key_package)
      ) {
        throw new Error('native MLS KeyPackage list entry is invalid');
      }
      references.add(keyPackage.reference);
      return keyPackage as MlsKeyPackage;
    });
  }

  async consumeKeyPackage(reference: string): Promise<void> {
    await this.init();
    if (!/^[0-9a-f]{64}$/.test(reference)) {
      throw new Error('MLS KeyPackage reference is invalid');
    }
    await this.native.call('mls.key_package.consume', { reference });
    await this.persistState();
  }

  async createGroup(conversationId: string): Promise<MlsGroupState> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const result = await this.native.call('mls.group.create', {
      device_scope: this.scope,
      conversation_id: conversation,
    });
    await this.persistState();
    return validateGroupState(result, conversation);
  }

  async addMember(
    conversationId: string,
    keyPackage: MlsKeyPackage,
  ): Promise<MlsMemberInvitation> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    if (
      keyPackage.protocol !== 'mls10-openmls-0.8' ||
      keyPackage.ciphersuite !==
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' ||
      !/^[0-9a-f]{64}$/.test(keyPackage.reference) ||
      !isBase64(keyPackage.key_package)
    ) {
      throw new Error('MLS member KeyPackage is invalid');
    }
    const result = (await this.native.call('mls.group.add_member', {
      device_scope: this.scope,
      conversation_id: conversation,
      key_package: keyPackage.key_package,
    })) as Partial<MlsMemberInvitation>;
    await this.persistState();
    if (
      result.protocol !== 'mls10-openmls-0.8' ||
      result.conversation_id !== conversation ||
      !isBase64(result.group_id) ||
      !Number.isSafeInteger(result.epoch) ||
      (result.epoch ?? -1) < 0 ||
      typeof result.key_package_reference !== 'string' ||
      !/^[0-9a-f]{64}$/.test(result.key_package_reference) ||
      result.key_package_reference !== keyPackage.reference ||
      typeof result.recipient_device_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(result.recipient_device_id) ||
      !isBase64(result.commit) ||
      !isBase64(result.welcome)
    ) {
      throw new Error('native MLS member invitation is invalid');
    }
    return result as MlsMemberInvitation;
  }

  async inspectGroup(
    conversationId: string,
  ): Promise<MlsGroupInspection | null> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const result = (await this.native.call('mls.group.inspect', {
      device_scope: this.scope,
      conversation_id: conversation,
    })) as Partial<MlsGroupInspection> | null;
    if (result === null) return null;
    const state = validateGroupState(result, conversation);
    if (
      typeof result.pending_commit !== 'boolean' ||
      (result.pending_invitation !== null &&
        (typeof result.pending_invitation !== 'object' ||
          result.pending_invitation.protocol !== 'mls10-openmls-0.8' ||
          result.pending_invitation.conversation_id !== conversation ||
          result.pending_invitation.group_id !== state.group_id ||
          result.pending_invitation.epoch !== state.epoch ||
          !/^[0-9a-f]{64}$/.test(
            result.pending_invitation.key_package_reference,
          ) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(
            result.pending_invitation.recipient_device_id,
          ) ||
          !isBase64(result.pending_invitation.commit) ||
          !isBase64(result.pending_invitation.welcome))) ||
      (result.pending_invitation !== null) !== result.pending_commit
    ) {
      throw new Error('native MLS group inspection response is invalid');
    }
    return {
      ...state,
      pending_commit: result.pending_commit,
      pending_invitation: result.pending_invitation ?? null,
    };
  }

  async mergePendingCommit(conversationId: string): Promise<MlsGroupState> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const result = await this.native.call('mls.group.merge_pending_commit', {
      device_scope: this.scope,
      conversation_id: conversation,
    });
    await this.persistState();
    return validateGroupState(result, conversation);
  }

  async joinGroup(
    conversationId: string,
    keyPackageReference: string,
    expectedGroupId: string,
    welcome: string,
  ): Promise<MlsGroupState> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    if (
      !/^[0-9a-f]{64}$/.test(keyPackageReference) ||
      !isBase64(expectedGroupId) ||
      !isBase64(welcome)
    ) {
      throw new Error('MLS Welcome parameters are invalid');
    }
    const result = await this.native.call('mls.group.join', {
      device_scope: this.scope,
      conversation_id: conversation,
      key_package_reference: keyPackageReference,
      expected_group_id: expectedGroupId,
      welcome,
    });
    await this.persistState();
    return validateGroupState(result, conversation);
  }

  async encryptTransportApplication(
    conversationId: string,
    peerAccountId: string,
    plaintext: Uint8Array,
  ): Promise<MlsPendingApplication> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const peer = peerAccountId.trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(peer) ||
      peer === this.scope.split('/')[2]
    ) {
      throw new Error('MLS peer account id is invalid');
    }
    if (plaintext.byteLength < 1 || plaintext.byteLength > 1024 * 1024) {
      throw new Error('MLS application plaintext size is invalid');
    }
    const result = await this.native.call('mls.application.encrypt_transport', {
      device_scope: this.scope,
      conversation_id: conversation,
      peer_account_id: peer,
      plaintext: Buffer.from(plaintext).toString('base64'),
    });
    await this.persistState();
    return validatePendingApplication(result, conversation, peer);
  }

  async listPendingApplications(
    conversationId: string,
    peerAccountId: string,
  ): Promise<MlsPendingApplication[]> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const peer = peerAccountId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(peer)) {
      throw new Error('MLS peer account id is invalid');
    }
    const result = await this.native.call('mls.application.outbox.list', {
      device_scope: this.scope,
      conversation_id: conversation,
      peer_account_id: peer,
    });
    if (!Array.isArray(result) || result.length > 1_000) {
      throw new Error('native MLS application outbox response is invalid');
    }
    const pending = result.map((item) =>
      validatePendingApplication(item, conversation, peer),
    );
    if (new Set(pending.map((item) => item.event_id)).size !== pending.length) {
      throw new Error('native MLS application outbox response is invalid');
    }
    return pending;
  }

  async listPendingApplicationPeers(): Promise<string[]> {
    await this.init();
    const result = await this.native.call('mls.application.outbox.list_peers', {
      device_scope: this.scope,
    });
    if (!Array.isArray(result) || result.length > 1_000) {
      throw new Error('native MLS application outbox peer response is invalid');
    }
    const peers = result.map((value) => {
      if (
        typeof value !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) ||
        value === this.scope.split('/')[2]
      ) {
        throw new Error('native MLS application outbox peer response is invalid');
      }
      return value;
    });
    if (
      new Set(peers).size !== peers.length ||
      peers.some((peer, index) => index > 0 && peers[index - 1]! >= peer)
    ) {
      throw new Error('native MLS application outbox peer response is invalid');
    }
    return peers;
  }

  async acknowledgePendingApplication(
    conversationId: string,
    peerAccountId: string,
    eventId: string,
  ): Promise<void> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const peer = peerAccountId.trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(peer) ||
      !/^mls-[0-9a-f]{64}$/.test(eventId)
    ) {
      throw new Error('MLS application event id is invalid');
    }
    const result = (await this.native.call('mls.application.outbox.ack', {
      device_scope: this.scope,
      conversation_id: conversation,
      peer_account_id: peer,
      event_id: eventId,
    })) as { event_id?: unknown };
    if (result.event_id !== eventId) {
      throw new Error('native MLS application acknowledgement is invalid');
    }
    await this.persistState();
  }

  async transportCursor(conversationId: string): Promise<number> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    const result = (await this.native.call('mls.transport.cursor', {
      device_scope: this.scope,
      conversation_id: conversation,
    })) as { sequence?: unknown };
    if (
      !Number.isSafeInteger(result.sequence) ||
      (result.sequence as number) < 0
    ) {
      throw new Error('native MLS transport cursor response is invalid');
    }
    return result.sequence as number;
  }

  async acknowledgeTransportEvent(
    conversationId: string,
    sequence: number,
  ): Promise<void> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('MLS transport sequence is invalid');
    }
    const result = (await this.native.call('mls.transport.ack', {
      device_scope: this.scope,
      conversation_id: conversation,
      sequence,
    })) as { sequence?: unknown };
    if (result.sequence !== sequence) {
      throw new Error('native MLS transport acknowledgement is invalid');
    }
    await this.persistState();
  }

  async decryptTransportApplication(
    conversationId: string,
    ciphertext: string,
    sequence: number,
  ): Promise<MlsDecryptedApplication> {
    await this.init();
    const conversation = mlsConversationId(conversationId);
    if (
      !isBase64(ciphertext) ||
      ciphertext.length > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      throw new Error('MLS transport application parameters are invalid');
    }
    const result = (await this.native.call(
      'mls.application.decrypt_transport',
      {
        device_scope: this.scope,
        conversation_id: conversation,
        ciphertext,
        sequence,
      },
    )) as {
      protocol?: unknown;
      conversation_id?: unknown;
      group_id?: unknown;
      epoch?: unknown;
      sender_device_scope?: unknown;
      plaintext?: unknown;
    };
    await this.persistState();
    if (
      result.protocol !== 'mls10-openmls-0.8' ||
      result.conversation_id !== conversation ||
      !isBase64(result.group_id) ||
      !Number.isSafeInteger(result.epoch) ||
      (result.epoch as number) < 0 ||
      typeof result.sender_device_scope !== 'string' ||
      !/^[^/\s]+\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(
        result.sender_device_scope,
      ) ||
      !isBase64(result.plaintext)
    ) {
      throw new Error('native MLS transport plaintext response is invalid');
    }
    return {
      protocol: 'mls10-openmls-0.8',
      conversationId: conversation,
      groupId: result.group_id,
      epoch: result.epoch as number,
      senderDeviceScope: result.sender_device_scope,
      plaintext: new Uint8Array(Buffer.from(result.plaintext, 'base64')),
    };
  }

  async reset(): Promise<void> {
    await this.init();
    await this.native.call('mls.reset', { device_scope: this.scope });
    if (this.persistence) {
      try {
        await this.persistence.clear();
      } catch (error) {
        this.persistenceFailed = true;
        throw new Error('MLS persistent state reset failed', { cause: error });
      }
    }
    this.initialized = false;
  }

  async close(): Promise<void> {
    await this.native.stop();
    this.initialized = false;
    this.initializing = null;
    this.persistenceFailed = false;
  }

  private async initializeOnce(): Promise<void> {
    await this.native.start();
    if (!this.persistence) {
      await this.native.call('mls.initialize', { device_scope: this.scope });
      this.initialized = true;
      return;
    }

    let stateKey: Uint8Array | null = null;
    try {
      const persisted = await this.persistence.load();
      if (persisted) {
        stateKey = new Uint8Array(persisted.stateKey);
        persisted.stateKey.fill(0);
        this.assertStateKey(stateKey);
        await this.native.call('mls.persistence.configure', {
          device_scope: this.scope,
          state_key: Buffer.from(stateKey).toString('base64'),
        });
        await this.native.call('mls.persistence.restore', {
          device_scope: this.scope,
          encrypted_state: persisted.encryptedState,
        });
      } else {
        stateKey = new Uint8Array(randomBytes(32));
        await this.native.call('mls.persistence.configure', {
          device_scope: this.scope,
          state_key: Buffer.from(stateKey).toString('base64'),
        });
        await this.native.call('mls.initialize', {
          device_scope: this.scope,
        });
        const encryptedState = await this.readNativeEncryptedState();
        await this.persistence.create(stateKey, encryptedState);
      }
      this.initialized = true;
    } catch (error) {
      this.persistenceFailed = true;
      await this.native.stop().catch(() => undefined);
      throw new Error('MLS persistent state initialization failed', {
        cause: error,
      });
    } finally {
      stateKey?.fill(0);
    }
  }

  private async persistState(): Promise<void> {
    if (!this.persistence) return;
    try {
      const encryptedState = await this.readNativeEncryptedState();
      await this.persistence.save(encryptedState);
    } catch (error) {
      this.persistenceFailed = true;
      throw new Error('MLS state persistence failed; kernel is locked', {
        cause: error,
      });
    }
  }

  private async readNativeEncryptedState(): Promise<string> {
    const result = (await this.native.call('mls.persistence.export', {
      device_scope: this.scope,
    })) as { format?: unknown; encrypted_state?: unknown };
    if (
      result.format !== 1 ||
      typeof result.encrypted_state !== 'string' ||
      !result.encrypted_state ||
      result.encrypted_state.length > 96 * 1024 * 1024
    ) {
      throw new Error('native MLS encrypted state response is invalid');
    }
    return result.encrypted_state;
  }

  private assertStateKey(stateKey: Uint8Array): void {
    if (stateKey.byteLength !== 32) {
      throw new Error('MLS state key from secure storage has an invalid size');
    }
  }
}

// ============ Tokenizer ============

export class Tokenizer {
  private native: NativeProcess;
  private initialized = false;

  constructor(
    private model: string,
    binaryPath?: string,
  ) {
    this.native = new NativeProcess(binaryPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('tokenizer.create', { model: this.model });
    this.initialized = true;
  }

  async count(text: string): Promise<number> {
    await this.init();
    const result = await this.native.call('tokenizer.count', { text });
    return (result as { tokens: number }).tokens;
  }

  async truncate(text: string, maxTokens: number): Promise<string> {
    await this.init();
    const result = await this.native.call('tokenizer.truncate', {
      text,
      max_tokens: maxTokens,
    });
    return (result as { text: string }).text;
  }

  static async supportedModels(binaryPath?: string): Promise<string[]> {
    const native = new NativeProcess(binaryPath);
    await native.start();
    const result = await native.call('tokenizer.supported_models');
    await native.stop();
    return (result as { models: string[] }).models;
  }

  async close(): Promise<void> {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Agent Pool ============

export class AgentPool {
  private native: NativeProcess;
  private initialized = false;

  constructor(
    private maxMemoryMb: number = 256,
    private maxAgents: number = 10,
    binaryPath?: string,
  ) {
    this.native = new NativeProcess(binaryPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('agent_pool.create', {
      max_memory_mb: this.maxMemoryMb,
      max_agents: this.maxAgents,
    });
    this.initialized = true;
  }

  async register(id: string, memoryMb: number = 10): Promise<boolean> {
    await this.init();
    const result = await this.native.call('agent_pool.register', {
      id,
      memory_mb: memoryMb,
    });
    return (result as { registered: boolean }).registered;
  }

  async unregister(id: string): Promise<boolean> {
    await this.init();
    const result = await this.native.call('agent_pool.unregister', { id });
    return (result as { unregistered: boolean }).unregistered;
  }

  async updateMemory(id: string, memoryMb: number): Promise<boolean> {
    await this.init();
    const result = await this.native.call('agent_pool.update_memory', {
      id,
      memory_mb: memoryMb,
    });
    return (result as { updated: boolean }).updated;
  }

  async addLog(id: string, log: string): Promise<boolean> {
    await this.init();
    const result = await this.native.call('agent_pool.add_log', { id, log });
    return (result as { added: boolean }).added;
  }

  async drainPending(id: string): Promise<string[]> {
    await this.init();
    const result = await this.native.call('agent_pool.drain_pending', { id });
    return (result as { results: string[] }).results;
  }

  async stats(): Promise<{
    current_memory_mb: number;
    max_memory_mb: number;
    agent_count: number;
  }> {
    await this.init();
    const result = await this.native.call('agent_pool.stats');
    return result as {
      current_memory_mb: number;
      max_memory_mb: number;
      agent_count: number;
    };
  }

  async listAgents(): Promise<AgentInfo[]> {
    await this.init();
    const result = await this.native.call('agent_pool.list_agents');
    return result as AgentInfo[];
  }

  async cleanupIdle(idleSeconds: number = 300): Promise<number> {
    await this.init();
    const result = await this.native.call('agent_pool.cleanup_idle', {
      idle_seconds: idleSeconds,
    });
    return (result as { cleaned: number }).cleaned;
  }

  async close(): Promise<void> {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Shared Process (for efficiency) ============

let sharedProcess: NativeProcess | null = null;

export async function getSharedProcess(
  binaryPath?: string,
): Promise<NativeProcess> {
  if (!sharedProcess) {
    sharedProcess = new NativeProcess(binaryPath);
    await sharedProcess.start();
  }
  return sharedProcess;
}

export async function closeSharedProcess(): Promise<void> {
  if (sharedProcess) {
    await sharedProcess.stop();
    sharedProcess = null;
  }
}
