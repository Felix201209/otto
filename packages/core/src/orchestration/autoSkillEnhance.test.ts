/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  flushSkillUsageWrites,
  getSkillStats,
  recordSkillUsage,
} from './autoSkillEnhance.js';

let previousUserDir: string | undefined;
let userDir = '';

beforeEach(async () => {
  previousUserDir = process.env['OTTO_USER_DIR'];
  userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-skill-usage-'));
  process.env['OTTO_USER_DIR'] = userDir;
});

afterEach(async () => {
  await flushSkillUsageWrites();
  if (previousUserDir === undefined) delete process.env['OTTO_USER_DIR'];
  else process.env['OTTO_USER_DIR'] = previousUserDir;
  await fs.rm(userDir, { recursive: true, force: true });
});

describe('AutoSkill usage feedback', () => {
  it('persists real activations without leaking full paths or credentials', async () => {
    recordSkillUsage({
      skillName: 'auto-brand-report',
      timestamp: '2026-07-30T09:00:00.000Z',
      success: true,
      durationMs: 124.8,
      toolCalls: 1,
      projectDir: path.join(userDir, 'customer-a'),
    });
    recordSkillUsage({
      skillName: 'auto-brand-report',
      timestamp: '2026-07-30T09:05:00.000Z',
      success: false,
      durationMs: 80,
      toolCalls: 1,
      errorMessage: 'api_key=secretsecret cannot load',
      projectDir: path.join(userDir, 'customer-a'),
    });
    await flushSkillUsageWrites();

    const stats = getSkillStats('auto-brand-report');
    expect(stats.totalUses).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(stats.topErrors[0]).toContain('[REDACTED]');

    const usagePath = path.join(userDir, 'memory', 'worklog', 'skill_usage.jsonl');
    const persisted = await fs.readFile(usagePath, 'utf8');
    expect(persisted).toContain('"projectDir":"customer-a"');
    expect(persisted).not.toContain(userDir);
    expect(persisted).not.toContain('secretsecret');
  });

  it('reloads persisted history when the account data root changes', async () => {
    const firstDir = userDir;
    recordSkillUsage({
      skillName: 'auto-first',
      timestamp: '2026-07-30T09:00:00.000Z',
      success: true,
      durationMs: 10,
      toolCalls: 1,
    });
    await flushSkillUsageWrites();

    const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-skill-usage-'));
    userDir = secondDir;
    process.env['OTTO_USER_DIR'] = secondDir;
    expect(getSkillStats('auto-first').totalUses).toBe(0);

    process.env['OTTO_USER_DIR'] = firstDir;
    expect(getSkillStats('auto-first').totalUses).toBe(1);
    userDir = firstDir;
    await fs.rm(secondDir, { recursive: true, force: true });
  });

  it('compacts persisted history to the most recent 500 activations', async () => {
    for (let index = 0; index < 501; index += 1) {
      recordSkillUsage({
        skillName: 'auto-bounded-history',
        timestamp: new Date(Date.UTC(2026, 6, 30, 0, index)).toISOString(),
        success: true,
        durationMs: index,
        toolCalls: 1,
      });
    }
    await flushSkillUsageWrites();

    expect(getSkillStats('auto-bounded-history').totalUses).toBe(500);
    const usagePath = path.join(userDir, 'memory', 'worklog', 'skill_usage.jsonl');
    const lines = (await fs.readFile(usagePath, 'utf8')).trim().split(/\r?\n/u);
    expect(lines).toHaveLength(500);
    expect(lines[0]).toContain('"durationMs":1');
  });
});
