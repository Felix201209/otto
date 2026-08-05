/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Park endpoint HTTP-layer tests.
 * 数据安全：独立临时 OTTO_ENTERPRISE_DIR + resetModules，绝不碰真实企业库。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type ServerModule = typeof import('./server.js');

let tmpDir: string;
let servers: Server[] = [];
const prevEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'OTTO_ENTERPRISE_DIR',
  'OTTO_ENTERPRISE_ADMIN_TOKEN',
  'OTTO_ENTERPRISE_PUBLIC_URL',
] as const;

const ADMIN_TOKEN = 'park-admin-token-xyz789';

interface ParkEndpointResponse {
  park: { id: string; name: string; adminUserIds: string[] };
  invite: { code: string; maxUses: number; active: boolean };
  parkId: string;
  enterpriseId: string;
  error: string;
  request: { status: string; assignedTo: string };
  requests: Array<{ id: string }>;
  specialists: Array<{ userId: string; serviceTypes: string[] }>;
  specialist: { userId: string; serviceTypes: string[] };
}

async function startIsolated(adminToken?: string): Promise<{ base: string; server: Server }> {
  process.env.OTTO_ENTERPRISE_DIR = tmpDir;
  process.env.OTTO_ENTERPRISE_PUBLIC_URL = 'https://park.otto.example';
  vi.resetModules();
  const mod: ServerModule = await import('./server.js');
  const { server } = mod.createEnterpriseServer({
    host: '127.0.0.1',
    adminToken,
    smsSender: null,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, server };
}

beforeEach(() => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-park-ep-'));
  servers = [];
});

afterEach(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function postJSON(
  base: string,
  path: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ status: number; body: ParkEndpointResponse }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as ParkEndpointResponse };
}

async function getJSON(
  base: string,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: ParkEndpointResponse }> {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() as ParkEndpointResponse };
}

async function createEnterpriseSession(
  slug: string,
): Promise<{ enterpriseId: string; headers: Record<string, string> }> {
  const database = await import('./db.js');
  const organization = database.createOrganization({
    name: `Park endpoint tenant ${slug}`,
    slug: `park-endpoint-${slug}`,
  });
  const account = database.createAccount({
    organizationId: organization.id,
    username: `park.endpoint.${slug}`,
    password: `park-endpoint-${slug}-password`,
    name: `Park endpoint member ${slug}`,
  });
  const session = database.createAuthSession(account.id);
  return {
    enterpriseId: organization.id,
    headers: { authorization: `Bearer ${session.token}` },
  };
}

