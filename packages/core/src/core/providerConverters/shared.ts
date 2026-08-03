/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 为对象添加 functionCalls getter，兼容不同的结构。
 * - GenerateContentResponse 结构: response.candidates[0].content.parts
 * - Content 结构: content.parts
 */
type GetterTarget = Record<string, unknown>;
type FunctionCallPart = { functionCall?: unknown };

export function addFunctionCallsGetter(obj: object): void {
  if (!obj) return;

  const descriptor = Object.getOwnPropertyDescriptor(obj, 'functionCalls');
  if (descriptor) return;

  Object.defineProperty(obj, 'functionCalls', {
    get () {
      const target = obj as GetterTarget & {
        candidates?: Array<{ content?: { parts?: FunctionCallPart[] } }>;
        parts?: FunctionCallPart[];
      };
      const partsFromResponse = target.candidates?.[0]?.content?.parts;
      const parts = partsFromResponse || target.parts;

      if (!parts || !Array.isArray(parts)) return undefined;

      const calls = parts
        .filter((p) => p && p.functionCall)
        .map((p) => p.functionCall);

      return calls.length > 0 ? calls : undefined;
    },
    enumerable: false,
    configurable: true,
  });
}
