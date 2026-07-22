/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  getNativeCoreBinaryCandidates,
  resolveNativeCoreMode,
  resolveNativeCoreRuntime,
} from './nativeCoreBridge.js';
import {
  REQUIRED_NATIVE_HOT_PATH_METHODS,
  validateNativeHotPathCoverage,
} from './nativeHotPaths.js';

describe('nativeCoreBridge', () => {
  it('defaults the Rust hot-path runtime to auto mode', () => {
    expect(resolveNativeCoreMode({})).toBe('auto');
    expect(resolveNativeCoreMode({ OTTO_NATIVE_CORE: 'required' })).toBe('required');
    expect(resolveNativeCoreMode({ OTTO_NATIVE_CORE: 'off' })).toBe('off');
    expect(resolveNativeCoreMode({ OTTO_NATIVE_CORE: 'surprise' })).toBe('auto');
  });

  it('prefers explicit native core binary paths', () => {
    const candidates = getNativeCoreBinaryCandidates({
      cwd: '/repo',
      platform: 'linux',
      env: { OTTO_NATIVE_CORE_BINARY: '/secure/otto-native' },
    });

    expect(candidates[0]).toBe('/secure/otto-native');
    expect(candidates).toContain(path.join('/repo', 'otto-native', 'bin', 'otto-native'));
    expect(candidates).toContain(path.join('/repo', 'otto-native', 'target', 'release', 'otto-native'));
  });

  it('keeps the native takeover scoped to the three approved hot paths', () => {
    expect(validateNativeHotPathCoverage(REQUIRED_NATIVE_HOT_PATH_METHODS)).toEqual([]);
    expect(REQUIRED_NATIVE_HOT_PATH_METHODS).toContain('agent_pool.register');
    expect(REQUIRED_NATIVE_HOT_PATH_METHODS).toContain('session_store.save');
    expect(REQUIRED_NATIVE_HOT_PATH_METHODS).toContain('tokenizer.count');
  });

  it('fails fast when native core is required but unavailable', () => {
    expect(() =>
      resolveNativeCoreRuntime({
        mode: 'required',
        cwd: '/definitely/not/the/repo',
        env: {},
      }),
    ).toThrow('OTTO_NATIVE_CORE=required');
  });

  it('allows JS fallback when native core is unavailable in auto mode', () => {
    expect(
      resolveNativeCoreRuntime({
        mode: 'auto',
        cwd: '/definitely/not/the/repo',
        env: {},
      }),
    ).toMatchObject({
      mode: 'auto',
      enabled: false,
      required: false,
    });
  });
});
