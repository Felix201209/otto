/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { MessageType, type HistoryItemContextBreakdown } from '../types.js';
import { tokenLimit, uiTelemetryService, getCoreSystemPrompt } from 'otto-core';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { t } from '../utils/i18n.js';
import { getEncoding } from 'js-tiktoken';

interface ToolRegistryLike {
  getTools?: () => unknown[];
  getAllTools?: () => unknown[];
}

interface ConfigWithToolRegistry {
  toolRegistry?: ToolRegistryLike;
}

function toSerializableTool(tool: unknown): Record<string, unknown> {
  if (!tool || typeof tool !== 'object') {
    return {};
  }

  const record = tool as Record<string, unknown>;
  return {
    name: record.name,
    description: record.description,
    parameters: record.parameters,
  };
}

export const contextCommand: SlashCommand = {
  name: 'context',
  altNames: [],
  description: t('command.context.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    // 获取用户偏好的模型
    const preferredModel = context.services.settings.merged.preferredModel;

    if (!preferredModel) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: 'No preferred model selected. Please use /model to select a model first.',
        },
        Date.now(),
      );
      return;
    }

    // 获取模型详细信息（包括displayName等）
    const cloudModelInfo = context.services.config?.getCloudModelInfo(preferredModel);
    const modelDisplayName = cloudModelInfo?.displayName || preferredModel;
    const maxTokens = tokenLimit(preferredModel, context.services.config || undefined);

    // 先显示模型信息
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `📊 Current Model: ${modelDisplayName}\n💾 Token Limit: ${(maxTokens / 1000).toFixed(0)}k tokens`,
      },
      Date.now(),
    );

    // 获取当前会话的实际统计数据
    const metrics = uiTelemetryService.getMetrics();
    const modelMetrics = metrics.models[preferredModel];

    // 从telemetry获取实际的token使用
    // 注意：modelMetrics.tokens.prompt 是累加值，不能用于计算当前上下文占用
    // 我们应该使用 lastPromptTokenCount，它代表最后一次请求的 input token，即当前上下文大小
    const actualPromptTokens = uiTelemetryService.getLastPromptTokenCount();
    // 1. 获取 Memory Token (从 Config)
    const memoryFilesTokens = context.services.config?.getMemoryTokenCount() ?? 0;

    // 2. 计算 System Prompt Token (实时计算)
    let systemPromptTokens = 0;
    try {
      const enc = getEncoding('cl100k_base');
      // 获取完整的 system prompt (包含 memory)
      const agentStyle = context.services.config?.getAgentStyle() ?? 'default';
      const fullSystemPrompt = getCoreSystemPrompt(
    context.services.config?.getUserMemory(),
    false,
    undefined,
    agentStyle,
    undefined,
    context.services.config?.getPreferredLanguage()
  );
      const totalSystemTokens = enc.encode(fullSystemPrompt).length;

      // 扣除 memory
      if (memoryFilesTokens > 0 && totalSystemTokens > memoryFilesTokens) {
        systemPromptTokens = totalSystemTokens - memoryFilesTokens;
      } else {
        systemPromptTokens = totalSystemTokens;
      }
    } catch {
      // Fallback: 使用 Claude 默认值
      systemPromptTokens = 6069;
    }

    // 3. Tools Token
    // 优先用 core 传过来的 definition，如果没有则手动计算
    let systemToolsTokens = modelMetrics?.tokens.tool || 0;

    if (systemToolsTokens === 0) {
      try {
        // 直接访问私有属性 toolRegistry，绕过 async 方法调用可能的问题
        const config = context.services.config as ConfigWithToolRegistry | null;
        const toolRegistry = config?.toolRegistry;

        if (toolRegistry) {
          let tools: unknown[] = [];
          // 尝试获取工具定义
          if (typeof toolRegistry.getTools === 'function') {
            tools = toolRegistry.getTools();
          } else if (typeof toolRegistry.getAllTools === 'function') {
            // 如果只有 getAllTools，我们需要转换
            const toolInstances = toolRegistry.getAllTools();
            tools = toolInstances.map((tool) => {
              if (tool && typeof tool === 'object' && typeof (tool as { getDefinition?: unknown }).getDefinition === 'function') {
                return (tool as { getDefinition: () => unknown }).getDefinition();
              }
              // 如果没有 getDefinition，尝试提取基本属性，避免循环引用
              return toSerializableTool(tool);
            });
          }

          if (tools && tools.length > 0) {
            const enc = getEncoding('cl100k_base');
            // 使用 safe stringify 或者 try-catch
            try {
              systemToolsTokens = enc.encode(JSON.stringify(tools)).length;
            } catch {
              // 如果还是失败，尝试只序列化必要字段
              const safeTools = tools.map(toSerializableTool);
              systemToolsTokens = enc.encode(JSON.stringify(safeTools)).length;
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // 4. Messages Token
    let messagesTokens = 0;
    if (actualPromptTokens > 0) {
      // Messages = 总 Prompt - System - Memory - Tools
      messagesTokens = Math.max(0, actualPromptTokens - systemPromptTokens - memoryFilesTokens - systemToolsTokens);
    }

    // 不再预留，所有剩余都是 free space
    const reservedTokens = 0;
    // 如果没有请求过(actualPromptTokens=0)，totalInputTokens 就是静态部分之和
    const totalInputTokens = actualPromptTokens > 0 ? actualPromptTokens : (systemPromptTokens + memoryFilesTokens + systemToolsTokens);
    const freeSpaceTokens = Math.max(0, maxTokens - totalInputTokens);

    const contextItem: Omit<HistoryItemContextBreakdown, 'id'> = {
      type: MessageType.CONTEXT_BREAKDOWN,
      systemPromptTokens,
      systemToolsTokens,
      memoryFilesTokens,
      messagesTokens,
      reservedTokens,
      totalInputTokens,
      freeSpaceTokens,
      maxTokens,
    };

    context.ui.addItem(contextItem, Date.now());
  },
};
