/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 斜杠命令单测：
 *   1) 纯函数层：filterCommands 过滤 / parseSlashQuery 命令输入态判定。
 *   2) 组件层（在 Composer 里集成验证真实交互）：命令过滤、方向键选择、
 *      Enter 分流（面板开=执行命令、面板关=发送消息）、Tab 补全执行、Esc 关闭。
 *
 * 交互放到 Composer 里测而非单测 SlashCommands 渲染，是因为键盘导航与 Enter 分流
 * 的逻辑本就在 Composer 的 textarea onKeyDown（焦点须留在 textarea），单独测面板
 * 无法覆盖分流这一核心需求。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { ModelInfo } from 'otto-server';
import {
  filterCommands,
  parseSlashQuery,
  splitSlashInput,
  mergeServerCommands,
  buildHelpMarkdown,
  type SlashCommand,
} from './SlashCommands.js';
import { Composer } from './Composer.js';

const CMDS: SlashCommand[] = [
  { id: 'new', description: '新建会话' },
  { id: 'model', description: '打开模型菜单' },
  { id: 'clear', description: '清空当前会话上下文' },
  { id: 'settings', description: '打开设置面板' },
];

// ── 纯函数层 ────────────────────────────────────────────────────────────────

describe('filterCommands', () => {
  it('空 query（刚敲 /）返回全部命令', () => {
    expect(filterCommands(CMDS, '')).toHaveLength(4);
  });

  it('按命令名前缀过滤（大小写不敏感）', () => {
    expect(filterCommands(CMDS, 'cl').map((c) => c.id)).toEqual(['clear']);
    expect(filterCommands(CMDS, 'S').map((c) => c.id)).toEqual(['settings']);
  });

  it('精确命令优先于更长的前缀命令', () => {
    const commands: SlashCommand[] = [
      { id: 'doctor', description: '依赖体检' },
      { id: 'doc', description: '文档写作专家' },
    ];

    expect(filterCommands(commands, 'doc').map((c) => c.id)).toEqual([
      'doc',
      'doctor',
    ]);
  });

  it('无匹配返回空数组', () => {
    expect(filterCommands(CMDS, 'zzz')).toEqual([]);
  });
});

describe('parseSlashQuery', () => {
  it('以 / 开头且首行 → 返回去掉 / 的 query', () => {
    expect(parseSlashQuery('/')).toBe('');
    expect(parseSlashQuery('/mod')).toBe('mod');
  });

  it('不以 / 开头 → null（非命令态）', () => {
    expect(parseSlashQuery('hello')).toBeNull();
    expect(parseSlashQuery(' /new')).toBeNull();
  });

  it('/ 不在首行（含换行）→ null', () => {
    expect(parseSlashQuery('/new\n后面')).toBeNull();
  });
});

// ── 组件层（Composer 集成）─────────────────────────────────────────────────

const MODELS: ModelInfo[] = [
  { id: 'm1', displayName: '模型一', provider: 'anthropic' },
];

/** 挂一个带全部斜杠命令回调的 Composer，返回 spy 便于断言。 */
function renderComposer(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  const onNewChat = vi.fn();
  const onClearContext = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <Composer
      models={MODELS}
      currentModel="m1"
      sessionId="s1"
      onSend={onSend}
      onSetModel={vi.fn()}
      onNewChat={onNewChat}
      onClearContext={onClearContext}
      onOpenSettings={onOpenSettings}
      {...overrides}
    />,
  );
  const textarea = screen.getByPlaceholderText('给 Otto 发送消息...');
  return { textarea, onSend, onNewChat, onClearContext, onOpenSettings };
}

/** 模拟输入并触发受控更新。 */
function type(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

describe('斜杠命令面板（Composer 集成）', () => {
  it('输入 / 弹出面板并列出全部命令；按名过滤', () => {
    const { textarea } = renderComposer();
    type(textarea, '/');
    expect(screen.getByRole('listbox', { name: '斜杠命令' })).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(4);

    type(textarea, '/cl');
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain('/clear');
  });

  it('非命令输入（不以 / 开头）不弹面板', () => {
    const { textarea } = renderComposer();
    type(textarea, '你好');
    expect(screen.queryByRole('listbox', { name: '斜杠命令' })).toBeNull();
  });

  it('ArrowDown/ArrowUp 移动高亮，Enter 执行选中命令', () => {
    const { textarea, onNewChat, onClearContext, onSend } = renderComposer();
    type(textarea, '/');
    // 首项默认高亮 /new；↓ 两次到 /clear（new→model→clear）。
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    const active = document.querySelector('.otto-slashmenu__item--active');
    expect(active?.textContent).toContain('/clear');

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onClearContext).toHaveBeenCalledTimes(1);
    expect(onNewChat).not.toHaveBeenCalled();
    // 关键：面板打开时的 Enter 不发送消息。
    expect(onSend).not.toHaveBeenCalled();
  });

  it('ArrowUp 从首项回环到末项', () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, '/');
    fireEvent.keyDown(textarea, { key: 'ArrowUp' }); // new → workflow（回环到最后一项）
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toContain('workflow');
  });

  it('Tab 也能补全执行选中命令', () => {
    const { textarea, onNewChat } = renderComposer();
    type(textarea, '/');
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('Esc 关闭面板并保留文本，之后 Enter 变回发送', () => {
    const { textarea, onSend } = renderComposer();
    type(textarea, '/new');
    expect(screen.queryByRole('listbox', { name: '斜杠命令' })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: 'Escape' });
    // 面板收起，文本仍在（可作为普通消息）。
    expect(screen.queryByRole('listbox', { name: '斜杠命令' })).toBeNull();

    // 面板关闭后 Enter = 发送。
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('/new');
  });

  it('面板关闭时（普通文本）Enter 正常发送、执行回调不触发', () => {
    const { textarea, onSend, onNewChat } = renderComposer();
    type(textarea, '普通消息');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('普通消息');
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it('鼠标点击命令项即执行', () => {
    const { textarea, onClearContext } = renderComposer();
    type(textarea, '/');
    const clearOpt = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('/clear'));
    fireEvent.click(clearOpt as HTMLElement);
    expect(onClearContext).toHaveBeenCalledTimes(1);
  });
});

