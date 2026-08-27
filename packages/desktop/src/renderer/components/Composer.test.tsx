/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Composer 模型菜单单测（搜索 / 分组）：
 *   BYO-key 用户接多个 provider 后模型列表会很长。模型数超过阈值（8）才在菜单顶部
 *   加搜索框并按 provider 分组；少量模型仍平铺、无搜索噪声。搜索按 displayName 过滤，
 *   且不破坏当前模型的勾选高亮。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react';
import type { ModelInfo } from 'otto-server';
import { Composer, insertComposerDraft } from './Composer.js';
import * as transport from '../transport.js';

/** 造 n 个模型（跨两个 provider），displayName 形如「模型-01」。 */
function makeModels(n: number): ModelInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    displayName: `模型-${String(i + 1).padStart(2, '0')}`,
    provider: i % 2 === 0 ? 'anthropic' : 'openai',
  }));
}

function renderComposer(models: ModelInfo[], current: string | null) {
  render(
    <Composer
      models={models}
      currentModel={current}
      sessionId="s1"
      onSend={vi.fn()}
      onSetModel={vi.fn()}
    />,
  );
}

/** 打开模型菜单：点 model pill（可访问名取当前模型 displayName，改用 class 定位更稳）。 */
function openMenu() {
  const pill = document.querySelector('.otto-modelpill');
  fireEvent.click(pill as Element);
  return screen.getByRole('listbox', { name: '选择模型' });
}

