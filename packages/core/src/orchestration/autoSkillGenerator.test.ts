/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import type { WorkLogEntry } from './workLog.js';
import { LocalKnowledgeStore } from '../knowledge/localKnowledgeStore.js';

const workLogMock = vi.hoisted(() => ({
  readDateRange: vi.fn(),
  log: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./workLog.js', () => ({
  getWorkLogger: () => workLogMock,
}));

import {
  confirmAndSaveSkill,
  confirmPendingSkill,
  generateSkillCandidates,
  listPendingSkillCandidates,
  rejectPendingSkill,
  resolveAutoSkillSkillsDir,
  scanAndStageSkillCandidates,
  startAutoSkillScanner,
  stopAutoSkillScanner,
} from './autoSkillGenerator.js';

const tempDirs: string[] = [];
const fakeConfig = {} as Config;
let previousUserDir: string | undefined;

function configWithModel() {
  const sendMessage = vi.fn().mockResolvedValue({
    candidates: [
      { content: { parts: [{ text: '{"skills":[]}' }] } },
    ],
  });
  const createTemporaryChat = vi.fn().mockResolvedValue({ sendMessage });
  const config = {
    getOttoClient: () => ({ createTemporaryChat }),
    getTargetDir: () => undefined,
  } as unknown as Config;
  return { config, createTemporaryChat };
}

function entry(action: string, day: number): WorkLogEntry {
  return {
    timestamp: `2026-07-${String(day).padStart(2, '0')}T09:00:00.000Z`,
    toolName: action,
    action,
    category: 'document',
    success: true,
  };
}

function repeatedPatternLogs(): Record<string, WorkLogEntry[]> {
  return {
    '2026-07-08': [entry('整理访谈记录', 8), entry('生成会议纪要', 8)],
    '2026-07-09': [entry('整理访谈记录', 9), entry('生成会议纪要', 9)],
    '2026-07-10': [entry('整理访谈记录', 10), entry('生成会议纪要', 10)],
  };
}

function workResult(title: string, day: number, userInput: string): WorkLogEntry {
  return {
    timestamp: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    toolName: 'otto_work_result',
    action: title,
    category: 'document',
    success: true,
    entryType: 'work_result',
    taskTitle: title,
    userInput,
    details: `已完成 ${title}`,
  };
}

function repeatedWorkResultLogs(): Record<string, WorkLogEntry[]> {
  return {
    '2026-07-08': [workResult('品牌营销方案', 8, '帮我写一个新品品牌营销方案')],
    '2026-07-09': [workResult('品牌营销方案', 9, '继续做一份品牌营销文案方案')],
    '2026-07-10': [workResult('品牌营销方案', 10, '给活动生成品牌营销落地页文案')],
  };
}

beforeEach(async () => {
  previousUserDir = process.env['OTTO_USER_DIR'];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-auto-skill-'));
  tempDirs.push(root);
  process.env['OTTO_USER_DIR'] = root;
  workLogMock.readDateRange.mockReset().mockResolvedValue(repeatedPatternLogs());
  workLogMock.log.mockClear();
});

