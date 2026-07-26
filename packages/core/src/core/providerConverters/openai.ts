/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../../config/messageRoles.js';
import {
  applyOpenAIChatThinking,
  effortToOpenAIEffort,
  resolveThinkingConfig,
  type CustomModelConfig,
} from '../../types/customModel.js';
import { OpenAIConverter } from '../customModelOpenAIConverter.js';
import { OpenAIResponsesConverter } from '../customModelOpenAIResponsesConverter.js';
import { parseJSONSafe } from '../customModelJson.js';
import { addFunctionCallsGetter } from './shared.js';

export function buildOpenAIChatRequestBody(input: {
  modelConfig: CustomModelConfig;
  request: any;
  systemText: string;
  maxOutputTokens: number;
  stream: boolean;
}): any {
  const thinkingConfig = resolveThinkingConfig(input.modelConfig);
  const messages = OpenAIConverter.contentsToMessages(input.request.contents);
  if (input.systemText) {
    messages.unshift({ role: 'system', content: input.systemText });
  }
  const requestBody: any = {
    model: input.modelConfig.modelId,
    messages,
    tools: OpenAIConverter.toolsToOpenAITools(input.request.config?.tools),
    stream: input.stream,
    max_tokens: input.maxOutputTokens,
  };
  if (input.stream) {
    requestBody.stream_options = { include_usage: true };
  }
  applyOpenAIChatThinking(
    requestBody,
    input.modelConfig.modelId,
    thinkingConfig,
  );
  return requestBody;
}

export function mapOpenAIChatCompletionResponse(
  data: any,
): GenerateContentResponse {
  const choice = data.choices[0];
  const message = choice.message;

  const parts: any[] = [];
  if (message.reasoning_content) {
    parts.push({ reasoning: message.reasoning_content });
  }
  if (message.content) parts.push({ text: message.content });
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      if (tc.type === 'function') {
        parts.push({
          functionCall: {
            name: tc.function.name?.trim() || tc.function.name,
            args: parseJSONSafe(tc.function.arguments),
            id: tc.id,
          },
        });
      }
    }
  }

  const cachedTokens = data.usage?.prompt_tokens_details?.cached_tokens || 0;
  const promptTokens = data.usage?.prompt_tokens || 0;

  const result = {
    candidates: [
      {
        content: {
          role: MESSAGE_ROLES.MODEL,
          parts: parts.length ? parts : [{ text: '' }],
        },
        finishReason: OpenAIConverter.mapFinishReason(choice.finish_reason),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: data.usage?.completion_tokens || 0,
      totalTokenCount: data.usage?.total_tokens || 0,
      ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
      uncachedInputTokens: promptTokens - cachedTokens,
    } as any,
  };
  addFunctionCallsGetter(result);
  return result as GenerateContentResponse;
}

export function buildOpenAIResponsesRequestBody(input: {
  modelConfig: CustomModelConfig;
  request: any;
  systemText: string;
  maxOutputTokens: number;
  stream: boolean;
  codexAuth: boolean;
}): any {
  const thinkingConfig = resolveThinkingConfig(input.modelConfig);
  const requestBody: any = {
    model: input.modelConfig.modelId,
    input: OpenAIResponsesConverter.contentsToInput(input.request.contents),
    tools: OpenAIResponsesConverter.toolsToResponsesTools(
      input.request.config?.tools,
    ),
    stream: input.stream,
    store: false,
    max_output_tokens: input.maxOutputTokens,
  };

  if (thinkingConfig.mode === 'off') {
    requestBody.reasoning = { effort: 'low', summary: 'detailed' };
  } else {
    const openaiEffort =
      effortToOpenAIEffort(thinkingConfig.effort) ?? 'medium';
    requestBody.reasoning = { effort: openaiEffort, summary: 'detailed' };
  }

  if (input.systemText) {
    requestBody.instructions = input.systemText;
  }

  if (input.codexAuth) {
    requestBody.instructions =
      input.systemText || 'You are a helpful assistant.';
    delete requestBody.max_output_tokens;
  }

  return requestBody;
}

export function mapOpenAIResponsesResponse(data: any): GenerateContentResponse {
  const parts = OpenAIResponsesConverter.outputToParts(data.output);

  const cachedTokens = data.usage?.input_tokens_details?.cached_tokens || 0;
  const promptTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;

  const result = {
    candidates: [
      {
        content: {
          role: MESSAGE_ROLES.MODEL,
          parts: parts.length ? parts : [{ text: '' }],
        },
        finishReason: OpenAIResponsesConverter.mapFinishReason(data.status),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount:
        promptTokens + outputTokens || data.usage?.total_tokens || 0,
      ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
      uncachedInputTokens: promptTokens - cachedTokens,
    } as any,
  };
  addFunctionCallsGetter(result);
  return result as GenerateContentResponse;
}
