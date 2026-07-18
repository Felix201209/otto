/**
 * @otto/native - Rust native bindings for Otto
 * 
 * Provides high-performance implementations of:
 * - Session Store (sled-based KV with LRU cache)
 * - Encryption Store (AES-256-GCM)
 * - Tokenizer (tiktoken-based local token counting)
 * - Agent Pool (memory-managed concurrent agent pool)
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ============ Native Process Manager ============

class NativeProcess extends EventEmitter {
  constructor(binaryPath) {
    super();
    this.process = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.binaryPath = binaryPath || this.findBinary();
  }

  findBinary() {
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

    return 'otto-native';
  }

  async start() {
    if (this.process) return;

    this.process = spawn(this.binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr.on('data', (data) => {
      this.emit('error', new Error(data.toString()));
    });

    this.process.on('exit', (code) => {
      this.process = null;
      this.emit('exit', code);
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Process exited with code ${code}`));
      }
      this.pending.clear();
    });

    await this.call('ping');
  }

  processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          if (response.id !== undefined && this.pending.has(response.id)) {
            const { resolve, reject } = this.pending.get(response.id);
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

  async call(method, params) {
    if (!this.process) {
      await this.start();
    }

    const id = ++this.requestId;
    const request = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  async stop() {
    if (this.process) {
      this.process.stdin.end();
      this.process = null;
    }
  }
}

// ============ Session Store ============

class SessionStore {
  constructor(dbPath, cacheSize, binaryPath) {
    this.dbPath = dbPath;
    this.cacheSize = cacheSize;
    this.native = new NativeProcess(binaryPath);
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('session_store.open', {
      path: this.dbPath,
      cache_size: this.cacheSize,
    });
    this.initialized = true;
  }

  async save(id, title, messages) {
    await this.init();
    await this.native.call('session_store.save', { id, title, messages });
  }

  async load(id) {
    await this.init();
    return await this.native.call('session_store.load', { id });
  }

  async delete(id) {
    await this.init();
    const result = await this.native.call('session_store.delete', { id });
    return result.deleted;
  }

  async list() {
    await this.init();
    return await this.native.call('session_store.list');
  }

  async sizeBytes() {
    await this.init();
    const result = await this.native.call('session_store.size_bytes');
    return result.size;
  }

  async close() {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Encryption Store ============

class EncryptionStore {
  constructor(dbPath, key, binaryPath) {
    this.dbPath = dbPath;
    this.key = key;
    this.native = new NativeProcess(binaryPath);
    this.initialized = false;
  }

  static generateKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  async init() {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('encryption.open', {
      path: this.dbPath,
      key: this.key,
    });
    this.initialized = true;
  }

  async save(id, data) {
    await this.init();
    await this.native.call('encryption.save', { id, data });
  }

  async load(id) {
    await this.init();
    const result = await this.native.call('encryption.load', { id });
    return result.data;
  }

  async delete(id) {
    await this.init();
    const result = await this.native.call('encryption.delete', { id });
    return result.deleted;
  }

  async listIds() {
    await this.init();
    const result = await this.native.call('encryption.list_ids');
    return result.ids;
  }

  async close() {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Tokenizer ============

class Tokenizer {
  constructor(model, binaryPath) {
    this.model = model;
    this.native = new NativeProcess(binaryPath);
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('tokenizer.create', { model: this.model });
    this.initialized = true;
  }

  async count(text) {
    await this.init();
    const result = await this.native.call('tokenizer.count', { text });
    return result.tokens;
  }

  async truncate(text, maxTokens) {
    await this.init();
    const result = await this.native.call('tokenizer.truncate', {
      text,
      max_tokens: maxTokens,
    });
    return result.text;
  }

  static async supportedModels(binaryPath) {
    const native = new NativeProcess(binaryPath);
    await native.start();
    const result = await native.call('tokenizer.supported_models');
    await native.stop();
    return result.models;
  }

  async close() {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Agent Pool ============

class AgentPool {
  constructor(maxMemoryMb = 256, maxAgents = 10, binaryPath) {
    this.maxMemoryMb = maxMemoryMb;
    this.maxAgents = maxAgents;
    this.native = new NativeProcess(binaryPath);
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await this.native.start();
    await this.native.call('agent_pool.create', {
      max_memory_mb: this.maxMemoryMb,
      max_agents: this.maxAgents,
    });
    this.initialized = true;
  }

  async register(id, memoryMb = 10) {
    await this.init();
    const result = await this.native.call('agent_pool.register', {
      id,
      memory_mb: memoryMb,
    });
    return result.registered;
  }

  async unregister(id) {
    await this.init();
    const result = await this.native.call('agent_pool.unregister', { id });
    return result.unregistered;
  }

  async updateMemory(id, memoryMb) {
    await this.init();
    const result = await this.native.call('agent_pool.update_memory', {
      id,
      memory_mb: memoryMb,
    });
    return result.updated;
  }

  async addLog(id, log) {
    await this.init();
    const result = await this.native.call('agent_pool.add_log', { id, log });
    return result.added;
  }

  async drainPending(id) {
    await this.init();
    const result = await this.native.call('agent_pool.drain_pending', { id });
    return result.results;
  }

  async stats() {
    await this.init();
    return await this.native.call('agent_pool.stats');
  }

  async listAgents() {
    await this.init();
    return await this.native.call('agent_pool.list_agents');
  }

  async cleanupIdle(idleSeconds = 300) {
    await this.init();
    const result = await this.native.call('agent_pool.cleanup_idle', {
      idle_seconds: idleSeconds,
    });
    return result.cleaned;
  }

  async close() {
    await this.native.stop();
    this.initialized = false;
  }
}

// ============ Exports ============

module.exports = {
  SessionStore,
  EncryptionStore,
  Tokenizer,
  AgentPool,
  NativeProcess,
};
