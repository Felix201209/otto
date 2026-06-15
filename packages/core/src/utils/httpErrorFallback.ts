/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP 错误兜底显示工具
 *
 * 目的：对于没有做友好翻译的 HTTP 错误，只要包含 message，就把 code + 消息
 * 完整地显示给用户，避免错误被静默吞掉或退化成 `[API Error: undefined]`。
 *
 * 使用约定：调用方应优先尝试自己的友好翻译（如 errorParsing.ts 中的本地化提示），
 * 只在所有匹配都未命中时再调用本工具。
 */

import { isApiError, isStructuredError } from './quotaErrorDetection.js';

/**
 * 从任意错误对象中提取出 HTTP status code（如果有）
 */
export function extractHttpStatusCode(error: unknown): number | undefined {
  if (error === null || error === undefined) return undefined;

  // 1. 直接挂在错误对象上的 status / statusCode（OttoServerAdapter 风格）
  if (typeof error === 'object') {
    const errAny = error as Record<string, unknown>;
    if (typeof errAny.status === 'number') return errAny.status;
    if (typeof errAny.statusCode === 'number') return errAny.statusCode;

    // response.status (Gaxios / fetch Response 风格)
    const response = errAny.response as Record<string, unknown> | undefined;
    if (response && typeof response.status === 'number') return response.status;
  }

  // 2. ApiError 风格 { error: { code: 401 } }
  if (isApiError(error) && typeof error.error.code === 'number') {
    return error.error.code;
  }

  // 3. 从字符串/message 中正则提取
  const msg =
    typeof error === 'string'
      ? error
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message ?? '')
        : '';

  // 匹配 "API request failed (XXX)" / "Stream API error (XXX)" / "(Status: XXX)" / "HTTP XXX"
  const patterns = [
    /API request failed \((\d{3})\)/,
    /Stream API error \((\d{3})\)/,
    /\(Status:\s*(\d{3})\)/i,
    /\bHTTP\s+(\d{3})\b/i,
    /\bstatus[\s:=]+(\d{3})\b/i,
  ];
  for (const re of patterns) {
    const m = msg.match(re);
    if (m) {
      const code = parseInt(m[1], 10);
      if (code >= 100 && code < 600) return code;
    }
  }

  return undefined;
}

/**
 * 从任意错误对象中提取出最有意义的 message。
 * 优先级：服务端 JSON 错误体 > error.message > String(error)。
 */
export function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) return '';

  if (typeof error === 'string') {
    return tryExtractServerMessage(error) ?? error;
  }

  // ApiError: { error: { message } }
  if (isApiError(error)) {
    return error.error.message || '';
  }

  if (isStructuredError(error)) {
    return tryExtractServerMessage(error.message) ?? error.message;
  }

  if (error instanceof Error) {
    return tryExtractServerMessage(error.message) ?? error.message;
  }

  try {
    return String(error);
  } catch {
    return '';
  }
}

/**
 * 尝试从一段可能含 JSON 的 message 中抽取服务端真实的错误描述。
 * 例如：'API request failed (500): {"error":"db down","message":"..."}'
 *      → 'db down' 或 'message 字段内容'
 */
function tryExtractServerMessage(text: string): string | undefined {
  if (!text) return undefined;
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return undefined;
  const jsonString = text.substring(jsonStart);
  try {
    const parsed = JSON.parse(jsonString) as unknown;
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      // 1. { error: { message } }
      if (
        obj.error &&
        typeof obj.error === 'object' &&
        typeof (obj.error as Record<string, unknown>).message === 'string'
      ) {
        const inner = (obj.error as Record<string, unknown>).message as string;
        if (inner.trim()) return `${text.substring(0, jsonStart).trim()} ${inner}`.trim();
      }
      // 2. { error: 'xxx', message: 'xxx' }
      if (typeof obj.message === 'string' && obj.message.trim()) {
        const prefix = text.substring(0, jsonStart).trim();
        return prefix ? `${prefix} ${obj.message}` : obj.message;
      }
      if (typeof obj.error === 'string' && obj.error.trim()) {
        const prefix = text.substring(0, jsonStart).trim();
        return prefix ? `${prefix} ${obj.error}` : obj.error;
      }
    }
  } catch {
    // JSON 解析失败，回退到原文
  }
  return undefined;
}

/**
 * HTTP 错误兜底格式化。
 *
 * 使用场景：当上层友好翻译都未命中、又不希望直接把原始堆栈/JSON 抛给用户时调用。
 * 输出格式：
 *   - 有 status 有 message: `[HTTP 500] db down`
 *   - 仅 message: `[Error] db down`
 *   - 都没有: 返回 undefined（调用方可决定不显示）
 *
 * @returns 兜底文本，若没有任何可显示信息则返回 undefined
 */
export function formatHttpErrorFallback(error: unknown): string | undefined {
  const status = extractHttpStatusCode(error);
  const message = extractErrorMessage(error).trim();

  // 🆕 仅对具有明确 HTTP 状态码的错误进行 HTTP 兜底格式化。
  // 若无状态码，则返回 undefined 让上层调用方（如 errorParsing）走其原本的错误格式化。
  if (status === undefined) {
    return undefined;
  }

  if (message) {
    return `[HTTP ${status}] ${message}`;
  }
  return `[HTTP ${status}]`;
}
