import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', async () => {
  const ReactModule = await import('react');
  const useReducedMotion = vi.fn(() => false);
  return {
    useReducedMotion,
    useDragControls: () => ({ start: vi.fn() }),
    Reorder: {
      Group: ({
        as: _as,
        axis: _axis,
        layoutScroll: _layoutScroll,
        values,
        onReorder,
        children,
        ...props
      }: React.HTMLAttributes<HTMLDivElement> & {
        as?: string;
        axis?: string;
        layoutScroll?: boolean;
        values: string[];
        onReorder(values: string[]): void;
      }) => ReactModule.createElement('div', {
        ...props,
        onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => {
          event.stopPropagation();
          onReorder([...values].reverse());
        },
      }, children),
      Item: ({
        as: _as,
        value: _value,
        dragControls: _dragControls,
        dragListener: _dragListener,
        layout: _layout,
        whileDrag: _whileDrag,
        transition: _transition,
        children,
        ...props
      }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => (
        ReactModule.createElement('div', props, children as React.ReactNode)
      ),
    },
  };
});

// Motion exposes its React runtime through this documented package entrypoint.
// eslint-disable-next-line import/no-internal-modules
import { useReducedMotion } from 'motion/react';
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
];

const layout: ModuleWorkspaceLayout = {
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
      rows: 2,
      moduleIds: ['agent-ppt'],
    },
  ],
};

describe('ModuleWorkspace drag reorder contract', () => {
  it('keeps group reorder transient until drag end, then persists once', () => {
    const onLayoutChange = vi.fn();
    const { container } = render(
      <ModuleWorkspace
        presentation="panel"
        layout={layout}
        modules={modules}
        onActivate={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onLayoutChange={onLayoutChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：园区服务' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑模块' }));
    const groupList = container.querySelector('[data-reorder-group="groups"]');
    expect(groupList).toBeTruthy();

    fireEvent.doubleClick(groupList!);
    expect(onLayoutChange).not.toHaveBeenCalled();
    fireEvent.dragEnd(container.querySelector('[data-reorder-group-item="daily-office"]')!);
    expect(onLayoutChange).toHaveBeenCalledOnce();
    expect(onLayoutChange.mock.calls[0][0].groups.map((group: { id: string }) => group.id))
      .toEqual(['daily-office', 'park-services']);
  });

  it('keeps module reorder inside its group and persists only on drop', () => {
    const onLayoutChange = vi.fn();
    const { container } = render(
      <ModuleWorkspace
        presentation="panel"
        layout={layout}
        modules={modules}
        onActivate={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onLayoutChange={onLayoutChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：园区服务' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑模块' }));
    const moduleGrid = container.querySelector('[data-reorder-group="modules:park-services"]');
    expect(moduleGrid).toBeTruthy();

    fireEvent.doubleClick(moduleGrid!);
    expect(onLayoutChange).not.toHaveBeenCalled();
    fireEvent.dragEnd(container.querySelector('[data-reorder-module-item="park-services:park-satisfaction"]')!);
    expect(onLayoutChange).toHaveBeenCalledOnce();
    expect(onLayoutChange.mock.calls[0][0].groups[0].moduleIds)
      .toEqual(['park-satisfaction', 'park-announcement']);
    expect(onLayoutChange.mock.calls[0][0].groups[1].moduleIds).toEqual(['agent-ppt']);
  });

  it('keeps the minimal edit controls for reduced-motion users', () => {
    vi.mocked(useReducedMotion).mockReturnValue(true);
    const { container } = render(
      <ModuleWorkspace
        presentation="panel"
        layout={layout}
        modules={modules}
        onActivate={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onLayoutChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '功能组菜单：园区服务' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '编辑模块' }));
    expect(container.querySelector('.otto-module-workspace.is-reduced-motion')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '拖动功能组：园区服务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拖动模块：园区公告' })).toBeNull();
    expect(screen.getByRole('button', { name: '移除 园区公告' })).toBeTruthy();
  });

  it('auto-scrolls the nearest group scroller when dragging near its edge', () => {
    const { container } = render(
      <ModuleWorkspace
        presentation="panel"
        layout={layout}
        modules={modules}
        onActivate={vi.fn()}
        onOpenMarketplace={vi.fn()}
        onLayoutChange={vi.fn()}
      />,
    );
    const groupList = container.querySelector<HTMLElement>('[data-reorder-group="groups"]')!;
    Object.defineProperty(groupList, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(groupList, 'clientHeight', { configurable: true, value: 300 });
    groupList.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 300, width: 320, height: 300,
      toJSON: () => ({}),
    });
    groupList.scrollTop = 100;

    const bottomMove = new Event('pointermove', { bubbles: true });
    Object.defineProperty(bottomMove, 'clientY', { value: 295 });
    fireEvent(groupList, bottomMove);
    expect(groupList.scrollTop).toBeGreaterThan(100);
    const topMove = new Event('pointermove', { bubbles: true });
    Object.defineProperty(topMove, 'clientY', { value: 2 });
    fireEvent(groupList, topMove);
    expect(groupList.scrollTop).toBeLessThan(120);
  });
});
