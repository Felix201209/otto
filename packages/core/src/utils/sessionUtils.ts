/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Content, type Part, type PartListUnion } from '@google/genai';

/**
 * Minimal conversation message shape understood by
 * {@link convertSessionToClientHistory}.
 *
 * DeepCode's {@link SessionManager} persists `clientHistory` as `any[]`
 * already shaped as `{ role, parts }[]`, so this record type is mostly a
 * lowest-common-denominator abstraction that also tolerates older records
 * using `type: 'user' | 'gemini' | 'info' | 'error' | 'warning'` (gemini-cli
 * compatible).
 */
export interface ConversationMessage {
  /** Either gemini-cli style (`'user'|'gemini'|...`) or direct role. */
  readonly type?: 'user' | 'gemini' | 'info' | 'error' | 'warning';
  readonly role?: 'user' | 'model';
  /** Raw content in any of the Part / PartListUnion shapes. */
  readonly content?: PartListUnion;
  /** Already-normalized Gemini parts. Preferred when present. */
  readonly parts?: Part[];
  /**
   * Tool calls attached to a gemini-turn message. Only honored when `type`
   * is `'gemini'` (i.e. the gemini-cli-style shape).
   */
  readonly toolCalls?: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  }>;
  /** Optional thought chunks emitted by the model. */
  readonly thoughts?: Array<{ subject?: string; description: string }>;
}

function ensurePartArray(content: PartListUnion): Part[] {
  if (Array.isArray(content)) {
    return content.map((part) =>
      typeof part === 'string' ? ({ text: part } as Part) : (part as Part),
    );
  }
  if (typeof content === 'string') {
    return [{ text: content } as Part];
  }
  return [content as Part];
}

function partsToString(parts: Part[]): string {
  return parts
    .map((p) =>
      typeof (p as { text?: string }).text === 'string'
        ? (p as { text: string }).text
        : '',
    )
    .join('');
}

/**
 * Convert a persisted conversation (from `SessionManager`) into the
 * `{role, parts}[]` shape expected by {@link GeminiClient.startChat} /
 * {@link GeminiClient.resumeChat}.
 *
 * Supports two input formats:
 *
 * 1. **Native Gemini history** — records already have `{ role, parts }`;
 *    these are passed through unchanged (after a defensive clone).
 * 2. **gemini-cli style** — records have `{ type, content, toolCalls?, thoughts? }`;
 *    we expand them into separate `user` / `model` turns, emitting
 *    `functionCall` + `functionResponse` parts for tool-call roundtrips.
 *
 * Info / error / warning messages and slash-command lines are dropped —
 * they should not be replayed to the model.
 */
export function convertSessionToClientHistory(
  messages: readonly ConversationMessage[] | undefined | null,
): Content[] {
  if (!messages || messages.length === 0) return [];

  const result: Content[] = [];

  for (const msg of messages) {
    // Already-normalized form.
    if (msg.role && (msg.parts || msg.content !== undefined)) {
      const parts = msg.parts ?? ensurePartArray(msg.content!);
      result.push({ role: msg.role, parts });
      continue;
    }

    // Structured form from gemini-cli style.
    if (msg.type === 'info' || msg.type === 'error' || msg.type === 'warning') {
      continue;
    }

    if (msg.type === 'user') {
      const parts = msg.content !== undefined ? ensurePartArray(msg.content) : [];
      const text = partsToString(parts).trim();
      if (text.startsWith('/') || text.startsWith('?')) continue;
      if (parts.length === 0) continue;
      result.push({ role: 'user', parts });
      continue;
    }

    if (msg.type === 'gemini') {
      const modelParts: Part[] = [];
      if (msg.thoughts && msg.thoughts.length > 0) {
        for (const thought of msg.thoughts) {
          const thoughtText = thought.subject
            ? `**${thought.subject}** ${thought.description}`
            : thought.description;
          modelParts.push({ text: thoughtText, thought: true } as Part);
        }
      }
      const hasToolCalls = !!msg.toolCalls && msg.toolCalls.length > 0;
      if (msg.content !== undefined) {
        modelParts.push(...ensurePartArray(msg.content));
      }
      if (hasToolCalls) {
        for (const call of msg.toolCalls!) {
          modelParts.push({
            functionCall: {
              name: call.name,
              args: call.args,
              ...(call.id ? { id: call.id } : {}),
            },
          } as Part);
        }
      }
      if (modelParts.length > 0) {
        result.push({ role: 'model', parts: modelParts });
      }
      if (hasToolCalls) {
        const responseParts: Part[] = [];
        for (const call of msg.toolCalls!) {
          if (call.result === undefined) continue;
          if (typeof call.result === 'string') {
            responseParts.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { output: call.result },
              },
            } as Part);
          } else if (Array.isArray(call.result)) {
            responseParts.push(...ensurePartArray(call.result as PartListUnion));
          } else {
            responseParts.push(call.result as Part);
          }
        }
        if (responseParts.length > 0) {
          result.push({ role: 'user', parts: responseParts });
        }
      }
    }
  }

  return result;
}
