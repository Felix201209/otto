/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TodoItem } from 'otto-core';
import { Colors } from '../colors.js';
import { isChineseLocale } from '../utils/i18n.js';

/** Maximum pending items shown before collapsing into a "+N more" line. */
const DEFAULT_MAX_PENDING = 6;

export interface TodoPanelView {
  isEmpty: boolean;
  allDone: boolean;
  completed: TodoItem[];
  inProgress: TodoItem[];
  pending: TodoItem[];
  /** Pending items not shown due to the cap. */
  hiddenPendingCount: number;
  total: number;
  completedCount: number;
}

/**
 * Pure view-model selector for the pinned todo panel. Kept separate from the
 * Ink rendering so the collapse/grouping logic is unit-testable.
 */
export function selectTodoPanelView(
  todos: TodoItem[],
  opts: { maxPending?: number } = {},
): TodoPanelView {
  const maxPending = opts.maxPending ?? DEFAULT_MAX_PENDING;
  const completed = todos.filter((t) => t.status === 'completed');
  const inProgress = todos.filter((t) => t.status === 'in_progress');
  const pendingAll = todos.filter((t) => t.status === 'pending');

  const pending = pendingAll.slice(0, maxPending);
  const hiddenPendingCount = pendingAll.length - pending.length;

  return {
    isEmpty: todos.length === 0,
    allDone: todos.length > 0 && completed.length === todos.length,
    completed,
    inProgress,
    pending,
    hiddenPendingCount,
    total: todos.length,
    completedCount: completed.length,
  };
}

const ItemRow: React.FC<{
  symbol: string;
  symbolColor: string;
  content: string;
  textColor?: string;
  bold?: boolean;
  strikethrough?: boolean;
}> = ({ symbol, symbolColor, content, textColor, bold, strikethrough }) => (
  <Box>
    <Text color={Colors.Gray}>{'  '}</Text>
    <Text color={symbolColor}>{symbol} </Text>
    <Text color={textColor} bold={bold} strikethrough={strikethrough} wrap="truncate-end">
      {content}
    </Text>
  </Box>
);

interface TodoPanelProps {
  todos: TodoItem[];
  maxPending?: number;
  isActive?: boolean; // 🆕 接收 AI 是否活动
}

/**
 * Pinned, in-place todo panel rendered just above the input prompt.
 *
 * Auto-hides when there are no todos or every todo is completed (per product
 * decision). Mirrors the Claude Code style: ✓ struck-through done, ■ current,
 * □ pending, with a "+N completed" roll-up.
 */
export const TodoPanel: React.FC<TodoPanelProps> = ({ todos, maxPending, isActive = true }) => {
  const view = selectTodoPanelView(todos, { maxPending });

  // Auto-hide: nothing to track, or all work is finished.
  if (view.isEmpty || view.allDone) {
    return null;
  }

  const zh = isChineseLocale();
  const header = zh ? '任务' : 'Tasks';
  const moreLabel = (n: number) => (zh ? `… 还有 ${n} 项` : `… +${n} more`);

  // 🎯 智能折叠：当 AI 响应结束（isActive === false）时，自动将复杂的 Todo 项折叠为简洁的一行
  if (!isActive) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={Colors.AccentOrange}>▶ </Text>
          <Text bold>{header}</Text>
          <Text color={Colors.Gray}>
            {' '}
            ({view.completedCount}/{view.total})
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header with progress */}
      <Box>
        <Text color={Colors.AccentOrange}>▶ </Text>
        <Text bold>{header}</Text>
        <Text color={Colors.Gray}>
          {' '}
          ({view.completedCount}/{view.total})
        </Text>
      </Box>

      {/* Completed items (rendered with checkmark and strikethrough in order) */}
      {view.completed.map((t) => (
        <ItemRow
          key={t.id}
          symbol="✓"
          symbolColor={Colors.AccentGreen}
          content={t.content}
          textColor={Colors.Gray}
          strikethrough
        />
      ))}

      {/* In-progress items (the focus) */}
      {view.inProgress.map((t) => (
        <ItemRow
          key={t.id}
          symbol="■"
          symbolColor={Colors.AccentOrange}
          content={t.content}
          bold
        />
      ))}

      {/* Pending items */}
      {view.pending.map((t) => (
        <ItemRow
          key={t.id}
          symbol="□"
          symbolColor={Colors.Foreground}
          content={t.content}
          textColor={Colors.Foreground}
        />
      ))}
      {view.hiddenPendingCount > 0 ? (
        <Box>
          <Text color={Colors.Gray}>
            {'  '}
            {moreLabel(view.hiddenPendingCount)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
};
