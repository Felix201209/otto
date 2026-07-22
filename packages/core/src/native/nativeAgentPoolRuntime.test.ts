/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { NativeAgentPoolRuntime, type NativeAgentPoolRuntimeBridge } from './nativeAgentPoolRuntime.js';

function createBridge(params: {
  enabled: boolean;
  required?: boolean;
  fail?: boolean;
}): NativeAgentPoolRuntimeBridge & { calls: Array<{ method: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    selection: {
      mode: params.required ? 'required' : 'auto',
      enabled: params.enabled,
      required: Boolean(params.required),
      binaryPath: params.enabled ? '/native/otto-native' : undefined,
      hotPathMethods: [],
    },
    async call(method: string, callParams?: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params: callParams });
      if (params.fail) throw new Error('native unavailable');
      if (method === 'agent_pool.register') return { registered: true };
      return { status: 'ok' };
    },
  };
}

describe('NativeAgentPoolRuntime', () => {
  it('uses JS fallback when native core is unavailable in auto mode', async () => {
    const bridge = createBridge({ enabled: false });
    const runtime = new NativeAgentPoolRuntime({ bridge });

    await expect(runtime.register('agent-1')).resolves.toEqual({
      status: 'fallback',
      registered: false,
    });
    expect(bridge.calls).toEqual([]);
  });

  it('creates and registers agents through Rust when native core is available', async () => {
    const bridge = createBridge({ enabled: true });
    const runtime = new NativeAgentPoolRuntime({ bridge, maxMemoryMb: 64, maxAgents: 2 });

    await expect(runtime.register('agent-1', 7)).resolves.toEqual({
      status: 'native',
      registered: true,
    });
    await runtime.updateMemory('agent-1', 8 * 1024 * 1024 + 1);
    await runtime.unregister('agent-1');

    expect(bridge.calls.map((call) => call.method)).toEqual([
      'agent_pool.create',
      'agent_pool.register',
      'agent_pool.update_memory',
      'agent_pool.unregister',
    ]);
    expect(bridge.calls[0].params).toMatchObject({ max_memory_mb: 64, max_agents: 2 });
    expect(bridge.calls[2].params).toMatchObject({ memory_mb: 9 });
  });

  it('fails fast in required mode when native calls fail', async () => {
    const bridge = createBridge({ enabled: true, required: true, fail: true });
    const runtime = new NativeAgentPoolRuntime({ bridge });

    await expect(runtime.register('agent-1')).rejects.toThrow('native unavailable');
  });
});

