/**
 * @otto/native integration layer for Otto core
 * 
 * This module provides optional Rust-native implementations for:
 * - Session storage (sled-based KV with LRU cache)
 * - Token counting (tiktoken-based local counting)
 * - Agent memory pool management
 * 
 * Falls back to JS implementations when native binary is not available.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

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
  private starting: Promise<void> | null = null;

  constructor(binaryPath?: string) {
    super();
    this.binaryPath = binaryPath || this.findBinary();
  }

  private findBinary(): string {
    const candidates = [
      // Development paths
      path.join(__dirname, '..', '..', '..', '..', 'otto-native', 'target', 'release', 'otto-native.exe'),
      path.join(__dirname, '..', '..', '..', '..', 'otto-native', 'target', 'release', 'otto-native'),
      path.join(__dirname, '..', '..', '..', '..', 'otto-native', 'target', 'x86_64-pc-windows-gnu', 'release', 'otto-native.exe'),
      path.join(__dirname, '..', '..', '..', '..', 'otto-native', 'target', 'x86_64-unknown-linux-gnu', 'release', 'otto-native'),
      // Installed paths
      path.join(__dirname, '..', 'bin', 'otto-native.exe'),
      path.join(__dirname, '..', 'bin', 'otto-native'),
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
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.binaryPath, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.process.stdout!.on('data', (data: Buffer) => {
          this.buffer += data.toString();
          this.processBuffer();
        });

        this.process.stderr!.on('data', (data: Buffer) => {
          console.error('[otto-native] stderr:', data.toString());
        });

        this.process.on('exit', (code) => {
          this.process = null;
          this.starting = null;
          this.emit('exit', code);
          this.pending.forEach(({ reject }) => {
            reject(new Error(`Process exited with code ${code}`));
          });
          this.pending.clear();
        });

        this.process.on('error', (err) => {
          this.process = null;
          this.starting = null;
          reject(err);
        });

        // Wait for process to be ready
        this.call('ping').then(() => resolve()).catch(reject);
      } catch (err) {
        this.starting = null;
        reject(err);
      }
    });

    return this.starting;
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
        } catch (e) {
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
      this.starting = null;
    }
  }
}

// ============ Singleton Process ============

let sharedProcess: NativeProcess | null = null;
let nativeAvailable: boolean | null = null;

async function getNativeProcess(): Promise<NativeProcess | null> {
  if (nativeAvailable === false) return null;
  
  if (!sharedProcess) {
    sharedProcess = new NativeProcess();
    try {
      await sharedProcess.start();
      nativeAvailable = true;
    } catch (err) {
      console.warn('[otto-native] Native binary not available, falling back to JS:', (err as Error).message);
      nativeAvailable = false;
      sharedProcess = null;
      return null;
    }
  }
  
  return sharedProcess;
}

export function isNativeAvailable(): boolean {
  return nativeAvailable === true;
}

// ============ Session Store ============

export class NativeSessionStore {
  private initialized = false;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    
    const proc = await getNativeProcess();
    if (!proc) return false;

    try {
      await proc.call('session_store.open', { path: this.dbPath });
      this.initialized = true;
      return true;
    } catch (err) {
      console.warn('[otto-native] Failed to open session store:', (err as Error).message);
      return false;
    }
  }

  async save(id: string, title: string, messages: Message[]): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) return false;
    }

    try {
      await proc.call('session_store.save', { id, title, messages });
      return true;
    } catch (err) {
      console.warn('[otto-native] Failed to save session:', (err as Error).message);
      return false;
    }
  }

  async load(id: string): Promise<SessionData | null> {
    const proc = await getNativeProcess();
    if (!proc) return null;
    
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) return null;
    }

    try {
      const result = await proc.call('session_store.load', { id });
      return result as SessionData | null;
    } catch (err) {
      console.warn('[otto-native] Failed to load session:', (err as Error).message);
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) return false;

    try {
      const result = await proc.call('session_store.delete', { id });
      return (result as { deleted: boolean }).deleted;
    } catch (err) {
      console.warn('[otto-native] Failed to delete session:', (err as Error).message);
      return false;
    }
  }

  async list(): Promise<SessionMeta[]> {
    const proc = await getNativeProcess();
    if (!proc) return [];
    
    if (!this.initialized) return [];

    try {
      const result = await proc.call('session_store.list');
      return result as SessionMeta[];
    } catch (err) {
      console.warn('[otto-native] Failed to list sessions:', (err as Error).message);
      return [];
    }
  }

  async sizeBytes(): Promise<number> {
    const proc = await getNativeProcess();
    if (!proc) return 0;
    
    if (!this.initialized) return 0;

    try {
      const result = await proc.call('session_store.size_bytes');
      return (result as { size: number }).size;
    } catch (err) {
      return 0;
    }
  }
}

// ============ Encryption Store ============

export class NativeEncryptionStore {
  private initialized = false;
  private dbPath: string;
  private key: string;

  constructor(dbPath: string, key: string) {
    this.dbPath = dbPath;
    this.key = key;
  }

  static generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    
    const proc = await getNativeProcess();
    if (!proc) return false;

    try {
      await proc.call('encryption.open', { path: this.dbPath, key: this.key });
      this.initialized = true;
      return true;
    } catch (err) {
      console.warn('[otto-native] Failed to open encryption store:', (err as Error).message);
      return false;
    }
  }

  async save(id: string, data: string): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) return false;
    }

    try {
      await proc.call('encryption.save', { id, data });
      return true;
    } catch (err) {
      console.warn('[otto-native] Failed to save encrypted data:', (err as Error).message);
      return false;
    }
  }

  async load(id: string): Promise<string | null> {
    const proc = await getNativeProcess();
    if (!proc) return null;
    
    if (!this.initialized) return null;

    try {
      const result = await proc.call('encryption.load', { id });
      return (result as { data: string | null }).data;
    } catch (err) {
      console.warn('[otto-native] Failed to load encrypted data:', (err as Error).message);
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) return false;

    try {
      const result = await proc.call('encryption.delete', { id });
      return (result as { deleted: boolean }).deleted;
    } catch (err) {
      return false;
    }
  }
}

// ============ Tokenizer ============

export class NativeTokenizer {
  private initialized = false;
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    
    const proc = await getNativeProcess();
    if (!proc) return false;

    try {
      await proc.call('tokenizer.create', { model: this.model });
      this.initialized = true;
      return true;
    } catch (err) {
      console.warn('[otto-native] Failed to create tokenizer:', (err as Error).message);
      return false;
    }
  }

  async count(text: string): Promise<number | null> {
    const proc = await getNativeProcess();
    if (!proc) return null;
    
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) return null;
    }

    try {
      const result = await proc.call('tokenizer.count', { text });
      return (result as { tokens: number }).tokens;
    } catch (err) {
      console.warn('[otto-native] Failed to count tokens:', (err as Error).message);
      return null;
    }
  }

  async truncate(text: string, maxTokens: number): Promise<string | null> {
    const proc = await getNativeProcess();
    if (!proc) return null;
    
    if (!this.initialized) return null;

    try {
      const result = await proc.call('tokenizer.truncate', { text, max_tokens: maxTokens });
      return (result as { text: string }).text;
    } catch (err) {
      console.warn('[otto-native] Failed to truncate text:', (err as Error).message);
      return null;
    }
  }

  static async supportedModels(): Promise<string[]> {
    const proc = await getNativeProcess();
    if (!proc) return [];

    try {
      const result = await proc.call('tokenizer.supported_models');
      return (result as { models: string[] }).models;
    } catch (err) {
      return [];
    }
  }
}

// ============ Agent Pool ============

export class NativeAgentPool {
  private initialized = false;
  private maxMemoryMb: number;
  private maxAgents: number;

  constructor(maxMemoryMb: number = 256, maxAgents: number = 10) {
    this.maxMemoryMb = maxMemoryMb;
    this.maxAgents = maxAgents;
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    
    const proc = await getNativeProcess();
    if (!proc) return false;

    try {
      await proc.call('agent_pool.create', {
        max_memory_mb: this.maxMemoryMb,
        max_agents: this.maxAgents,
      });
      this.initialized = true;
      return true;
    } catch (err) {
      console.warn('[otto-native] Failed to create agent pool:', (err as Error).message);
      return false;
    }
  }

  async register(id: string, memoryMb: number = 10): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) {
      const ok = await this.init();
      if (!ok) return false;
    }

    try {
      const result = await proc.call('agent_pool.register', { id, memory_mb: memoryMb });
      return (result as { registered: boolean }).registered;
    } catch (err) {
      console.warn('[otto-native] Failed to register agent:', (err as Error).message);
      return false;
    }
  }

  async unregister(id: string): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) return false;

    try {
      const result = await proc.call('agent_pool.unregister', { id });
      return (result as { unregistered: boolean }).unregistered;
    } catch (err) {
      return false;
    }
  }

  async updateMemory(id: string, memoryMb: number): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) return false;

    try {
      const result = await proc.call('agent_pool.update_memory', { id, memory_mb: memoryMb });
      return (result as { updated: boolean }).updated;
    } catch (err) {
      return false;
    }
  }

  async addLog(id: string, log: string): Promise<boolean> {
    const proc = await getNativeProcess();
    if (!proc) return false;
    
    if (!this.initialized) return false;

    try {
      const result = await proc.call('agent_pool.add_log', { id, log });
      return (result as { added: boolean }).added;
    } catch (err) {
      return false;
    }
  }

  async stats(): Promise<{ current_memory_mb: number; max_memory_mb: number; agent_count: number } | null> {
    const proc = await getNativeProcess();
    if (!proc) return null;
    
    if (!this.initialized) return null;

    try {
      const result = await proc.call('agent_pool.stats');
      return result as { current_memory_mb: number; max_memory_mb: number; agent_count: number };
    } catch (err) {
      return null;
    }
  }

  async listAgents(): Promise<AgentInfo[]> {
    const proc = await getNativeProcess();
    if (!proc) return [];
    
    if (!this.initialized) return [];

    try {
      const result = await proc.call('agent_pool.list_agents');
      return result as AgentInfo[];
    } catch (err) {
      return [];
    }
  }

  async cleanupIdle(idleSeconds: number = 300): Promise<number> {
    const proc = await getNativeProcess();
    if (!proc) return 0;
    
    if (!this.initialized) return 0;

    try {
      const result = await proc.call('agent_pool.cleanup_idle', { idle_seconds: idleSeconds });
      return (result as { cleaned: number }).cleaned;
    } catch (err) {
      return 0;
    }
  }
}

// ============ Cleanup ============

export async function shutdownNative(): Promise<void> {
  if (sharedProcess) {
    await sharedProcess.stop();
    sharedProcess = null;
    nativeAvailable = null;
  }
}

// Graceful shutdown on process exit
process.on('exit', () => {
  if (sharedProcess) {
    try {
      sharedProcess.stop();
    } catch {
      // Ignore errors during shutdown
    }
  }
});
