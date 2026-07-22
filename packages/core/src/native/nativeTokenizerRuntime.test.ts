/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { NativeTokenizerRuntime, type NativeTokenizerRuntimeBridge } from './nativeTokenizerRuntime.js';

function createBridge(params: {
  enabled: boolean;
  required?: boolean;
  fail?: boolean;
}): NativeTokenizerRuntimeBridge & { calls: Array<{ method: string; params?: Record<string, unknown> }> } {
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
      if (params.fail) throw new Error('native tokenizer unavailable');
      if (method === 'tokenizer.count') return { tokens: 42 };
      if (method === 'tokenizer.truncate') return { text: 'short' };
      if (method === 'tokenizer.supported_models') return { models: ['gpt-4', 'cl100k_base'] };
      return { status: 'ok' };
    },
  };
}

describe('NativeTokenizerRuntime', () => {
  it('uses fallback when native tokenizer is unavailable in auto mode', async () => {
    const bridge = createBridge({ enabled: false });
    const runtime = new NativeTokenizerRuntime({ bridge });

    await expect(runtime.count('hello')).resolves.toEqual({ status: 'fallback' });
    await expect(runtime.truncate('hello world', 1)).resolves.toEqual({ status: 'fallback' });
    expect(bridge.calls).toEqual([]);
  });

  it('counts and truncates through Rust when native core is available', async () => {
    const bridge = createBridge({ enabled: true });
    const runtime = new NativeTokenizerRuntime({ bridge, model: 'gpt-4' });

    await expect(runtime.count('hello')).resolves.toEqual({ status: 'native', tokens: 42 });
    await expect(runtime.truncate('hello world', 3)).resolves.toEqual({ status: 'native', text: 'short' });
    await expect(runtime.supportedModels()).resolves.toEqual(['gpt-4', 'cl100k_base']);

    expect(bridge.calls.map((call) => call.method)).toEqual([
      'tokenizer.create',
      'tokenizer.count',
      'tokenizer.truncate',
      'tokenizer.supported_models',
    ]);
    expect(bridge.calls[0].params).toEqual({ model: 'gpt-4' });
  });

  it('fails fast in required mode when native tokenizer calls fail', async () => {
    const bridge = createBridge({ enabled: true, required: true, fail: true });
    const runtime = new NativeTokenizerRuntime({ bridge });

    await expect(runtime.count('hello')).rejects.toThrow('native tokenizer unavailable');
  });
});

