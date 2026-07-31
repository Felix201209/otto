/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 个人本地知识库存储（无企业授权即可用）。
 *
 * 存储方案拍板：JSONL 追加文件 + 内存关键词检索，而不是 node:sqlite——
 * core 包 engines 只要求 node>=20，而 node:sqlite 需要 Node 22.5+；core 还被
 * CLI / VSCode 插件（Electron，Node 版本不受我们控制）消费，sqlite 会在
 * 低版本环境直接 import 崩掉。JSONL 零依赖、全版本可用，个人量级
 * （几千条）全量载入内存检索绰绰有余；条目变多也只是线性扫描，可接受。
 *
 * 路径：~/.otto-user/knowledge/entries.jsonl。
 * OTTO_USER_DIR 环境变量可覆盖根目录（与 customModelsStorage 的
 * 测试隔离/沙箱重定向惯例一致），测试绝不污染真实 ~/.otto-user。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

/** 一条个人知识条目 */
export interface KnowledgeEntry {
  id: string;
  category: string;
  content: string;
  tags: string[];
  /** ISO 时间戳 */
  createdAt: string;
  /** 内容指纹（sha256 前 16 hex），供去重；可选，旧条目无此字段时为 undefined */
  fingerprint?: string;
  /** 自动捕获置信度；手动条目及旧条目可为空。 */
  confidence?: number;
  /** 最近一次内容或元数据发生变化的时间。 */
  updatedAt?: string;
  /** 同一知识被独立观察到的次数；旧条目按 1 次处理。 */
  reinforcementCount?: number;
  /** 最近一次被重复验证的时间。 */
  lastReinforcedAt?: string;
  /** 提供过相同证据的会话，限制长度以避免条目无限膨胀。 */
  sourceSessionIds?: string[];
  /** 被检索并用于回答的次数。 */
  useCount?: number;
  /** 最近一次被检索使用的时间。 */
  lastUsedAt?: string;
}

/** 检索结果：条目 + 相关度分（越大越相关） */
export interface KnowledgeSearchResult extends KnowledgeEntry {
  score: number;
  strength: number;
  freshness: 'current' | 'aging' | 'needs_review';
}

const KNOWLEDGE_DIR_NAME = 'knowledge';
const ENTRIES_FILE_NAME = 'entries.jsonl';
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 20;
const MAX_SOURCE_SESSION_IDS = 24;

export interface ReinforceKnowledgeOptions {
  sourceSessionId?: string;
  confidence?: number;
  tags?: string[];
  content?: string;
  category?: string;
}

function normalizedStrings(values: unknown, maximum = Number.POSITIVE_INFINITY): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]
    .slice(-maximum);
}

function normalizeEntry(entry: KnowledgeEntry): KnowledgeEntry {
  const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : '';
  return {
    ...entry,
    tags: normalizedStrings(entry.tags),
    createdAt,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : createdAt,
    reinforcementCount: Math.max(1, Math.floor(entry.reinforcementCount ?? 1)),
    sourceSessionIds: normalizedStrings(entry.sourceSessionIds, MAX_SOURCE_SESSION_IDS),
    useCount: Math.max(0, Math.floor(entry.useCount ?? 0)),
  };
}

/**
 * 个人知识强度只由本地可核验证据计算，不使用模型自评。
 * 重复验证、跨会话来源、实际使用和置信度都会提高强度。
 */
export function personalKnowledgeStrength(entry: KnowledgeEntry): number {
  const confidence = Math.min(1, Math.max(0, entry.confidence ?? 0.75));
  const repetitions = Math.min(1, Math.max(1, entry.reinforcementCount ?? 1) / 5);
  const sessions = Math.min(1, (entry.sourceSessionIds?.length ?? 0) / 4);
  const uses = Math.min(1, (entry.useCount ?? 0) / 6);
  const freshness = personalKnowledgeFreshness(entry);
  const freshnessFactor = freshness === 'needs_review' ? 0.62 : freshness === 'aging' ? 0.84 : 1;
  return Math.round(
    (confidence * 0.45 + repetitions * 0.3 + sessions * 0.15 + uses * 0.1)
      * freshnessFactor
      * 100,
  ) / 100;
}

