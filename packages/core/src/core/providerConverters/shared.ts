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
export function addFunctionCallsGetter(obj: any): void {
  if (!obj) return;

  const descriptor = Object.getOwnPropertyDescriptor(obj, 'functionCalls');
  if (descriptor) return;

  Object.defineProperty(obj, 'functionCalls', {
    get: function () {
      const partsFromResponse = this.candidates?.[0]?.content?.parts;
      const parts = partsFromResponse || this.parts;

      if (!parts || !Array.isArray(parts)) return undefined;

      const calls = parts
        .filter((p: any) => p && p.functionCall)
        .map((p: any) => p.functionCall);

      return calls.length > 0 ? calls : undefined;
    },
    enumerable: false,
    configurable: true,
  });
}
