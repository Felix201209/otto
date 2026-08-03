/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason, type GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../../config/messageRoles.js';
import { normaliseGeminiUsageMetadata } from '../customModelGeminiNative.js';
import { addFunctionCallsGetter } from './shared.js';

type GeminiRecord = Record<string, unknown>;

export function mapGeminiGenerateContentResponse(
  data: GeminiRecord,
): GenerateContentResponse {
  const candidates = Array.isArray(data.candidates) ? data.candidates as GeminiRecord[] : [];
  const cand = candidates[0];
  const content = cand?.content && typeof cand.content === 'object' ? cand.content as GeminiRecord : undefined;
  const rawParts = Array.isArray(content?.parts) ? content.parts as GeminiRecord[] : [];
  const parts: GeminiRecord[] = [];
  for (const p of rawParts) {
    if (p?.thought === true && typeof p.text === 'string') {
      const out: GeminiRecord = { reasoning: p.text };
      if (typeof p.thoughtSignature === 'string') {
        out.thoughtSignature = p.thoughtSignature;
      }
      parts.push(out);
    } else if (typeof p?.text === 'string') {
      const out: GeminiRecord = { text: p.text };
      if (typeof p.thoughtSignature === 'string') {
        out.thoughtSignature = p.thoughtSignature;
      }
      parts.push(out);
    } else if (p?.functionCall) {
      const functionCall = p.functionCall as GeminiRecord;
      const out: GeminiRecord = {
        functionCall: {
          name: typeof functionCall.name === 'string' ? functionCall.name.trim() || functionCall.name : undefined,
          args: functionCall.args || {},
          id: functionCall.id,
        },
      };
      if (typeof p.thoughtSignature === 'string') {
        out.thoughtSignature = p.thoughtSignature;
      }
      parts.push(out);
    } else if (p?.inlineData) {
      parts.push({ inlineData: p.inlineData });
    }
  }

  const result = {
    candidates: [
      {
        content: {
          role: MESSAGE_ROLES.MODEL,
          parts: parts.length ? parts : [{ text: '' }],
        },
        ...(cand?.finishReason
          ? { finishReason: cand.finishReason }
          : { finishReason: FinishReason.STOP }),
        index: 0,
      },
    ],
    usageMetadata: normaliseGeminiUsageMetadata(data.usageMetadata),
  };
  addFunctionCallsGetter(result);
  return result as unknown as GenerateContentResponse;
}
