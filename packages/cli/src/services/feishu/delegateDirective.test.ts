/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseDelegatePrefix,
  parseResumeTask,
  resolveDelegation,
  buildDelegateDirective,
  parseBindAgentFlag,
  agentDisplayLabel,
  SESSION_RESUME_WINDOW_MS,
} from './delegateDirective.js';

describe('parseDelegatePrefix — Claude Code aliases', () => {
  it.each([
    ['@cc fix the bug', 'fix the bug'],
    ['/cc fix the bug', 'fix the bug'],
    ['@CC Fix It', 'Fix It'],
    ['/claude-code do x', 'do x'],
    ['@claudecode  do  y', 'do  y'],
    ['@cc: refactor', 'refactor'],
    ['@cc：重构一下', '重构一下'],
  ])('matches Claude prefix in %j → agent=claude-code', (input, task) => {
    const r = parseDelegatePrefix(input);
    expect(r.matched).toBe(true);
    expect(r.agent).toBe('claude-code');
    expect(r.task).toBe(task);
  });
});

describe('parseDelegatePrefix — Codex aliases', () => {
  it.each([
    ['@codex fix the bug', 'fix the bug'],
    ['/codex fix the bug', 'fix the bug'],
    ['@CODEX Fix It', 'Fix It'],
    ['@cdx  do  y', 'do  y'],
    ['@codex: refactor', 'refactor'],
    ['@codex：重构一下', '重构一下'],
  ])('matches Codex prefix in %j → agent=codex', (input, task) => {
    const r = parseDelegatePrefix(input);
    expect(r.matched).toBe(true);
    expect(r.agent).toBe('codex');
    expect(r.task).toBe(task);
  });
});

describe('parseDelegatePrefix — non-matches', () => {
  it('does not match a bare word or unrelated text', () => {
    expect(parseDelegatePrefix('ccc do x').matched).toBe(false);
    expect(parseDelegatePrefix('please fix').matched).toBe(false);
    expect(parseDelegatePrefix('account stuff').matched).toBe(false);
    expect(parseDelegatePrefix('codexish word').matched).toBe(false);
  });

  it('does not match codex mentioned in the middle of a sentence', () => {
    // Mid-message "@codex" or natural "让 codex 帮我" should go through the
    // LLM's tool-selection path, NOT the deterministic prefix path.
    expect(parseDelegatePrefix('你好，@codex给我把xx弄了').matched).toBe(false);
    expect(parseDelegatePrefix('去，让codex帮我把xx弄了').matched).toBe(false);
  });

  it('handles empty/undefined input', () => {
    expect(parseDelegatePrefix('').matched).toBe(false);
    // @ts-expect-error testing undefined robustness
    expect(parseDelegatePrefix(undefined).matched).toBe(false);
  });
});

describe('resolveDelegation', () => {
  it('Claude prefix wins regardless of default agent', () => {
    const r = resolveDelegation('@cc do x', 'self');
    expect(r).toMatchObject({ delegate: true, agent: 'claude-code', task: 'do x', reason: 'prefix' });
  });

  it('Codex prefix wins regardless of default agent', () => {
    const r = resolveDelegation('@codex do x', 'self');
    expect(r).toMatchObject({ delegate: true, agent: 'codex', task: 'do x', reason: 'prefix' });
  });

  it('Codex prefix wins even when default agent is claude-code', () => {
    const r = resolveDelegation('@codex refactor', 'claude-code');
    expect(r.agent).toBe('codex');
    expect(r.reason).toBe('prefix');
  });

  it('delegates to claude-code when chat default agent is claude-code', () => {
    const r = resolveDelegation('do x', 'claude-code');
    expect(r).toMatchObject({ delegate: true, agent: 'claude-code', task: 'do x', reason: 'route' });
  });

  it('delegates to codex when chat default agent is codex', () => {
    const r = resolveDelegation('do x', 'codex');
    expect(r).toMatchObject({ delegate: true, agent: 'codex', task: 'do x', reason: 'route' });
  });

  it('does not delegate by default', () => {
    const r = resolveDelegation('do x');
    expect(r.delegate).toBe(false);
    expect(r.reason).toBe('none');
  });

  it('does not delegate when default agent is self', () => {
    expect(resolveDelegation('do x', 'self').delegate).toBe(false);
  });
});

