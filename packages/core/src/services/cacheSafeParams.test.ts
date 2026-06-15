/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { CacheSafeParamsStore } from './cacheSafeParams.js';

const stubSnapshot = (label: string) => ({
  model: 'gemini-2.0-flash-001',
  contents: [{ role: 'user', parts: [{ text: label }] }],
  systemInstruction: 'system: be helpful',
  timestamp: 1700000000000,
});

describe('CacheSafeParamsStore', () => {
  it('starts empty: get() === null, has() === false', () => {
    const store = new CacheSafeParamsStore();
    expect(store.get()).toBeNull();
    expect(store.has()).toBe(false);
  });

  it('stores and returns the latest snapshot', () => {
    const store = new CacheSafeParamsStore();
    const snap = stubSnapshot('first');
    store.set(snap);
    expect(store.get()).toBe(snap);
    expect(store.has()).toBe(true);
  });

  it('set() replaces (does not merge) — latest write wins', () => {
    const store = new CacheSafeParamsStore();
    store.set(stubSnapshot('first'));
    const second = stubSnapshot('second');
    store.set(second);
    expect(store.get()).toBe(second);
  });

  it('clear() resets the store to empty', () => {
    const store = new CacheSafeParamsStore();
    store.set(stubSnapshot('first'));
    store.clear();
    expect(store.get()).toBeNull();
    expect(store.has()).toBe(false);
  });

  it('two independent stores do not share state', () => {
    const a = new CacheSafeParamsStore();
    const b = new CacheSafeParamsStore();
    a.set(stubSnapshot('A'));
    expect(b.get()).toBeNull();
    expect(a.get()?.contents[0].parts?.[0]).toMatchObject({ text: 'A' });
  });
});
