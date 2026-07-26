/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse, FinishReason } from '@google/genai';
import {
  CustomModelConfig,
  resolveThinkingConfig,
} from '../types/customModel.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { OttoChat } from './ottoChat.js';
import { retryWithBackoff } from '../utils/retry.js';
import {
  sanitiseGeminiToolSchema,
  sanitiseGeminiTools,
} from './customModelGeminiSchema.js';
import {
  buildGeminiNativeRequestBody,
  buildGeminiNativeUrl,
  dumpGeminiRequest,
  mapGeminiChunkToResponses,
} from './customModelGeminiNative.js';
import { AnthropicConverter } from './customModelAnthropicConverter.js';
import { parseJSONSafe } from './customModelJson.js';
import {
  buildOpenAIChatRequestBody,
  buildOpenAIResponsesRequestBody,
  mapOpenAIChatCompletionResponse,
  mapOpenAIResponsesResponse,
} from './providerConverters/openai.js';
import {
  buildAnthropicMessagesRequestBody,
  mapAnthropicMessageResponse,
} from './providerConverters/anthropic.js';
import { mapGeminiGenerateContentResponse } from './providerConverters/gemini.js';
import { addFunctionCallsGetter } from './providerConverters/shared.js';
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
export { CODEX_OAUTH_SENTINEL } from './customModelProviderContract.js';
export { shouldDumpGeminiRequest } from './customModelGeminiNative.js';

/**
 * OpenAI 兼容模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 */
export async function callOpenAICompatibleModel(
  modelConfig: CustomModelConfig,
  request: any,
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
  request: any,
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
  request: any,
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
              yield resp as any as GenerateContentResponse;
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
              } as any;
            }
          }
        } catch (e) {}
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
 * Anthropic 模型单次调用
 * 使用指数退避重试策略处理 429 和 5xx 错误
 * 支持 extended thinking 配置
 */
export async function callAnthropicModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const systemText = extractSystemText(request);
  const requestBody = buildAnthropicMessagesRequestBody({
    modelConfig,
    request,
    systemText,
    maxOutputTokens: resolveOutputTokens(modelConfig),
    resolveOutputTokens,
    stream: false,
  });

  // 使用指数退避重试包装 API 调用
  return retryWithBackoff(
    async () => {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(
          response.status,
          `Anthropic error (${response.status}): ${errorText}`,
          response,
        );
      }

      return mapAnthropicMessageResponse(await response.json());
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );
}

/**
 * OpenAI 兼容模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 */
export async function* callOpenAICompatibleModelStream(
  modelConfig: CustomModelConfig,
  request: any,
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
              yield resp as any as GenerateContentResponse;
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
              yield resp as any as GenerateContentResponse;
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
            } as any;
          }
        } catch (e) {}
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

/**
 * Anthropic 模型流式调用
 * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
 * 支持 extended thinking 配置
 */
