/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detect whether `claude` (Claude Code) and/or `codex` (OpenAI Codex CLI) are
 * installed on the user's machine and resolvable on PATH. Used to enrich the
 * Feishu DM welcome message with extra hints about how to spin up an agent-
 * specific project group ("拉个 cc 群 / 拉个 codex 群").
 *
 * The check shells out to `where` (Windows) or `which` (POSIX). Failures of
 * any kind (missing binary, timeout, permission error) are interpreted as
 * "not available" — we never let detection failure crash the welcome flow.
 *
 * The `lookup` dependency is injectable so tests can drive the function
 * without spawning real processes.
 */

import { execFile } from 'node:child_process';

/** Result of probing the user's machine for known local coding agents. */
export interface LocalAgentAvailability {
  /** True when `claude` resolves on PATH. */
  claudeCode: boolean;
  /** True when `codex` resolves on PATH. */
  codex: boolean;
}

export interface DetectLocalAgentsDeps {
  /**
   * Bin lookup function. Returns true iff the named binary is found on PATH.
   * Defaults to a spawn-based implementation using `where`/`which`.
   * Tests should inject a fake.
   */
  lookup?: (bin: string) => Promise<boolean>;
}

/** Bins we care about, in the registry order. */
const BINS = {
  claudeCode: 'claude',
  codex: 'codex',
} as const;

/**
 * Probe for the local presence of Claude Code and Codex CLI. Always resolves
 * — never throws — even if the platform lookup tool is missing.
 */
export async function detectLocalAgents(
  deps: DetectLocalAgentsDeps = {},
): Promise<LocalAgentAvailability> {
  const lookup = deps.lookup ?? defaultLookup;
  // Run in parallel; any per-bin failure resolves to `false`.
  const [claudeCode, codex] = await Promise.all([
    safeLookup(lookup, BINS.claudeCode),
    safeLookup(lookup, BINS.codex),
  ]);
  return { claudeCode, codex };
}

async function safeLookup(
  lookup: (bin: string) => Promise<boolean>,
  bin: string,
): Promise<boolean> {
  try {
    return await lookup(bin);
  } catch {
    return false;
  }
}

/**
 * Default lookup: spawns `where <bin>` on Windows or `which <bin>` on POSIX
 * and treats a 0 exit code as "found". A 1500ms timeout caps how long the
 * welcome handshake can be delayed by a slow PATH scan.
 */
async function defaultLookup(bin: string): Promise<boolean> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(
      cmd,
      [bin],
      { timeout: 1500, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(typeof stdout === 'string' && stdout.trim().length > 0);
      },
    );
  });
}

/**
 * Build the welcome-message lines describing how to spin up an agent-specific
 * project group, given the detected agents. Returns an empty array if neither
 * agent is available.
 *
 * Example output when both are installed:
 *   - "💡 检测到您本机已安装 **Claude Code** 与 **Codex**，您可以发送："
 *   - "   拉个 cc 群 D:\\projects\\my-app  （绑定本机 Claude Code）"
 *   - "   拉个 codex 群 D:\\projects\\my-app  （绑定本机 Codex）"
 */
export function buildLocalAgentWelcomeHints(
  availability: LocalAgentAvailability,
): string[] {
  const lines: string[] = [];
  if (!availability.claudeCode && !availability.codex) {
    return lines;
  }

  const detected: string[] = [];
  if (availability.claudeCode) detected.push('[Claude Code]');
  if (availability.codex) detected.push('[Codex]');
  lines.push(
    `💡 检测到您本机已安装 ${detected.join('、')}，您还可以发送以下命令拉一个绑定该 agent 的专属群：`,
  );
  if (availability.claudeCode) {
    lines.push(
      '   拉个 cc 群 + 路径  （例如：「拉个 cc 群 D:\\projects\\my-app，绑定本机 Claude Code」）',
    );
  }
  if (availability.codex) {
    lines.push(
      '   拉个 codex 群 + 路径  （例如：「拉个 codex 群 D:\\projects\\my-app，绑定本机 Codex」）',
    );
  }
  return lines;
}
