/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { TodoWriteTool, type TodoWriteParams } from './todo-write.js';
import { todoStore } from './todo-store.js';

describe('TodoWriteTool', () => {
  it('describes the number of todo items', () => {
    const tool = new TodoWriteTool({} as Config);

    expect(
      tool.getDescription({
        todos: [
          {
            id: 'task_1',
            content: 'Write regression test',
            status: 'pending',
            priority: 'high',
          },
          {
            id: 'task_2',
            content: 'Run the test',
            status: 'in_progress',
            priority: 'medium',
          },
        ],
      }),
    ).toBe('Update todo list with 2 items');
  });

  it('describes malformed params as an empty todo list instead of throwing', () => {
    const tool = new TodoWriteTool({} as Config);

    expect(tool.getDescription(undefined as unknown as TodoWriteParams)).toBe(
      'Update todo list with 0 item',
    );
    expect(tool.getDescription({} as TodoWriteParams)).toBe(
      'Update todo list with 0 item',
    );
    expect(
      tool.getDescription({ todos: undefined } as unknown as TodoWriteParams),
    ).toBe('Update todo list with 0 item');
  });

  it('publishes the todo list to the shared store on execute', async () => {
    const tool = new TodoWriteTool({} as Config);
    todoStore.clear();

    await tool.execute(
      {
        todos: [
          {
            id: 'task_1',
            content: 'Write regression test',
            status: 'in_progress',
            priority: 'high',
          },
        ],
      },
      new AbortController().signal,
    );

    expect(todoStore.getTodos()).toEqual([
      {
        id: 'task_1',
        content: 'Write regression test',
        status: 'in_progress',
        priority: 'high',
      },
    ]);

    todoStore.clear();
  });
});
