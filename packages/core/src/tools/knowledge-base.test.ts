/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * knowledge_base 工具单测：add/search/list/remove 全链路 + 参数校验。
 * 存储经 OTTO_USER_DIR 重定向到临时目录，不污染真实 ~/.otto-user。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { KnowledgeBaseTool } from './knowledge-base.js';

describe('KnowledgeBaseTool', () => {
  let tmpDir: string;
  let savedOttoUserDir: string | undefined;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    savedOttoUserDir = process.env.OTTO_USER_DIR;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kb-tool-test-'));
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

  it('工具名为 knowledge_base', () => {
    expect(KnowledgeBaseTool.Name).toBe('knowledge_base');
  });

  it('add → search → list → remove 全链路', async () => {
    const tool = new KnowledgeBaseTool();

    // add
    const addResult = await tool.execute(
      {
        action: 'add',
        content: 'Otto 的用户目录是 ~/.otto-user',
        category: 'otto',
        tags: ['paths'],
      },
      signal,
    );
    const addText = String(addResult.llmContent);
    expect(addText).toContain('Saved knowledge entry');
    const id = addText.match(/kb_[a-z0-9_]+/)?.[0];
    expect(id).toBeTruthy();

    // 存储确实落在临时目录（不污染真实 ~/.otto-user）
    const raw = await fs.readFile(
      path.join(tmpDir, 'knowledge', 'entries.jsonl'),
      'utf-8',
    );
    expect(raw).toContain(id);

    // search
    const searchResult = await tool.execute(
      { action: 'search', query: '用户目录' },
      signal,
    );
    expect(String(searchResult.llmContent)).toContain('~/.otto-user');
    expect(String(searchResult.llmContent)).toContain(id!);

    // list
    const listResult = await tool.execute({ action: 'list' }, signal);
    expect(String(listResult.llmContent)).toContain('[otto]');

    // remove
    const removeResult = await tool.execute({ action: 'remove', id }, signal);
    expect(String(removeResult.llmContent)).toContain('Removed');

    const afterRemove = await tool.execute(
      { action: 'search', query: '用户目录' },
      signal,
    );
    expect(String(afterRemove.llmContent)).toContain('No knowledge entries matched');
  });

  it('search 支持 category 过滤', async () => {
    const tool = new KnowledgeBaseTool();
    await tool.execute(
      { action: 'add', content: 'keyword beta in dev', category: 'dev' },
      signal,
    );
    await tool.execute(
      { action: 'add', content: 'keyword beta in life', category: 'life' },
      signal,
    );
    const result = await tool.execute(
      { action: 'search', query: 'beta', category: 'life' },
      signal,
    );
    const text = String(result.llmContent);
    expect(text).toContain('in life');
    expect(text).not.toContain('in dev');
  });

  it('remove 不存在的 id 报"未找到"而不是假装成功', async () => {
    const tool = new KnowledgeBaseTool();
    const result = await tool.execute(
      { action: 'remove', id: 'kb_not_exist' },
      signal,
    );
    expect(String(result.llmContent)).toContain('not found');
  });

  describe('参数校验', () => {
    it('add 缺 content 拒绝', async () => {
      const tool = new KnowledgeBaseTool();
      const result = await tool.execute({ action: 'add' }, signal);
      expect(String(result.llmContent)).toContain('content required');
    });

    it('search 缺 query 拒绝', async () => {
      const tool = new KnowledgeBaseTool();
      const result = await tool.execute({ action: 'search' }, signal);
      expect(String(result.llmContent)).toContain('query required');
    });

    it('remove 缺 id 拒绝', async () => {
      const tool = new KnowledgeBaseTool();
      const result = await tool.execute({ action: 'remove' }, signal);
      expect(String(result.llmContent)).toContain('id required');
    });
  });
});
