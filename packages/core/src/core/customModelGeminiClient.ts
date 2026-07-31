/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { type GenerateContentResponse } from '@google/genai';
import type { CustomModelConfig } from '../types/customModel.js';
import { retryWithBackoff } from '../utils/retry.js';
import {
  buildGeminiNativeRequestBody,
  buildGeminiNativeUrl,
  dumpGeminiRequest,
  mapGeminiChunkToResponses,
} from './customModelGeminiNative.js';
import {
  createHttpError,
  readStreamWithIdleTimeout,
  resolveEnvVar,
  resolveOutputTokens,
  shouldRetryCustomModel,
} from './customModelRuntimeHelpers.js';
import { mapGeminiGenerateContentResponse } from './providerConverters/gemini.js';
import { addFunctionCallsGetter } from './providerConverters/shared.js';
import type { NativeRequest } from './customModelGeminiNative.js';

/**
 * Gemini native single-shot call (GenAI generateContent).
 */
export async function callGeminiNativeModel(
  modelConfig: CustomModelConfig,
  request: NativeRequest,
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
  request: NativeRequest,
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
