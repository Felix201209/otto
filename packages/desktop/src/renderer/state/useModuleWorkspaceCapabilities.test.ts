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
};

beforeEach(() => {
  clearEnterpriseOrganizationFeaturesCache();
  Object.assign(window.otto, {
    enterpriseOrganizationFeaturesGet: vi.fn(async () => enabledFeatures),
    enterpriseParkView: vi.fn(async () => ({
      status: 'active', brandName: '测试园区', isAdminOrganization: false,
    })),
  });
});

describe('useModuleWorkspaceCapabilities', () => {
  it('企业能力尚未解析时保持 loading，失败后可显式重试恢复', async () => {
    const getFeatures = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(enabledFeatures);
    Object.assign(window.otto, { enterpriseOrganizationFeaturesGet: getFeatures });
    const view = renderHook(() => useModuleWorkspaceCapabilities({
      edition: 'enterprise', organizationId: 'org-a', accountIsAdmin: false,
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
      edition: 'personal', profiles: BASE_AGENT_PROFILES, customAgents: [],
    }));
    expect(view.result.current.status).toBe('ready');
    expect(view.result.current.modules
      .filter((module) => module.availability === 'available')
      .every((module) => !module.id.startsWith('park-'))).toBe(true);
    expect(getFeatures).not.toHaveBeenCalled();
  });
});
