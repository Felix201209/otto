/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectLocalAgents,
  buildLocalAgentWelcomeHints,
} from './localAgentDetection.js';

describe('detectLocalAgents', () => {
  it('reports both available when lookup resolves true for both', async () => {
    const result = await detectLocalAgents({
      lookup: async () => true,
    });
    expect(result).toEqual({ claudeCode: true, codex: true });
  });

  it('reports neither available when lookup resolves false', async () => {
    const result = await detectLocalAgents({
      lookup: async () => false,
    });
    expect(result).toEqual({ claudeCode: false, codex: false });
  });

  it('asks lookup exactly for "claude" and "codex"', async () => {
    const lookup = vi.fn(async (bin: string) => bin === 'claude');
    const result = await detectLocalAgents({ lookup });
    expect(lookup).toHaveBeenCalledTimes(2);
    const askedFor = lookup.mock.calls.map((c) => c[0]).sort();
    expect(askedFor).toEqual(['claude', 'codex']);
    expect(result).toEqual({ claudeCode: true, codex: false });
  });

  it('returns false (not throws) when lookup rejects for one binary', async () => {
    const lookup = async (bin: string) => {
      if (bin === 'claude') throw new Error('boom');
      return true;
    };
    const result = await detectLocalAgents({ lookup });
    expect(result).toEqual({ claudeCode: false, codex: true });
  });

  it('returns both false when lookup rejects for both', async () => {
    const lookup = async () => {
      throw new Error('PATH lookup binary missing');
    };
    const result = await detectLocalAgents({ lookup });
    expect(result).toEqual({ claudeCode: false, codex: false });
  });
});

describe('buildLocalAgentWelcomeHints', () => {
  it('returns an empty array when nothing is detected (no extra welcome noise)', () => {
    expect(buildLocalAgentWelcomeHints({ claudeCode: false, codex: false })).toEqual([]);
  });

  it('mentions only Claude Code when only Claude Code is available', () => {
    const lines = buildLocalAgentWelcomeHints({ claudeCode: true, codex: false });
    const text = lines.join('\n');
    expect(text).toContain('Claude Code');
    expect(text).not.toContain('Codex');
    expect(text).toContain('拉个 cc 群');
    expect(text).not.toContain('拉个 codex 群');
  });

  it('mentions only Codex when only Codex is available', () => {
    const lines = buildLocalAgentWelcomeHints({ claudeCode: false, codex: true });
    const text = lines.join('\n');
    expect(text).toContain('Codex');
    expect(text).not.toContain('Claude Code');
    expect(text).toContain('拉个 codex 群');
    expect(text).not.toContain('拉个 cc 群');
  });

  it('lists both agents when both are available', () => {
    const lines = buildLocalAgentWelcomeHints({ claudeCode: true, codex: true });
    const text = lines.join('\n');
    expect(text).toContain('Claude Code');
    expect(text).toContain('Codex');
    expect(text).toContain('拉个 cc 群');
    expect(text).toContain('拉个 codex 群');
  });
});