export async function* callAnthropicModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
  const baseUrl = resolveEnvVar(modelConfig.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveEnvVar(modelConfig.apiKey);
  const systemText = extractSystemText(request);
  const requestBody = buildAnthropicMessagesRequestBody({
    modelConfig,
    request,
    systemText,
    maxOutputTokens: resolveOutputTokens(modelConfig),
    resolveOutputTokens,
    stream: true,
  });

  // 使用指数退避重试包装初始连接
  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(
          res.status,
          `Anthropic Stream error (${res.status}): ${errorText}`,
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
  const aggregatedTools: Map<
    number,
    { id: string; name: string; args: string }
  > = new Map();
  // 🆕 用于聚合 thinking 内容块（流式累积后一次性发送）
  const aggregatedThinking: Map<number, string> = new Map();

  // 用于累积 token 使用统计
  // 🔧 修复：缓存 token 来自 message_start（初始值），output_tokens 来自 message_delta（累加）
  let inputTokens = 0;
  let totalOutputTokens = 0;
  // 缓存相关 token（从 message_start 获取，不累加）
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  try {
    while (true) {
      const { done, value } = await readStreamWithIdleTimeout(reader);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const dataStr = trimmed.slice(6);

        try {
          const chunk = JSON.parse(dataStr);
          const idx = chunk.index ?? 0;

          if (chunk.type === 'content_block_start') {
            if (chunk.content_block?.type === 'tool_use') {
              aggregatedTools.set(idx, {
                id: chunk.content_block.id,
                name:
                  chunk.content_block.name?.trim() || chunk.content_block.name,
                args: '',
              });
            } else if (chunk.content_block?.type === 'thinking') {
              // 🆕 开始聚合 thinking 内容块
              aggregatedThinking.set(idx, chunk.content_block.thinking || '');
            }
          } else if (chunk.type === 'content_block_delta') {
            if (chunk.delta?.type === 'text_delta') {
              const content = {
                role: MESSAGE_ROLES.MODEL,
                parts: [{ text: chunk.delta.text }],
              };
              const resp = { candidates: [{ content, index: 0 }] };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as any;
            } else if (chunk.delta?.type === 'input_json_delta') {
              const tool = aggregatedTools.get(idx);
              if (tool) tool.args += chunk.delta.partial_json;
            } else if (chunk.delta?.type === 'thinking_delta') {
              // 🆕 实时流式输出 thinking 内容，让 UI 能显示模型思考过程
              const thinkingChunk = chunk.delta.thinking || '';
              if (thinkingChunk) {
                const content = {
                  role: MESSAGE_ROLES.MODEL,
                  parts: [{ reasoning: thinkingChunk }],
                } as any;
                const resp = { candidates: [{ content, index: 0 }] } as any;
                addFunctionCallsGetter(resp);
                addFunctionCallsGetter(content);
                yield resp;
              }
              // 同时累积完整内容，以便在 content_block_stop 时可用（如果需要）
              const existing = aggregatedThinking.get(idx) || '';
              aggregatedThinking.set(idx, existing + thinkingChunk);
            }
          } else if (chunk.type === 'content_block_stop') {
            const tool = aggregatedTools.get(idx);
            if (tool) {
              const content = {
                role: MESSAGE_ROLES.MODEL,
                parts: [
                  {
                    functionCall: {
                      name: tool.name,
                      args: parseJSONSafe(tool.args),
                      id: tool.id,
                    },
                  },
                ],
              };
              const resp = {
                candidates: [
                  {
                    content,
                    index: 0,
                  },
                ],
              };
              addFunctionCallsGetter(resp);
              addFunctionCallsGetter(content);
              yield resp as GenerateContentResponse;
              aggregatedTools.delete(idx);
            }
            // 🆕 thinking 内容已在 thinking_delta 中实时流式输出，这里只需清理状态
            // 不再重复 yield 完整内容，避免 UI 显示重复
            if (aggregatedThinking.has(idx)) {
              aggregatedThinking.delete(idx);
            }
          } else if (chunk.type === 'message_delta') {
            // 🔧 message_delta 中的 output_tokens 是最终总数，不是增量，所以用替换而非累加
            // 参考日志：message_start 有 output_tokens:5，message_delta 有 output_tokens:298（最终值）
            if (chunk.usage?.output_tokens != null) {
              totalOutputTokens = chunk.usage.output_tokens;
            }

            // 🔧 鲁棒性增强：一些上游厂商（如 GLM-4 的 Anthropic 兼容接口）在 message_start 中
            // 返回 input_tokens: 0，但在最后的 message_delta 中才返回真实的 token 用量。
            // 这里采用"有非零值就更新"的策略，确保能从任何位置获取正确的 token 数据。
            if (
              chunk.usage?.input_tokens != null &&
              chunk.usage.input_tokens > 0
            ) {
              inputTokens = chunk.usage.input_tokens;
            }
            if (
              chunk.usage?.cache_creation_input_tokens != null &&
              chunk.usage.cache_creation_input_tokens > 0
            ) {
              cacheCreationInputTokens =
                chunk.usage.cache_creation_input_tokens;
            }
            if (
              chunk.usage?.cache_read_input_tokens != null &&
              chunk.usage.cache_read_input_tokens > 0
            ) {
              cacheReadInputTokens = chunk.usage.cache_read_input_tokens;
            }

            // 🔧 计算真正的总输入 token：
            // Anthropic 的 input_tokens 只是非缓存的直接输入，实际总输入需要加上缓存 token
            // 实际总输入 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
            const actualPromptTokens =
              inputTokens + cacheCreationInputTokens + cacheReadInputTokens;

            const content = { role: MESSAGE_ROLES.MODEL, parts: [] };
            const resp = {
              candidates: [
                {
                  content,
                  finishReason: AnthropicConverter.mapFinishReason(
                    chunk.delta?.stop_reason,
                  ),
                  index: 0,
                },
              ],
              usageMetadata: {
                // promptTokenCount 应该反映实际处理的总输入 token（包括缓存）
                promptTokenCount: actualPromptTokens,
                candidatesTokenCount: totalOutputTokens,
                totalTokenCount: actualPromptTokens + totalOutputTokens,
                // 🔧 Claude prompt caching 详细信息
                // 字段名与 geminiChat.ts 中读取的一致（不带 Count 后缀）
                // - cacheCreationInputTokens: 本次写入缓存的 token（1.25x 价格）
                //   同时设置 cacheWriteInputTokens 别名，供 telemetry 等下游兼容读取
                // - cacheReadInputTokens: 从缓存读取的 token（0.1x 价格，便宜 90%）
                // - uncachedInputTokens: 非缓存的直接输入 token（原始 input_tokens）
                ...(cacheCreationInputTokens != null && {
                  cacheCreationInputTokens,
                  cacheWriteInputTokens: cacheCreationInputTokens,
                }),
                ...(cacheReadInputTokens != null && { cacheReadInputTokens }),
                // 保留原始的非缓存输入 token 以便精确计费
                uncachedInputTokens: inputTokens,
              },
            } as any;
            addFunctionCallsGetter(resp);
            addFunctionCallsGetter(content);
            yield resp;
          } else if (chunk.type === 'message_start' && chunk.message?.usage) {
            // 🔧 message_start 包含完整的初始 usage，包括缓存 token
            const usage = chunk.message.usage;
            inputTokens = usage.input_tokens || 0;
            totalOutputTokens = usage.output_tokens || 0;
            // 缓存 token 只在 message_start 中出现，记录后不再累加
            cacheCreationInputTokens = usage.cache_creation_input_tokens || 0;
            cacheReadInputTokens = usage.cache_read_input_tokens || 0;
          }
        } catch (e) {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Gemini native single-shot call (GenAI generateContent).
 */
export async function callGeminiNativeModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  const url = buildGeminiNativeUrl(
    modelConfig.modelId,
    resolveEnvVar(modelConfig.baseUrl),
    resolveEnvVar(modelConfig.apiKey),
    'generateContent',
  );
  const requestBody = buildGeminiNativeRequestBody(
    modelConfig,
    request,
    resolveOutputTokens(modelConfig),
  );
  dumpGeminiRequest('unary', modelConfig.modelId, requestBody);

  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw createHttpError(
          response.status,
          `Gemini native error (${response.status}): ${errorText}`,
          response,
        );
      }
      return mapGeminiGenerateContentResponse(await response.json());
    },
    {
      shouldRetry: shouldRetryCustomModel,
    },
  );
}

/**
 * Gemini native streaming call (GenAI streamGenerateContent + alt=sse).
 *
 * EasyRouter follows Google's wire format: lines look like
 *   data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"…"}]}}]}
 * separated by blank lines. We tolerate both `\n` and `\r\n` framings and
 * a trailing partial chunk on the buffer between reads.
 */
export async function* callGeminiNativeModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
  const url = buildGeminiNativeUrl(
    modelConfig.modelId,
    resolveEnvVar(modelConfig.baseUrl),
    resolveEnvVar(modelConfig.apiKey),
    'streamGenerateContent',
  );
  const requestBody = buildGeminiNativeRequestBody(
    modelConfig,
    request,
    resolveOutputTokens(modelConfig),
  );
  dumpGeminiRequest('stream', modelConfig.modelId, requestBody);

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...modelConfig.headers,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw createHttpError(
          res.status,
          `Gemini native stream error (${res.status}): ${errorText}`,
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
  try {
    while (true) {
      const { value, done } = await readStreamWithIdleTimeout(reader);
      if (done) {
        buffer += decoder.decode(undefined, { stream: false });
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      // SSE events are separated by blank lines. Tolerate both \n\n and \r\n\r\n.
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const ev of events) {
        // Only interested in `data:` lines; concatenate them per-event.
        let data = '';
        for (const line of ev.split(/\r?\n/)) {
          const trimmed = line.replace(/^\s+/, '');
          if (trimmed.startsWith('data:')) data += trimmed.slice(5).trim();
        }
        if (!data || data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data);
          yield* mapGeminiChunkToResponses(chunk, addFunctionCallsGetter);
        } catch {
          // Tolerate malformed chunks — Gemini streaming occasionally
          // sends framing artefacts; swallow and continue.
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* callCustomModelStream(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): AsyncGenerator<GenerateContentResponse> {
  console.log(
    `[CustomModel] Stream call: ${modelConfig.displayName} (${modelConfig.provider})`,
  );
  // 🐛 [thinking-debug] 直连自定义模型路径 - 打印解析后的 thinking 配置
  // eslint-disable-next-line no-console
  console.log(
    `\x1b[35m[thinking-debug]\x1b[0m (custom-direct/stream) modelId=\x1b[36m${modelConfig.modelId}\x1b[0m  resolvedThinking=${JSON.stringify(resolveThinkingConfig(modelConfig))}`,
  );

  // 🛡️ 协议安全网：复用 OttoChat.sanitizeRequestContents（即 fixRequestContents）
  // 修复 functionCall ↔ functionResponse 配对错乱、孤立 functionResponse、
  // 末尾 model 消息（破坏 Bedrock prefill 限制）等问题。
  // 该方法在 Gemini 原生路径已经经过长期打磨，CustomModel 路径直连（GCP/AWS/...）也必须走同一卫士。
  const requestToUse =
    request && Array.isArray(request.contents)
      ? {
          ...request,
          contents: OttoChat.sanitizeRequestContents(request.contents),
        }
      : request;

  if (modelConfig.provider === 'openai')
    yield* callOpenAICompatibleModelStream(
      modelConfig,
      requestToUse,
      abortSignal,
    );
  else if (modelConfig.provider === 'openai-responses')
    yield* callOpenAIResponsesModelStream(
      modelConfig,
      requestToUse,
      abortSignal,
    );
  else if (modelConfig.provider === 'anthropic')
    yield* callAnthropicModelStream(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'gemini')
    yield* callGeminiNativeModelStream(modelConfig, requestToUse, abortSignal);
  else
    throw new Error(
      `Unsupported custom model provider for streaming: ${modelConfig.provider}`,
    );
}

export async function callCustomModel(
  modelConfig: CustomModelConfig,
  request: any,
  abortSignal?: AbortSignal,
): Promise<GenerateContentResponse> {
  console.log(
    `[CustomModel] Unary call: ${modelConfig.displayName} (${modelConfig.provider})`,
  );
  // 🐛 [thinking-debug] 直连自定义模型路径 - 打印解析后的 thinking 配置
  // eslint-disable-next-line no-console
  console.log(
    `\x1b[35m[thinking-debug]\x1b[0m (custom-direct/unary) modelId=\x1b[36m${modelConfig.modelId}\x1b[0m  resolvedThinking=${JSON.stringify(resolveThinkingConfig(modelConfig))}`,
  );

  // 🛡️ 协议安全网：与 stream 路径保持一致，统一调用 fixRequestContents 清洗。
  const requestToUse =
    request && Array.isArray(request.contents)
      ? {
          ...request,
          contents: OttoChat.sanitizeRequestContents(request.contents),
        }
      : request;

  if (modelConfig.provider === 'openai')
    return callOpenAICompatibleModel(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'openai-responses')
    return callOpenAIResponsesModel(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'anthropic')
    return callAnthropicModel(modelConfig, requestToUse, abortSignal);
  else if (modelConfig.provider === 'gemini')
    return callGeminiNativeModel(modelConfig, requestToUse, abortSignal);
  else
    throw new Error(
      `Unsupported custom model provider: ${modelConfig.provider}`,
    );
}

/**
 * @internal
 * 导出 parseJSONSafe 用于单元测试
 * 这是内部实现细节，不属于公开 API，可能随时变更
 */
export { parseJSONSafe as parseJSONSafeExport };

/**
 * @internal
 * Exported for the Gemini-native tool-schema sanitiser unit tests
 * (see customModelAdapter.test.ts → "sanitiseGeminiToolSchema"). These are
 * implementation details of the GenAI v1beta tool branch, not public API.
 */
export {
  sanitiseGeminiToolSchema as sanitiseGeminiToolSchemaExport,
  sanitiseGeminiTools as sanitiseGeminiToolsExport,
};
