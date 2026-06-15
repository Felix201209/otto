/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书工具卡片显示辅助 —— 代码框体积裁剪。
 *
 * 背景：飞书单张卡片数据容量约 30KB（feishuCommand 内安全阈值 8500 字符）。
 * 工具调用报告（formatToolCallWithBorder）会把工具的结果/diff/写入内容渲染成
 * Markdown 代码框。若不加限制：
 *   - 一个大 replace 把完整 diff 全量渲染 → 单个工具块就上千甚至上万字符；
 *   - 一个 write_file 即便只取前 15 行，单行若极长（压缩 JSON、长字符串）
 *     仍能撑爆整卡 → 被迫触发分页，可读性骤降。
 *
 * 因此对任意代码框内容施加「行数 + 字符数」双重上限，超限保留头部并提示省略。
 */

export interface ClampOptions {
  /** 最多保留的行数。超出则只保留前 maxLines 行。 */
  maxLines?: number;
  /** 最多保留的字符数（行裁剪后再做硬截断兜底）。 */
  maxChars?: number;
}

export interface ClampResult {
  /** 裁剪后的正文（不含外层 ``` 代码框，由调用方包裹）。 */
  text: string;
  /** 是否发生了裁剪。 */
  truncated: boolean;
  /** 因行数上限被省略的行数（仅行裁剪触发时 > 0）。 */
  omittedLines: number;
}

/** 默认上限：与 feishuCommand 既有 maxLinesToShow=15 对齐，字符上限给单块留足余量。 */
const DEFAULT_MAX_LINES = 15;
const DEFAULT_MAX_CHARS = 2000;

/**
 * 对代码框内容施加行数 + 字符数双重上限。
 *
 * 处理顺序：
 *   1) 先按行数裁剪：超过 maxLines 只留前 maxLines 行，记录省略行数；
 *   2) 再按字符数硬截断：行裁剪后的结果若仍超过 maxChars，截断到 maxChars；
 *   3) 任一裁剪发生都会在末尾追加一行人类可读的省略提示。
 */
export function clampCodeBlock(
  content: string,
  options: ClampOptions = {},
): ClampResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  if (!content) {
    return { text: '', truncated: false, omittedLines: 0 };
  }

  let truncated = false;
  let omittedLines = 0;

  // 1) 行数裁剪
  const lines = content.split('\n');
  let working = content;
  if (lines.length > maxLines) {
    omittedLines = lines.length - maxLines;
    working = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }

  // 2) 字符数硬截断（行裁剪后仍可能因单行超长而爆量）
  let charTruncated = false;
  if (working.length > maxChars) {
    working = working.slice(0, maxChars);
    charTruncated = true;
    truncated = true;
  }

  // 3) 省略提示
  if (truncated) {
    const hintParts: string[] = [];
    if (omittedLines > 0) {
      hintParts.push(`还有 ${omittedLines} 行`);
    }
    if (charTruncated) {
      hintParts.push('内容过长已截断');
    }
    const hint = hintParts.length > 0 ? hintParts.join('，') : '内容已截断';
    working = `${working}\n… (${hint})`;
  }

  return { text: working, truncated, omittedLines };
}
