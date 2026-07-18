/**
 * Native performance utilities for Otto
 * 
 * Provides easy access to Rust-native implementations:
 * - Local token counting (no network, instant)
 * - Encrypted storage for sensitive data
 * - Agent memory pool management
 * 
 * Usage:
 *   import { nativeUtils } from './utils/nativeUtils.js';
 *   
 *   // Count tokens locally
 *   const tokens = await nativeUtils.countTokens('Hello world', 'gpt-4');
 *   
 *   // Store encrypted data
 *   await nativeUtils.storeSecret('api-key', 'sk-...');
 *   const key = await nativeUtils.loadSecret('api-key');
 */

import { 
  NativeTokenizer, 
  NativeEncryptionStore, 
  NativeAgentPool,
  isNativeAvailable,
  shutdownNative,
} from '../native/index.js';
import * as path from 'path';
import * as fs from 'fs';
import { getProjectTempDir } from './paths.js';

// Singleton instances
let tokenizer: NativeTokenizer | null = null;
let encryptionStore: NativeEncryptionStore | null = null;
let agentPool: NativeAgentPool | null = null;
let currentModel = 'gpt-4';

/**
 * Initialize native utilities
 * Call this at startup to enable native features
 */
export async function initNativeUtils(projectRoot?: string): Promise<boolean> {
  if (!isNativeAvailable()) {
    console.log('[nativeUtils] Native binary not available, using JS fallbacks');
    return false;
  }
  
  // Initialize tokenizer with default model
  tokenizer = new NativeTokenizer(currentModel);
  const tokenizerOk = await tokenizer.init();
  
  if (tokenizerOk) {
    console.log('[nativeUtils] Native tokenizer initialized');
  }
  
  // Initialize encryption store if project root provided
  if (projectRoot) {
    const tempDir = getProjectTempDir(projectRoot);
    const encDbPath = path.join(tempDir, 'secrets.db');
    
    // Generate or load encryption key
    const keyPath = path.join(tempDir, '.encryption-key');
    let key: string;
    
    try {
      key = fs.readFileSync(keyPath, 'utf-8').trim();
    } catch {
      key = NativeEncryptionStore.generateKey();
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
    }
    
    encryptionStore = new NativeEncryptionStore(encDbPath, key);
    const encOk = await encryptionStore.init();
    
    if (encOk) {
      console.log('[nativeUtils] Native encryption store initialized');
    }
  }
  
  // Initialize agent pool
  agentPool = new NativeAgentPool(256, 10);
  const poolOk = await agentPool.init();
  
  if (poolOk) {
    console.log('[nativeUtils] Native agent pool initialized (256MB, 10 agents)');
  }
  
  return tokenizerOk;
}

/**
 * Native utilities object
 */
export const nativeUtils = {
  /**
   * Check if native features are available
   */
  isAvailable(): boolean {
    return isNativeAvailable();
  },
  
  /**
   * Count tokens locally using Rust tiktoken
   * Falls back to null if native not available
   */
  async countTokens(text: string, model?: string): Promise<number | null> {
    if (!tokenizer) return null;
    
    // Switch model if different
    if (model && model !== currentModel) {
      currentModel = model;
      tokenizer = new NativeTokenizer(model);
      await tokenizer.init();
    }
    
    return tokenizer.count(text);
  },
  
  /**
   * Truncate text to fit within token limit
   */
  async truncateToTokens(text: string, maxTokens: number): Promise<string | null> {
    if (!tokenizer) return null;
    return tokenizer.truncate(text, maxTokens);
  },
  
  /**
   * Store encrypted secret
   */
  async storeSecret(key: string, value: string): Promise<boolean> {
    if (!encryptionStore) return false;
    return encryptionStore.save(key, value);
  },
  
  /**
   * Load encrypted secret
   */
  async loadSecret(key: string): Promise<string | null> {
    if (!encryptionStore) return null;
    return encryptionStore.load(key);
  },
  
  /**
   * Delete encrypted secret
   */
  async deleteSecret(key: string): Promise<boolean> {
    if (!encryptionStore) return false;
    return encryptionStore.delete(key);
  },
  
  /**
   * Get agent pool statistics
   */
  async getAgentPoolStats(): Promise<{
    current_memory_mb: number;
    max_memory_mb: number;
    agent_count: number;
  } | null> {
    if (!agentPool) return null;
    return agentPool.stats();
  },
  
  /**
   * List active agents
   */
  async listActiveAgents(): Promise<Array<{
    id: string;
    memory_mb: number;
    log_count: number;
    created_secs_ago: number;
  }>> {
    if (!agentPool) return [];
    return agentPool.listAgents();
  },
  
  /**
   * Cleanup idle agents
   */
  async cleanupIdleAgents(idleSeconds: number = 300): Promise<number> {
    if (!agentPool) return 0;
    return agentPool.cleanupIdle(idleSeconds);
  },
  
  /**
   * Shutdown native process
   */
  async shutdown(): Promise<void> {
    await shutdownNative();
    tokenizer = null;
    encryptionStore = null;
    agentPool = null;
  },
};

// Export types
export type NativeUtils = typeof nativeUtils;
