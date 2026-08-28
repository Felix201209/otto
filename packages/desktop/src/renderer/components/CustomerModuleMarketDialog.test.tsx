import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CustomerModuleMarketDialog } from './CustomerModuleMarketDialog.js';

describe('CustomerModuleMarketDialog', () => {
  it('shows upgrade permission additions before manual confirmation', async () => {
    const next = {
      manifest: { id: 'com.acme.report', name: 'Report', version: '2.0.0', releaseNotes: 'Adds model', permissions: [{ kind: 'storage', access: 'read' }, { kind: 'model', paid: true }], signature: { keyId: 'market' } },
      publisherId: 'publisher', status: 'approved', scanReport: { passed: true, findings: [] }, reviewerId: 'reviewer', createdAt: '', updatedAt: '', installCount: 2,
    };
    const customerModuleList = vi.fn().mockResolvedValue([next]);
    const customerModuleInstall = vi.fn().mockResolvedValue({ id: next.manifest.id, version: next.manifest.version });
    Object.assign(window.otto, { customerModuleList, customerModuleInstall });
    render(<CustomerModuleMarketDialog open installed={[{ id: next.manifest.id, version: '1.0.0', name: 'Report', description: '', permissions: [{ kind: 'storage', access: 'read' }], enabled: true, installedAt: '', iconDataUrl: '', inputSchema: { type: 'object', properties: {} } }]} onInstalled={vi.fn()} onInstalledChanged={vi.fn()} onCreate={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText(/com\.acme\.report@2\.0\.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看并安装' }));
    expect(screen.getByRole('alert').textContent).toContain('model');
    expect(screen.getByText(/费用可能性/).textContent).toContain('Token');
    fireEvent.click(screen.getByRole('button', { name: '确认权限并安装' }));
    await waitFor(() => expect(customerModuleInstall).toHaveBeenCalledWith(expect.objectContaining({ version: '2.0.0', approvedPermissions: next.manifest.permissions })));
    await screen.findByText(/模块已安装/);
  });
});
