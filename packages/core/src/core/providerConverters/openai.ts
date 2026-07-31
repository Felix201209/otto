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

type OpenAIRecord = Record<string, unknown>;

export function buildOpenAIChatRequestBody(input: {
  modelConfig: CustomModelConfig;
  request: { contents?: unknown; config?: unknown };
  systemText: string;
  maxOutputTokens: number;
  stream: boolean;
}): OpenAIRecord {
  const thinkingConfig = resolveThinkingConfig(input.modelConfig);
  const contents = Array.isArray(input.request.contents) ? input.request.contents as OpenAIRecord[] : [];
  const messages = OpenAIConverter.contentsToMessages(contents);
  if (input.systemText) {
    messages.unshift({ role: 'system', content: input.systemText });
  }
  const config = input.request.config && typeof input.request.config === 'object' ? input.request.config as { tools?: unknown } : undefined;
  const requestBody: OpenAIRecord = {
    model: input.modelConfig.modelId,
    messages,
    tools: OpenAIConverter.toolsToOpenAITools(Array.isArray(config?.tools) ? config.tools as OpenAIRecord[] : []),
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
  data: OpenAIRecord,
): GenerateContentResponse {
  const choices = Array.isArray(data.choices) ? data.choices as OpenAIRecord[] : [];
  const choice = choices[0] ?? {};
  const message = choice.message && typeof choice.message === 'object' ? choice.message as OpenAIRecord : {};

  const parts: OpenAIRecord[] = [];
  if (typeof message.reasoning_content === 'string') {
    parts.push({ reasoning: message.reasoning_content });
  }
  if (typeof message.content === 'string') parts.push({ text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls as OpenAIRecord[]) {
      if (tc.type === 'function') {
        const fn = tc.function && typeof tc.function === 'object' ? tc.function as OpenAIRecord : {};
        parts.push({
          functionCall: {
            name: typeof fn.name === 'string' ? fn.name.trim() || fn.name : '',
            args: parseJSONSafe(typeof fn.arguments === 'string' ? fn.arguments : '{}'),
            id: tc.id,
          },
        });
      }
    }
  }

  const usage = data.usage && typeof data.usage === 'object' ? data.usage as OpenAIRecord : {};
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object' ? usage.prompt_tokens_details as OpenAIRecord : {};
  const cachedTokens = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0;
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;

  const result = {
    candidates: [
      {
        content: {
          role: MESSAGE_ROLES.MODEL,
          parts: parts.length ? parts : [{ text: '' }],
        },
        finishReason: OpenAIConverter.mapFinishReason(typeof choice.finish_reason === 'string' ? choice.finish_reason : ''),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      totalTokenCount: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
      ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
      uncachedInputTokens: promptTokens - cachedTokens,
    },
  };
  addFunctionCallsGetter(result);
  return result as unknown as GenerateContentResponse;
}

export function buildOpenAIResponsesRequestBody(input: {
  modelConfig: CustomModelConfig;
  request: { contents?: unknown; config?: unknown };
  systemText: string;
  maxOutputTokens: number;
  stream: boolean;
  codexAuth: boolean;
}): OpenAIRecord {
  const thinkingConfig = resolveThinkingConfig(input.modelConfig);
  const requestContents = Array.isArray(input.request.contents) ? input.request.contents as OpenAIRecord[] : [];
  const config = input.request.config && typeof input.request.config === 'object' ? input.request.config as { tools?: unknown } : undefined;
  const requestBody: OpenAIRecord = {
    model: input.modelConfig.modelId,
    input: OpenAIResponsesConverter.contentsToInput(requestContents),
    tools: OpenAIResponsesConverter.toolsToResponsesTools(
      Array.isArray(config?.tools) ? config.tools as OpenAIRecord[] : [],
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

export function mapOpenAIResponsesResponse(data: OpenAIRecord): GenerateContentResponse {
  const parts = OpenAIResponsesConverter.outputToParts(Array.isArray(data.output) ? data.output as OpenAIRecord[] : []);

  const usage = data.usage && typeof data.usage === 'object' ? data.usage as OpenAIRecord : {};
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === 'object' ? usage.input_tokens_details as OpenAIRecord : {};
  const cachedTokens = typeof details.cached_tokens === 'number' ? details.cached_tokens : 0;
  const promptTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  const result = {
    candidates: [
      {
        content: {
          role: MESSAGE_ROLES.MODEL,
          parts: parts.length ? parts : [{ text: '' }],
        },
        finishReason: OpenAIResponsesConverter.mapFinishReason(typeof data.status === 'string' ? data.status : ''),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount:
        promptTokens + outputTokens || (typeof usage.total_tokens === 'number' ? usage.total_tokens : 0),
      ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
      uncachedInputTokens: promptTokens - cachedTokens,
    },
  };
  addFunctionCallsGetter(result);
  return result as unknown as GenerateContentResponse;
}