// The first isolated import compiles the large enterprise graph under Vitest
// coverage. Production uses prebuilt JavaScript, but CI needs a wider startup
// budget on slower Windows runners.
describe('Park endpoints', { timeout: 30_000 }, () => {
  it('POST /enterprise/park creates a park (admin only)', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };

    const { status, body } = await postJSON(
      base, '/enterprise/park',
      { name: '中关村科技园', address: '北京市海淀区', adminUserIds: ['admin-1'] },
      adminHeaders,
    );
    expect(status).toBe(201);
    expect(body.park.id).toMatch(/^park_/);
    expect(body.park.name).toBe('中关村科技园');
    expect(body.park.adminUserIds).toEqual(['admin-1']);
  });

  it('POST /enterprise/park rejects without admin token', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const { status } = await postJSON(
      base, '/enterprise/park',
      { name: 'Unauthorized Park' },
    );
    expect(status).toBe(401);
  });

  it('POST /enterprise/park/invite creates an invite code', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };

    // First create a park
    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: '测试园区' }, adminHeaders,
    );

    // Then create invite code
    const { status, body } = await postJSON(
      base, '/enterprise/park/invite',
      { parkId: parkBody.park.id, maxUses: 5 },
      adminHeaders,
    );
    expect(status).toBe(201);
    expect(body.invite.code).toHaveLength(8);
    expect(body.invite.maxUses).toBe(5);
    expect(body.invite.active).toBe(true);
  });

  it('POST /enterprise/park/join: enterprise joins via valid invite code', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };

    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: '开发区' }, adminHeaders,
    );
    const { body: inviteBody } = await postJSON(
      base, '/enterprise/park/invite',
      { parkId: parkBody.park.id }, adminHeaders,
    );

    // Join
    const { status, body } = await postJSON(
      base, '/enterprise/park/join',
      { code: inviteBody.invite.code, enterpriseId: 'ent-42' },
    );
    expect(status).toBe(200);
    expect(body.parkId).toBe(parkBody.park.id);
    expect(body.enterpriseId).toBe('ent-42');
  });

  it('POST /enterprise/park/join rejects invalid invite code', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const { status, body } = await postJSON(
      base, '/enterprise/park/join',
      { code: 'DEADBEEF', enterpriseId: 'ent-42' },
    );
    expect(status).toBe(403);
    expect(body.error).toBeTruthy();
  });

  it('POST /enterprise/park/join rejects without arguments', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const { status } = await postJSON(base, '/enterprise/park/join', {});
    expect(status).toBe(400);
  });

  it('POST /enterprise/park/services/request auto-routes to specialist', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };
    const tenant = await createEnterpriseSession('specialist');

    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: '服务园区' }, adminHeaders,
    );
    const parkId = parkBody.park.id;

    // Assign a repair specialist
    await postJSON(
      base, '/enterprise/park/services/assign',
      { parkId, userId: 'repair-guy', serviceTypes: ['维修'] },
      adminHeaders,
    );

    // A signed-in enterprise member creates the request.
    const { status, body } = await postJSON(
      base, '/enterprise/park/services/request',
      { parkId, enterpriseId: tenant.enterpriseId, type: '维修', description: '空调故障' },
      tenant.headers,
    );
    expect(status).toBe(201);
    expect(body.request.status).toBe('assigned');
    expect(body.request.assignedTo).toBe('repair-guy');
  });

  it('POST /enterprise/park/services/request falls back to admin when no specialist', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };
    const tenant = await createEnterpriseSession('fallback');

    const { body: parkBody } = await postJSON(
      base, '/enterprise/park',
      { name: '无人园区', adminUserIds: ['park-admin'] },
      adminHeaders,
    );

    const { status, body } = await postJSON(
      base, '/enterprise/park/services/request',
      {
        parkId: parkBody.park.id,
        enterpriseId: tenant.enterpriseId,
        type: '保洁',
        description: '打扫',
      },
      tenant.headers,
    );
    expect(status).toBe(201);
    expect(body.request.status).toBe('assigned');
    expect(body.request.assignedTo).toBe('park-admin');
  });

  it('GET /enterprise/park/services lists requests and specialists', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };
    const tenant = await createEnterpriseSession('listing');

    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: '查询园区' }, adminHeaders,
    );

    // Assign specialist
    await postJSON(
      base, '/enterprise/park/services/assign',
      { parkId: parkBody.park.id, userId: 's1', serviceTypes: ['维修'] },
      adminHeaders,
    );

    // Create request
    await postJSON(
      base, '/enterprise/park/services/request',
      {
        parkId: parkBody.park.id,
        enterpriseId: tenant.enterpriseId,
        type: '维修',
        description: '修理',
      },
      tenant.headers,
    );

    const { status, body } = await getJSON(
      base,
      `/enterprise/park/services?parkId=${parkBody.park.id}`,
    );
    expect(status).toBe(200);
    expect(body.requests).toHaveLength(1);
    expect(body.specialists).toHaveLength(1);
    expect(body.specialists[0].userId).toBe('s1');
  });

  it('POST /enterprise/park/services/request rejects cross-organization spoofing', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };
    const tenant = await createEnterpriseSession('spoofing');
    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: 'Spoofing test park' }, adminHeaders,
    );

    const { status } = await postJSON(
      base,
      '/enterprise/park/services/request',
      {
        parkId: parkBody.park.id,
        enterpriseId: 'another-enterprise',
        type: 'repair',
        description: 'must be rejected',
      },
      tenant.headers,
    );

    expect(status).toBe(403);
  });

  it('POST /enterprise/park/services/assign is admin-only', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };

    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: '权限园区' }, adminHeaders,
    );

    // Without admin token
    const { status } = await postJSON(
      base, '/enterprise/park/services/assign',
      { parkId: parkBody.park.id, userId: 'bad-guy', serviceTypes: ['安保'] },
    );
    expect(status).toBe(401);
  });

  it('POST /enterprise/park/services/assign with admin token succeeds', async () => {
    const { base } = await startIsolated(ADMIN_TOKEN);
    const adminHeaders = { 'x-otto-admin-token': ADMIN_TOKEN };

    const { body: parkBody } = await postJSON(
      base, '/enterprise/park', { name: '分派园区' }, adminHeaders,
    );

    const { status, body } = await postJSON(
      base, '/enterprise/park/services/assign',
      { parkId: parkBody.park.id, userId: 'good-guy', serviceTypes: ['保洁', '绿化'] },
      adminHeaders,
    );
    expect(status).toBe(201);
    expect(body.specialist.userId).toBe('good-guy');
    expect(body.specialist.serviceTypes.sort()).toEqual(['保洁', '绿化']);
  });
});
