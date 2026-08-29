import { describe, expect, it, vi } from 'vitest';
import { EnterpriseSkillLibrary } from './enterpriseSkillLibrary.js';

const records = JSON.stringify([
  {
    skillName: 'Deploy', version: 2, featureDescription: 'Safe release',
    sharedBy: 'u1', sharedByName: 'Alice', teamId: 'engineering', teamName: '研发部',
    status: 'active', rating: 4.8, ratingCount: 3, installCount: 10,
    usageCount: 20, successCount: 18, publishedToMarketplace: true,
  },
  {
    skillName: 'Draft', sharedBy: 'u2', sharedByName: 'Bob', teamId: 'legal',
    status: 'active', publishedToMarketplace: false,
  },
]);

describe('EnterpriseSkillLibrary', () => {
  it('loads once for department, market and leaderboard queries while the file is unchanged', async () => {
    const readFile = vi.fn(async () => records);
    const library = new EnterpriseSkillLibrary('skills.json', {
      stat: vi.fn(async () => ({ mtimeMs: 10, size: records.length })),
      readFile,
    });

    expect((await library.listDepartment({ teamId: 'engineering' })).text).toContain('Deploy');
    expect((await library.listMarketplace()).text).toContain('Deploy');
    expect((await library.leaderboard({ teamId: 'engineering' })).leaderboard).toContain('研发部 Skill 排行榜');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('keeps department and company visibility independent', async () => {
    const library = new EnterpriseSkillLibrary('skills.json', {
      stat: async () => ({ mtimeMs: 10, size: records.length }),
      readFile: async () => records,
    });

    expect((await library.listDepartment({ teamId: 'legal' })).text).toContain('Draft');
    expect((await library.listDepartment({ teamId: 'legal' })).text).not.toContain('Deploy');
    expect((await library.listMarketplace()).text).not.toContain('Draft');
  });

  it('returns stable empty states when storage is unavailable', async () => {
    const library = new EnterpriseSkillLibrary('missing.json', {
      stat: async () => { throw new Error('missing'); },
      readFile: async () => { throw new Error('missing'); },
    });
    await expect(library.listDepartment()).resolves.toEqual({ text: '本部门暂无共享 Skill。' });
  });

  it('fails closed without an authenticated department scope', async () => {
    const readFile = vi.fn(async () => records);
    const library = new EnterpriseSkillLibrary('skills.json', {
      stat: vi.fn(async () => ({ mtimeMs: 10, ctimeMs: 10, size: records.length, ino: 1 })),
      readFile,
    });

    await expect(library.listDepartment({ teamId: 'other-team' })).resolves.toEqual({
      text: '本部门暂无共享 Skill。',
    });
    await expect(library.leaderboard(null)).resolves.toMatchObject({
      leaderboard: '本部门暂无可用的 Skill 排行榜。',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('normalizes malformed records individually and never throws on bad metrics', async () => {
    const readFile = vi.fn(async () => JSON.stringify([
      null,
      { skillName: 'Safe', teamId: 'engineering', status: 'active', rating: 'bad', installCount: NaN },
      { skillName: 'Broken', teamId: 'engineering', status: 'active', rating: {} },
    ]));
    const library = new EnterpriseSkillLibrary('skills.json', {
      stat: vi.fn(async () => ({ mtimeMs: 10, ctimeMs: 10, size: 1, ino: 1 })),
      readFile,
    });

    await expect(library.listDepartment({ teamId: 'engineering' })).resolves.toMatchObject({
      text: expect.stringContaining('Safe'),
    });
    await expect(library.leaderboard({ teamId: 'engineering' })).resolves.toMatchObject({
      leaderboard: expect.stringContaining('Broken'),
    });
  });

  it('reloads when ctime changes even if mtime and size do not', async () => {
    const readFile = vi.fn()
      .mockResolvedValueOnce(records)
      .mockResolvedValueOnce(JSON.stringify([{
        skillName: 'Changed', teamId: 'engineering', status: 'active',
      }]));
    const stat = vi.fn()
      .mockResolvedValueOnce({ mtimeMs: 10, ctimeMs: 10, size: records.length, ino: 1 })
      .mockResolvedValueOnce({ mtimeMs: 10, ctimeMs: 11, size: records.length, ino: 1 });
    const library = new EnterpriseSkillLibrary('skills.json', { stat, readFile });

    await expect(library.listDepartment({ teamId: 'engineering' })).resolves.toMatchObject({
      text: expect.stringContaining('Deploy'),
    });
    await expect(library.listDepartment({ teamId: 'engineering' })).resolves.toMatchObject({
      text: expect.stringContaining('Changed'),
    });
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