describe('buildDelegateDirective', () => {
  it('defaults to Claude Code + stream mode and names the tool', () => {
    const d = buildDelegateDirective('add tests');
    expect(d).toContain('delegate_to_agent');
    expect(d).toContain('add tests');
    expect(d).toContain('Claude Code');
    expect(d).toContain('agent="claude-code"');
    // Prefix/route triggers default to stream so the user sees live progress.
    expect(d).toContain('mode="stream"');
    expect(d).toContain('同步流式');
  });

  it('builds a Codex directive when agent="codex" (still stream by default)', () => {
    const d = buildDelegateDirective('write benchmark', 'codex');
    expect(d).toContain('delegate_to_agent');
    expect(d).toContain('write benchmark');
    expect(d).toContain('Codex');
    expect(d).not.toContain('Claude Code');
    expect(d).toContain('agent="codex"');
    expect(d).toContain('mode="stream"');
  });

  it('emits mode="background" when explicitly requested', () => {
    const d = buildDelegateDirective('big refactor', 'codex', 'background');
    expect(d).toContain('agent="codex"');
    expect(d).toContain('mode="background"');
    expect(d).toContain('后台异步');
    expect(d).not.toContain('同步流式');
  });

  it('claude-code + background combination renders correctly', () => {
    const d = buildDelegateDirective('do x', 'claude-code', 'background');
    expect(d).toContain('agent="claude-code"');
    expect(d).toContain('mode="background"');
  });

  it('includes resumeSessionId when resuming a session', () => {
    const d = buildDelegateDirective('继续', 'claude-code', 'stream', 'sess-9');
    expect(d).toContain('resumeSessionId="sess-9"');
    expect(d).toContain('续接');
    expect(d).toContain('继续');
  });
});

describe('parseResumeTask', () => {
  it('extracts the session id and remaining task from "resume <id> <task>"', () => {
    expect(parseResumeTask('resume sess-123 finish the tests')).toEqual({
      resumeSessionId: 'sess-123',
      task: 'finish the tests',
    });
  });

  it('is case-insensitive and tolerates extra spaces', () => {
    expect(parseResumeTask('RESUME   abc   do  x')).toEqual({
      resumeSessionId: 'abc',
      task: 'do  x',
    });
  });

  it('returns the task unchanged when there is no resume prefix', () => {
    expect(parseResumeTask('just do this')).toEqual({ task: 'just do this' });
  });

  it('allows an empty trailing task (resume with no follow-up)', () => {
    expect(parseResumeTask('resume sess-123')).toEqual({
      resumeSessionId: 'sess-123',
      task: '',
    });
  });
});

