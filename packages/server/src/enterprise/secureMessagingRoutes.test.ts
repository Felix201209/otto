/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import type {
  AccountView,
  E2eeDeviceDirectorySnapshot,
  E2eeTransparencyInclusionProof,
} from './db.js';
import { handleSecureMessagingRoute } from './secureMessagingRoutes.js';

const MEMBER = {
  id: 'account-a',
  organizationId: 'organization-a',
  status: 'active',
} as AccountView;

const DIRECTORY = {
  protocolId: 'otto-mls-v1',
  trustVersion: 2,
  organizationId: MEMBER.organizationId,
  accountId: MEMBER.id,
} as E2eeDeviceDirectorySnapshot;

const INCLUSION_PROOF = {
  accountSequence: 1,
  checkpoint: { size: 1, rootHash: 'a'.repeat(64) },
  nodes: [],
} satisfies E2eeTransparencyInclusionProof;

function createHarness(input: {
  path: string;
  method?: string;
  query?: string;
  memberAccount?: AccountView | null;
  body?: Record<string, unknown>;
  accountLookup?: AccountView | null;
}) {
  let response: { status: number; data: unknown } | null = null;
  const headers = new Map<string, string>();
  const services = {
    approveE2eeDevice: vi.fn(() => DIRECTORY),
    getAccount: vi.fn(() => input.accountLookup === undefined ? MEMBER : input.accountLookup),
    getE2eeCapabilityStatus: vi.fn(() => ({
      protocolId: 'otto-mls-v1' as const,
      releaseState: 'foundation-only' as const,
      enabled: false,
      externalAuditCompleted: false,
      mlsEngineReady: false,
      reason: 'not released',
    })),
    getE2eeDeviceDirectory: vi.fn(() => DIRECTORY),
    getE2eeTransparencyInclusionProof: vi.fn(() => INCLUSION_PROOF),
    registerE2eeAccountRoot: vi.fn(() => DIRECTORY),
    registerE2eeDevice: vi.fn(() => DIRECTORY),
    revokeE2eeDevice: vi.fn(() => DIRECTORY),
  };
  const res = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
  } as unknown as ServerResponse;
  const handled = handleSecureMessagingRoute({
    path: input.path,
    method: input.method ?? 'GET',
    url: new URL(`https://enterprise.test${input.path}${input.query ?? ''}`),
    req: {} as IncomingMessage,
    res,
    memberAccount: input.memberAccount === undefined ? MEMBER : input.memberAccount,
    services,
    readBody: async () => input.body ?? {},
    sendJSON: (_res, status, data) => {
      response = { status, data };
    },
  });
  return { handled, headers, services, getResponse: () => response };
}

describe('secure messaging HTTP routes', () => {
  it('requires a member session and reports foundation-only capability state', async () => {
    const denied = createHarness({
      path: '/enterprise/e2ee/status',
      memberAccount: null,
    });
    await expect(denied.handled).resolves.toBe(true);
    expect(denied.getResponse()).toEqual({
      status: 401,
      data: { error: 'login required' },
    });

    const allowed = createHarness({ path: '/enterprise/e2ee/status' });
    await expect(allowed.handled).resolves.toBe(true);
    expect(allowed.getResponse()).toEqual({
      status: 200,
      data: { status: expect.objectContaining({ enabled: false, releaseState: 'foundation-only' }) },
    });
    expect(allowed.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([
    ['/enterprise/e2ee/account-root', 'registerE2eeAccountRoot'],
    ['/enterprise/e2ee/devices/register', 'registerE2eeDevice'],
    ['/enterprise/e2ee/devices/approve', 'approveE2eeDevice'],
    ['/enterprise/e2ee/devices/revoke', 'revokeE2eeDevice'],
  ] as const)('rejects forged scope before dispatching %s', async (path, serviceName) => {
    const harness = createHarness({
      path,
      method: 'POST',
      body: { organizationId: 'organization-b', accountId: MEMBER.id },
    });
    await expect(harness.handled).resolves.toBe(true);
    expect(harness.getResponse()).toEqual({
      status: 403,
      data: { error: 'E2EE device trust scope does not match the authenticated account' },
    });
    expect(harness.services[serviceName]).not.toHaveBeenCalled();
  });

  it.each([
    ['/enterprise/e2ee/account-root', 'registerE2eeAccountRoot', 200],
    ['/enterprise/e2ee/devices/register', 'registerE2eeDevice', 201],
    ['/enterprise/e2ee/devices/approve', 'approveE2eeDevice', 200],
    ['/enterprise/e2ee/devices/revoke', 'revokeE2eeDevice', 200],
  ] as const)('dispatches authenticated mutation %s', async (path, serviceName, status) => {
    const body = {
      organizationId: MEMBER.organizationId,
      accountId: MEMBER.id,
    };
    const harness = createHarness({ path, method: 'POST', body });
    await expect(harness.handled).resolves.toBe(true);
    expect(harness.services[serviceName]).toHaveBeenCalledWith(body);
    expect(harness.getResponse()).toEqual({
      status,
      data: { directory: DIRECTORY },
    });
  });

  it('limits directory and transparency lookups to active same-organization accounts', async () => {
    const denied = createHarness({
      path: '/enterprise/e2ee/directory',
      query: '?accountId=account-b',
      accountLookup: null,
    });
    await expect(denied.handled).resolves.toBe(true);
    expect(denied.getResponse()).toEqual({
      status: 404,
      data: { error: 'E2EE device directory not found' },
    });
    expect(denied.services.getE2eeDeviceDirectory).not.toHaveBeenCalled();

    const allowed = createHarness({
      path: '/enterprise/e2ee/transparency',
      query: '?accountId=account-a&sequence=1',
    });
    await expect(allowed.handled).resolves.toBe(true);
    expect(allowed.services.getAccount).toHaveBeenCalledWith(
      MEMBER.id,
      MEMBER.organizationId,
    );
    expect(allowed.services.getE2eeTransparencyInclusionProof).toHaveBeenCalledWith(
      MEMBER.organizationId,
      MEMBER.id,
      1,
    );
    expect(allowed.getResponse()).toEqual({
      status: 200,
      data: { proof: INCLUSION_PROOF },
    });
  });

  it('does not turn unexpected storage failures into client-visible validation errors', async () => {
    const harness = createHarness({
      path: '/enterprise/e2ee/account-root',
      method: 'POST',
      body: {
        organizationId: MEMBER.organizationId,
        accountId: MEMBER.id,
      },
    });
    harness.services.registerE2eeAccountRoot.mockImplementation(() => {
      throw new Error('UNIQUE constraint failed: internal_table.secret_column');
    });

    await expect(harness.handled).rejects.toThrow('UNIQUE constraint failed');
    expect(harness.getResponse()).toBeNull();
  });
});
