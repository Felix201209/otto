/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  todoStore,
  checkTodoStaleness,
  TODO_STALENESS_CONFIG,
  type TodoItem,
} from './todo-store.js';

const sample = (overrides: Partial<TodoItem> = {}): TodoItem => ({
  id: 'task_1',
  content: 'Do the thing',
  status: 'pending',
  priority: 'high',
  ...overrides,
});

describe('todoStore', () => {
  afterEach(() => {
    // Reset shared singleton state between tests.
    todoStore.clear();
    todoStore.removeAllListeners();
  });

  it('starts empty', () => {
    expect(todoStore.getTodos()).toEqual([]);
  });

  it('returns a defensive copy from getTodos', () => {
    todoStore.setTodos([sample()]);
    const a = todoStore.getTodos();
    a.push(sample({ id: 'task_2' }));
    expect(todoStore.getTodos()).toHaveLength(1);
  });

  it('replaces the whole list on setTodos', () => {
    todoStore.setTodos([sample({ id: 'a' }), sample({ id: 'b' })]);
    todoStore.setTodos([sample({ id: 'c' })]);
    expect(todoStore.getTodos().map((t) => t.id)).toEqual(['c']);
  });

  it('emits an update with the new list on setTodos', () => {
    const listener = vi.fn();
    todoStore.onUpdate(listener);
    const items = [sample({ id: 'x' })];
    todoStore.setTodos(items);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith([sample({ id: 'x' })]);
    // Listener receives a copy, not the internal array reference.
    expect(listener.mock.calls[0][0]).not.toBe(items);
  });

  it('emits an empty update on clear', () => {
    todoStore.setTodos([sample()]);
    const listener = vi.fn();
    todoStore.onUpdate(listener);
    todoStore.clear();
    expect(listener).toHaveBeenCalledWith([]);
    expect(todoStore.getTodos()).toEqual([]);
  });

  it('stops notifying after offUpdate', () => {
    const listener = vi.fn();
    todoStore.onUpdate(listener);
    todoStore.offUpdate(listener);
    todoStore.setTodos([sample()]);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('todoStore staleness tracking', () => {
  afterEach(() => {
    todoStore.clear();
    todoStore.resetStalenessCounter();
    todoStore.removeAllListeners();
    vi.useRealTimers();
  });

  it('tracks lastUpdatedAt on setTodos', () => {
    const before = Date.now();
    todoStore.setTodos([sample()]);
    const after = Date.now();
    const lastUpdated = todoStore.getLastUpdatedAt();
    expect(lastUpdated).toBeGreaterThanOrEqual(before);
    expect(lastUpdated).toBeLessThanOrEqual(after);
  });

  it('resets lastUpdatedAt to 0 on clear', () => {
    todoStore.setTodos([sample()]);
    expect(todoStore.getLastUpdatedAt()).toBeGreaterThan(0);
    todoStore.clear();
    expect(todoStore.getLastUpdatedAt()).toBe(0);
  });

  it('increments toolCallsSinceLastUpdate', () => {
    expect(todoStore.getToolCallsSinceLastUpdate()).toBe(0);
    todoStore.incrementToolCallsSinceLastUpdate();
    expect(todoStore.getToolCallsSinceLastUpdate()).toBe(1);
    todoStore.incrementToolCallsSinceLastUpdate();
    expect(todoStore.getToolCallsSinceLastUpdate()).toBe(2);
  });

  it('resets toolCallsSinceLastUpdate on setTodos', () => {
    todoStore.incrementToolCallsSinceLastUpdate();
    todoStore.incrementToolCallsSinceLastUpdate();
    expect(todoStore.getToolCallsSinceLastUpdate()).toBe(2);
    todoStore.setTodos([sample()]);
    expect(todoStore.getToolCallsSinceLastUpdate()).toBe(0);
  });

  it('resets toolCallsSinceLastUpdate on resetStalenessCounter', () => {
    todoStore.incrementToolCallsSinceLastUpdate();
    todoStore.resetStalenessCounter();
    expect(todoStore.getToolCallsSinceLastUpdate()).toBe(0);
  });

  it('hasActiveTodos returns false when empty', () => {
    expect(todoStore.hasActiveTodos()).toBe(false);
  });

  it('hasActiveTodos returns false when all completed', () => {
    todoStore.setTodos([sample({ status: 'completed' })]);
    expect(todoStore.hasActiveTodos()).toBe(false);
  });

  it('hasActiveTodos returns true when there are pending items', () => {
    todoStore.setTodos([sample({ status: 'completed' }), sample({ status: 'pending' })]);
    expect(todoStore.hasActiveTodos()).toBe(true);
  });
});

describe('checkTodoStaleness', () => {
  afterEach(() => {
    todoStore.clear();
    todoStore.resetStalenessCounter();
    todoStore.removeAllListeners();
    vi.useRealTimers();
  });

  it('returns null when no active todos', () => {
    // No todos at all
    expect(checkTodoStaleness()).toBeNull();

    // All completed
    todoStore.setTodos([sample({ status: 'completed' })]);
    for (let i = 0; i < TODO_STALENESS_CONFIG.MIN_TOOL_CALLS + 1; i++) {
      todoStore.incrementToolCallsSinceLastUpdate();
    }
    expect(checkTodoStaleness()).toBeNull();
  });

  it('returns null when not stale yet', () => {
    todoStore.setTodos([sample({ status: 'in_progress' })]);
    // Only a few tool calls, not enough to trigger
    for (let i = 0; i < TODO_STALENESS_CONFIG.MIN_TOOL_CALLS - 1; i++) {
      todoStore.incrementToolCallsSinceLastUpdate();
    }
    expect(checkTodoStaleness()).toBeNull();
  });

  it('returns reminder when stale by tool call count', () => {
    todoStore.setTodos([sample({ status: 'in_progress' })]);
    for (let i = 0; i < TODO_STALENESS_CONFIG.MIN_TOOL_CALLS; i++) {
      todoStore.incrementToolCallsSinceLastUpdate();
    }
    const result = checkTodoStaleness();
    expect(result).toContain('<system-reminder>');
    expect(result).toContain('todo_write');
  });

  it('resets staleness counter after returning a reminder', () => {
    todoStore.setTodos([sample({ status: 'in_progress' })]);
    for (let i = 0; i < TODO_STALENESS_CONFIG.MIN_TOOL_CALLS; i++) {
      todoStore.incrementToolCallsSinceLastUpdate();
    }
    const first = checkTodoStaleness();
    expect(first).not.toBeNull();

    // Counter was reset — next call should return null
    expect(checkTodoStaleness()).toBeNull();

    // But after more tool calls, it triggers again
    for (let i = 0; i < TODO_STALENESS_CONFIG.MIN_TOOL_CALLS; i++) {
      todoStore.incrementToolCallsSinceLastUpdate();
    }
    const second = checkTodoStaleness();
    expect(second).not.toBeNull();
  });

  it('returns reminder when stale by elapsed time', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    todoStore.setTodos([sample({ status: 'pending' })]);

    // Advance time past the threshold
    const elapsedMs = (TODO_STALENESS_CONFIG.MIN_ELAPSED_MINUTES + 1) * 60 * 1000;
    vi.setSystemTime(now + elapsedMs);

    // Even with 0 tool calls, should be stale by time
    expect(checkTodoStaleness()).toContain('<system-reminder>');
  });

  it('returns null when elapsed time is under threshold', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    todoStore.setTodos([sample({ status: 'pending' })]);

    // Advance time just below the threshold
    const elapsedMs = (TODO_STALENESS_CONFIG.MIN_ELAPSED_MINUTES - 0.5) * 60 * 1000;
    vi.setSystemTime(now + elapsedMs);

    expect(checkTodoStaleness()).toBeNull();
  });
});