// ── P3：参数态解析 / server 命令合并 / help 总览（纯函数层）──────────────────

describe('splitSlashInput', () => {
  it('无空白 → 全串是 head，非参数态', () => {
    expect(splitSlashInput('kb')).toEqual({
      head: 'kb',
      args: '',
      argMode: false,
    });
  });

  it('命令名后敲了空格即进入参数态（`/kb ` 面板不该消失）', () => {
    expect(splitSlashInput('kb ')).toEqual({
      head: 'kb',
      args: '',
      argMode: true,
    });
  });

  it('空白后的文本原样作为 args（含内部空格）', () => {
    expect(splitSlashInput('kb search 报销 流程')).toEqual({
      head: 'kb',
      args: 'search 报销 流程',
      argMode: true,
    });
  });
});

describe('mergeServerCommands', () => {
  const server = [
    { name: 'kb', description: '知识库', usage: 'kb add|search|list|remove …' },
    { name: 'new', description: 'server 版新建（应被本地遮蔽）' },
  ];

  it('server 独有命令以 action:server 追加，本地同名优先不覆盖', () => {
    const merged = mergeServerCommands(CMDS, server);
    const kb = merged.find((c) => c.id === 'kb');
    expect(kb?.action).toBe('server');
    expect(kb?.usage).toContain('kb add');
    // 本地 'new' 保持原定义（无 action:'server'）。
    const news = merged.filter((c) => c.id === 'new');
    expect(news).toHaveLength(1);
    expect(news[0].description).toBe('新建会话');
  });

  it('server 清单为空时返回本地原样', () => {
    expect(mergeServerCommands(CMDS, [])).toHaveLength(CMDS.length);
  });
});

describe('buildHelpMarkdown', () => {
  it('列出全部命令名与描述', () => {
    const md = buildHelpMarkdown(
      mergeServerCommands(CMDS, [
        { name: 'kb', description: '知识库', usage: 'kb add …' },
      ]),
    );
    expect(md).toContain('`/new`');
    expect(md).toContain('`/kb`');
    expect(md).toContain('知识库');
    expect(md).toContain('`/kb add …`');
  });
});

// ── P3：Composer 集成——参数态锁定命令 + server 分派 ─────────────────────────

describe('Composer server 命令分派', () => {
  const SERVER_CMDS: SlashCommand[] = [
    {
      id: 'kb',
      description: '知识库',
      action: 'server',
      usage: 'kb add|search|list|remove …',
    },
    {
      id: 'memory',
      description: '记忆（裸调开面板）',
      action: 'server',
      bareLocal: true,
    },
  ];

  function renderComposer(overrides: Record<string, unknown> = {}) {
    const onRunServerCommand = vi.fn();
    const onOpenMemory = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        models={[] as ModelInfo[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={() => {}}
        commands={SERVER_CMDS}
        onRunServerCommand={onRunServerCommand}
        onOpenMemory={onOpenMemory}
        {...overrides}
      />,
    );
    return { onRunServerCommand, onOpenMemory, onSend };
  }

  it('`/kb search 报销` Enter → 发 run_server（name+args），不发消息', () => {
    const { onRunServerCommand, onSend } = renderComposer();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/kb search 报销' } });
    // 参数态：面板锁定 kb 一条（textarea 文本也含 /kb，须用 option 角色定位）。
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('/kb');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onRunServerCommand).toHaveBeenCalledWith('kb', 'search 报销');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('`/kb `（带尾空格）仍锁定 kb，Enter 以空参执行', () => {
    const { onRunServerCommand } = renderComposer();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/kb ' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('/kb');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onRunServerCommand).toHaveBeenCalledWith('kb', '');
  });

  it('bareLocal：`/memory` 裸调走本地面板，`/memory add x` 走 server', () => {
    const { onRunServerCommand, onOpenMemory } = renderComposer();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/memory' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onOpenMemory).toHaveBeenCalledTimes(1);
    expect(onRunServerCommand).not.toHaveBeenCalled();

    fireEvent.change(ta, { target: { value: '/memory add 用 pnpm' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onRunServerCommand).toHaveBeenCalledWith('memory', 'add 用 pnpm');
  });
});
