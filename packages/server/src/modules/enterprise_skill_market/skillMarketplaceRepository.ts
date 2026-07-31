/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Database, EncryptedFieldCipher, EncryptedFieldValue } from '../data_platform/index.js';

export type EnterpriseSkillVisibility = 'department' | 'company';
export type EnterpriseSkillStatus = 'pending_review' | 'active' | 'archived';
export type EnterpriseSkillScope = 'department' | 'company' | 'mine' | 'review';
export type EnterpriseSkillSort = 'recommended' | 'rating' | 'installs' | 'usage' | 'newest';

export interface EnterpriseSkillMarketStore {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  organizationExists(organizationId: string): boolean;
  createId(): string;
}

export interface EnterpriseSkillActor {
  accountId: string;
  organizationId: string;
  name: string;
  department: string | null;
  isAdmin: boolean;
}

export interface EnterpriseSkillView {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  department: string | null;
  visibility: EnterpriseSkillVisibility;
  status: EnterpriseSkillStatus;
  authorAccountId: string | null;
  authorName: string;
  contentHash: string;
  version: number;
  installCount: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  rating: number;
  ratingCount: number;
  installedVersion: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseSkillInstallView extends EnterpriseSkillView {
  content: string;
}

export interface EnterpriseSkillLeaderboard {
  skills: Array<EnterpriseSkillView & { rank: number; score: number; successRate: number }>;
  contributors: Array<{
    rank: number;
    accountId: string | null;
    name: string;
    skillCount: number;
    installCount: number;
    usageCount: number;
    score: number;
  }>;
  generatedAt: string;
}

interface EnterpriseSkillRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  department: string | null;
  visibility: EnterpriseSkillVisibility;
  status: EnterpriseSkillStatus;
  author_account_id: string | null;
  author_name: string;
  content: string;
  content_ciphertext: string | null;
  content_iv: string | null;
  content_auth_tag: string | null;
  content_key_version: number | null;
  content_hash: string;
  version: number;
  install_count: number;
  usage_count: number;
  success_count: number;
  failure_count: number;
  rating_total: number;
  rating_count: number;
  installed_version?: number | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_NAME = 100;
const MAX_DESCRIPTION = 1_000;
const MAX_CONTENT = 200_000;

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
  const clean = value.trim();
  if (clean.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return clean;
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label}格式不正确`);
  const clean = value.trim();
  if (clean.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return clean || null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeSlug(name: string, requested?: string): string {
  const source = requested?.trim() || name;
  const normalized = source.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return normalized || `shared-skill-${contentHash(name).slice(0, 10)}`;
}

export function assertEnterpriseSkillContentSafe(content: string): void {
  const sensitivePatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/u,
    /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_+\-/=.]{16,}/iu,
  ];
  if (sensitivePatterns.some((pattern) => pattern.test(content))) {
    throw new Error('Skill 中疑似包含密钥、令牌或密码，请移除敏感信息后再分享');
  }
}

function encryptedContext(organizationId: string, skillId: string, version: number): string {
  return `enterprise-skill:${organizationId}:${skillId}:v${version}`;
}

function encryptedColumns(value: EncryptedFieldValue): [string, string, string, number] {
  return [value.ciphertext, value.iv, value.authTag, value.keyVersion];
}

function decryptContent(store: EnterpriseSkillMarketStore, row: EnterpriseSkillRow): string {
  if (!row.content_ciphertext || !row.content_iv || !row.content_auth_tag || !row.content_key_version) {
    if (row.content !== '[encrypted:v1]') return row.content;
    throw new Error('Skill 内容缺少加密元数据');
  }
  return store.fieldCipher.decryptText({
    ciphertext: row.content_ciphertext,
    iv: row.content_iv,
    authTag: row.content_auth_tag,
    keyVersion: row.content_key_version,
  }, encryptedContext(row.organization_id, row.id, row.version));
}

function toView(row: EnterpriseSkillRow): EnterpriseSkillView {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    department: row.department,
    visibility: row.visibility,
    status: row.status,
    authorAccountId: row.author_account_id,
    authorName: row.author_name,
    contentHash: row.content_hash,
    version: row.version,
    installCount: row.install_count,
    usageCount: row.usage_count,
    successCount: row.success_count,
    failureCount: row.failure_count,
    rating: row.rating_count > 0 ? row.rating_total / row.rating_count : 0,
    ratingCount: row.rating_count,
    installedVersion: row.installed_version ?? null,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireOrganization(store: EnterpriseSkillMarketStore, organizationId: string): void {
  if (!store.organizationExists(organizationId)) throw new Error('企业不存在');
}

function runTransaction<T>(database: Database, operation: () => T): T {
  const owns = !database.inTransaction;
  if (owns) database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (owns) database.exec('COMMIT');
    return result;
  } catch (error) {
    if (owns && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function skillById(database: Database, id: string, organizationId: string): EnterpriseSkillRow | null {
  return (database.prepare(
    'SELECT * FROM enterprise_skills WHERE id = ? AND organization_id = ?',
  ).get(id, organizationId) as EnterpriseSkillRow | undefined) ?? null;
}

function isAccessible(row: EnterpriseSkillRow, actor: EnterpriseSkillActor): boolean {
  if (row.organization_id !== actor.organizationId || row.status !== 'active') return false;
  return row.visibility === 'company'
    || Boolean(actor.department && row.department === actor.department);
}

export function submitEnterpriseSkillInRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
  input: {
    name: string;
    slug?: string;
    description: string;
    content: string;
    visibility?: EnterpriseSkillVisibility;
  },
): { outcome: 'submitted' | 'exists'; skill: EnterpriseSkillView } {
  requireOrganization(store, actor.organizationId);
  const name = requiredText(input.name, 'Skill 名称', MAX_NAME);
  const description = requiredText(input.description, 'Skill 描述', MAX_DESCRIPTION);
  const content = requiredText(input.content, 'Skill 内容', MAX_CONTENT);
  assertEnterpriseSkillContentSafe(content);
  const visibility = input.visibility === 'company' ? 'company' : 'department';
  if (visibility === 'department' && !actor.department) {
    throw new Error('当前账号没有所属部门，不能投稿到部门市场');
  }
  const hash = contentHash(content);
  const database = store.db();
  const existing = database.prepare(
    `SELECT s.*, NULL AS installed_version FROM enterprise_skills s
     WHERE s.organization_id = ? AND s.author_account_id = ?
       AND s.content_hash = ? AND s.status <> 'archived' LIMIT 1`,
  ).get(actor.organizationId, actor.accountId, hash) as EnterpriseSkillRow | undefined;
  if (existing) return { outcome: 'exists', skill: toView(existing) };

  return runTransaction(database, () => {
    const id = `skill_${store.createId()}`;
    const version = 1;
    const encrypted = store.fieldCipher.encryptText(
      content,
      encryptedContext(actor.organizationId, id, version),
    );
    const status: EnterpriseSkillStatus = actor.isAdmin ? 'active' : 'pending_review';
    const reviewedBy = actor.isAdmin ? actor.name : null;
    const [ciphertext, iv, authTag, keyVersion] = encryptedColumns(encrypted);
    database.prepare(
      `INSERT INTO enterprise_skills
       (id, organization_id, slug, name, description, department, visibility, status,
        author_account_id, author_name, content, content_ciphertext, content_iv,
        content_auth_tag, content_key_version, content_hash, version, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[encrypted:v1]', ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`,
    ).run(
      id,
      actor.organizationId,
      normalizeSlug(name, input.slug),
      name,
      description,
      actor.department,
      visibility,
      status,
      actor.accountId,
      actor.name,
      ciphertext,
      iv,
      authTag,
      keyVersion,
      hash,
      version,
      reviewedBy,
      reviewedBy,
    );
    database.prepare(
      `INSERT INTO enterprise_skill_versions
       (skill_id, organization_id, version, content, content_ciphertext, content_iv,
        content_auth_tag, content_key_version, content_hash, description, created_by)
       VALUES (?, ?, ?, '[encrypted:v1]', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      actor.organizationId,
      version,
      ciphertext,
      iv,
      authTag,
      keyVersion,
      hash,
      description,
      actor.accountId,
    );
    const row = skillById(database, id, actor.organizationId)!;
    return { outcome: 'submitted' as const, skill: toView(row) };
  });
}

export function listEnterpriseSkillsFromRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
  input: {
    scope?: EnterpriseSkillScope;
    query?: string;
    sort?: EnterpriseSkillSort;
  } = {},
): EnterpriseSkillView[] {
  requireOrganization(store, actor.organizationId);
  const scope = input.scope ?? 'department';
  if (scope === 'review' && !actor.isAdmin) throw new Error('只有企业管理员可以查看 Skill 审核队列');
  let sql = `SELECT s.*,
    (SELECT i.installed_version FROM enterprise_skill_installs i
     WHERE i.skill_id = s.id AND i.account_id = ?) AS installed_version
    FROM enterprise_skills s WHERE s.organization_id = ?`;
  const params: Array<string | number> = [actor.accountId, actor.organizationId];
  if (scope === 'department') {
    if (!actor.department) return [];
    sql += " AND s.status = 'active' AND s.visibility = 'department' AND s.department = ?";
    params.push(actor.department);
  } else if (scope === 'company') {
    sql += " AND s.status = 'active' AND s.visibility = 'company'";
  } else if (scope === 'mine') {
    sql += ' AND s.author_account_id = ?';
    params.push(actor.accountId);
  } else {
    sql += " AND s.status = 'pending_review'";
  }
  const query = optionalText(input.query, '搜索词', 200);
  if (query) {
    const pattern = `%${escapeLike(query)}%`;
    sql += " AND (s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' OR s.author_name LIKE ? ESCAPE '\\' OR s.department LIKE ? ESCAPE '\\')";
    params.push(pattern, pattern, pattern, pattern);
  }
  const rows = store.db().prepare(`${sql} ORDER BY datetime(s.updated_at) DESC LIMIT 200`)
    .all(...params) as EnterpriseSkillRow[];
  const views = rows.map(toView);
  const sort = input.sort ?? 'recommended';
  const maxInstalls = Math.max(...views.map((item) => item.installCount), 1);
  const maxUsage = Math.max(...views.map((item) => item.usageCount), 1);
  return views.sort((left, right) => {
    if (sort === 'newest') return right.updatedAt.localeCompare(left.updatedAt);
    if (sort === 'installs') return right.installCount - left.installCount;
    if (sort === 'usage') return right.usageCount - left.usageCount;
    if (sort === 'rating') {
      const leftRating = (left.rating * left.ratingCount + 3.5 * 5) / (left.ratingCount + 5);
      const rightRating = (right.rating * right.ratingCount + 3.5 * 5) / (right.ratingCount + 5);
      return rightRating - leftRating || right.ratingCount - left.ratingCount;
    }
    return skillEvidenceScore(right, maxInstalls, maxUsage)
      - skillEvidenceScore(left, maxInstalls, maxUsage)
      || right.updatedAt.localeCompare(left.updatedAt);
  }).slice(0, 100);
}

export function reviewEnterpriseSkillInRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
  input: { id: string; action: 'approve' | 'archive'; visibility?: EnterpriseSkillVisibility },
): EnterpriseSkillView | null {
  if (!actor.isAdmin) throw new Error('只有企业管理员可以审核 Skill');
  const database = store.db();
  return runTransaction(database, () => {
    const row = skillById(database, input.id, actor.organizationId);
    if (!row) return null;
    if (input.action === 'approve' && row.status !== 'pending_review') {
      throw new Error('只有待审核 Skill 可以发布');
    }
    const status: EnterpriseSkillStatus = input.action === 'approve' ? 'active' : 'archived';
    const visibility = input.visibility ?? row.visibility;
    if (visibility === 'department' && !row.department) throw new Error('该 Skill 没有所属部门');
    database.prepare(
      `UPDATE enterprise_skills SET status = ?, visibility = ?, reviewed_by = ?,
       reviewed_at = datetime('now'), archived_at = CASE WHEN ? = 'archived' THEN datetime('now') ELSE NULL END,
       updated_at = datetime('now') WHERE id = ? AND organization_id = ?`,
    ).run(status, visibility, actor.name, status, row.id, actor.organizationId);
    return toView(skillById(database, row.id, actor.organizationId)!);
  });
}

export function installEnterpriseSkillInRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
  id: string,
): EnterpriseSkillInstallView | null {
  const database = store.db();
  return runTransaction(database, () => {
    const row = skillById(database, id, actor.organizationId);
    if (!row) return null;
    if (!isAccessible(row, actor)) throw new Error('无权安装该 Skill');
    const previous = database.prepare(
      'SELECT installed_version FROM enterprise_skill_installs WHERE skill_id = ? AND account_id = ?',
    ).get(id, actor.accountId) as { installed_version: number } | undefined;
    database.prepare(
      `INSERT INTO enterprise_skill_installs
       (skill_id, organization_id, account_id, installed_version)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(skill_id, account_id) DO UPDATE SET
         installed_version = excluded.installed_version, updated_at = datetime('now')`,
    ).run(id, actor.organizationId, actor.accountId, row.version);
    if (!previous) {
      database.prepare(
        'UPDATE enterprise_skills SET install_count = install_count + 1, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(id);
    }
    const updated = skillById(database, id, actor.organizationId)!;
    updated.installed_version = updated.version;
    return { ...toView(updated), content: decryptContent(store, updated) };
  });
}

export function rateEnterpriseSkillInRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
  id: string,
  score: number,
): EnterpriseSkillView | null {
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('评分必须是 1 到 5 的整数');
  const database = store.db();
  return runTransaction(database, () => {
    const row = skillById(database, id, actor.organizationId);
    if (!row) return null;
    if (!isAccessible(row, actor)) throw new Error('无权评价该 Skill');
    if (row.author_account_id === actor.accountId) throw new Error('不能评价自己分享的 Skill');
    const installed = database.prepare(
      'SELECT installed_version FROM enterprise_skill_installs WHERE skill_id = ? AND account_id = ?',
    ).get(id, actor.accountId) as { installed_version: number } | undefined;
    if (!installed) throw new Error('安装并实际体验后才能评分');
    database.prepare(
      `INSERT INTO enterprise_skill_ratings
       (skill_id, organization_id, account_id, score) VALUES (?, ?, ?, ?)
       ON CONFLICT(skill_id, account_id) DO UPDATE SET score = excluded.score, updated_at = datetime('now')`,
    ).run(id, actor.organizationId, actor.accountId, score);
    const totals = database.prepare(
      'SELECT COALESCE(SUM(score), 0) AS total, COUNT(*) AS count FROM enterprise_skill_ratings WHERE skill_id = ?',
    ).get(id) as { total: number; count: number };
    database.prepare(
      `UPDATE enterprise_skills SET rating_total = ?, rating_count = ?, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(totals.total, totals.count, id, actor.organizationId);
    const updated = skillById(database, id, actor.organizationId)!;
    updated.installed_version = installed.installed_version;
    return toView(updated);
  });
}

export function recordEnterpriseSkillUsageInRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
  id: string,
  success: boolean,
  eventId?: string,
): EnterpriseSkillView | null {
  const database = store.db();
  const normalizedEventId = eventId === undefined
    ? null
    : requiredText(eventId, '使用事件 ID', 128);
  if (normalizedEventId && !/^[A-Za-z0-9_-]{16,128}$/u.test(normalizedEventId)) {
    throw new Error('使用事件 ID 格式不正确');
  }
  return runTransaction(database, () => {
    const row = skillById(database, id, actor.organizationId);
    if (!row) return null;
    if (!isAccessible(row, actor)) throw new Error('无权记录该 Skill 的使用结果');
    const installed = database.prepare(
      'SELECT installed_version FROM enterprise_skill_installs WHERE skill_id = ? AND account_id = ?',
    ).get(id, actor.accountId) as { installed_version: number } | undefined;
    if (!installed) throw new Error('尚未安装该 Skill');
    if (normalizedEventId) {
      const inserted = database.prepare(
        `INSERT OR IGNORE INTO enterprise_skill_usage_events
         (event_id, skill_id, organization_id, account_id, success) VALUES (?, ?, ?, ?, ?)`,
      ).run(normalizedEventId, id, actor.organizationId, actor.accountId, success ? 1 : 0);
      if (inserted.changes === 0) {
        row.installed_version = installed.installed_version;
        return toView(row);
      }
    }
    database.prepare(
      `UPDATE enterprise_skills SET usage_count = usage_count + 1,
       success_count = success_count + ?, failure_count = failure_count + ?, updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(success ? 1 : 0, success ? 0 : 1, id, actor.organizationId);
    const updated = skillById(database, id, actor.organizationId)!;
    updated.installed_version = installed.installed_version;
    return toView(updated);
  });
}

function skillEvidenceScore(skill: EnterpriseSkillView, maxInstalls: number, maxUsage: number): number {
  const bayesianRating = (skill.rating * skill.ratingCount + 3.5 * 5) / (skill.ratingCount + 5);
  const ratingScore = (bayesianRating / 5) * 40;
  const installScore = (Math.log1p(skill.installCount) / Math.log1p(maxInstalls)) * 25;
  const usageScore = (Math.log1p(skill.usageCount) / Math.log1p(maxUsage)) * 15;
  const reliability = skill.usageCount > 0
    ? (skill.successCount + 2) / (skill.usageCount + 4)
    : 0.5;
  return ratingScore + installScore + usageScore + reliability * 20;
}

export function getEnterpriseSkillLeaderboardFromRepository(
  store: EnterpriseSkillMarketStore,
  actor: EnterpriseSkillActor,
): EnterpriseSkillLeaderboard {
  const database = store.db();
  const rows = database.prepare(
    `SELECT s.*,
      (SELECT i.installed_version FROM enterprise_skill_installs i
       WHERE i.skill_id = s.id AND i.account_id = ?) AS installed_version
     FROM enterprise_skills s
     WHERE s.organization_id = ? AND s.status = 'active'
       AND (s.visibility = 'company' OR (s.visibility = 'department' AND s.department = ?))`,
  ).all(actor.accountId, actor.organizationId, actor.department) as EnterpriseSkillRow[];
  const views = rows.map(toView);
  const maxInstalls = Math.max(...views.map((skill) => skill.installCount), 1);
  const maxUsage = Math.max(...views.map((skill) => skill.usageCount), 1);
  const skills = views
    .map((skill) => ({
      ...skill,
      rank: 0,
      score: skillEvidenceScore(skill, maxInstalls, maxUsage),
      successRate: skill.usageCount > 0 ? skill.successCount / skill.usageCount : 0,
    }))
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt));
  skills.forEach((skill, index) => { skill.rank = index + 1; });

  const contributorMap = new Map<string, {
    accountId: string | null;
    name: string;
    skillCount: number;
    installCount: number;
    usageCount: number;
    score: number;
  }>();
  for (const skill of skills) {
    const key = skill.authorAccountId ?? `anonymous:${skill.authorName}`;
    const contributor = contributorMap.get(key) ?? {
      accountId: skill.authorAccountId,
      name: skill.authorName,
      skillCount: 0,
      installCount: 0,
      usageCount: 0,
      score: 0,
    };
    contributor.skillCount += 1;
    contributor.installCount += skill.installCount;
    contributor.usageCount += skill.usageCount;
    contributor.score += skill.score;
    contributorMap.set(key, contributor);
  }
  const contributors = [...contributorMap.values()]
    .sort((left, right) => right.score - left.score || right.installCount - left.installCount)
    .map((contributor, index) => ({ ...contributor, rank: index + 1 }));
  return { skills, contributors, generatedAt: new Date().toISOString() };
}
