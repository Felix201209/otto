/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { todoStore, type TodoItem } from 'otto-core';

/**
 * Subscribe to the shared todo store and re-render on changes.
 *
 * Powers the pinned TodoPanel so the todo list updates in place rather than
 * being re-emitted into the scrollback on every `todo_write` call.
 */
export const useTodos = (): TodoItem[] => {
  const [todos, setTodos] = useState<TodoItem[]>(() => todoStore.getTodos());

  useEffect(() => {
    const handleUpdate = (next: TodoItem[]) => {
      setTodos(next);
    };

    // Sync immediately in case the store changed between render and effect.
    setTodos(todoStore.getTodos());

    todoStore.onUpdate(handleUpdate);
    return () => {
      todoStore.offUpdate(handleUpdate);
    };
  }, []);

  return todos;
};
