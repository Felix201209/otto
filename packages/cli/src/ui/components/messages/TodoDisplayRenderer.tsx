/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../colors.js';
import { isChineseLocale } from '../../utils/i18n.js';
import type { TodoDisplay } from 'otto-core';

/**
 * Render a TodoDisplay structure with Ink, matching the screenshot style:
 * - Leading green dot before the title
 * - Tree-like connectors (├─ / └─)
 * - Checkbox-like icons
 * - Blue highlight for in-progress, green for completed, gray/foreground for pending
 */
export const TodoDisplayRenderer: React.FC<{ data: TodoDisplay } & { titleEmphasis?: 'normal' | 'strong' }> = ({ data, titleEmphasis = 'strong' }) => {
  const items = data.items || [];

  const getColorForStatus = (status: 'pending' | 'in_progress' | 'completed') => {
    if (status === 'completed') return Colors.AccentGreen;
    if (status === 'in_progress') return Colors.AccentBlue; // 蓝色高亮
    return Colors.Foreground;
  };

  const getCheckboxForStatus = (status: 'pending' | 'in_progress' | 'completed') => {
    return status === 'completed' ? '☒' : '□'; // 完成项使用方框+X
  };

  return (
    <Box flexDirection="column">
      {/* Title with green dot */}
      <Box>
        <Text color={Colors.AccentGreen}>• </Text>
        <Text bold={titleEmphasis === 'strong'}>{data.title || 'Update Todos'}</Text>
      </Box>

      {/* Items */}
      <Box flexDirection="column" marginTop={0}>
        {items.map((t, idx) => {
          const isLast = idx === items.length - 1;
          const connector = isLast ? '└' : '├';
          const color = getColorForStatus(t.status);
          const checkbox = getCheckboxForStatus(t.status);
          return (
            <Box key={t.id}>
              <Text>  {connector} </Text>
              <Text color={color} strikethrough={t.status === 'completed'}>
                {checkbox} {t.content}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

/**
 * One-line collapsed summary of a todo update for the scrollback.
 *
 * The live, full list now lives in the pinned TodoPanel above the input, so
 * each `todo_write` call only leaves a compact breadcrumb here (progress +
 * current task) instead of repeating the whole list on every update.
 */
export const TodoSummaryLine: React.FC<{ data: TodoDisplay }> = ({ data }) => {
  const items = data.items || [];
  const total = items.length;
  const completed = items.filter((t) => t.status === 'completed').length;
  const current = items.find((t) => t.status === 'in_progress');
  const zh = isChineseLocale();

  const label = zh ? '任务' : 'Tasks';
  let detail: string;
  if (total === 0) {
    detail = zh ? '已清空' : 'cleared';
  } else if (completed === total) {
    detail = zh ? '全部完成' : 'all done';
  } else if (current) {
    detail = current.content;
  } else {
    detail = zh ? '已更新' : 'updated';
  }

  return (
    <Box>
      <Text color={Colors.AccentGreen}>• </Text>
      <Text>
        {label}{' '}
      </Text>
      <Text color={Colors.Gray}>
        ({completed}/{total}){total > 0 ? ' · ' : ''}
      </Text>
      {total > 0 ? (
        <Text wrap="truncate-end">{detail}</Text>
      ) : (
        <Text color={Colors.Gray}>{detail}</Text>
      )}
    </Box>
  );
};

