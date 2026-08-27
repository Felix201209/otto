import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleWorkspace } from './ModuleWorkspace.js';

const modules: readonly ModuleDefinition[] = [
  {
    id: 'park-announcement',
    label: '园区公告',
    category: 'park',
    icon: 'park-announcement',
    activation: { kind: 'dialog', dialog: 'park', target: 'announcement' },
    availability: 'available',
  },
  {
    id: 'park-satisfaction',
    label: '满意度调查',
    category: 'park',
    icon: 'park-satisfaction',
    activation: { kind: 'dialog', dialog: 'park', target: 'satisfaction' },
    availability: 'available',
  },
  {
    id: 'agent-ppt',
    label: 'PPT 创作专家',
    category: 'common',
    icon: 'generated:expert-presentation',
    activation: { kind: 'agent', profileId: 'ppt' },
    availability: 'available',
  },
  {
    id: 'enterprise-memory',
    label: '企业记忆',
    category: 'capability',
    icon: 'enterprise-memory',
    activation: { kind: 'dialog', dialog: 'enterprise-memory' },
    availability: 'available',
  },
];

const enterpriseLayout: ModuleWorkspaceLayout = {
  version: 1,
  groups: [
    {
      id: 'park-services',
      name: '园区服务',
      rows: 2,
      moduleIds: ['park-announcement', 'park-satisfaction'],
    },
    {
      id: 'daily-office',
      name: '日常办公',
      rows: 3,
      moduleIds: ['agent-ppt', 'enterprise-memory'],
    },
  ],
};

function renderWorkspace(
  presentation: 'panel' | 'page' = 'panel',
  layout: ModuleWorkspaceLayout = enterpriseLayout,
) {
  const onActivate = vi.fn();
  const onOpenMarketplace = vi.fn();
  const onLayoutChange = vi.fn();
  const view = render(
    <ModuleWorkspace
      presentation={presentation}
      layout={layout}
      modules={modules}
      onActivate={onActivate}
      onOpenMarketplace={onOpenMarketplace}
      onLayoutChange={onLayoutChange}
    />,
  );
  return { ...view, onActivate, onOpenMarketplace, onLayoutChange };
}

function renderControlledWorkspace() {
  function Harness() {
    const [layout, setLayout] = React.useState(enterpriseLayout);
    return (
      <ModuleWorkspace
        presentation="panel"
        layout={layout}
        defaultLayout={enterpriseLayout}
        modules={modules}
        onActivate={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onLayoutChange={setLayout}
      />
    );
  }
  return render(<Harness />);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ModuleWorkspace', () => {
  it('renders injected enterprise groups in a three-column module grid', () => {
    const { container } = renderWorkspace();

    expect(screen.getByRole('heading', { name: '园区服务' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '日常办公' })).toBeTruthy();
    expect(container.querySelectorAll('.otto-module-group__grid')).toHaveLength(2);
    expect(container.querySelector('.otto-module-group__grid--rows-2')).toBeTruthy();
    expect(container.querySelector('.otto-module-group__grid--rows-3')).toBeTruthy();
  });

  it('activates modules through accessible buttons and opens the matching group marketplace', () => {
    const { onActivate, onOpenMarketplace } = renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: '打开 PPT 创作专家' }));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-ppt' }));

    fireEvent.click(screen.getByRole('button', { name: '向园区服务添加模块' }));
    expect(onOpenMarketplace).toHaveBeenCalledWith('park-services');
  });

  it('renders personal capability fixtures without synthesizing enterprise groups', () => {
    renderWorkspace('panel', {
      version: 1,
      groups: [{
        id: 'daily-office',
        name: '日常办公',
        rows: 2,
        moduleIds: ['agent-ppt'],
      }],
    });

    expect(screen.getByRole('heading', { name: '日常办公' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '园区服务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打开 企业记忆' })).toBeNull();
  });

  it.each(['panel', 'page'] as const)(
    'keeps activation semantics in the %s presentation',
    (presentation) => {
      const { container, onActivate } = renderWorkspace(presentation);
      const workspace = container.querySelector('.otto-module-workspace');

      expect(workspace?.getAttribute('data-presentation')).toBe(presentation);
      fireEvent.click(screen.getByRole('button', { name: '打开 园区公告' }));
      expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'park-announcement' }));
    },
  );

  it('uses a focusable internal scroller for overflowing groups', () => {
    const overflowModules = Array.from({ length: 8 }, (_, index): ModuleDefinition => ({
      id: `module-${index}`,
      label: `模块 ${index + 1}`,
      category: 'common',
      icon: 'agent',
      activation: { kind: 'agent', profileId: `profile-${index}` },
      availability: 'available',
    }));
    const { container } = render(
      <ModuleWorkspace
        presentation="panel"
        layout={{
          version: 1,
          groups: [{
            id: 'overflow',
            name: '超出容量',
            rows: 2,
            moduleIds: overflowModules.map((module) => module.id),
          }],
        }}
        modules={overflowModules}
        onActivate={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onLayoutChange={vi.fn()}
      />,
    );

    const grid = container.querySelector('.otto-module-group__grid');
    expect(grid?.classList.contains('is-overflowing')).toBe(true);
    expect(grid?.getAttribute('tabindex')).toBe('0');
  });

  it('creates a group and supports rename validation and row changes', () => {
    renderControlledWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '添加功能组' }));
    expect(screen.getByRole('heading', { name: '新功能组' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：新功能组' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '重命名' }));
    const input = screen.getByRole('textbox', { name: '功能组名称' });
    fireEvent.change(input, { target: { value: '日常办公' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    expect(screen.getByRole('alert').textContent).toContain('不能重复');
    fireEvent.change(input, { target: { value: '项目协作' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    expect(screen.getByRole('heading', { name: '项目协作' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：项目协作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '显示三行' }));
    expect(document.querySelector('[data-group-id="custom-group"] .otto-module-group__grid--rows-3')).toBeTruthy();
  });

  it('removes a module in edit mode and can undo for five seconds', () => {
    renderControlledWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：园区服务' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑模块' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 园区公告' }));
    expect(screen.queryByRole('button', { name: '打开 园区公告' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '撤销移除' }));
    expect(screen.getByRole('button', { name: '打开 园区公告' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '移除 园区公告' }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByRole('button', { name: '撤销移除' })).toBeNull();
  });

  it('deletes a non-last group only after confirmation and can undo', () => {
    renderControlledWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：园区服务' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '删除功能组' }));
    expect(screen.getByRole('dialog', { name: '删除功能组' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(screen.queryByRole('heading', { name: '园区服务' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '撤销删除' }));
    expect(screen.getByRole('heading', { name: '园区服务' })).toBeTruthy();
  });

  it('restores defaults after confirmation and provides keyboard-friendly group ordering', () => {
    renderControlledWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：日常办公' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '上移功能组' }));
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings.slice(0, 2)).toEqual(['日常办公', '园区服务']);

    fireEvent.click(screen.getByRole('button', { name: '恢复默认布局' }));
    expect(screen.getByRole('dialog', { name: '恢复默认布局' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(screen.getAllByRole('heading', { level: 2 }).slice(0, 2).map((heading) => heading.textContent))
      .toEqual(['园区服务', '日常办公']);
  });

  it('dismisses a group menu on outside click and Escape', () => {
    renderControlledWorkspace();
    const menuButton = screen.getByRole('button', { name: '功能组菜单：园区服务' });
    fireEvent.click(menuButton);
    expect(screen.getByRole('menu', { name: '园区服务设置' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: '园区服务设置' })).toBeNull();
    fireEvent.click(menuButton);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '园区服务设置' })).toBeNull();
  });
});
