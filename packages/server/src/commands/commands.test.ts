/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server 侧斜杠命令层单测：命令路由（未知命令/子命令、bare 用法）、
 * /kb 全链路（add→list→search→remove，OTTO_USER_DIR 隔离到临时目录）、
 * /about、/memory add|show|list（临时 cwd，真实写盘）、/todo、
 * /mcp、/tools（runtime 未初始化的诚实报错）、/init（submit_prompt 形态）。
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { todoStore } from 'otto-core';
import { executeSlashCommand, listSlashCommands } from './registry.js';
import type { CommandHost, SlashOutcome } from './types.js';
import type { SessionStore } from '../sessions.js';

// ── 测试隔离：知识库 / 记忆文件全部落进临时目录，绝不污染真实 ~/.otto-user ──

let tmpUserDir: string;
let tmpCwd: string;
const originalUserDir = process.env['OTTO_USER_DIR'];

beforeEach(() => {
  tmpUserDir = mkdtempSync(path.join(tmpdir(), 'otto-cmd-user-'));
  tmpCwd = mkdtempSync(path.join(tmpdir(), 'otto-cmd-cwd-'));
  process.env['OTTO_USER_DIR'] = tmpUserDir;
  todoStore.clear();
});

afterEach(() => {
  rmSync(tmpUserDir, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
});

afterAll(() => {
  if (originalUserDir === undefined) delete process.env['OTTO_USER_DIR'];
  else process.env['OTTO_USER_DIR'] = originalUserDir;
});

/** 最小假 host：命令只用到声明的窄接口，成员按需覆盖。 */
function makeHost(overrides: Partial<CommandHost> = {}): CommandHost {
  const fakeStore = {
    listSessions: () => [],
    getSession: () => undefined,
    getRuntime: () => undefined,
  } as unknown as SessionStore;
  return {
    store: fakeStore,
    serverVersion: '0.0.0-test',
    protocolVersion: '1',
    uptimeMs: () => 61_000,
    cwd: () => tmpCwd,
    getConfig: () => undefined,
    currentModel: () => undefined,
    modelInfos: () => [],
    mcpServerInfos: () => [],
    extensionSummaries: async () => [],
    ...overrides,
  };
}

/** 便捷执行：断言返回的是 markdown 形态并取出。 */
async function runMd(
  name: string,
  args = '',
  host: CommandHost = makeHost(),
): Promise<{ ok: boolean; markdown: string }> {
  const outcome: SlashOutcome = await executeSlashCommand(
    host,
    's1',
    name,
    args,
  );
  expect(outcome.kind).toBe('markdown');
  if (outcome.kind !== 'markdown') throw new Error('unreachable');
  return outcome;
}

describe('命令路由', () => {
  it('未知命令 → ok:false + 提示', async () => {
    const r = await runMd('nonexistent');
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('未知命令');
    expect(r.markdown).toContain('/nonexistent');
  });

  it('带子命令的命令 bare 调用 → 用法说明（列出子命令）', async () => {
    const r = await runMd('kb');
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain('/kb add');
    expect(r.markdown).toContain('/kb search');
    expect(r.markdown).toContain('/kb list');
    expect(r.markdown).toContain('/kb remove');
  });

  it('未知子命令 → ok:false + 用法', async () => {
    const r = await runMd('kb', 'frobnicate xx');
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('未知子命令');
    expect(r.markdown).toContain('frobnicate');
  });

  it('action 抛异常 → 收敛为 ok:false，不外抛', async () => {
    // /tools 在 getConfig 抛错时不该把异常抛出 executeSlashCommand。
    const host = makeHost({
      getConfig: () => {
        throw new Error('boom');
      },
    });
    const r = await runMd('tools', '', host);
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('boom');
  });

  it('listSlashCommands 暴露完整清单（面板单一事实源）', () => {
    const names = listSlashCommands().map((c) => c.name);
    for (const expected of [
      'about',
      'context',
      'tools',
      'mcp',
      'extensions',
      'kb',
      'memory',
      'todo',
      'compress',
      'init',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('stats');
    // kb/memory 带 usage 提示（面板附注用）。
    const kb = listSlashCommands().find((c) => c.name === 'kb');
    expect(kb?.usage).toContain('kb add|search|list|remove');
  });
});

describe('/kb 全链路（真实读写临时知识库）', () => {
  it('add → list → search → remove', async () => {
    const added = await runMd('kb', 'add --category dev --tags react 报销流程走 OA 系统');
    expect(added.ok).toBe(true);
    expect(added.markdown).toContain('Saved knowledge entry');

    const listed = await runMd('kb', 'list');
    expect(listed.ok).toBe(true);
    expect(listed.markdown).toContain('报销流程走 OA 系统');

    const found = await runMd('kb', 'search 报销');
    expect(found.ok).toBe(true);
    expect(found.markdown).toContain('报销流程走 OA 系统');

    // 从 list 输出提取条目 id（格式 `(id: kb_xxx, ...)`）再删除。
    const idMatch = listed.markdown.match(/id: (kb_[^\s,)]+)/);
    expect(idMatch).not.toBeNull();
    const removed = await runMd('kb', `remove ${idMatch![1]}`);
    expect(removed.ok).toBe(true);
    expect(removed.markdown).toContain('Removed');

    const empty = await runMd('kb', 'list');
    expect(empty.markdown).toContain('empty');
  });

  it('add 缺内容 → 用法错误', async () => {
    const r = await runMd('kb', 'add');
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('用法');
  });

  it('search 缺关键词 → 用法错误', async () => {
    const r = await runMd('kb', 'search');
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('用法');
  });
});

describe('/memory（runtime 未初始化时的文件兜底，真实写盘）', () => {
  it('add 写入项目级 OTTO.md，show/list 能读回', async () => {
    const r = await runMd('memory', 'add 项目用 pnpm 不用 npm');
    expect(r.ok).toBe(true);
    const memPath = path.join(tmpCwd, 'OTTO.md');
    expect(existsSync(memPath)).toBe(true);
    expect(readFileSync(memPath, 'utf-8')).toContain('项目用 pnpm 不用 npm');

    const shown = await runMd('memory', 'show');
    expect(shown.ok).toBe(true);
    expect(shown.markdown).toContain('项目用 pnpm 不用 npm');

    const listed = await runMd('memory', 'list');
    expect(listed.ok).toBe(true);
    expect(listed.markdown).toContain(memPath);
  });

  it('add 缺内容 → 用法错误（零副作用）', async () => {
    const r = await runMd('memory', 'add');
    expect(r.ok).toBe(false);
    expect(existsSync(path.join(tmpCwd, 'OTTO.md'))).toBe(false);
  });

  it('refresh 在 runtime 未初始化时如实说明语义', async () => {
    const r = await runMd('memory', 'refresh');
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain('尚未初始化');
  });
});

describe('/todo（进程级 todoStore 真实读写）', () => {
  it('bare 列出当前任务；clear 清空', async () => {
    todoStore.setTodos([
      { id: '1', content: '写协议帧', status: 'completed', priority: 'high' },
      { id: '2', content: '写单测', status: 'in_progress', priority: 'high' },
    ]);
    const listed = await runMd('todo');
    expect(listed.ok).toBe(true);
    expect(listed.markdown).toContain('写协议帧');
    expect(listed.markdown).toContain('写单测');

    const cleared = await runMd('todo', 'clear');
    expect(cleared.ok).toBe(true);
    expect(todoStore.getTodos()).toEqual([]);
  });

  it('空清单 → 如实说明', async () => {
    const r = await runMd('todo');
    expect(r.markdown).toContain('没有任务清单');
  });
});

describe('信息类命令', () => {
  it('/about 含 core 环境信息与 server 版本', async () => {
    const r = await runMd('about');
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain('关于 Otto');
    expect(r.markdown).toContain('Otto Server: 0.0.0-test');
    expect(r.markdown).toContain('Platform');
  });

  it('/mcp 未配置时给出面板指引', async () => {
    const r = await runMd('mcp');
    expect(r.markdown).toContain('未配置 MCP 服务器');
  });

  it('/mcp 有配置时列出状态', async () => {
    const host = makeHost({
      mcpServerInfos: () => [
        { name: 'figma', status: 'connected', command: 'npx figma-mcp' },
      ],
    });
    const r = await runMd('mcp', '', host);
    expect(r.markdown).toContain('figma');
    expect(r.markdown).toContain('已连接');
  });

  it('/tools 在 runtime 未初始化时诚实报错（不给空列表冒充无工具）', async () => {
    const r = await runMd('tools');
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('尚未初始化');
  });

  it('/extensions 空列表如实说明', async () => {
    const r = await runMd('extensions');
    expect(r.markdown).toContain('未安装扩展');
  });

  it('/context 输出用量表（无 runtime 也能按兜底口径算）', async () => {
    const r = await runMd('context');
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain('上下文用量');
    expect(r.markdown).toContain('系统提示词');
  });
});

describe('/compress 与 /init', () => {
  it('/compress 在 runtime 未初始化时诚实报错', async () => {
    const r = await runMd('compress');
    expect(r.ok).toBe(false);
    expect(r.markdown).toContain('无法压缩');
  });

  it('/init 无 OTTO.md → submit_prompt 形态（转投模型生成）', async () => {
    const outcome = await executeSlashCommand(makeHost(), 's1', 'init', '');
    expect(outcome.kind).toBe('submit_prompt');
    if (outcome.kind === 'submit_prompt') {
      expect(outcome.content).toContain('OTTO.md');
      expect(outcome.note).toContain('分析');
    }
  });

  it('/init 已有 OTTO.md → 如实说明未做改动', async () => {
    writeFileSync(path.join(tmpCwd, 'OTTO.md'), '# 已有记忆\n');
    const r = await runMd('init');
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain('already exists');
  });
});