describe('输入区工具布局与弹层', () => {
  it('工作目录和授权位于输入面板上方，模型位于发送按钮左侧，且无独立文件夹按钮', () => {
    const { container } = render(
      <Composer
        models={makeModels(2)}
        currentModel="m0"
        sessionId="s1"
        workspacePath="/Users/yang/project"
        recentWorkspacePaths={['/Users/yang/project']}
        onSetWorkspace={vi.fn()}
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    const contextBar = container.querySelector('.otto-composer__contextbar');
    expect(contextBar?.querySelector('.otto-workspace')).not.toBeNull();
    expect(contextBar?.querySelector('.otto-authorization')).not.toBeNull();
    expect(container.querySelector('[aria-label="添加文件夹"]')).toBeNull();
    const bar = container.querySelector('.otto-composer__bar')!;
    const model = bar.querySelector('.otto-modelpill')!;
    const send = bar.querySelector('.otto-send')!;
    expect(model.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('同一时间只打开一个列表，点击列表外或按 Esc 会关闭', () => {
    render(
      <Composer
        models={makeModels(2)}
        currentModel="m0"
        sessionId="s1"
        workspacePath="/Users/yang/project"
        recentWorkspacePaths={['/Users/yang/project']}
        onSetWorkspace={vi.fn()}
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^工作目录：/ }));
    expect(screen.getByRole('menu', { name: '选择工作目录' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /执行授权/ }));
    expect(screen.queryByRole('menu', { name: '选择工作目录' })).toBeNull();
    expect(screen.getByRole('menu', { name: '选择执行授权方式' })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: '选择执行授权方式' })).toBeNull();
    fireEvent.click(document.querySelector('.otto-modelpill') as Element);
    expect(screen.getByRole('listbox', { name: '选择模型' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: '选择模型' })).toBeNull();
  });

  it('回形针菜单同时保留添加文件与目录附件能力', () => {
    render(
      <Composer models={[]} currentModel={null} sessionId="s1" onSend={vi.fn()} onSetModel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    expect(screen.getByRole('menuitem', { name: '添加文件或图片' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '添加文件夹作为附件' })).toBeTruthy();
  });

  it('原生工作目录选择失败时给出非阻断错误，用户取消保持静默', async () => {
    const selectWorkspaceDirectory = vi.fn()
      .mockRejectedValueOnce(new Error('无法读取该目录'))
      .mockResolvedValueOnce(null);
    const getWorkspaceDirectories = vi.fn(async () => ({
      defaultPath: '/Users/yang',
      recentPaths: ['/Users/yang'],
    }));
    Object.assign(window.otto, { selectWorkspaceDirectory, getWorkspaceDirectories });
    const { rerender } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        workspacePath="/Users/yang"
        onSetWorkspace={vi.fn()}
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^工作目录：/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /添加工作目录/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('无法读取该目录');

    fireEvent.click(screen.getByRole('menuitem', { name: /添加工作目录/ }));
    await waitFor(() => expect(selectWorkspaceDirectory).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('alert').textContent).toContain('无法读取该目录');

    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        workspacePath="/Users/yang/next"
        onSetWorkspace={vi.fn()}
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('专家提示词草稿', () => {
  it('填入后不自动发送，用户可修改再发送', () => {
    const onSend = vi.fn();
    render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="expert-session"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    const textarea = document.querySelector('.otto-composer__textarea') as HTMLTextAreaElement;

    act(() => insertComposerDraft('请作为「PPT 创作专家」协助我'));
    expect(textarea.value).toContain('PPT 创作专家');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: '帮我做一份产品发布会 PPT' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('帮我做一份产品发布会 PPT', []);
  });
});

describe('PPT 专家内置入口', () => {
  it('/ppt 直接新建绑定 ppt profile 的专家会话，不再给普通会话发送提示词', () => {
    const onSend = vi.fn();
    const onLaunchAgentProfile = vi.fn();
    render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
        onLaunchAgentProfile={onLaunchAgentProfile}
      />,
    );
    const textarea = document.querySelector(
      '.otto-composer__textarea',
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '/ppt' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onLaunchAgentProfile).toHaveBeenCalledWith(
      'ppt',
      'PPT 创作专家',
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('/doc 直接新建绑定 doc profile 的 Word 专家会话', () => {
    const onSend = vi.fn();
    const onLaunchAgentProfile = vi.fn();
    render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
        onLaunchAgentProfile={onLaunchAgentProfile}
      />,
    );
    const textarea = document.querySelector(
      '.otto-composer__textarea',
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '/doc' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onLaunchAgentProfile).toHaveBeenCalledWith(
      'doc',
      '文档写作专家',
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('/pdf 和 /excel 也直接新建绑定专家 profile 的会话', () => {
    const onSend = vi.fn();
    const onLaunchAgentProfile = vi.fn();
    render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
        onLaunchAgentProfile={onLaunchAgentProfile}
      />,
    );
    const textarea = document.querySelector(
      '.otto-composer__textarea',
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: '/pdf' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    fireEvent.change(textarea, { target: { value: '/excel' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onLaunchAgentProfile).toHaveBeenNthCalledWith(
      1,
      'pdf',
      'PDF 处理专家',
    );
    expect(onLaunchAgentProfile).toHaveBeenNthCalledWith(
      2,
      'sheet',
      'Excel 数据表格专家',
    );
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('模型菜单搜索框显隐（阈值 8）', () => {
  it('模型数 ≤ 8：不显示搜索框，平铺全部', () => {
    renderComposer(makeModels(8), 'm0');
    openMenu();
    expect(screen.queryByLabelText('搜索模型')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(8);
  });

  it('模型数 > 8：显示搜索框', () => {
    renderComposer(makeModels(9), 'm0');
    openMenu();
    expect(screen.getByLabelText('搜索模型')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(9);
  });
});

describe('旧企业模型显示迁移', () => {
  it('会话残留的 otto 模型不存在时，显示首个可用的个人 API 模型', () => {
    renderComposer(makeModels(2), 'otto:deepseek');
    expect(document.querySelector('.otto-modelpill')?.textContent).toContain('模型-01');
    expect(document.querySelector('.otto-modelpill')?.textContent).not.toContain('otto:deepseek');
  });
});

describe('执行授权菜单', () => {
  it('默认全局自动，并可降级到当前会话或手动后再恢复', () => {
    const send = vi.spyOn(transport, 'send').mockImplementation(() => {});
    localStorage.clear();
    renderComposer([], null);
    fireEvent.click(screen.getByRole('button', { name: '执行授权：所有会话自动' }));
    expect(document.querySelector('.otto-authorization__option-icon--manual path[d^="M18 11V6"]')).toBeTruthy();
    expect(document.querySelector('.otto-authorization__option-icon--session path[d="M8 12h.01M12 12h.01M16 12h.01"]')).toBeTruthy();
    expect(document.querySelector('.otto-authorization__option-icon--global path[d="m9 12 2 2 4-4"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /自动授权（仅当前会话）/ }));
    expect(localStorage.getItem('otto.authorization.global-auto')).toBe('0');
    expect(send.mock.calls.slice(-2).map(([message]) => message)).toEqual([
      {
        type: 'set_authorization_mode',
        payload: { sessionId: 's1', mode: 'manual', scope: 'all' },
      },
      {
        type: 'set_authorization_mode',
        payload: { sessionId: 's1', mode: 'auto', scope: 'session' },
      },
    ]);
    expect(send).toHaveBeenLastCalledWith({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'auto', scope: 'session' },
    });
    expect(screen.getByRole('button', { name: '执行授权：当前会话自动' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '执行授权：当前会话自动' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /手动授权/ }));
    expect(send).toHaveBeenLastCalledWith({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'manual', scope: 'session' },
    });
    expect(screen.getByRole('button', { name: '执行授权：手动授权' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '执行授权：手动授权' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /自动授权（所有会话）/ }));
    expect(localStorage.getItem('otto.authorization.global-auto')).toBe('1');
    expect(send).toHaveBeenLastCalledWith({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'auto', scope: 'all' },
    });
  });

  it('离开仅当前会话自动的会话时在服务端 fail closed 回手动', () => {
    const send = vi.spyOn(transport, 'send').mockImplementation(() => {});
    localStorage.setItem('otto.authorization.global-auto', '0');
    const props = {
      models: [] as ModelInfo[],
      currentModel: null,
      onSend: vi.fn(),
      onSetModel: vi.fn(),
    };
    const view = render(<Composer {...props} sessionId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: '执行授权：手动授权' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /自动授权（仅当前会话）/ }));
    send.mockClear();

    view.rerender(<Composer {...props} sessionId="s2" />);

    expect(send).toHaveBeenCalledWith({
      type: 'set_authorization_mode',
      payload: { sessionId: 's1', mode: 'manual', scope: 'session' },
    });
    expect(screen.getByRole('button', { name: '执行授权：手动授权' })).toBeTruthy();
  });
});

describe('模型菜单搜索过滤', () => {
  it('按 displayName 过滤（大小写 / 子串匹配）', () => {
    renderComposer(makeModels(12), 'm0');
    openMenu();
    const search = screen.getByLabelText('搜索模型');
    // 「模型-01」匹配 1 项。
    fireEvent.change(search, { target: { value: '模型-01' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain('模型-01');
  });

  it('无匹配时显示「未找到」提示、无选项', () => {
    renderComposer(makeModels(12), 'm0');
    openMenu();
    fireEvent.change(screen.getByLabelText('搜索模型'), {
      target: { value: 'zzz不存在' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('未找到匹配的模型')).toBeTruthy();
  });
});

describe('每会话草稿隔离', () => {
  const ta = () =>
    document.querySelector('.otto-composer__textarea') as HTMLTextAreaElement;

  it('切换会话时各自保留未发送的草稿，切回原样复现', () => {
    const { rerender } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );

    // 在 s1 打一段草稿。
    fireEvent.change(ta(), { target: { value: 'draft-for-s1' } });
    expect(ta().value).toBe('draft-for-s1');

    // 切到 s2：不该串到 s1 的草稿，应是空的。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('');

    // 在 s2 打另一段草稿。
    fireEvent.change(ta(), { target: { value: 'draft-for-s2' } });
    expect(ta().value).toBe('draft-for-s2');

    // 切回 s1：恢复 s1 自己的草稿。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('draft-for-s1');

    // 再切回 s2：恢复 s2 自己的草稿。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('draft-for-s2');
  });

  it('发送后清空，切走再切回不残留已发送内容', () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );

    fireEvent.change(ta(), { target: { value: 'hello' } });
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello', []);
    expect(ta().value).toBe('');

    // 切走再切回 s1：草稿表里不该残留已发送的 'hello'。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('');
  });
});

describe('停止生成按钮', () => {
  it('busy 时保持可点击并触发 onCancel', () => {
    const onCancel = vi.fn();
    render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        busy
        onSend={vi.fn()}
        onCancel={onCancel}
        onSetModel={vi.fn()}
      />,
    );

    const stop = screen.getByRole('button', { name: '停止生成' });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('模型菜单 provider 分组与勾选', () => {
  it('多 provider 时出现分组标题', () => {
    renderComposer(makeModels(10), 'm0');
    const menu = openMenu();
    // 两个 provider 各成一组；用 class 精确取分组标题（避免撞到每项的 provider 副标签）。
    const heads = Array.from(
      menu.querySelectorAll('.otto-modelmenu__grouphead'),
    ).map((el) => el.textContent);
    expect(heads).toContain('anthropic');
    expect(heads).toContain('openai');
  });

  it('当前模型仍被勾选高亮（分组不破坏 active 态）', () => {
    renderComposer(makeModels(10), 'm3');
    const menu = openMenu();
    const active = menu.querySelector('.otto-modelmenu__item--active');
    expect(active).toBeTruthy();
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.textContent).toContain('模型-04'); // m3 → 第 4 个
  });
});

describe('语音录音配件', () => {
  it('输入栏不再展示语音输入图标入口', () => {
    render(
      <Composer models={[]} currentModel={null} sessionId="s1" onSend={vi.fn()} onSetModel={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: '语音输入' })).toBeNull();
  });
});

describe('附件预览卡片', () => {
  it('普通文件以横向卡片展示类型、单行文件名、大小和独立删除按钮', async () => {
    const { container } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(
      [new Uint8Array(1536)],
      '产品销售数据汇总与下一季度预测.xlsx',
      {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    );

    fireEvent.change(input, { target: { files: [file] } });

    const displayName = '产品销售数据汇总与下一季度预测';
    const fileName = await screen.findByText(displayName);
    const card = fileName.closest('.otto-attachment');
    expect(card?.classList.contains('otto-attachment--file')).toBe(true);
    const typeIcon = card?.querySelector('.otto-attachment__type-icon');
    expect(typeIcon?.textContent).toBe('EXCEL');
    expect(typeIcon?.getAttribute('data-type')).toBe('EXCEL');
    expect(fileName.classList.contains('otto-attachment__file-name')).toBe(true);
    expect(fileName.getAttribute('title')).toBe(file.name);
    expect(fileName.textContent).not.toContain('.xlsx');
    expect(card?.querySelector('.otto-attachment__meta')?.textContent).toContain(
      '1.5 KB',
    );

    const remove = screen.getByRole('button', { name: `移除 ${file.name}` });
    expect(card?.lastElementChild).toBe(remove);
    fireEvent.click(remove);
    expect(screen.queryByText(displayName)).toBeNull();
  });

  it('原生选择的目录以目录卡片展示并作为 folder_reference 附件发送', async () => {
    const onSend = vi.fn();
    const folderPath = 'C:\\Users\\tester\\Documents\\客户资料';
    const selectFolders = vi.fn(async () => [folderPath]);
    Object.assign(window.otto, { selectFolders });
    render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '添加文件夹作为附件' }));
    const folderName = await screen.findByText('客户资料');
    const card = folderName.closest('.otto-attachment');
    expect(selectFolders).toHaveBeenCalledTimes(1);
    expect(card?.classList.contains('otto-attachment--folder')).toBe(true);
    expect(card?.querySelector('.otto-attachment__type-icon')?.textContent).toBe('DIR');
    expect(await screen.findByTitle(folderPath)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('', [
      { folderName: '客户资料', folderPath },
    ]);
  });

  it('拖入外部卷文件时通过 webUtils 保留真实路径并随消息发送', async () => {
    const onSend = vi.fn();
    const externalPath = '/Volumes/Portable/客户资料/园区方案.pdf';
    Object.assign(window.otto, {
      authorizeFileForAttachment: vi.fn(async () => externalPath),
    });
    const { container } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    const file = new File([new Uint8Array(2048)], '园区方案.pdf', {
      type: 'application/pdf',
    });

    fireEvent.drop(container.querySelector('.otto-composer') as Element, {
      dataTransfer: { files: [file], types: ['Files'] },
    });

    expect(await screen.findByTitle(externalPath)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSend).toHaveBeenCalledWith('', [
      { fileName: '园区方案.pdf', filePath: externalPath },
    ]);
  });

  it('拖入文件若无法由 preload/main 授权，不会附加或发送裸路径', async () => {
    const onSend = vi.fn();
    Object.assign(window.otto, {
      authorizeFileForAttachment: vi.fn(async () => {
        throw new Error('文件未获得授权');
      }),
    });
    const { container } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    const file = new File(['x'], '机密.pdf', { type: 'application/pdf' });

    fireEvent.drop(container.querySelector('.otto-composer') as Element, {
      dataTransfer: { files: [file], types: ['Files'] },
    });

    expect(await screen.findByText('文件未获得授权')).toBeTruthy();
    expect(screen.queryByText('机密')).toBeNull();
    expect(screen.getByRole('button', { name: '发送' }).getAttribute('disabled')).not.toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('右键粘贴使用系统剪贴板并插入当前输入位置', async () => {
    const read = vi.fn(async () => [{
      types: ['text/plain'],
      getType: vi.fn(async () => new Blob(['粘贴内容'], { type: 'text/plain' })),
    }]);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read, readText: vi.fn(), writeText: vi.fn() },
    });
    const { container } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );

    fireEvent.contextMenu(container.querySelector('.otto-composer') as Element, {
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(screen.getByRole('button', { name: '粘贴' }));

    await waitFor(() => {
      expect((container.querySelector('.otto-composer__textarea') as HTMLTextAreaElement).value)
        .toBe('粘贴内容');
    });
    expect(read).toHaveBeenCalledOnce();
  });
});
