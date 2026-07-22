/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { NativeSessionStoreRuntime, type NativeSessionStoreRuntimeBridge } from './nativeSessionStoreRuntime.js';

function createBridge(params: {
  enabled: boolean;
  required?: boolean;
  fail?: boolean;
}): NativeSessionStoreRuntimeBridge & { calls: Array<{ method: string; params?: Record<string, unknown> }> } {
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
      if (params.fail) throw new Error('native session store unavailable');
      if (method === 'session_store.load') {
        return {
          meta: { id: 's1', title: 'Session', updated_at: 1, message_count: 1 },
          messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
        };
      }
      if (method === 'session_store.delete') return { deleted: true };
      if (method === 'session_store.list') return [{ id: 's1', title: 'Session', updated_at: 1, message_count: 1 }];
      if (method === 'session_store.size_bytes') return { size: 123 };
      return { status: 'ok' };
    },
  };
}

describe('NativeSessionStoreRuntime', () => {
  it('uses fallback when native session store is unavailable in auto mode', async () => {
    const bridge = createBridge({ enabled: false });
    const runtime = new NativeSessionStoreRuntime({ bridge, path: '/sessions.db' });

    await expect(runtime.load('s1')).resolves.toEqual({ status: 'fallback' });
    await expect(runtime.list()).resolves.toEqual({ status: 'fallback' });
    expect(bridge.calls).toEqual([]);
  });

  it('opens once and routes session operations through Rust when available', async () => {
    const bridge = createBridge({ enabled: true });
    const runtime = new NativeSessionStoreRuntime({ bridge, path: '/sessions.db', cacheSize: 20 });

    await expect(runtime.save('s1', 'Session', [{ role: 'user', content: 'hello', timestamp: 1 }])).resolves.toBe('native');
    await expect(runtime.load('s1')).resolves.toMatchObject({ status: 'native', value: { meta: { id: 's1' } } });
    await expect(runtime.delete('s1')).resolves.toEqual({ status: 'native', value: true });
    await expect(runtime.list()).resolves.toMatchObject({ status: 'native', value: [{ id: 's1' }] });
    await expect(runtime.sizeBytes()).resolves.toEqual({ status: 'native', value: 123 });

    expect(bridge.calls.map((call) => call.method)).toEqual([
      'session_store.open',
      'session_store.save',
      'session_store.load',
      'session_store.delete',
      'session_store.list',
      'session_store.size_bytes',
    ]);
    expect(bridge.calls[0].params).toEqual({ path: '/sessions.db', cache_size: 20 });
  });

  it('fails fast in required mode when native session store calls fail', async () => {
    const bridge = createBridge({ enabled: true, required: true, fail: true });
    const runtime = new NativeSessionStoreRuntime({ bridge, path: '/sessions.db' });

    await expect(runtime.load('s1')).rejects.toThrow('native session store unavailable');
  });
});

