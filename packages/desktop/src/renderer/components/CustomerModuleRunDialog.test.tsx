import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerModuleRunDialog } from './CustomerModuleRunDialog.js';

describe('CustomerModuleRunDialog', () => {
  it('enforces required inputs and cancels an active run when the dialog closes', async () => {
    const pending = new Promise(() => undefined);
    const customerModuleRun = vi.fn().mockReturnValue(pending);
    const customerModuleCancel = vi.fn().mockResolvedValue(true);
    Object.assign(window.otto, { customerModuleRun, customerModuleCancel });
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const onClose = vi.fn();
    render(<CustomerModuleRunDialog open name="Report" moduleId="com.acme.report" version="1.0.0" inputSchema={{ properties: { title: { type: 'string', title: '标题' } }, required: ['title'] }} permissions={[{ kind: 'model', paid: true }]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '运行模块' }));
    expect(screen.getByRole('status').textContent).toContain('请填写必填项');
    expect(customerModuleRun).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '月报' } });
    fireEvent.click(screen.getByRole('button', { name: '运行模块' }));
    expect(screen.getByRole('status').textContent).toContain('确认本次运行');
    expect(customerModuleRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /可能产生模型 Token 费用/ }));
    fireEvent.click(screen.getByRole('button', { name: '运行模块' }));
    expect(customerModuleRun).toHaveBeenCalledWith(expect.objectContaining({ runId: '00000000-0000-4000-8000-000000000001' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭客户模块' }));
    expect(customerModuleCancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
