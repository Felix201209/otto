/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  handleOrganizationRoute,
  type OrganizationRouteServices,
} from './modules/identity_organization/index.js';

function createServices(enterpriseTree = true): OrganizationRouteServices {
  return {
    getOrganizationFeatures: vi.fn(() => ({
      enterprise_tree: enterpriseTree,
      park_service: true,
      feishu_auto_reply: true,
      direct_messages: true,
      atoa: true,
      knowledge: true,
    })),
    updateOrganizationFeatures: vi.fn((_organizationId, patch) => ({
      enterprise_tree: enterpriseTree,
      park_service: true,
      feishu_auto_reply: true,
      direct_messages: true,
      atoa: true,
      knowledge: patch.knowledge ?? true,
    })),
    listOrganizationStructure: vi.fn(() => []),
    createOrganizationDepartment: vi.fn((input) => ({ id: 'dept-1', ...input })),
    updateOrganizationDepartment: vi.fn((input) => ({ id: input.departmentId, ...input })),
    deleteOrganizationDepartment: vi.fn(),
    createOrganizationPosition: vi.fn((input) => ({ id: 'position-1', ...input })),
    updateOrganizationPosition: vi.fn((input) => ({ id: input.positionId, ...input })),
    deleteOrganizationPosition: vi.fn(),
  };
}

async function dispatch(input: {
  path: string;
  method: string;
  services: OrganizationRouteServices;
  body?: Record<string, unknown>;
  memberAccount?: { organizationId: string; isAdmin: boolean } | null;
  adminPrincipal?: { kind: 'system' | 'account'; organizationId: string } | null;
}) {
  const responses: Array<{ status: number; data: unknown }> = [];
  const handled = await handleOrganizationRoute({
    path: input.path,
    method: input.method,
    req: {} as IncomingMessage,
    res: {} as ServerResponse,
    services: input.services,
    memberAccount: input.memberAccount ?? null,
    adminPrincipal: input.adminPrincipal ?? null,
    readBody: async () => input.body ?? {},
    sendJSON: (_res, status, data) => responses.push({ status, data }),
  });
  return { handled, responses };
}

describe('identity_organization route service boundary', () => {
  it('rejects a normal member before changing organization feature flags', async () => {
    const services = createServices();
    const result = await dispatch({
      path: '/enterprise/organization/features',
      method: 'PATCH',
      services,
      memberAccount: { organizationId: 'org-member', isAdmin: false },
      body: { knowledge: false },
    });

    expect(result.handled).toBe(true);
    expect(result.responses).toEqual([{ status: 403, data: { error: '需要管理员权限' } }]);
    expect(services.updateOrganizationFeatures).not.toHaveBeenCalled();
  });

  it('uses the authenticated principal tenant and ignores a tenant id in the body', async () => {
    const services = createServices();
    const result = await dispatch({
      path: '/enterprise/organization/departments',
      method: 'POST',
      services,
      adminPrincipal: { kind: 'account', organizationId: 'org-safe' },
      body: { name: 'Engineering', organizationId: 'org-evil' },
    });

    expect(result.responses[0]?.status).toBe(201);
    expect(services.createOrganizationDepartment).toHaveBeenCalledWith({
      organizationId: 'org-safe',
      name: 'Engineering',
    });
  });

  it('fails closed before writing departments or positions when the tree is disabled', async () => {
    const services = createServices(false);
    const result = await dispatch({
      path: '/enterprise/organization/positions',
      method: 'POST',
      services,
      adminPrincipal: { kind: 'account', organizationId: 'org-safe' },
      body: { departmentId: 'dept-1', title: 'Manager' },
    });

    expect(result.responses).toEqual([{
      status: 403,
      data: { error: '企业树功能已由管理员关闭' },
    }]);
    expect(services.createOrganizationPosition).not.toHaveBeenCalled();
  });

  it('updates feature flags only for the authenticated member organization', async () => {
    const services = createServices();
    const result = await dispatch({
      path: '/enterprise/organization/features',
      method: 'PATCH',
      services,
      memberAccount: { organizationId: 'org-safe', isAdmin: true },
      body: { knowledge: false, organizationId: 'org-evil' },
    });

    expect(result.responses[0]?.status).toBe(200);
    expect(services.updateOrganizationFeatures).toHaveBeenCalledWith(
      'org-safe',
      expect.objectContaining({ knowledge: false }),
    );
  });
});
