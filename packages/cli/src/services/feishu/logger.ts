/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Feishu module debug logger.
 *
 * The CLI runs an Ink TUI (full-screen React in the terminal). Anything
 * written to stdout outside of Ink's render path corrupts the layout, so
 * we cannot just `console.log` from the Feishu code paths.
 *
 * - `dlog` / `dwarn` / `derror` write to stderr ONLY when the env var
 *   `DEEPV_DEBUG_FEISHU` is truthy. This keeps Ink's stdout clean by
 *   default, while still allowing developers to opt in for diagnosis.
 * - User-facing status messages (success / error feedback) should go
 *   through the slash command return value or `tuiContext.addItem(...)`,
 *   NOT through this logger.
 */

const DEBUG_ENABLED = (() => {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return false;
  }
  const v = process.env['EASYCODE_DEBUG_FEISHU'] ?? process.env['DEEPV_DEBUG_FEISHU'];
  if (v !== undefined) {
    const lower = v.toLowerCase();
    return lower !== '0' && lower !== 'false' && lower !== 'no' && lower !== '';
  }
  return false; // 🚀 默认关闭所有原始 stderr 日志打印，防止破坏和滚动污染终端 TUI 布局。需要调试时可设置 EASYCODE_DEBUG_FEISHU=1 开启。
})();

function ts(): string {
  return new Date().toISOString();
}

export function dlog(...args: unknown[]): void {
  if (!DEBUG_ENABLED) return;
  // stderr keeps Ink stdout intact.
  process.stderr.write(`[feishu ${ts()}] ${args.map(String).join(' ')}\n`);
}

export function dwarn(...args: unknown[]): void {
  if (!DEBUG_ENABLED) return;
  process.stderr.write(`[feishu ${ts()}] WARN ${args.map(String).join(' ')}\n`);
}

export function derror(...args: unknown[]): void {
  // Errors are kept silent in production unless explicitly enabled — the
  // primary feedback channel for users is the TUI / Bot reply, not stderr.
  if (!DEBUG_ENABLED) return;
  process.stderr.write(`[feishu ${ts()}] ERROR ${args.map(String).join(' ')}\n`);
}

/** Exposed for tests. */
export function isFeishuDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}