function isTimeSensitiveKnowledge(entry: KnowledgeEntry): boolean {
  const searchable = `${entry.category} ${entry.tags.join(' ')} ${entry.content}`.toLowerCase();
  return /(价格|费用|政策|制度|版本|配置|地址|电话|联系人|排期|库存|license|price|policy|version|config|contact)/iu
    .test(searchable);
}

export function personalKnowledgeFreshness(
  entry: KnowledgeEntry,
): 'current' | 'aging' | 'needs_review' {
  const timestamp = Date.parse(
    entry.lastReinforcedAt || entry.updatedAt || entry.createdAt,
  );
  if (!Number.isFinite(timestamp)) return 'needs_review';
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  const timeSensitive = isTimeSensitiveKnowledge(entry);
  if (ageDays > (timeSensitive ? 90 : 365)) return 'needs_review';
  if (ageDays > (timeSensitive ? 45 : 180)) return 'aging';
  return 'current';
}

/**
 * 配置根目录：默认 ~/.otto-user；OTTO_USER_DIR 可覆盖（测试隔离用）。
 * 每次调用现读环境变量，保证测试在 beforeEach 里改 env 后立即生效。
 */
function getUserDir(): string {
  return process.env.OTTO_USER_DIR || path.join(homedir(), '.otto-user');
}

/** 知识库目录：~/.otto-user/knowledge */
export function getKnowledgeDir(): string {
  return path.join(getUserDir(), KNOWLEDGE_DIR_NAME);
}

