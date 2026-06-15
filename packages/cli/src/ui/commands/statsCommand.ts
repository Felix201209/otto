/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType, HistoryItemStats, HistoryItemTokenBreakdown } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import { tokenLimit } from 'otto-core';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { uiTelemetryService } from 'otto-core';
import { t, tp } from '../utils/i18n.js';

export const statsCommand: SlashCommand = {
  name: 'stats',
  altNames: ['usage'],
  description: t('command.stats.description'),
  kind: CommandKind.BUILT_IN,
  action: (context: CommandContext, args?: string) => {
    // 🛡️ 合并：/stats 现在会显示所有统计信息（session + model + tools + token breakdown）
    const now = new Date();
    const { sessionStartTime } = context.session.stats;
    if (!sessionStartTime) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('command.stats.error.noSessionStartTime'),
        },
        Date.now(),
      );
      return;
    }
    const wallDuration = now.getTime() - sessionStartTime.getTime();

    // 1. 显示会话统计
    const statsItem: HistoryItemStats = {
      type: MessageType.STATS,
      duration: formatDuration(wallDuration),
    };
    context.ui.addItem(statsItem, Date.now());

    // 2. 显示上下文占用细分统计
    // 获取当前会话的 token 统计信息
    const metrics = uiTelemetryService.getMetrics();
    // 🛡️ 简化：使用一个默认的模型作为估算基准
    const currentModel = 'claude-opus-4-1';
    const maxTokens = tokenLimit(currentModel, context.services.config || undefined);

    // 🛡️ 注：这里使用估算值，因为 API 不会分离返回各部分的 token
    // 实际的细分数据需要从 session 的消息历史中计算
    const totalInputTokens = context.session.stats.lastPromptTokenCount || 0;

    // 简单的估算：
    // - System Prompt 大约占 5-15% 的 input token
    // - Tools 大约占 5-10% 的 input token
    // - Memory/Context 和 User Message 分享剩余部分
    const estimatedSystemPromptTokens = Math.round(totalInputTokens * 0.10);
    const estimatedToolsTokens = Math.round(totalInputTokens * 0.08);
    const estimatedMemoryContextTokens = Math.round(totalInputTokens * 0.40);
    const estimatedUserMessageTokens = totalInputTokens - estimatedSystemPromptTokens - estimatedToolsTokens - estimatedMemoryContextTokens;

    const tokenBreakdownItem: HistoryItemTokenBreakdown = {
      type: MessageType.TOKEN_BREAKDOWN,
      systemPromptTokens: estimatedSystemPromptTokens,
      userMessageTokens: Math.max(0, estimatedUserMessageTokens),
      memoryContextTokens: estimatedMemoryContextTokens,
      toolsTokens: estimatedToolsTokens,
      totalInputTokens: totalInputTokens,
      maxTokens: maxTokens,
    };
    context.ui.addItem(tokenBreakdownItem, Date.now());

    // 3. 显示模型统计
    context.ui.addItem(
      {
        type: MessageType.MODEL_STATS,
      },
      Date.now(),
    );

    // 4. 显示工具统计
    context.ui.addItem(
      {
        type: MessageType.TOOL_STATS,
      },
      Date.now(),
    );
  },
  subCommands: [
    {
      name: 'model',
      description: t('command.stats.model.description'),
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext, args?: string) => {
        const modelName = args?.trim();

        if (modelName) {
          // 显示特定模型的统计
          const metrics = uiTelemetryService.getMetrics();
          if (metrics.models[modelName]) {
            context.ui.addItem(
              {
                type: MessageType.MODEL_STATS,
              },
              Date.now(),
            );
          } else {
            context.ui.addItem(
              {
                type: MessageType.ERROR,
                text: tp('command.stats.error.modelNotFound', { modelName }),
              },
              Date.now(),
            );
          }
        } else {
          // 显示所有模型的统计
          context.ui.addItem(
            {
              type: MessageType.MODEL_STATS,
            },
            Date.now(),
          );
        }
      },
      completion: async (context: CommandContext, partialArg: string) => {
        // 获取当前会话中已使用的模型列表
        const metrics = uiTelemetryService.getMetrics();
        const availableModels = Object.keys(metrics.models);

        // 根据用户输入过滤模型列表
        return availableModels.filter(model =>
          model.toLowerCase().includes(partialArg.toLowerCase())
        );
      },
    },
    {
      name: 'tools',
      description: t('command.stats.tools.description'),
      kind: CommandKind.BUILT_IN,
      action: (context: CommandContext) => {
        context.ui.addItem(
          {
            type: MessageType.TOOL_STATS,
          },
          Date.now(),
        );
      },
    },
  ],
};
