/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAgentResourceBudget } from '../core/agentResourceBudget.js';
import { NativeCoreBridge, type NativeCoreRuntimeSelection } from './nativeCoreBridge.js';

export type NativeAgentPoolStatus = 'native' | 'fallback';

export interface NativeAgentPoolRuntimeBridge {
  readonly selection: NativeCoreRuntimeSelection;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface NativeAgentPoolRuntimeOptions {
  bridge?: NativeAgentPoolRuntimeBridge;
  maxMemoryMb?: number;
  maxAgents?: number;
  initialMemoryMb?: number;
}

export interface NativeAgentPoolRegistration {
  status: NativeAgentPoolStatus;
  registered: boolean;
}

const DEFAULT_MAX_MEMORY_MB = 256;
const DEFAULT_INITIAL_MEMORY_MB = 10;

function readBooleanField(value: unknown, field: string): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    field in value &&
    (value as Record<string, unknown>)[field] === true,
  );
}

function bytesToWholeMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return DEFAULT_INITIAL_MEMORY_MB;
  return Math.max(1, Math.ceil(bytes / 1024 / 1024));
}

export class NativeAgentPoolRuntime {
  private initialized = false;
  private disabled = false;

  constructor(private readonly options: NativeAgentPoolRuntimeOptions = {}) {}

  async register(agentId: string, initialMemoryMb: number = DEFAULT_INITIAL_MEMORY_MB): Promise<NativeAgentPoolRegistration> {
    const ready = await this.ensureInitialized();
    if (!ready) return { status: 'fallback', registered: false };

    const result = await this.callNative('agent_pool.register', {
      id: agentId,
      memory_mb: Math.max(1, Math.ceil(initialMemoryMb)),
    });

    return {
      status: 'native',
      registered: readBooleanField(result, 'registered'),
    };
  }

  async updateMemory(agentId: string, memoryBytes: number): Promise<NativeAgentPoolStatus> {
    const ready = await this.ensureInitialized();
    if (!ready) return 'fallback';

    await this.callNative('agent_pool.update_memory', {
      id: agentId,
      memory_mb: bytesToWholeMb(memoryBytes),
    });
    return 'native';
  }

  async unregister(agentId: string): Promise<NativeAgentPoolStatus> {
    const ready = await this.ensureInitialized();
    if (!ready) return 'fallback';

    await this.callNative('agent_pool.unregister', { id: agentId });
    return 'native';
  }

  private async ensureInitialized(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.disabled) return false;

    const bridge = this.bridge;
    let selection: NativeCoreRuntimeSelection;
    try {
      selection = bridge.selection;
    } catch {
      throw new Error('Native core runtime selection is unavailable');
    }

    if (!selection.enabled) {
      this.disabled = true;
      return false;
    }

    try {
      const budget = getAgentResourceBudget();
      await bridge.call('agent_pool.create', {
        max_memory_mb: this.options.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB,
        max_agents: this.options.maxAgents ?? budget.taskMaxConcurrency,
      });
      this.initialized = true;
      return true;
    } catch (error) {
      if (selection.required) throw error;
      this.disabled = true;
      return false;
    }
  }

  private async callNative(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.bridge.call(method, params);
    } catch (error) {
      if (this.bridge.selection.required) throw error;
      this.disabled = true;
      return undefined;
    }
  }

  private get bridge(): NativeAgentPoolRuntimeBridge {
    return this.options.bridge ?? DEFAULT_NATIVE_AGENT_POOL_BRIDGE;
  }
}

const DEFAULT_NATIVE_AGENT_POOL_BRIDGE = new NativeCoreBridge();
let defaultNativeAgentPoolRuntime: NativeAgentPoolRuntime | undefined;

export function getNativeAgentPoolRuntime(): NativeAgentPoolRuntime {
  defaultNativeAgentPoolRuntime ??= new NativeAgentPoolRuntime();
  return defaultNativeAgentPoolRuntime;
}

export function resetNativeAgentPoolRuntimeForTests(): void {
  defaultNativeAgentPoolRuntime = undefined;
}
