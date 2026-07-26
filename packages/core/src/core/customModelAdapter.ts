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
import { parseJSONSafe } from './customModelJson.js';
import { mapGeminiGenerateContentResponse } from './providerConverters/gemini.js';
import { addFunctionCallsGetter } from './providerConverters/shared.js';
import {
  callAnthropicModel,
  callAnthropicModelStream,
} from './customModelAnthropicClient.js';
import {
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
  callOpenAIResponsesModel,
  callOpenAIResponsesModelStream,
} from './customModelOpenAIClient.js';
import {
  createHttpError,
  extractSystemText,
  readStreamWithIdleTimeout,
  resolveEnvVar,
  resolveOutputTokens,
  shouldRetryCustomModel,
} from './customModelRuntimeHelpers.js';
export { CODEX_OAUTH_SENTINEL } from './customModelProviderContract.js';
export { shouldDumpGeminiRequest } from './customModelGeminiNative.js';
export {
  callAnthropicModel,
  callAnthropicModelStream,
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
  callOpenAIResponsesModel,
  callOpenAIResponsesModelStream,
};

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
