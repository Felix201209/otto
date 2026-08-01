/**
 * @otto/native - Rust native bindings for Otto
 * 
 * Provides high-performance implementations of:
 * - Session Store (sled-based KV with LRU cache)
 * - Encryption Store (AES-256-GCM)
 * - Tokenizer (tiktoken-based local token counting)
 * - Agent Pool (memory-managed concurrent agent pool)
 */

import { createHash, randomBytes } from 'node:crypto';
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
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
      path.join(__dirname, '..', 'target', 'x86_64-pc-windows-gnu', 'release', 'otto-native.exe'),
      path.join(__dirname, '..', 'target', 'x86_64-unknown-linux-gnu', 'release', 'otto-native'),
      path.join(__dirname, '..', 'target', 'x86_64-apple-darwin', 'release', 'otto-native'),
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
      this.emit('error', new Error(data.toString()));
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

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
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

  constructor(private dbPath: string, private cacheSize?: number, binaryPath?: string) {
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

  constructor(private dbPath: string, private key: string, binaryPath?: string) {
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

/**
 * Thin typed client for the native OpenMLS process. Only public KeyPackages
 * cross this boundary. Signature keys, HPKE init private keys and provider
 * state remain inside Rust and disappear on reset or process exit.
 */
export class OpenMlsNativeKernel {
  private native: NativeProcess;
  private scope: string;
  private initialized = false;

  constructor(deviceScope: MlsDeviceScope, binaryPath?: string) {
    this.scope = mlsDeviceScope(deviceScope);
    this.native = new NativeProcess(binaryPath);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('mls.initialize', { device_scope: this.scope });
    this.initialized = true;
  }

  async createKeyPackage(): Promise<MlsKeyPackage> {
    await this.init();
    const result = await this.native.call('mls.key_package.create', {
      device_scope: this.scope,
    });
    const keyPackage = result as Partial<MlsKeyPackage>;
    if (
      keyPackage.protocol !== 'mls10-openmls-0.8' ||
      keyPackage.ciphersuite !==
        'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519' ||
      typeof keyPackage.reference !== 'string' ||
      !/^[0-9a-f]{64}$/.test(keyPackage.reference) ||
      typeof keyPackage.key_package !== 'string' ||
      !keyPackage.key_package
    ) {
      throw new Error('native MLS KeyPackage response is invalid');
    }
    return keyPackage as MlsKeyPackage;
  }

  async consumeKeyPackage(reference: string): Promise<void> {
    await this.init();
    if (!/^[0-9a-f]{64}$/.test(reference)) {
      throw new Error('MLS KeyPackage reference is invalid');
    }
    await this.native.call('mls.key_package.consume', { reference });
  }

  async reset(): Promise<void> {
    await this.init();
    await this.native.call('mls.reset', { device_scope: this.scope });
    this.initialized = false;
  }

  async close(): Promise<void> {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Tokenizer ============

export class Tokenizer {
  private native: NativeProcess;
  private initialized = false;

  constructor(private model: string, binaryPath?: string) {
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
    binaryPath?: string
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

  async stats(): Promise<{ current_memory_mb: number; max_memory_mb: number; agent_count: number }> {
    await this.init();
    const result = await this.native.call('agent_pool.stats');
    return result as { current_memory_mb: number; max_memory_mb: number; agent_count: number };
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

export async function getSharedProcess(binaryPath?: string): Promise<NativeProcess> {
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
