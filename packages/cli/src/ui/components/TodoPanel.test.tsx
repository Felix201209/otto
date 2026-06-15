/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { TodoItem } from 'otto-core';
import { selectTodoPanelView, TodoPanel } from './TodoPanel.js';

const todo = (id: string, status: TodoItem['status'], content = id): TodoItem => ({
  id,
  content,
  status,
  priority: 'medium',
});

describe('selectTodoPanelView', () => {
  it('reports empty when there are no todos', () => {
    const view = selectTodoPanelView([]);
    expect(view.isEmpty).toBe(true);
    expect(view.allDone).toBe(false);
  });

  it('reports allDone when every todo is completed', () => {
    const view = selectTodoPanelView([
      todo('a', 'completed'),
      todo('b', 'completed'),
    ]);
    expect(view.allDone).toBe(true);
    expect(view.isEmpty).toBe(false);
  });

  it('separates in-progress and pending items', () => {
    const view = selectTodoPanelView([
      todo('a', 'completed'),
      todo('b', 'in_progress'),
      todo('c', 'pending'),
      todo('d', 'pending'),
    ]);
    expect(view.inProgress.map((t) => t.id)).toEqual(['b']);
    expect(view.pending.map((t) => t.id)).toEqual(['c', 'd']);
  });

  it('returns all completed items without hiding them', () => {
    const view = selectTodoPanelView([
      todo('done1', 'completed'),
      todo('done2', 'completed'),
      todo('done3', 'completed'),
      todo('cur', 'in_progress'),
    ]);
    expect(view.completed.map((t) => t.id)).toEqual(['done1', 'done2', 'done3']);
  });

  it('caps the number of visible pending items', () => {
    const pending = Array.from({ length: 12 }, (_, i) =>
      todo(`p${i}`, 'pending'),
    );
    const view = selectTodoPanelView(
      [todo('cur', 'in_progress'), ...pending],
      { maxPending: 5 },
    );
    expect(view.pending).toHaveLength(5);
    expect(view.hiddenPendingCount).toBe(7);
  });
});

describe('TodoPanel rendering', () => {
  it('renders nothing when there are no todos', () => {
    const { lastFrame } = render(<TodoPanel todos={[]} />);
    expect(lastFrame()).toBe('');
  });

  it('renders nothing when all todos are completed', () => {
    const { lastFrame } = render(
      <TodoPanel todos={[todo('a', 'completed'), todo('b', 'completed')]} />,
    );
    expect(lastFrame()).toBe('');
  });

  it('renders in-progress and pending content when active', () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[
          todo('done', 'completed', 'Finished setup'),
          todo('cur', 'in_progress', 'Build the gallery'),
          todo('next', 'pending', 'Wire the home page'),
        ]}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Build the gallery');
    expect(frame).toContain('Wire the home page');
    // Progress count is shown.
    expect(frame).toContain('(1/3)');
  });

  it('renders only header in collapsed mode when isActive is false', () => {
    const { lastFrame } = render(
      <TodoPanel
        todos={[
          todo('done', 'completed', 'Finished setup'),
          todo('cur', 'in_progress', 'Build the gallery'),
          todo('next', 'pending', 'Wire the home page'),
        ]}
        isActive={false}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Build the gallery');
    expect(frame).not.toContain('Wire the home page');
    expect(frame).toContain('Tasks (1/3)'); // 进度 Header 依然展示
  });
});