/** 生成短 id：时间戳 + 随机后缀，可读且基本不会撞 */
function generateId(): string {
  return `kb_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * 关键词相关度打分。中文查询没有空格分词，所以"整句子串命中"权重最高；
 * 再按空格/常见中英文分隔符切 token 逐个累加。返回 0 表示不相关。
 */
function scoreEntry(entry: KnowledgeEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const content = entry.content.toLowerCase();
  const category = entry.category.toLowerCase();
  const tags = entry.tags.map((tag) => tag.toLowerCase());

  let score = 0;
  // 整句命中权重最高（对中文查询尤其关键）
  if (content.includes(q)) score += 5;
  if (tags.some((tag) => tag.includes(q))) score += 3;
  if (category.includes(q)) score += 2;

  // 分 token 累加（跳过与整句相同的单 token，避免重复计分）
  const tokens = q.split(/[\s,，、;；]+/).filter((s) => s.length > 0 && s !== q);
  for (const token of tokens) {
    if (content.includes(token)) score += 2;
    if (tags.some((tag) => tag.includes(token))) score += 2;
    if (category.includes(token)) score += 1;
  }
  if (score <= 0) return 0;
  return score * 10 + Math.round(personalKnowledgeStrength(entry) * 8);
}

/**
 * 个人知识库存储。add 追加 JSONL 行；remove 全量重写；
 * 所有写操作经进程内 promise 链串行化，防止并发 read-modify-write 丢更新
 * （与 memoryTool 的 memoryWriteChains 同一思路）。
 */
export class LocalKnowledgeStore {
  private readonly filePath: string;
  /** 进程内写串行链 */
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * @param baseDir 存储目录，默认 ~/.otto-user/knowledge
   *（构造时固化；测试请先设 OTTO_USER_DIR 再 new）
   */
  constructor(baseDir: string = getKnowledgeDir()) {
    this.filePath = path.join(baseDir, ENTRIES_FILE_NAME);
  }

  /** 把写操作排进串行链，保证同一进程内互不交叠 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.catch(() => undefined).then(op);
    this.writeChain = run;
    return run;
  }

  private async rewriteEntries(entries: KnowledgeEntry[]): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = entries.map((entry) => JSON.stringify(normalizeEntry(entry))).join('\n')
      + (entries.length > 0 ? '\n' : '');
    await fs.writeFile(tmpPath, body, 'utf-8');
    await fs.rename(tmpPath, this.filePath);
  }

  /**
   * 读取全部条目。文件不存在视为空库；坏行（手工编辑/断电截断）跳过并
   * warn，不让个别坏行毁掉整个库。
   */
  async loadAll(): Promise<KnowledgeEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const entries: KnowledgeEntry[] = [];
    let corrupted = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as KnowledgeEntry;
        // 关键字段缺失的行同样按坏行处理
        if (
          typeof parsed.id === 'string' &&
          typeof parsed.content === 'string' &&
          typeof parsed.category === 'string'
        ) {
          entries.push(normalizeEntry({
            ...parsed,
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            createdAt:
              typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
          }));
        } else {
          corrupted++;
        }
      } catch {
        corrupted++;
      }
    }
    if (corrupted > 0) {
      console.warn(
        `[LocalKnowledgeStore] Skipped ${corrupted} corrupted line(s) in ${this.filePath}`,
      );
    }
    return entries;
  }

  /** 新增一条知识。追加一行 JSONL（近似原子，不重写全文件）。 */
  async add(
    category: string,
    content: string,
    tags: string[] = [],
    fingerprint?: string,
    confidence?: number,
    sourceSessionId?: string,
  ): Promise<KnowledgeEntry> {
    const trimmedContent = (content ?? '').trim();
    if (!trimmedContent) {
      throw new Error('knowledge content cannot be empty');
    }
    const now = new Date().toISOString();
    const entry: KnowledgeEntry = {
      id: generateId(),
      category: (category ?? '').trim() || 'general',
      content: trimmedContent,
      tags: (tags ?? []).map((tag) => String(tag).trim()).filter(Boolean),
      createdAt: now,
      updatedAt: now,
      reinforcementCount: 1,
      lastReinforcedAt: now,
      sourceSessionIds: sourceSessionId?.trim() ? [sourceSessionId.trim()] : [],
      useCount: 0,
      ...(fingerprint ? { fingerprint } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    };

    await this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(
        this.filePath,
        JSON.stringify(entry) + '\n',
        'utf-8',
      );
    });
    return entry;
  }

  /**
   * 关键词检索：按相关度降序、同分按时间倒序，返回 top20。
   * @param category 可选，限定分类（精确匹配，大小写不敏感）
   */
  async search(
    query: string,
    category?: string,
  ): Promise<KnowledgeSearchResult[]> {
    const q = (query ?? '').trim();
    if (!q) return [];

    const entries = await this.loadAll();
    const categoryFilter = (category ?? '').trim().toLowerCase();

    return entries
      .filter(
        (entry) =>
          !categoryFilter || entry.category.toLowerCase() === categoryFilter,
      )
      .map((entry) => ({
        ...entry,
        score: scoreEntry(entry, q),
        strength: personalKnowledgeStrength(entry),
        freshness: personalKnowledgeFreshness(entry),
      }))
      .filter((result) => result.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, DEFAULT_SEARCH_LIMIT);
  }

  /** 按时间倒序列出最近的条目 */
  async list(limit: number = DEFAULT_LIST_LIMIT): Promise<KnowledgeEntry[]> {
    const entries = await this.loadAll();
    return [...entries]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, limit));
  }

  /**
   * 按 id 删除。返回是否真的删掉了（false = 没找到）。
   * 删除需要重写文件：先写临时文件再 rename，避免中途崩溃留下半截库。
   */
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const entries = await this.loadAll();
      const remaining = entries.filter((entry) => entry.id !== id);
      if (remaining.length === entries.length) {
        return false;
      }
      await this.rewriteEntries(remaining);
      return true;
    });
  }

  /**
   * 按指纹查找条目。返回命中的第一条，否则 null。
   * 供自动沉淀前去重：内容变了但结构与之前相同 → 避免重复写入。
   */
  async findByFingerprint(fingerprint: string): Promise<KnowledgeEntry | null> {
    if (!fingerprint) return null;
    const entries = await this.loadAll();
    return entries.find((e) => e.fingerprint === fingerprint) ?? null;
  }

  /** 把重复出现变成证据，而不是简单丢弃。 */
  async reinforceByFingerprint(
    fingerprint: string,
    options: ReinforceKnowledgeOptions = {},
  ): Promise<KnowledgeEntry | null> {
    if (!fingerprint) return null;
    return this.enqueue(async () => {
      const entries = await this.loadAll();
      const index = entries.findIndex((entry) => entry.fingerprint === fingerprint);
      if (index < 0) return null;
      const current = entries[index];
      const now = new Date().toISOString();
      const sourceSessionIds = normalizedStrings([
        ...(current.sourceSessionIds ?? []),
        options.sourceSessionId,
      ], MAX_SOURCE_SESSION_IDS);
      const tags = normalizedStrings([...(current.tags ?? []), ...(options.tags ?? [])]);
      const next: KnowledgeEntry = normalizeEntry({
        ...current,
        category: options.category?.trim() || current.category,
        content: options.content?.trim() || current.content,
        tags,
        confidence: options.confidence === undefined
          ? current.confidence
          : Math.max(current.confidence ?? 0, Math.min(1, Math.max(0, options.confidence))),
        updatedAt: now,
        lastReinforcedAt: now,
        reinforcementCount: (current.reinforcementCount ?? 1) + 1,
        sourceSessionIds,
      });
      entries[index] = next;
      await this.rewriteEntries(entries);
      return next;
    });
  }

  /** 记录真正进入回答上下文的知识，供后续排序与 Skill 提炼使用。 */
  async markUsed(ids: string[]): Promise<void> {
    const wanted = new Set(ids.filter(Boolean));
    if (wanted.size === 0) return;
    await this.enqueue(async () => {
      const entries = await this.loadAll();
      const now = new Date().toISOString();
      let changed = false;
      for (let index = 0; index < entries.length; index++) {
        if (!wanted.has(entries[index].id)) continue;
        entries[index] = normalizeEntry({
          ...entries[index],
          useCount: (entries[index].useCount ?? 0) + 1,
          lastUsedAt: now,
          updatedAt: entries[index].updatedAt || entries[index].createdAt,
        });
        changed = true;
      }
      if (changed) await this.rewriteEntries(entries);
    });
  }

  /**
   * Upsert：按指纹查找，存在则更新内容/标签/时间，不存在则新增。
   * 新增走 JSONL 追加；更新需要重写文件。
   * 返回最终条目（新增或更新后）。
   */
  async upsert(
    category: string,
    content: string,
    tags: string[] = [],
    fingerprint?: string,
    confidence?: number,
    sourceSessionId?: string,
  ): Promise<KnowledgeEntry> {
    const trimmedContent = (content ?? '').trim();
    if (!trimmedContent) {
      throw new Error('knowledge content cannot be empty');
    }

    // 无指纹走新增
    if (!fingerprint) {
      return this.add(category, trimmedContent, tags, undefined, confidence, sourceSessionId);
    }

    const existing = await this.findByFingerprint(fingerprint);
    if (!existing) {
      return this.add(category, trimmedContent, tags, fingerprint, confidence, sourceSessionId);
    }

    return (await this.reinforceByFingerprint(fingerprint, {
      category,
      content: trimmedContent,
      tags,
      confidence,
      sourceSessionId,
    })) ?? existing;
  }

  /**
   * 合并高度相似条目。
   *
   * 用简单的 Jaccard 字符 3-gram 相似度：两条内容的 n-gram 交集 / 并集。
   * 对达到 threshold 的条目对，保留较新的一条，删除旧的一条。
   * 返回合并掉的条目数。
   */
  async mergeSimilar(threshold: number = 0.85): Promise<number> {
    const entries = await this.loadAll();
    if (entries.length <= 1) return 0;

    const removed = new Set<string>();
    // 按时间倒序：优先保留新的
    const sorted = [...entries].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
    const mergedById = new Map(sorted.map((entry) => [entry.id, { ...entry }]));

    for (let i = 0; i < sorted.length; i++) {
      if (removed.has(sorted[i].id)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        if (removed.has(sorted[j].id)) continue;
        if (this.hasPolarityConflict(sorted[i].content, sorted[j].content)) continue;
        const sim = this.textSimilarity(sorted[i].content, sorted[j].content);
        if (sim >= threshold) {
          const keeper = mergedById.get(sorted[i].id)!;
          const duplicate = mergedById.get(sorted[j].id)!;
          mergedById.set(keeper.id, normalizeEntry({
            ...keeper,
            tags: normalizedStrings([...keeper.tags, ...duplicate.tags]),
            createdAt: [keeper.createdAt, duplicate.createdAt].filter(Boolean).sort()[0] || keeper.createdAt,
            updatedAt: [keeper.updatedAt, duplicate.updatedAt].filter(Boolean).sort().at(-1),
            lastReinforcedAt: [keeper.lastReinforcedAt, duplicate.lastReinforcedAt]
              .filter((value): value is string => Boolean(value)).sort().at(-1),
            reinforcementCount: (keeper.reinforcementCount ?? 1) + (duplicate.reinforcementCount ?? 1),
            sourceSessionIds: normalizedStrings([
              ...(keeper.sourceSessionIds ?? []),
              ...(duplicate.sourceSessionIds ?? []),
            ], MAX_SOURCE_SESSION_IDS),
            useCount: (keeper.useCount ?? 0) + (duplicate.useCount ?? 0),
            lastUsedAt: [keeper.lastUsedAt, duplicate.lastUsedAt]
              .filter((value): value is string => Boolean(value)).sort().at(-1),
            confidence: Math.max(keeper.confidence ?? 0, duplicate.confidence ?? 0) || undefined,
          }));
          removed.add(duplicate.id);
        }
      }
    }

    if (removed.size === 0) return 0;

    // 重写文件：去掉被标记的条目
    await this.enqueue(async () => {
      const current = await this.loadAll();
      const remaining = current
        .filter((entry) => !removed.has(entry.id))
        .map((entry) => mergedById.get(entry.id) ?? entry);
      await this.rewriteEntries(remaining);
    });

    return removed.size;
  }

  /**
   * 简易文本相似度（Jaccard on character 3-grams）。
   * 返回 0-1 之间的值，越大越相似。
   */
  private textSimilarity(a: string, b: string): number {
    const getGrams = (s: string): Set<string> => {
      const grams = new Set<string>();
      const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
      for (let i = 0; i < t.length - 2; i++) {
        grams.add(t.slice(i, i + 3));
      }
      return grams;
    };

    const ga = getGrams(a);
    const gb = getGrams(b);

    if (ga.size === 0 && gb.size === 0) return 1;
    if (ga.size === 0 || gb.size === 0) return 0;

    let intersection = 0;
    for (const g of ga) {
      if (gb.has(g)) intersection++;
    }
    const union = ga.size + gb.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** 相反结论宁可并存等待用户复核，也不能被“文本很像”误合并。 */
  private hasPolarityConflict(a: string, b: string): boolean {
    const normalize = (value: string): string => value.toLowerCase().replace(/\s+/gu, '');
    const negation = /(?:不能|不必|无需|禁止|不得|mustn't|shouldn't|never|not|未|否|不)/giu;
    const negationCount = (value: string): number => value.match(negation)?.length ?? 0;
    const left = normalize(a);
    const right = normalize(b);
    const polarityDiffers = Math.abs(negationCount(left) - negationCount(right)) % 2 === 1;
    if (!polarityDiffers) return false;
    return this.textSimilarity(left, right) >= 0.55
      || this.textSimilarity(
        left.replace(negation, ''),
        right.replace(negation, ''),
      ) >= 0.55;
  }
}