afterEach(async () => {
  await stopAutoSkillScanner();
  vi.useRealTimers();
  if (previousUserDir === undefined) delete process.env['OTTO_USER_DIR'];
  else process.env['OTTO_USER_DIR'] = previousUserDir;
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('AutoSkillGenerator 个人 Skill 候选闭环', () => {
  it('候选默认指向用户级 ~/.otto-user/skills，而不是当前项目', async () => {
    const candidates = await generateSkillCandidates(fakeConfig);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].filePath).toBe(
      path.join(resolveAutoSkillSkillsDir(), candidates[0].name, 'SKILL.md'),
    );
    expect(candidates[0].filePath).not.toContain(path.join('.otto', 'skills'));
    await expect(fs.access(candidates[0].filePath)).rejects.toThrow();
  });

  it('只有最终业务成果重复时，也会生成业务流程型 Skill 候选', async () => {
    workLogMock.readDateRange.mockResolvedValueOnce(repeatedWorkResultLogs());

    const candidates = await generateSkillCandidates(fakeConfig);

    const candidate = candidates.find((item) => item.name === 'auto-copywriting');
    expect(candidate).toBeDefined();
    expect(candidate?.skillContent).toContain('业务交付流程');
    expect(candidate?.skillContent).toContain('已观察到的典型需求');
  });

  it('把同类成果的真实失败吸收到边界说明，而不是伪造百分百成功', async () => {
    const logs = repeatedWorkResultLogs();
    logs['2026-07-10'].push({
      ...workResult('品牌营销方案', 10, '生成品牌营销方案'),
      success: false,
      details: '缺少品牌色导致交付返工',
    });
    workLogMock.readDateRange.mockResolvedValueOnce(logs);

    const candidates = await generateSkillCandidates(fakeConfig);

    const candidate = candidates.find((item) => item.name === 'auto-copywriting');
    expect(candidate?.failureLessons).toContain('缺少品牌色导致交付返工');
    expect(candidate?.skillContent).toContain('缺少品牌色导致交付返工');
    expect(candidate?.evidence?.join('\n')).toContain('成功率 75%');
  });

  it('使用跨会话稳定个人知识增强 Skill 的步骤依据', async () => {
    workLogMock.readDateRange.mockResolvedValueOnce(repeatedWorkResultLogs());
    const store = new LocalKnowledgeStore();
    await store.add(
      'copywriting',
      '品牌营销方案交付前必须核对品牌色、受众和统计周期',
      ['品牌营销'],
      'brand-check',
      0.95,
      'session-a',
    );
    await store.reinforceByFingerprint('brand-check', { sourceSessionId: 'session-b' });

    const candidates = await generateSkillCandidates(fakeConfig);
    const candidate = candidates.find((item) => item.name === 'auto-copywriting');

    expect(candidate?.knowledgeEvidence).toHaveLength(1);
    expect(candidate?.evidence?.join('\n')).toContain('个人知识证据');
  });

  it('确认增强已有 Skill 时保留旧版本并写入证据签名', async () => {
    const skillDir = path.join(resolveAutoSkillSkillsDir(), 'auto-copywriting');
    const skillPath = path.join(skillDir, 'SKILL.md');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillPath, [
      '---',
      'name: auto-copywriting',
      'description: 品牌营销方案流程',
      '---',
      '# 旧版品牌营销流程',
    ].join('\n'));
    const logs = repeatedWorkResultLogs();
    logs['2026-07-10'].push({
      ...workResult('品牌营销方案', 10, '生成品牌营销方案'),
      success: false,
      details: '品牌色缺失导致返工',
    });
    workLogMock.readDateRange.mockResolvedValueOnce(logs);

    const candidate = (await generateSkillCandidates(fakeConfig))
      .find((item) => item.targetSkillName === 'auto-copywriting');
    expect(candidate?.recommendation).toBe('enhance');
    await confirmAndSaveSkill(candidate!);

    expect(await fs.readFile(skillPath, 'utf8')).toContain('otto-auto-skill-evidence:');
    expect(await fs.readdir(path.join(skillDir, 'history'))).toHaveLength(1);
  });

  it('扫描只暂存候选，用户明确确认后才写 SKILL.md', async () => {
    const staged = await scanAndStageSkillCandidates(fakeConfig, () => 'user-1');

    expect(staged).toHaveLength(1);
    await expect(fs.access(staged[0].filePath)).rejects.toThrow();
    expect(await listPendingSkillCandidates()).toHaveLength(1);

    const savedPath = await confirmPendingSkill(staged[0].id);
    expect(savedPath).toBe(staged[0].filePath);
    await expect(fs.readFile(savedPath, 'utf8')).resolves.toContain(
      '此 Skill 由 Otto 从你的工作日志中自动发现并生成',
    );
    expect(await listPendingSkillCandidates()).toEqual([]);
  });

  it('stores portable pending paths and rehydrates them on another device', async () => {
    const sourceRoot = process.env['OTTO_USER_DIR']!;
    const [candidate] = await scanAndStageSkillCandidates(fakeConfig, () => 'user-1');
    const sourcePendingPath = path.join(
      sourceRoot,
      'memory',
      'worklog',
      'pending_skills.json',
    );
    const stored = JSON.parse(await fs.readFile(sourcePendingPath, 'utf8')) as Array<{
      filePath: string;
    }>;
    expect(stored[0].filePath).toBe(`${candidate.name}/SKILL.md`);

    const restoredRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-auto-skill-restored-'));
    tempDirs.push(restoredRoot);
    const restoredPendingPath = path.join(
      restoredRoot,
      'memory',
      'worklog',
      'pending_skills.json',
    );
    await fs.mkdir(path.dirname(restoredPendingPath), { recursive: true });
    await fs.copyFile(sourcePendingPath, restoredPendingPath);
    process.env['OTTO_USER_DIR'] = restoredRoot;

    const [restored] = await listPendingSkillCandidates();
    const expectedPath = path.join(restoredRoot, 'skills', candidate.name, 'SKILL.md');
    expect(restored.filePath).toBe(expectedPath);
    await expect(confirmPendingSkill(restored.id)).resolves.toBe(expectedPath);
    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toContain(`name: ${candidate.name}`);
  });

  it('用户拒绝后移出待确认区，并且后续扫描不会重复推荐', async () => {
    const [candidate] = await scanAndStageSkillCandidates(fakeConfig, () => 'user-1');

    await rejectPendingSkill(candidate.id);

    expect(await listPendingSkillCandidates()).toEqual([]);
    expect(await generateSkillCandidates(fakeConfig)).toEqual([]);
  });

  it('已经确认生成的 Skill 不会再次进入候选区', async () => {
    const [candidate] = await scanAndStageSkillCandidates(fakeConfig, () => 'user-1');
    await confirmPendingSkill(candidate.id);

    expect(await generateSkillCandidates(fakeConfig)).toEqual([]);
  });

  it('即使候选数据被篡改，也不能把 Skill 写到用户 skills 目录之外', async () => {
    const [candidate] = await generateSkillCandidates(fakeConfig);
    const outsidePath = path.join(process.env['OTTO_USER_DIR']!, 'outside.md');

    await expect(
      confirmAndSaveSkill({ ...candidate, filePath: outsidePath }),
    ).rejects.toThrow('只能写入用户级 skills 目录');
    await expect(fs.access(outsidePath)).rejects.toThrow();
  });

  it('后台扫描完成后通知桌面刷新候选，但仍不自动安装', async () => {
    let resolveStaged!: (candidates: Awaited<ReturnType<typeof listPendingSkillCandidates>>) => void;
    const stagedPromise = new Promise<Awaited<ReturnType<typeof listPendingSkillCandidates>>>(
      (resolve) => { resolveStaged = resolve; },
    );
    const onCandidatesStaged = vi.fn((candidates) => resolveStaged(candidates));
    startAutoSkillScanner(fakeConfig, () => 'user-1', {
      initialDelayMs: 1,
      intervalMs: 60_000,
      onCandidatesStaged,
    });

    const candidates = await stagedPromise;
    expect(onCandidatesStaged).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1);
    await expect(fs.access(candidates[0].filePath)).rejects.toThrow();
  });

  it('后台定时扫描默认不调用模型，手动立即分析仍可调用模型', async () => {
    vi.useFakeTimers();
    const { config, createTemporaryChat } = configWithModel();

    startAutoSkillScanner(config, () => 'user-1', {
      initialDelayMs: 1,
      intervalMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(1);
    await stopAutoSkillScanner();
    expect(createTemporaryChat).not.toHaveBeenCalled();

    await scanAndStageSkillCandidates(config, () => 'user-1');
    expect(createTemporaryChat).toHaveBeenCalledTimes(1);
  });

  it('显式 opt-in 后同一批日志只调用模型一次，重启 scanner 也不重复', async () => {
    vi.useFakeTimers();
    const { config, createTemporaryChat } = configWithModel();

    startAutoSkillScanner(config, () => 'user-1', {
      initialDelayMs: 1,
      intervalMs: 100,
      enableBackgroundModelAnalysis: true,
    });
    await vi.advanceTimersByTimeAsync(101);
    await stopAutoSkillScanner();
    expect(createTemporaryChat).toHaveBeenCalledTimes(1);

    startAutoSkillScanner(config, () => 'user-1', {
      initialDelayMs: 1,
      intervalMs: 100,
      enableBackgroundModelAnalysis: true,
    });
    await vi.advanceTimersByTimeAsync(1);
    await stopAutoSkillScanner();
    expect(createTemporaryChat).toHaveBeenCalledTimes(1);
  });

  it('停止 scanner 会取消尚未开始的后台扫描', async () => {
    vi.useFakeTimers();
    startAutoSkillScanner(fakeConfig, () => 'user-1', {
      initialDelayMs: 50,
      intervalMs: 60_000,
    });

    await stopAutoSkillScanner();
    await vi.advanceTimersByTimeAsync(100);

    expect(workLogMock.readDateRange).not.toHaveBeenCalled();
  });

  it('停止后丢弃尚未结束的扫描结果，不写候选也不通知', async () => {
    vi.useFakeTimers();
    let resolveLogs!: (logs: Record<string, WorkLogEntry[]>) => void;
    workLogMock.readDateRange.mockImplementationOnce(
      () => new Promise((resolve) => { resolveLogs = resolve; }),
    );
    const onCandidatesStaged = vi.fn();
    startAutoSkillScanner(fakeConfig, () => 'user-1', {
      initialDelayMs: 1,
      intervalMs: 60_000,
      onCandidatesStaged,
    });
    await vi.advanceTimersByTimeAsync(1);

    const stopping = stopAutoSkillScanner();
    resolveLogs(repeatedPatternLogs());
    await stopping;
    await vi.runAllTimersAsync();

    expect(onCandidatesStaged).not.toHaveBeenCalled();
    expect(await listPendingSkillCandidates()).toEqual([]);
  });
});
