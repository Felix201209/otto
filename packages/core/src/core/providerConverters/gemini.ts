/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason, type GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../../config/messageRoles.js';
import { normaliseGeminiUsageMetadata } from '../customModelGeminiNative.js';
import { addFunctionCallsGetter } from './shared.js';

export function mapGeminiGenerateContentResponse(
  data: any,
): GenerateContentResponse {
  const cand = data.candidates?.[0];
  const rawParts = cand?.content?.parts || [];
  const parts: any[] = [];
  for (const p of rawParts) {
    if (p?.thought === true && typeof p.text === 'string') {
      const out: any = { reasoning: p.text };
      if (typeof p.thoughtSignature === 'string') {
        out.thoughtSignature = p.thoughtSignature;
      }
      parts.push(out);
    } else if (typeof p?.text === 'string') {
      const out: any = { text: p.text };
      if (typeof p.thoughtSignature === 'string') {
        out.thoughtSignature = p.thoughtSignature;
      }
      parts.push(out);
    } else if (p?.functionCall) {
      const out: any = {
        functionCall: {
          name: p.functionCall.name?.trim() || p.functionCall.name,
          args: p.functionCall.args || {},
          id: p.functionCall.id,
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
  return result as any as GenerateContentResponse;
}
