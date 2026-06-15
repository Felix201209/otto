/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Registry of external ACP-speaking agents that Otto can drive as an ACP
 * *client* (orchestrator). Today only Claude Code is wired up; `codex` is left
 * as a documented extension point so adding it later is a one-line change here
 * plus a tool/route that targets the new type.
 *
 * Claude Code does not speak ACP natively — we drive it through the community
 * `@agentclientprotocol/claude-agent-acp` bridge (backed by the official
 * `@anthropic-ai/claude-agent-sdk`), spawned on demand via `npx` (not
 * bundled), mirroring how {@link LarkCliTool} shells out to `lark-cli`. The
 * bridge reuses the user's local Claude Code credentials, which is exactly the
 * "drive the user's own local Claude Code" semantics we want.
 */

/** Stable identifiers for the external agents we can delegate to. */
export type ExternalAgentType = 'claude-code' | 'codex';

/** All external agent types in a stable order, useful for tests/iteration. */
export const EXTERNAL_AGENT_TYPES: readonly ExternalAgentType[] = [
  'claude-code',
  'codex',
] as const;

/** How to launch an external ACP agent over stdio. */
export interface ExternalAgentSpec {
  /** Stable id used by tools and Feishu routes. */
  readonly type: ExternalAgentType;
  /** Human-readable label for cards / CLI output. */
  readonly label: string;
  /** Executable to spawn. */
  readonly command: string;
  /** Arguments appended to {@link command}. */
  readonly args: readonly string[];
  /** Extra environment variables merged over `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Per-agent environment variable that overrides the spawn command. The value is
 * split on whitespace into `command` + `args`, e.g.
 *   EASYCODE_CLAUDE_CODE_ACP_CMD="node /abs/path/to/acp-bridge.js --flag"
 * This lets users point at a globally-installed bridge, a pinned version, or a
 * local build without code changes.
 */
const OVERRIDE_ENV: Record<ExternalAgentType, string> = {
  'claude-code': 'EASYCODE_CLAUDE_CODE_ACP_CMD',
  'codex': 'EASYCODE_CODEX_ACP_CMD',
};

const DEFAULT_SPECS: Record<ExternalAgentType, ExternalAgentSpec> = {
  'claude-code': {
    type: 'claude-code',
    label: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  'codex': {
    // Codex CLI does not speak ACP natively. We drive it through Zed
    // Industries' official adapter (github.com/zed-industries/codex-acp),
    // which spawns the user's locally-installed `codex` and exposes ACP
    // over stdio. Assumes the user has already authenticated via
    // `codex login` (or has CODEX_API_KEY / OPENAI_API_KEY in env).
    type: 'codex',
    label: 'Codex',
    command: 'npx',
    args: ['-y', '@zed-industries/codex-acp'],
  },
};

/** Whether the given string is a known external agent type. */
export function isExternalAgentType(value: string): value is ExternalAgentType {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SPECS, value);
}

/**
 * Resolve the launch spec for an external agent, applying any environment
 * override. `env` is injectable for testing.
 */
export function resolveExternalAgentSpec(
  type: ExternalAgentType,
  env: NodeJS.ProcessEnv = process.env,
): ExternalAgentSpec {
  const base = DEFAULT_SPECS[type];
  if (!base) {
    throw new Error(`Unknown external agent type: ${type}`);
  }

  const override = env[OVERRIDE_ENV[type]]?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    const [command, ...args] = parts;
    if (command) {
      return { ...base, command, args };
    }
  }

  return base;
}
