/**
 * Read-only enterprise Skill catalog for the desktop shell.
 *
 * The renderer and IPC layer only consume these query methods. File layout,
 * caching, schema normalization, filtering, scoring and presentation stay
 * isolated here. A department scope is trusted only when supplied by the
 * authenticated main-process account.
 */

import { promises as fs } from 'node:fs';

export interface EnterpriseSkillRecord {
  skillName?: string;
  version?: number;
  featureDescription?: string;
  sharedBy?: string;
  sharedByName?: string;
  teamId?: string;
  teamName?: string;
  status?: string;
  note?: string;
  rating?: number;
  ratingCount?: number;
  installCount?: number;
  usageCount?: number;
  successCount?: number;
  publishedToMarketplace?: boolean;
}

/** Derived by the main process from the authenticated enterprise account. */
export interface EnterpriseSkillScope {
  teamId: string;
}

interface SkillLibraryFileAccess {
  stat(path: string): Promise<{
    mtimeMs: number;
    size: number;
    ctimeMs?: number;
    ino?: number;
  }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

export interface EnterpriseSkillLeaderboard {
  leaderboard: string;
  starBoard: string;
  tabs: Array<{ id: 'leaderboard' | 'stars'; label: string; icon: string }>;
}

const tabs: EnterpriseSkillLeaderboard['tabs'] = [
  { id: 'leaderboard', label: '排行榜', icon: '' },
  { id: 'stars', label: '明星榜', icon: '' },
];

const EMPTY_DEPARTMENT_TEXT = '本部门暂无共享 Skill。';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function normalizeRecord(value: unknown): EnterpriseSkillRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const skillName = text(raw.skillName);
  if (!skillName) return null;
  const version = finiteNumber(raw.version, 1);
  const featureDescription = text(raw.featureDescription);
  const sharedBy = text(raw.sharedBy);
  const sharedByName = text(raw.sharedByName);
  const teamId = text(raw.teamId);
  const teamName = text(raw.teamName);
  const status = text(raw.status);
  const note = text(raw.note);
  const ratingValue = finiteNumber(raw.rating, 0, 5);
  const ratingCount = finiteNumber(raw.ratingCount);
  const installCount = finiteNumber(raw.installCount);
  const usageCount = finiteNumber(raw.usageCount);
  const successCount = finiteNumber(raw.successCount);
  return {
    skillName,
    ...(version !== undefined ? { version } : {}),
    ...(featureDescription ? { featureDescription } : {}),
    ...(sharedBy ? { sharedBy } : {}),
    ...(sharedByName ? { sharedByName } : {}),
    ...(teamId ? { teamId } : {}),
    ...(teamName ? { teamName } : {}),
    ...(status ? { status } : {}),
    ...(note ? { note } : {}),
    ...(ratingValue !== undefined ? { rating: ratingValue } : {}),
    ...(ratingCount !== undefined ? { ratingCount } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
    ...(usageCount !== undefined ? { usageCount } : {}),
    ...(successCount !== undefined ? { successCount } : {}),
    ...(typeof raw.publishedToMarketplace === 'boolean'
      ? { publishedToMarketplace: raw.publishedToMarketplace }
      : {}),
  };
}

function rating(record: EnterpriseSkillRecord): string {
  return typeof record.rating === 'number' && Number.isFinite(record.rating)
    ? `${record.rating.toFixed(1)}/5`
    : '暂无';
}

function emptyLeaderboard(): EnterpriseSkillLeaderboard {
  return {
    leaderboard: '本部门暂无可用的 Skill 排行榜。',
    starBoard: '本部门暂无 Skill 贡献者。',
    tabs,
  };
}

export class EnterpriseSkillLibrary {
  private cache: { signature: string; records: EnterpriseSkillRecord[] } | null = null;

  constructor(
    private readonly filePath: string,
    private readonly fileAccess: SkillLibraryFileAccess = fs,
  ) {}

  private async records(): Promise<EnterpriseSkillRecord[]> {
    try {
      const stat = await this.fileAccess.stat(this.filePath);
      const signature = [stat.mtimeMs, stat.ctimeMs ?? '', stat.size, stat.ino ?? ''].join(':');
      if (this.cache?.signature === signature) return this.cache.records;

      const parsed: unknown = JSON.parse(await this.fileAccess.readFile(this.filePath, 'utf8'));
      const records = Array.isArray(parsed)
        ? parsed.map(normalizeRecord).filter((record): record is EnterpriseSkillRecord => record !== null)
        : [];
      this.cache = { signature, records };
      return records;
    } catch {
      this.cache = null;
      return [];
    }
  }

