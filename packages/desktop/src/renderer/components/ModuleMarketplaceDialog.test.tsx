import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleWorkspaceLayout } from '../moduleWorkspace.js';
import { ModuleMarketplaceDialog } from './ModuleMarketplaceDialog.js';

const modules: readonly ModuleDefinition[] = [
  {
    id: 'park-announcement', label: '园区公告', category: 'park', icon: 'park-announcement',
    activation: { kind: 'dialog', dialog: 'park', target: 'announcement' }, availability: 'available',
  },
  {
    id: 'agent-ppt', label: 'PPT 创作专家', category: 'common', icon: 'agent',
    activation: { kind: 'agent', profileId: 'ppt' }, availability: 'available',
  },
  {
    id: 'enterprise-memory', label: '企业记忆', category: 'capability', icon: 'enterprise-memory',
    activation: { kind: 'dialog', dialog: 'enterprise-memory' }, availability: 'disabled',
    disabledReason: '需要企业知识库权限',
  },
  {
    id: 'agent-custom', label: '客户成功助手', category: 'custom-agent', icon: 'custom-agent',
    activation: { kind: 'agent', profileId: 'otto-enterprise-work', customAgentId: 'custom' },
    availability: 'available',
  },
];

const layout: ModuleWorkspaceLayout = {
  version: 1,
  groups: [
    { id: 'park-services', name: '园区服务', rows: 2, moduleIds: ['park-announcement'] },
    { id: 'daily-office', name: '日常办公', rows: 2, moduleIds: ['agent-ppt'] },
  ],
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof ModuleMarketplaceDialog>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const onManageExperts = vi.fn();
  const view = render(
    <ModuleMarketplaceDialog
      open
      targetGroupId="park-services"
      layout={layout}
      modules={modules}
      onConfirm={onConfirm}
      onClose={onClose}
      onManageExperts={onManageExperts}
      {...overrides}
    />,
  );
  return { ...view, onConfirm, onClose, onManageExperts };
}

describe('ModuleMarketplaceDialog', () => {
  it('searches categories and applies a multi-select draft only on confirmation', () => {
    const { onConfirm } = renderDialog();
    expect(screen.getByRole('heading', { name: '常用' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '园区服务' })).toBeTruthy();

    const current = screen.getByRole('checkbox', { name: '园区公告' }) as HTMLInputElement;
    expect(current.checked).toBe(true);
    expect(current.disabled).toBe(true);

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索模块' }), {
      target: { value: 'PPT' },
    });
    const ppt = screen.getByRole('checkbox', { name: 'PPT 创作专家' });
    expect(screen.queryByRole('checkbox', { name: '园区公告' })).toBeNull();
    fireEvent.click(ppt);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '添加（1）' }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      groups: [
        expect.objectContaining({
          id: 'park-services',
          moduleIds: ['park-announcement', 'agent-ppt'],
        }),
        expect.objectContaining({ id: 'daily-office', moduleIds: [] }),
      ],
    }));
  });

  it('explains moves and unavailable modules, and exposes expert management', () => {
    const { onManageExperts } = renderDialog();
    const pptRow = screen.getByRole('checkbox', { name: 'PPT 创作专家' }).closest('label');
    expect(pptRow?.textContent).toContain('将从“日常办公”移动');

    const memory = screen.getByRole('checkbox', { name: '企业记忆' }) as HTMLInputElement;
    expect(memory.disabled).toBe(true);
    expect(memory.closest('label')?.textContent).toContain('需要企业知识库权限');

    fireEvent.click(screen.getByRole('button', { name: '创建专家模块' }));
    expect(onManageExperts).toHaveBeenCalledTimes(1);
  });

  it('uses group identity rather than duplicate display names for module ownership', () => {
    renderDialog({
      targetGroupId: 'second',
      layout: {
        version: 1,
        groups: [
          { id: 'first', name: '重复名称', rows: 2, moduleIds: ['agent-ppt'] },
          { id: 'second', name: '重复名称', rows: 2, moduleIds: [] },
        ],
      },
    });

    const ppt = screen.getByRole('checkbox', { name: 'PPT 创作专家' }) as HTMLInputElement;
    expect(ppt.disabled).toBe(false);
    expect(ppt.checked).toBe(false);
    expect(ppt.closest('label')?.textContent).toContain('将从“重复名称”移动');
  });

  it('closes from backdrop and Escape', () => {
    const { onClose } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: '添加模块' });
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps focus and restores it to the trigger after close', () => {
    const trigger = document.createElement('button');
    trigger.textContent = '触发器';
    document.body.append(trigger);
    trigger.focus();
    const { rerender } = renderDialog();
    const dialog = screen.getByRole('dialog', { name: '添加模块' });
    const close = within(dialog).getByRole('button', { name: '关闭添加模块' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '创建专家模块' }));
    rerender(
      <ModuleMarketplaceDialog
        open={false}
        targetGroupId="park-services"
        layout={layout}
        modules={modules}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        onManageExperts={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(trigger);
  });
});
