/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 本地 Token 估算工具（不依赖 API）
 *
 * 用于在请求 API 之前就能判断是否该压缩，避免等待 countTokens API 调用。
 *
 * 策略：
 *   - 中文字符 / 中文标点（CJK Unified, CJK Compatibility, Fullwidth）≈ 2 char/token
 *   - 其他字符 ≈ 4 char/token
 *   - 额外加 10% 安全缓冲，避免低估值导致实际超出
 */

import { Content } from '../types/extendedContent.js';

/**
 * 判断 Unicode 码点是否为 CJK 字符（中文、日文、韩文等）
 */
function isCJKChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||   // CJK Unified Ideographs
    (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||   // CJK Unified Ideographs Extension A
    (codePoint >= 0x20000 && codePoint <= 0x2A6DF) || // CJK Unified Ideographs Extension B
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (codePoint >= 0xFF00 && codePoint <= 0xFFEF) ||   // Halfwidth and Fullwidth Forms
    (codePoint >= 0x3000 && codePoint <= 0x303F) ||   // CJK Symbols and Punctuation
    (codePoint >= 0x2E80 && codePoint <= 0x2EFF) ||   // CJK Radicals Supplement
    (codePoint >= 0x31C0 && codePoint <= 0x31EF) ||   // CJK Strokes
    (codePoint >= 0xAC00 && codePoint <= 0xD7AF)      // Hangul Syllables
  );
}

/**
 * 估算一段文本的 token 数
 */
function estimateTextTokens(text: string): number {
  let cjkCount = 0;
  let otherCount = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isCJKChar(codePoint)) {
      cjkCount++;
    } else {
      otherCount++;
    }
  }

  // 中文 ~2 char/token, 英文 ~4 char/token
  return Math.ceil(cjkCount / 2) + Math.ceil(otherCount / 4);
}

/**
 * 序列化 Content 对象为文本，用于 token 估算
 */
function contentToText(content: Content): string {
  const parts: string[] = [];

  if (content.parts) {
    for (const part of content.parts) {
      const p = part as Record<string, unknown>;
      if (typeof p.text === 'string') {
        parts.push(p.text);
      } else if (p.functionCall) {
        parts.push(JSON.stringify(p.functionCall));
      } else if (p.functionResponse) {
        // 工具响应可能很大，取其首段做估算
        const functionResponse = p.functionResponse as { response?: unknown };
        const response = functionResponse.response;
        if (typeof response === 'string') {
          parts.push(response);
        } else if (response && typeof response === 'object') {
          const responseRecord = response as { output?: unknown; content?: unknown; result?: unknown };
          const output = responseRecord.output ?? responseRecord.content ?? responseRecord.result;
          if (typeof output === 'string') {
            // 只取前 500 字符做估算（太长的工具输出用上限估算）
            parts.push(output.substring(0, 500));
          } else if (output) {
            parts.push(JSON.stringify(output).substring(0, 500));
          }
        }
      } else if (p.toolResult) {
        const content = (p.toolResult as { content?: unknown })?.content;
        if (typeof content === 'string') {
          parts.push(content.substring(0, 500));
        } else if (content && typeof content === 'object') {
          parts.push(JSON.stringify(content).substring(0, 500));
        }
      }
    }
  }

  // 加入角色信息（少量开销）
  if (content.role) {
    parts.push(content.role);
  }

  return parts.join('\n');
}

/**
 * 估算对话历史的 token 总数
 *
 * @param history 对话历史
 * @param safetyFactor 安全因子，默认 1.1（多估 10%）
 * @returns 估算的 token 数量
 */
export function estimateHistoryTokens(
  history: Content[],
  safetyFactor: number = 1.1
): number {
  if (!history || history.length === 0) return 0;

  let totalTokens = 0;

  for (const content of history) {
    const text = contentToText(content);
    totalTokens += estimateTextTokens(text);
  }

  // 安全缓冲
  return Math.ceil(totalTokens * safetyFactor);
}

/**
 * 快速估算单个 Content 的 token 数
 */
export function estimateContentTokens(content: Content): number {
  const text = contentToText(content);
  return estimateTextTokens(text);
}

/**
 * 计算内容哈希（用于缓存判断）
 */
export function computeContentHash(content: Content): string {
  const text = contentToText(content);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * 计算历史列表的内容哈希
 */
export function computeHistoryHash(history: Content[]): string {
  // 只取最后 30 条消息做哈希（因为早期内容基本不变）
  const recentMessages = history.slice(-30);
  const fingerprints = recentMessages.map(c => computeContentHash(c));
  return fingerprints.join('_').substring(0, 64);
}