  private async active(scope?: EnterpriseSkillScope | null): Promise<EnterpriseSkillRecord[]> {
    const teamId = scope?.teamId.trim();
    if (!teamId) return [];
    return (await this.records()).filter(
      (record) => record.status === 'active' && record.teamId === teamId,
    );
  }

  async listDepartment(scope?: EnterpriseSkillScope | null): Promise<{ text: string }> {
    const records = await this.active(scope);
    if (records.length === 0) return { text: EMPTY_DEPARTMENT_TEXT };

    const lines = ['部门共享 Skill 列表', ''];
    for (const record of records) {
      lines.push(`${record.skillName} (v${record.version || 1})`);
      lines.push(`  功能：${record.featureDescription || '暂无描述'}`);
      lines.push(`  分享者：${record.sharedByName || '未知'}`);
      lines.push(
        `  评分：${rating(record)} (${record.ratingCount || 0}人 | 安装：${record.installCount || 0}次 | 使用：${record.usageCount || 0}次)`,
      );
      if (record.note) lines.push(`  备注：${record.note}`);
      lines.push('');
    }
    return { text: lines.join('\n') };
  }

  async listMarketplace(): Promise<{ text: string }> {
    const records = (await this.records())
      .filter((record) => record.status === 'active' && record.publishedToMarketplace === true)
      .sort((left, right) => (right.rating || 0) - (left.rating || 0));
    if (records.length === 0) {
      return { text: '公司 Skill 市场暂无已发布的 Skill。\n\n部门共享的 Skill 需要分享者“发布到市场”后才会在此显示。' };
    }

    const lines = ['公司 Skill 市场', ''];
    for (const record of records) {
      lines.push(`${record.skillName} (v${record.version || 1})`);
      lines.push(`  功能：${record.featureDescription || '暂无描述'}`);
      lines.push(`  分享者：${record.sharedByName || '未知'} (${record.teamName || '未知部门'})`);
      lines.push(
        `  评分：${rating(record)} (${record.ratingCount || 0}人 | 安装：${record.installCount || 0}次 | 使用：${record.usageCount || 0}次)`,
      );
      lines.push('');
    }
    return { text: lines.join('\n') };
  }

  async leaderboard(scope?: EnterpriseSkillScope | null): Promise<EnterpriseSkillLeaderboard> {
    const records = await this.active(scope);
    if (records.length === 0) return emptyLeaderboard();
    const teamName = records[0]?.teamName || '本部门';
    const medals = ['1.', '2.', '3.'];
    const maxInstalls = Math.max(...records.map((record) => record.installCount || 0), 1);
    const maxUsage = Math.max(...records.map((record) => record.usageCount || 0), 1);
    const scored = records
      .map((record) => {
        const successRate = (record.usageCount || 0) > 0
          ? ((record.successCount || 0) / (record.usageCount || 1)) * 100
          : 50;
        return {
          record,
          score: ((record.rating || 0) / 5) * 35
            + ((record.installCount || 0) / maxInstalls) * 25
            + successRate * 0.25
            + ((record.usageCount || 0) / maxUsage) * 15,
        };
      })
      .sort((left, right) => right.score - left.score);

    const leaderboard = [`${teamName} Skill 排行榜`, ''];
    scored.forEach(({ record, score }, index) => {
      leaderboard.push(`${medals[index] || `${index + 1}.`} ${record.skillName} (v${record.version || 1})`);
      leaderboard.push(`   ${record.featureDescription || ''}`);
      leaderboard.push(
        `   ${record.sharedByName || '未知'} | ${rating(record)} (${record.ratingCount || 0}人 | 装${record.installCount || 0} | 用${record.usageCount || 0} | ${score.toFixed(0)}分)`,
      );
      leaderboard.push('');
    });

    const contributors = new Map<string, { name: string; count: number; installs: number; skills: string[] }>();
    for (const record of records) {
      const key = record.sharedBy || 'unknown';
      const contributor = contributors.get(key) || {
        name: record.sharedByName || '未知', count: 0, installs: 0, skills: [],
      };
      contributor.count += 1;
      contributor.installs += record.installCount || 0;
      if (record.skillName) contributor.skills.push(record.skillName);
      contributors.set(key, contributor);
    }

    const starBoard = [`${teamName} 贡献明星榜`, ''];
    [...contributors.values()]
      .sort((left, right) => right.installs - left.installs)
      .forEach((contributor, index) => {
        starBoard.push(`${medals[index] || `${index + 1}.`} ${contributor.name}`);
        starBoard.push(`   分享${contributor.count}个 | 安装${contributor.installs}次 | ${contributor.skills.join('、')}`);
        starBoard.push('');
      });

    return { leaderboard: leaderboard.join('\n'), starBoard: starBoard.join('\n'), tabs };
  }
}
