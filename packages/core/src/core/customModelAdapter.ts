/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GenerateContentResponse } from '@google/genai';
import {
  CustomModelConfig,
  resolveThinkingConfig,
} from '../types/customModel.js';
import { OttoChat } from './ottoChat.js';
import {
  sanitiseGeminiToolSchema,
  sanitiseGeminiTools,
} from './customModelGeminiSchema.js';
import {
  callGeminiNativeModel,
  callGeminiNativeModelStream,
} from './customModelGeminiClient.js';
import { parseJSONSafe } from './customModelJson.js';
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
export { CODEX_OAUTH_SENTINEL } from './customModelProviderContract.js';
export { shouldDumpGeminiRequest } from './customModelGeminiNative.js';
export {
  callAnthropicModel,
  callAnthropicModelStream,
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
  callOpenAIResponsesModel,
  callOpenAIResponsesModelStream,
  callGeminiNativeModel,
  callGeminiNativeModelStream,
};

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
