/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason, type GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import type { CustomModelConfig } from '../types/customModel.js';
import { retryWithBackoff } from '../utils/retry.js';
import { parseJSONSafe } from './customModelJson.js';
import {
  createHttpError,
  extractSystemText,
  isCodexAuth,
  readStreamWithIdleTimeout,
  resolveAuthHeaders,
  resolveEnvVar,
  resolveOutputTokens,
  shouldRetryCustomModel,
} from './customModelRuntimeHelpers.js';
import {
  buildOpenAIChatRequestBody,
  buildOpenAIResponsesRequestBody,
  mapOpenAIChatCompletionResponse,
  mapOpenAIResponsesResponse,
} from './providerConverters/openai.js';
import { addFunctionCallsGetter } from './providerConverters/shared.js';

type OpenAIRequest = Record<string, unknown>;

/**
 * OpenAI 兼容模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAICompatibleModel(
  modelConfig: CustomModelConfig,
  request: OpenAIRequest,
  abortSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const url = `${baseUrl}/chat/completions`;

  const systemText = extractSystemText(request);
  const requestBody = buildOpenAIChatRequestBody({
    modelConfig,
    request,
    systemText,
    maxOutputTokens: resolveOutputTokens(modelConfig),
    stream: false,
  });

  // 使用指数退避重试包装 API 调用
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(
          response.status,
          `OpenAI API error (${response.status}): ${errorText}`,
          response,
        );
      }

      return mapOpenAIChatCompletionResponse(await response.json());
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );
}

/**
 * OpenAI Responses API 单次调用
 * 使用 POST /responses 端点
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAIResponsesModel(
  modelConfig: CustomModelConfig,
  request: OpenAIRequest,
  abortSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const url = `${baseUrl}/responses`;

  const systemText = extractSystemText(request);
  const requestBody = buildOpenAIResponsesRequestBody({
    modelConfig,
    request,
    systemText,
    maxOutputTokens: resolveOutputTokens(modelConfig),
    stream: false,
    codexAuth: isCodexAuth(modelConfig, apiKey),
  });

  return retryWithBackoff(
    async () => {
      const authHeaders = await resolveAuthHeaders(modelConfig, apiKey);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(
          response.status,
          `OpenAI Responses API error (${response.status}): ${errorText}`,
          response,
        );
      }

      return mapOpenAIResponsesResponse(await response.json());
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );
}

/**
 * OpenAI Responses API 流式调用
 * 使用 POST /responses 端点 + stream: true
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAIResponsesModelStream(
  modelConfig: CustomModelConfig,
  request: OpenAIRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);

  const systemText = extractSystemText(request);
  const requestBody = buildOpenAIResponsesRequestBody({
    modelConfig,
    request,
    systemText,
    maxOutputTokens: resolveOutputTokens(modelConfig),
    stream: true,
    codexAuth: isCodexAuth(modelConfig, apiKey),
  });

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await resolveAuthHeaders(modelConfig, apiKey)),
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(
          res.status,
          `OpenAI Responses Stream error (${res.status}): ${errorText}`,
          res,
        );
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Aggregate function call arguments across deltas
  const aggregatedFunctionCalls: Map<
    string,
    { callId: string; name: string; args: string }
  > = new Map();

  const flushFunctionCalls = function* (): Generator<GenerateContentResponse> {
    if (aggregatedFunctionCalls.size === 0) return;
    const toolParts = Array.from(aggregatedFunctionCalls.values()).map(
      (fc) => ({
        functionCall: {
          name: fc.name || 'unknown_tool',
          args: parseJSONSafe(fc.args),
          id: fc.callId || `call_${Date.now()}`,
        },
      }),
    );
    const content = { role: MESSAGE_ROLES.MODEL, parts: toolParts };
    const resp = {
      candidates: [
        {
          content,
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
    };
    addFunctionCallsGetter(resp);
    addFunctionCallsGetter(content);
    yield resp as GenerateContentResponse;
    aggregatedFunctionCalls.clear();
  };

  try {
    let isDone = false;
    while (true) {
      const { done, value } = await readStreamWithIdleTimeout(reader);
      if (done) {
        isDone = true;
      }

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      } else {
        buffer += decoder.decode(undefined, { stream: false });
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          yield* flushFunctionCalls();
          isDone = true;
          break;
        }

        try {
          const event = JSON.parse(dataStr);

          // response.reasoning_summary_text.delta - reasoning summary streaming
          // gpt-5.x emits these only when reasoning.summary='detailed' is set
          // (EasyRouter gateway never honors 'auto'). The delta string is
          // a chunk of natural-language summary; map it to a `reasoning` part
          // so the UI thinking-block renderer picks it up.
          if (event.type === 'response.reasoning_summary_text.delta') {
            const reasoning = event.delta || '';
            if (reasoning) {
              const content = {
                role: MESSAGE_ROLES.MODEL,
                parts: [{ reasoning }],
              };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as unknown as GenerateContentResponse;
            }
          }

          // response.output_text.delta - text content streaming
          if (event.type === 'response.output_text.delta') {
            const text = event.delta || '';
            if (text) {
              const content = { role: MESSAGE_ROLES.MODEL, parts: [{ text }] };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
            }
          }

          // response.function_call_arguments.delta - function call argument streaming
          if (event.type === 'response.function_call_arguments.delta') {
            const itemId = event.item_id || 'default';
            let fc = aggregatedFunctionCalls.get(itemId);
            if (!fc) {
              fc = { callId: '', name: '', args: '' };
              aggregatedFunctionCalls.set(itemId, fc);
            }
            if (event.delta) fc.args += event.delta;
          }

          // response.output_item.added - track new function call items
          if (
            event.type === 'response.output_item.added' &&
            event.item?.type === 'function_call'
          ) {
            const itemId = event.item.id || 'default';
            aggregatedFunctionCalls.set(itemId, {
              callId:
                event.item.call_id || event.item.id || `call_${Date.now()}`,
              name: event.item.name?.trim() || '',
              args: '',
            });
          }

          // response.function_call_arguments.done - function call complete
          if (event.type === 'response.function_call_arguments.done') {
            const itemId = event.item_id || 'default';
            const fc = aggregatedFunctionCalls.get(itemId);
            if (fc) {
              // Use the final arguments if provided
              if (event.arguments) {
                fc.args = event.arguments;
              }
              // Yield completed function call
              const content = {
                role: MESSAGE_ROLES.MODEL,
                parts: [
                  {
                    functionCall: {
                      name: fc.name,
                      args: parseJSONSafe(fc.args),
                      id: fc.callId,
                    },
                  },
                ],
              };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
              aggregatedFunctionCalls.delete(itemId);
            }
          }

          // response.completed - final event with usage
          if (event.type === 'response.completed' && event.response) {
            const usage = event.response.usage;
            if (usage) {
              const cachedTokens =
                usage.input_tokens_details?.cached_tokens || 0;
              const promptTokens = usage.input_tokens || 0;

              yield {
                candidates: [],
                usageMetadata: {
                  promptTokenCount: promptTokens,
                  candidatesTokenCount: usage.output_tokens || 0,
                  totalTokenCount:
                    promptTokens + (usage.output_tokens || 0) ||
                    usage.total_tokens ||
                    0,
                  ...(cachedTokens > 0 && {
                    cacheReadInputTokens: cachedTokens,
                  }),
                  uncachedInputTokens: promptTokens - cachedTokens,
                },
              } as unknown as GenerateContentResponse;
            }
          }
        } catch {}
      }

      if (isDone) {
        yield* flushFunctionCalls();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * OpenAI 兼容模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAICompatibleModelStream(
  modelConfig: CustomModelConfig,
  request: OpenAIRequest,
  abortSignal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);

  const systemText = extractSystemText(request);
  const requestBody = buildOpenAIChatRequestBody({
    modelConfig,
    request,
    systemText,
    stream: true,
    maxOutputTokens: resolveOutputTokens(modelConfig),
  });

  // 使用指数退避重试包装初始连接
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(
          res.status,
          `OpenAI Stream error (${res.status}): ${errorText}`,
          res,
        );
      }

      return res;
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  // 用于聚合流式工具调用
  const aggregatedTools: Map<
    number,
    { id: string; name: string; args: string }
  > = new Map();

  const flushTools = function* (): Generator<GenerateContentResponse> {
    if (aggregatedTools.size === 0) return;
    const toolParts = Array.from(aggregatedTools.values()).map((at) => ({
      functionCall: {
        name: at.name || 'unknown_tool',
        args: parseJSONSafe(at.args),
        id: at.id || `call_${Date.now()}`,
      },
    }));
    const content = { role: MESSAGE_ROLES.MODEL, parts: toolParts };
    const resp = {
      candidates: [
        {
          content,
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ],
    };
    addFunctionCallsGetter(resp);
    addFunctionCallsGetter(content);
    yield resp as GenerateContentResponse;
    aggregatedTools.clear();
  };

  try {
    let isDone = false;
    while (true) {
      const { done, value } = await readStreamWithIdleTimeout(reader);
      if (done) {
        isDone = true;
      }

      if (!done) {
        buffer += decoder.decode(value, { stream: true });
      } else {
        // 流结束，使用最终解码
        buffer += decoder.decode(undefined, { stream: false });
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
          // OpenAI 明确表示流结束，此时应该 flush 所有待完成的工具调用
          yield* flushTools();
          isDone = true;
          break;
        }

        try {
          const chunk = JSON.parse(dataStr);
          const choice = chunk.choices?.[0];

          if (choice) {
            const delta = choice.delta;

            // 处理思考内容 - 立即 yield
            if (delta?.reasoning_content) {
              const content = {
                role: MESSAGE_ROLES.MODEL,
                parts: [{ reasoning: delta.reasoning_content }],
              };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as unknown as GenerateContentResponse;
            }

            // 处理文本内容 - 立即 yield
            if (delta?.content) {
              const content = {
                role: MESSAGE_ROLES.MODEL,
                parts: [{ text: delta.content }],
              };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as unknown as GenerateContentResponse;
            }

            // 聚合工具调用 - 不立即 yield，等待完全接收
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let tool = aggregatedTools.get(idx);
                if (!tool) {
                  tool = { id: '', name: '', args: '' };
                  aggregatedTools.set(idx, tool);
                }
                if (tc.id) tool.id = tc.id;
                if (tc.function?.name) tool.name = tc.function.name.trim();
                if (tc.function?.arguments) tool.args += tc.function.arguments;
              }
            }

            // 只在流结束时 flush，不在 finish_reason 中间 flush
            // 这与 Claude 的行为一致，防止不完整的工具调用被识别
          }

          if (chunk.usage) {
            // 🔧 OpenAI prompt caching：缓存信息在 usage.prompt_tokens_details.cached_tokens
            const cachedTokens =
              chunk.usage.prompt_tokens_details?.cached_tokens || 0;
            const promptTokens = chunk.usage.prompt_tokens || 0;

            yield {
              candidates: [],
              usageMetadata: {
                promptTokenCount: promptTokens,
                candidatesTokenCount: chunk.usage.completion_tokens || 0,
                totalTokenCount: chunk.usage.total_tokens || 0,
                // 🔧 OpenAI prompt caching support
                // OpenAI 使用 prompt_tokens_details.cached_tokens 表示缓存命中的 token
                // 映射到我们的字段名以保持与 geminiChat.ts 兼容
                ...(cachedTokens > 0 && { cacheReadInputTokens: cachedTokens }),
                // OpenAI 不区分 cache creation，只有 cache read
                uncachedInputTokens: promptTokens - cachedTokens,
              },
            } as unknown as GenerateContentResponse;
          }
        } catch {}
      }

      if (isDone) {
        // 在流完全结束时，flush 所有待完成的工具调用
        yield* flushTools();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
