/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import { todoStore, type TodoItem } from 'otto-core';
import { useTodos } from './useTodos.js';

const item = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: 'task_1',
  content: 'Do the thing',
  status: 'pending',
  priority: 'high',
  ...overrides,
});

describe('useTodos', () => {
  afterEach(() => {
    act(() => {
      todoStore.clear();
    });
  });

  it('returns the current todos on mount', () => {
    act(() => {
      todoStore.setTodos([item({ id: 'a' })]);
    });
    const { result } = renderHook(() => useTodos());
    expect(result.current.map((t) => t.id)).toEqual(['a']);
  });

  it('updates when the store changes', () => {
    const { result } = renderHook(() => useTodos());
    expect(result.current).toEqual([]);

    act(() => {
      todoStore.setTodos([item({ id: 'a' }), item({ id: 'b' })]);
    });
    expect(result.current.map((t) => t.id)).toEqual(['a', 'b']);

    act(() => {
      todoStore.setTodos([item({ id: 'c' })]);
    });
    expect(result.current.map((t) => t.id)).toEqual(['c']);
  });

  it('clears when the store is cleared', () => {
    const { result } = renderHook(() => useTodos());
    act(() => {
      todoStore.setTodos([item()]);
    });
    expect(result.current).toHaveLength(1);

    act(() => {
      todoStore.clear();
    });
    expect(result.current).toEqual([]);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useTodos());
    unmount();
    // Should not throw and should leave no dangling listeners for this hook.
    act(() => {
      todoStore.setTodos([item()]);
    });
    expect(todoStore.listenerCount('update')).toBe(0);
  });
});
