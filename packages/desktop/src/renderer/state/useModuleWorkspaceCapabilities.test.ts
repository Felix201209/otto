import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BASE_AGENT_PROFILES } from '../agents/departmentAgents.js';
import { clearEnterpriseOrganizationFeaturesCache } from './enterpriseOrganizationFeatures.js';
import { useModuleWorkspaceCapabilities } from './useModuleWorkspaceCapabilities.js';

const enabledFeatures = {
  enterprise_tree: true,
  park_service: true,
  feishu_auto_reply: true,
  direct_messages: true,
  atoa: true,
  knowledge: true,
  skill_market: true,
};

beforeEach(() => {
  clearEnterpriseOrganizationFeaturesCache();
  Object.assign(window.otto, {
    enterpriseOrganizationFeaturesGet: vi.fn(async () => enabledFeatures),
    enterpriseParkView: vi.fn(async () => ({
      status: 'active', brandName: '测试园区', isAdminOrganization: false,
    })),
    enterpriseTicketList: vi.fn(async () => []),
  });
});

describe('useModuleWorkspaceCapabilities', () => {
  it('显式管理员 UI 预览使用本地完整目录且不请求企业后端', () => {
    const getFeatures = vi.mocked(window.otto.enterpriseOrganizationFeaturesGet);
    const getPark = vi.mocked(window.otto.enterpriseParkView);
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', serverUrl: 'internal://admin-preview',
      organizationId: 'local-internal-test', accountId: 'local-admin', accountIsAdmin: true,
      internalAdminPreview: true,
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));

    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.modules.find((module) => module.id === 'park-overview')?.availability)
      .toBe('available');
    expect(view.result.current.modules.find((module) => module.id === 'enterprise-memory')?.availability)
      .toBe('available');
    expect(view.result.current.modules.find((module) => module.id === 'skill-zone')?.availability)
      .toBe('available');
    expect(getFeatures).not.toHaveBeenCalled();
    expect(getPark).not.toHaveBeenCalled();
  });

  it('企业能力尚未解析时保持 loading，失败后可显式重试恢复', async () => {
    const getFeatures = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(enabledFeatures);
    Object.assign(window.otto, { enterpriseOrganizationFeaturesGet: getFeatures });
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', serverUrl: 'https://enterprise.example.com',
      organizationId: 'org-a', accountId: 'account-a', accountIsAdmin: false,
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));
    expect(view.result.current.status).toBe('loading');
    await waitFor(() => expect(view.result.current.status).toBe('failed'));

    act(() => view.result.current.retry());
    expect(view.result.current.status).toBe('loading');
    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.modules.some((module) => module.id === 'enterprise-memory')).toBe(true);
  });

  it('个人版立即就绪且不会请求企业能力', () => {
    const getFeatures = vi.mocked(window.otto.enterpriseOrganizationFeaturesGet);
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'personal', serverUrl: 'local', accountId: 'account-a',
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));
    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.modules
      .filter((module) => module.availability === 'available')
      .every((module) => !module.id.startsWith('park-'))).toBe(true);
    expect(getFeatures).not.toHaveBeenCalled();
  });

  it('does not grant park administration modules to a tenant organization administrator', async () => {
    Object.assign(window.otto, { enterpriseTicketList: vi.fn(async () => []) });
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', serverUrl: 'https://enterprise.example.com',
      organizationId: 'tenant-org', accountId: 'tenant-admin', accountIsAdmin: true,
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));

    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.modules.find((module) => module.id === 'park-overview')?.availability)
      .toBe('hidden');
    expect(view.result.current.modules.find((module) => module.id === 'park-staff-tasks')?.availability)
      .toBe('hidden');
  });

  it('exposes staff tasks only when the current account has received a park ticket', async () => {
    Object.assign(window.otto, {
      enterpriseTicketList: vi.fn(async () => [{ id: 'ticket-1', isRecipient: true }]),
    });
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', serverUrl: 'https://enterprise.example.com',
      organizationId: 'tenant-org', accountId: 'staff-a', accountIsAdmin: false,
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));

    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.modules.find((module) => module.id === 'park-staff-tasks')?.availability)
      .toBe('available');
  });

  it('isolates park capability loading failures from non-park modules', async () => {
    Object.assign(window.otto, {
      enterpriseParkView: vi.fn(async () => { throw new Error('park unavailable'); }),
      enterpriseTicketList: vi.fn(async () => []),
    });
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', serverUrl: 'https://enterprise.example.com',
      organizationId: 'org-a', accountId: 'account-a', accountIsAdmin: false,
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));

    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.modules.every((module) => !module.id.startsWith('park-')
      || module.availability === 'hidden')).toBe(true);
    expect(view.result.current.modules.find((module) => module.id === 'enterprise-memory')?.availability)
      .toBe('available');
    expect(view.result.current.modules.find((module) => module.id === 'skill-zone')?.availability)
      .toBe('available');
  });

  it('isolates park ticket loading failures from non-park modules', async () => {
    Object.assign(window.otto, {
      enterpriseTicketList: vi.fn(async () => { throw new Error('tickets unavailable'); }),
    });
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', serverUrl: 'https://enterprise.example.com',
      organizationId: 'org-a', accountId: 'account-a', accountIsAdmin: false,
      profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));

    await waitFor(() => expect(view.result.current.status).toBe('ready'));
    expect(view.result.current.modules.find((module) => module.id === 'park-announcement')?.availability)
      .toBe('available');
    expect(view.result.current.modules.find((module) => module.id === 'park-staff-tasks')?.availability)
      .toBe('hidden');
    expect(view.result.current.modules.find((module) => module.id === 'enterprise-memory')?.availability)
      .toBe('available');
  });

  it('synchronously drops the previous privilege snapshot when account or role changes', async () => {
    Object.assign(window.otto, {
      enterpriseParkView: vi.fn(async () => ({
        status: 'active', brandName: '测试园区', isAdminOrganization: true,
      })),
      enterpriseTicketList: vi.fn(async () => []),
    });
    const view = renderHook(
      (props: { accountId: string; accountIsAdmin: boolean }) => useModuleWorkspaceCapabilities({
        edition: 'enterprise', serverUrl: 'https://enterprise.example.com',
        organizationId: 'org-a', accountId: props.accountId,
        accountIsAdmin: props.accountIsAdmin,
        profiles: BASE_AGENT_PROFILES, customAgents: [],
      }),
      { initialProps: { accountId: 'admin-a', accountIsAdmin: true } },
    );
    await waitFor(() => expect(view.result.current.status).toBe('ready'));

    act(() => view.rerender({ accountId: 'member-a', accountIsAdmin: false }));
    expect(view.result.current.status).toBe('loading');
    expect(view.result.current.modules.find((module) => module.id === 'park-overview')?.availability)
      .toBe('hidden');
  });
});
