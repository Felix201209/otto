/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  EXTERNAL_AGENT_TYPES,
  isExternalAgentType,
  resolveExternalAgentSpec,
} from './externalAgentRegistry.js';

describe('isExternalAgentType', () => {
  it('accepts every type listed in EXTERNAL_AGENT_TYPES', () => {
    for (const t of EXTERNAL_AGENT_TYPES) {
      expect(isExternalAgentType(t)).toBe(true);
    }
  });

  it('rejects unknown types', () => {
    expect(isExternalAgentType('claude')).toBe(false);
    expect(isExternalAgentType('cc')).toBe(false);
    expect(isExternalAgentType('gemini-cli')).toBe(false);
    expect(isExternalAgentType('')).toBe(false);
  });
});

describe('resolveExternalAgentSpec', () => {
  it('resolves claude-code to the claude-agent-acp npx bridge', () => {
    const spec = resolveExternalAgentSpec('claude-code', {});
    expect(spec.type).toBe('claude-code');
    expect(spec.label).toBe('Claude Code');
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp']);
  });

  it('resolves codex to the zed-industries codex-acp npx bridge', () => {
    const spec = resolveExternalAgentSpec('codex', {});
    expect(spec.type).toBe('codex');
    expect(spec.label).toBe('Codex');
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', '@zed-industries/codex-acp']);
  });

  it('applies EASYCODE_CLAUDE_CODE_ACP_CMD override (command + args, split on whitespace)', () => {
    const spec = resolveExternalAgentSpec('claude-code', {
      EASYCODE_CLAUDE_CODE_ACP_CMD: 'node /abs/path/to/bridge.js --flag value',
    });
    expect(spec.command).toBe('node');
    expect(spec.args).toEqual(['/abs/path/to/bridge.js', '--flag', 'value']);
    // Override does not change label/type.
    expect(spec.type).toBe('claude-code');
    expect(spec.label).toBe('Claude Code');
  });

  it('applies EASYCODE_CODEX_ACP_CMD override independently from claude-code', () => {
    const spec = resolveExternalAgentSpec('codex', {
      EASYCODE_CODEX_ACP_CMD: '/usr/local/bin/codex-acp',
      // Set the wrong agent's override too — must not bleed across.
      EASYCODE_CLAUDE_CODE_ACP_CMD: 'should-not-apply',
    });
    expect(spec.command).toBe('/usr/local/bin/codex-acp');
    expect(spec.args).toEqual([]);
    expect(spec.type).toBe('codex');
  });

  it('ignores a whitespace-only override and falls back to the default spec', () => {
    const spec = resolveExternalAgentSpec('codex', {
      EASYCODE_CODEX_ACP_CMD: '   \t  ',
    });
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['-y', '@zed-industries/codex-acp']);
  });

  it('throws for an unknown agent type', () => {
    expect(() =>
      resolveExternalAgentSpec('gemini-cli' as never, {}),
    ).toThrow(/Unknown external agent type/);
  });
});
