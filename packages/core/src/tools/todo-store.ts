/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';

/** Todo data model shared across the todo tool and the UI. */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export type TodoStatus = TodoItem['status'];
export type TodoPriority = TodoItem['priority'];

const UPDATE_EVENT = 'update';

/** Staleness reminder configuration */
export const TODO_STALENESS_CONFIG = {
  /** Minimum tool calls since last todo_write before considering stale */
  MIN_TOOL_CALLS: 5,
  /** Minimum elapsed minutes since last todo_write before considering stale */
  MIN_ELAPSED_MINUTES: 3,
} as const;

/**
 * Reactive, in-memory store for the current todo list.
 *
 * The list is replaced wholesale on every `todo_write` call. Subscribers
 * (e.g. the pinned TodoPanel in the CLI) get notified via the `update` event
 * so they can re-render in place instead of relying on repeated scrollback
 * entries.
 */

class TodoStore extends EventEmitter {
  private todos: TodoItem[] = [];
  private lastUpdatedAt: number = 0;
  private toolCallsSinceLastUpdate: number = 0;

  /** Returns a defensive copy of the current todos. */
  getTodos(): TodoItem[] {
    return this.todos.map((t) => ({ ...t }));
  }

  /** Replaces the entire list and notifies subscribers. */
  setTodos(todos: TodoItem[]): void {
    this.todos = todos.map((t) => ({ ...t }));
    this.lastUpdatedAt = Date.now();
    this.toolCallsSinceLastUpdate = 0;
    this.emit(UPDATE_EVENT, this.getTodos());
  }

  /** Clears the list (e.g. on a new session) and notifies subscribers. */
  clear(): void {
    this.todos = [];
    this.lastUpdatedAt = 0;
    this.toolCallsSinceLastUpdate = 0;
    this.emit(UPDATE_EVENT, this.getTodos());
  }

  /** Returns the timestamp of the last setTodos() call, or 0 if never set. */
  getLastUpdatedAt(): number {
    return this.lastUpdatedAt;
  }

  /** Returns the number of non-todo_write tool calls since the last todo_write. */
  getToolCallsSinceLastUpdate(): number {
    return this.toolCallsSinceLastUpdate;
  }

  /** Increments the counter of non-todo_write tool calls since the last todo_write. */
  incrementToolCallsSinceLastUpdate(): void {
    this.toolCallsSinceLastUpdate++;
  }

  /** Resets the staleness counter (called after a reminder is injected). */
  resetStalenessCounter(): void {
    this.toolCallsSinceLastUpdate = 0;
  }

  /**
   * Whether the todo list has active (non-completed) items.
   * Used to decide if staleness reminders are relevant.
   */
  hasActiveTodos(): boolean {
    return this.todos.length > 0 && this.todos.some((t) => t.status !== 'completed');
  }

  /** Subscribe to list changes. Receives a copy of the new list. */
  onUpdate(callback: (todos: TodoItem[]) => void): void {
    this.on(UPDATE_EVENT, callback);
  }

  /** Unsubscribe a previously registered listener. */
  offUpdate(callback: (todos: TodoItem[]) => void): void {
    this.off(UPDATE_EVENT, callback);
  }
}

export const todoStore = new TodoStore();

/**
 * Check whether the todo list is stale and a reminder should be injected.
 *
 * Staleness is determined by either:
 * - More than MIN_TOOL_CALLS non-todo_write tool calls since last todo_write
 * - More than MIN_ELAPSED_MINUTES since last todo_write
 *
 * Only triggers when there are active (non-completed) todos.
 * After returning a reminder string, the staleness counter is reset to
 * avoid nagging on every subsequent tool call.
 *
 * @returns A <system-reminder> string to append, or null if not stale.
 */
export function checkTodoStaleness(): string | null {
  // No active todos — nothing to remind about
  if (!todoStore.hasActiveTodos()) {
    return null;
  }

  const toolCalls = todoStore.getToolCallsSinceLastUpdate();
  const lastUpdated = todoStore.getLastUpdatedAt();

  const isStaleByToolCalls = toolCalls >= TODO_STALENESS_CONFIG.MIN_TOOL_CALLS;

  let isStaleByTime = false;
  if (lastUpdated > 0) {
    const elapsedMinutes = (Date.now() - lastUpdated) / (60 * 1000);
    isStaleByTime = elapsedMinutes >= TODO_STALENESS_CONFIG.MIN_ELAPSED_MINUTES;
  }

  if (!isStaleByToolCalls && !isStaleByTime) {
    return null;
  }

  // Reset counter so the next reminder only fires after another threshold
  todoStore.resetStalenessCounter();

  return '<system-reminder>You haven\'t updated the task list recently. Please call todo_write to reflect your current progress before continuing.</system-reminder>';
}
