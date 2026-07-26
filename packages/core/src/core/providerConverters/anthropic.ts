/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../../config/messageRoles.js';
import {
  applyAnthropicAdaptiveThinking,
  effortToAnthropicBudget,
  effortToAnthropicEffort,
  isAdaptiveThinkingClaude,
  resolveThinkingConfig,
  type CustomModelConfig,
} from '../../types/customModel.js';
import { AnthropicConverter } from '../customModelAnthropicConverter.js';
import { addFunctionCallsGetter } from './shared.js';

function shouldEnableThinkingByDefault(): boolean {
  return true;
}

export function buildAnthropicMessagesRequestBody(input: {
  modelConfig: CustomModelConfig;
  request: any;
  systemText: string;
  maxOutputTokens: number;
  resolveOutputTokens(
    modelConfig: CustomModelConfig,
    thinkingMinimum?: number,
  ): number;
  stream: boolean;
}): any {
  const { messages, system } = AnthropicConverter.contentsToAnthropic(
    input.request.contents,
  );
  const systemBlocks = system ? [...system] : [];
  if (
    input.systemText &&
    !systemBlocks.some((block) => block.text === input.systemText)
  ) {
    systemBlocks.unshift({
      type: 'text',
      text: input.systemText,
      cache_control: { type: 'ephemeral' },
    });
  }

  const requestBody: any = {
    model: input.modelConfig.modelId,
    messages,
    tools: AnthropicConverter.toolsToAnthropicTools(
      input.request.config?.tools,
    ),
    max_tokens: input.maxOutputTokens,
  };
  if (input.stream) requestBody.stream = true;
  if (systemBlocks.length > 0) {
    requestBody.system = systemBlocks;
  }

  const thinkingConfig = resolveThinkingConfig(input.modelConfig);
  const isHaiku = input.modelConfig.modelId.toLowerCase().includes('haiku');
  const isThinkingEnabled =
    !isHaiku &&
    (thinkingConfig.mode === 'on' ||
      (thinkingConfig.mode === 'auto' && shouldEnableThinkingByDefault()));

  if (isThinkingEnabled) {
    const isAdaptiveModel =
      isAdaptiveThinkingClaude(input.modelConfig.modelId) ||
      (thinkingConfig.effort !== undefined && thinkingConfig.effort !== 'auto');

    if (isAdaptiveModel && thinkingConfig.budgetTokens === undefined) {
      const effort = effortToAnthropicEffort(thinkingConfig.effort) || 'high';
      applyAnthropicAdaptiveThinking(requestBody, effort);
    } else {
      const budgetTokens =
        thinkingConfig.budgetTokens !== undefined
          ? thinkingConfig.budgetTokens
          : effortToAnthropicBudget(thinkingConfig.effort);
      const adjustedMax = input.resolveOutputTokens(
        input.modelConfig,
        budgetTokens,
      );
      requestBody.max_tokens = adjustedMax;
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: Math.min(adjustedMax - 1, budgetTokens),
      };
    }
  }

  return requestBody;
}

export function mapAnthropicMessageResponse(
  data: any,
): GenerateContentResponse {
  const parts = data.content
    .map((c: any) => {
      if (c.type === 'text') return { text: c.text };
      if (c.type === 'tool_use') {
        return {
          functionCall: {
            name: c.name?.trim() || c.name,
            args: c.input,
            id: c.id,
          },
        };
      }
      if (c.type === 'thinking') return { reasoning: c.thinking };
      return null;
    })
    .filter(Boolean);

  const directInputTokens = data.usage?.input_tokens || 0;
  const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;
  const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
  const actualPromptTokens =
    directInputTokens + cacheCreationTokens + cacheReadTokens;
  const outputTokens = data.usage?.output_tokens || 0;

  const result = {
    candidates: [
      {
        content: {
          role: MESSAGE_ROLES.MODEL,
          parts: parts.length ? parts : [{ text: '' }],
        },
        finishReason: AnthropicConverter.mapFinishReason(data.stop_reason),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: actualPromptTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: actualPromptTokens + outputTokens,
      ...(cacheCreationTokens && {
        cacheCreationInputTokens: cacheCreationTokens,
        cacheWriteInputTokens: cacheCreationTokens,
      }),
      ...(cacheReadTokens != null && { cacheReadInputTokens: cacheReadTokens }),
      uncachedInputTokens: directInputTokens,
    } as any,
  };
  addFunctionCallsGetter(result);
  return result as GenerateContentResponse;
}
