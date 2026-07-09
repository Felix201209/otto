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
}

/** 检索结果：条目 + 相关度分（越大越相关） */
export interface KnowledgeSearchResult extends KnowledgeEntry {
  score: number;
}

const KNOWLEDGE_DIR_NAME = 'knowledge';
const ENTRIES_FILE_NAME = 'entries.jsonl';
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_LIST_LIMIT = 20;

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
  return score;
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
          entries.push({
            ...parsed,
            tags: Array.isArray(parsed.tags) ? parsed.tags : [],
            createdAt:
              typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
          });
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
  ): Promise<KnowledgeEntry> {
    const trimmedContent = (content ?? '').trim();
    if (!trimmedContent) {
      throw new Error('knowledge content cannot be empty');
    }
    const entry: KnowledgeEntry = {
      id: generateId(),
      category: (category ?? '').trim() || 'general',
      content: trimmedContent,
      tags: (tags ?? []).map((tag) => String(tag).trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
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
      .map((entry) => ({ ...entry, score: scoreEntry(entry, q) }))
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
      const tmpPath = `${this.filePath}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const body =
        remaining.map((entry) => JSON.stringify(entry)).join('\n') +
        (remaining.length > 0 ? '\n' : '');
      await fs.writeFile(tmpPath, body, 'utf-8');
      await fs.rename(tmpPath, this.filePath);
      return true;
    });
  }
}
