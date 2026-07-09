/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * LocalKnowledgeStore 单测。全部走临时目录（OTTO_USER_DIR 环境变量重定向，
 * 与 customModelsStorage 的测试隔离惯例一致），绝不污染真实 ~/.otto-user。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  LocalKnowledgeStore,
  getKnowledgeDir,
} from './localKnowledgeStore.js';

describe('LocalKnowledgeStore', () => {
  let tmpDir: string;
  let savedOttoUserDir: string | undefined;

  beforeEach(async () => {
    savedOttoUserDir = process.env.OTTO_USER_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kb-store-test-'));
    process.env.OTTO_USER_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedOttoUserDir === undefined) {
      delete process.env.OTTO_USER_DIR;
    } else {
      process.env.OTTO_USER_DIR = savedOttoUserDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('getKnowledgeDir 尊重 OTTO_USER_DIR，落在临时目录内', () => {
    expect(getKnowledgeDir()).toBe(path.join(tmpDir, 'knowledge'));
  });

  describe('add', () => {
    it('新增条目并持久化到 entries.jsonl（新实例可读回）', async () => {
      const store = new LocalKnowledgeStore();
      const entry = await store.add('dev', 'React hooks 不能放在条件语句里', [
        'react',
        'hooks',
      ]);

      expect(entry.id).toMatch(/^kb_/);
      expect(entry.category).toBe('dev');
      expect(entry.tags).toEqual(['react', 'hooks']);
      expect(entry.createdAt).toBeTruthy();

      // 文件真的写在临时目录里
      const filePath = path.join(tmpDir, 'knowledge', 'entries.jsonl');
      const raw = await fs.readFile(filePath, 'utf-8');
      expect(raw).toContain(entry.id);

      // 持久化验证：换一个新实例仍能读到
      const reloaded = await new LocalKnowledgeStore().loadAll();
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].content).toBe('React hooks 不能放在条件语句里');
    });

    it('空内容拒绝；空分类归为 general', async () => {
      const store = new LocalKnowledgeStore();
      await expect(store.add('dev', '   ')).rejects.toThrow('empty');
      const entry = await store.add('', 'some content');
      expect(entry.category).toBe('general');
    });
  });

  describe('search', () => {
    it('关键词命中内容/标签/分类，按相关度排序', async () => {
      const store = new LocalKnowledgeStore();
      await store.add('dev', 'TypeScript strict mode saves lives', ['typescript']);
      await store.add('dev', 'React useEffect cleanup 防内存泄漏', ['react']);
      await store.add('life', '周三买菜便宜');

      const results = await store.search('react useEffect');
      expect(results.length).toBeGreaterThan(0);
      // 整句 + 双 token 全命中的那条应排最前
      expect(results[0].content).toContain('useEffect');
      expect(results[0].score).toBeGreaterThan(0);
      // 不相关条目不出现
      expect(results.some((r) => r.content.includes('买菜'))).toBe(false);
    });

    it('中文整句子串匹配可命中（无空格分词场景）', async () => {
      const store = new LocalKnowledgeStore();
      await store.add('dev', '飞书机器人需要开通 im:message 权限');
      const results = await store.search('飞书机器人');
      expect(results).toHaveLength(1);
    });

    it('category 参数过滤分类', async () => {
      const store = new LocalKnowledgeStore();
      await store.add('dev', 'shared keyword alpha');
      await store.add('life', 'shared keyword alpha too');
      const results = await store.search('alpha', 'dev');
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe('dev');
    });

    it('空 query 返回空；最多返回 20 条', async () => {
      const store = new LocalKnowledgeStore();
      for (let i = 0; i < 25; i++) {
        await store.add('dev', `common keyword entry ${i}`);
      }
      expect(await store.search('   ')).toEqual([]);
      const results = await store.search('common keyword');
      expect(results).toHaveLength(20);
    });
  });

  describe('list', () => {
    it('按时间倒序返回并尊重 limit', async () => {
      const store = new LocalKnowledgeStore();
      const first = await store.add('dev', 'older entry');
      // createdAt 是毫秒级 ISO；隔 5ms 保证顺序可判定
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await store.add('dev', 'newer entry');

      const all = await store.list();
      expect(all.map((e) => e.id)).toEqual([second.id, first.id]);

      const limited = await store.list(1);
      expect(limited).toHaveLength(1);
      expect(limited[0].id).toBe(second.id);
    });
  });

  describe('remove', () => {
    it('删除存在的条目返回 true 且持久化；不存在返回 false', async () => {
      const store = new LocalKnowledgeStore();
      const a = await store.add('dev', 'to be removed');
      const b = await store.add('dev', 'to be kept');

      expect(await store.remove(a.id)).toBe(true);
      expect(await store.remove('kb_not_exist')).toBe(false);

      const remaining = await new LocalKnowledgeStore().loadAll();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(b.id);
    });
  });

  describe('loadAll 容错', () => {
    it('文件不存在视为空库；坏行跳过不炸', async () => {
      const store = new LocalKnowledgeStore();
      expect(await store.loadAll()).toEqual([]);

      const dir = path.join(tmpDir, 'knowledge');
      await fs.mkdir(dir, { recursive: true });
      const good = JSON.stringify({
        id: 'kb_ok',
        category: 'dev',
        content: 'good line',
        tags: [],
        createdAt: new Date().toISOString(),
      });
      await fs.writeFile(
        path.join(dir, 'entries.jsonl'),
        `${good}\nnot-json-at-all\n{"id":123}\n`,
        'utf-8',
      );
      const entries = await store.loadAll();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('kb_ok');
    });
  });
});
