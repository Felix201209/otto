/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import type { CustomModelConfig } from '../types/customModel.js';
import { retryWithBackoff } from '../utils/retry.js';
import { AnthropicConverter } from './customModelAnthropicConverter.js';
import { parseJSONSafe } from './customModelJson.js';
import {
  createHttpError,
  extractSystemText,
  readStreamWithIdleTimeout,
  resolveEnvVar,
  resolveOutputTokens,
  shouldRetryCustomModel,
} from './customModelRuntimeHelpers.js';
import {
  buildAnthropicMessagesRequestBody,
  mapAnthropicMessageResponse,
} from './providerConverters/anthropic.js';
import { addFunctionCallsGetter } from './providerConverters/shared.js';

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