describe('resolveDelegation — resume sub-syntax', () => {
  it('parses "@cc:resume <id> <task>" into a resuming delegation', () => {
    const d = resolveDelegation('@cc:resume sess-123 继续把测试补全');
    expect(d.delegate).toBe(true);
    expect(d.agent).toBe('claude-code');
    expect(d.resumeSessionId).toBe('sess-123');
    expect(d.task).toBe('继续把测试补全');
  });

  it('parses resume on a routed chat (no prefix) too', () => {
    const d = resolveDelegation('resume cx-9 build it', 'codex');
    expect(d.delegate).toBe(true);
    expect(d.agent).toBe('codex');
    expect(d.resumeSessionId).toBe('cx-9');
    expect(d.task).toBe('build it');
  });

  it('leaves resumeSessionId undefined for a normal delegation', () => {
    const d = resolveDelegation('@codex write a benchmark');
    expect(d.resumeSessionId).toBeUndefined();
    expect(d.task).toBe('write a benchmark');
  });

  it('auto-resumes using lastSessionId when session is recent and chat is routed', () => {
    const recentTimestamp = Date.now() - 60_000; // 1 minute ago
    const d = resolveDelegation('do more stuff', 'claude-code', 'sess-auto-1', recentTimestamp);
    expect(d.delegate).toBe(true);
    expect(d.reason).toBe('route');
    expect(d.resumeSessionId).toBe('sess-auto-1');
    expect(d.task).toBe('do more stuff');
  });

  it('does NOT auto-resume when session is older than the time window', () => {
    const staleTimestamp = Date.now() - SESSION_RESUME_WINDOW_MS - 60_000; // 11 minutes ago
    const d = resolveDelegation('do more stuff', 'claude-code', 'sess-auto-1', staleTimestamp);
    expect(d.delegate).toBe(true);
    expect(d.reason).toBe('route');
    expect(d.resumeSessionId).toBeUndefined();
  });

  it('does NOT auto-resume when lastSessionAt is missing (legacy routes)', () => {
    const d = resolveDelegation('do more stuff', 'claude-code', 'sess-auto-1');
    expect(d.delegate).toBe(true);
    expect(d.reason).toBe('route');
    expect(d.resumeSessionId).toBeUndefined();
  });

  it('does NOT auto-resume when lastSessionId is missing', () => {
    const d = resolveDelegation('do more stuff', 'claude-code', undefined, Date.now());
    expect(d.delegate).toBe(true);
    expect(d.reason).toBe('route');
    expect(d.resumeSessionId).toBeUndefined();
  });

  it('explicit resume takes precedence over lastSessionId', () => {
    const d = resolveDelegation('resume explicit-id continue', 'codex', 'sess-auto-old', Date.now());
    expect(d.resumeSessionId).toBe('explicit-id');
  });

  it('explicit resume takes precedence even when lastSessionId is stale', () => {
    const staleTimestamp = Date.now() - SESSION_RESUME_WINDOW_MS - 60_000;
    const d = resolveDelegation('resume explicit-id continue', 'codex', 'sess-auto-old', staleTimestamp);
    expect(d.resumeSessionId).toBe('explicit-id');
  });

  it('lastSessionId is not used for prefix-based delegation (@cc)', () => {
    const d = resolveDelegation('@cc do something', 'self', 'sess-auto-1', Date.now());
    expect(d.reason).toBe('prefix');
    expect(d.resumeSessionId).toBeUndefined();
  });

  it('auto-resumes at the edge of the time window (just within)', () => {
    const edgeTimestamp = Date.now() - SESSION_RESUME_WINDOW_MS + 1000; // 1 second before expiry
    const d = resolveDelegation('continue work', 'claude-code', 'sess-edge', edgeTimestamp);
    expect(d.resumeSessionId).toBe('sess-edge');
  });

  it('does NOT auto-resume just past the time window', () => {
    const edgeTimestamp = Date.now() - SESSION_RESUME_WINDOW_MS - 1000; // 1 second past expiry
    const d = resolveDelegation('continue work', 'claude-code', 'sess-edge', edgeTimestamp);
    expect(d.resumeSessionId).toBeUndefined();
  });
});

describe('parseBindAgentFlag', () => {
  it('extracts --agent claude-code and leaves the path', () => {
    const r = parseBindAgentFlag('D:\\proj --agent claude-code');
    expect(r.agent).toBe('claude-code');
    expect(r.rest).toBe('D:\\proj');
  });

  it('extracts --agent codex and leaves the path', () => {
    const r = parseBindAgentFlag('D:\\proj --agent codex');
    expect(r.agent).toBe('codex');
    expect(r.rest).toBe('D:\\proj');
  });

  it('accepts the cdx alias for codex', () => {
    expect(parseBindAgentFlag('--agent cdx').agent).toBe('codex');
    expect(parseBindAgentFlag('--agent=cdx').agent).toBe('codex');
  });

  it('supports --agent=value forms for all agents', () => {
    expect(parseBindAgentFlag('--agent=cc').agent).toBe('claude-code');
    expect(parseBindAgentFlag('--agent=codex').agent).toBe('codex');
    expect(parseBindAgentFlag('/path -a self').agent).toBe('self');
  });

  it('returns undefined agent when flag absent', () => {
    const r = parseBindAgentFlag('D:\\proj');
    expect(r.agent).toBeUndefined();
    expect(r.rest).toBe('D:\\proj');
  });

  it('ignores invalid agent value but still consumes the value token', () => {
    const r = parseBindAgentFlag('D:\\proj --agent bogus');
    expect(r.agent).toBeUndefined();
    // The "bogus" value must NOT leak into the path argument.
    expect(r.rest).toBe('D:\\proj');
  });
});

describe('agentDisplayLabel', () => {
  it('labels claude-code distinctly from codex', () => {
    expect(agentDisplayLabel('claude-code')).toContain('Claude Code');
    expect(agentDisplayLabel('codex')).toContain('Codex');
    expect(agentDisplayLabel('codex')).not.toContain('Claude Code');
  });

  it('labels self/undefined as Otto', () => {
    expect(agentDisplayLabel('self')).toContain('Otto');
    expect(agentDisplayLabel(undefined)).toContain('Otto');
  });
});
