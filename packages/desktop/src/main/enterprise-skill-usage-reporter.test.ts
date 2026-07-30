/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseSkillUsageReporter } from './enterprise-skill-usage-reporter.js';

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  skills: string;
  usage: string;
  state: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-skill-market-usage-'));
  roots.push(root);
  const skills = path.join(root, 'skills');
  const marketSkill = path.join(skills, 'market-skill-1');
  await fs.mkdir(marketSkill, { recursive: true });
  await fs.writeFile(path.join(marketSkill, '.otto-market.json'), JSON.stringify({
    skillId: 'skill-1',
    skillName: 'monthly-report',
    version: 1,
  }));
  return {
    root,
    skills,
    usage: path.join(root, 'skill_usage.jsonl'),
    state: path.join(root, 'state.json'),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('EnterpriseSkillUsageReporter', () => {
  it('reports only installed market Skills and does not upload an event twice', async () => {
    const files = await fixture();
    await fs.writeFile(files.usage, [
      JSON.stringify({ skillName: 'market-skill-1', success: true, errorMessage: 'private output' }),
      JSON.stringify({ skillName: 'unshared-local-skill', success: false }),
    ].join('\n'));
    const report = vi.fn().mockResolvedValue(undefined);
    const reporter = new EnterpriseSkillUsageReporter({
      skillsRoot: () => files.skills,
      usageFile: () => files.usage,
      stateFile: () => files.state,
      identity: () => ({ serverUrl: 'https://enterprise.example.test', accountId: 'account-1' }),
      report,
    });

    await expect(reporter.poll()).resolves.toBe(1);
    await expect(reporter.poll()).resolves.toBe(0);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('skill-1', true, expect.stringMatching(/^[a-f0-9]{64}$/u));
    expect(JSON.stringify(report.mock.calls)).not.toContain('private output');
  });

  it('keeps failed reports pending and isolates delivery state by account', async () => {
    const files = await fixture();
    await fs.writeFile(files.usage, `${JSON.stringify({ skillName: 'monthly-report', success: false })}\n`);
    let accountId = 'account-1';
    const report = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const reporter = new EnterpriseSkillUsageReporter({
      skillsRoot: () => files.skills,
      usageFile: () => files.usage,
      stateFile: () => files.state,
      identity: () => ({ serverUrl: 'https://enterprise.example.test', accountId }),
      report,
    });

    await expect(reporter.poll()).resolves.toBe(0);
    await expect(reporter.poll()).resolves.toBe(1);
    accountId = 'account-2';
    await expect(reporter.poll()).resolves.toBe(1);
    expect(report).toHaveBeenCalledTimes(3);
    expect(report.mock.calls[1]?.[2]).not.toBe(report.mock.calls[2]?.[2]);
  });
});
