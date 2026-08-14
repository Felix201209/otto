#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Credential-free black-box security probe for an isolated Otto Enterprise
 * Server. This script never accepts a remote URL and deletes its temporary
 * database when it finishes.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '..');
const serverEntry = pathToFileURL(
  resolve(repoRoot, 'packages/server/dist/src/enterprise/server.js'),
).href;
const databaseEntry = pathToFileURL(
  resolve(repoRoot, 'packages/server/dist/src/enterprise/db.js'),
).href;
const dataDirectory = mkdtempSync(resolve(tmpdir(), 'otto-security-probe-'));
const adminToken = randomBytes(32).toString('base64url');
const checks = [];

process.env.NODE_ENV = 'test';
process.env.OTTO_ENTERPRISE_DIR = dataDirectory;
process.env.OTTO_ENTERPRISE_DATABASE_BACKEND = 'sqlite';
process.env.OTTO_DATABASE_ENCRYPTION = 'disabled';
process.env.OTTO_LICENSE_ENFORCE = 'false';

function record(name, passed, detail = '') {
  checks.push({ name, passed, detail });
  process.stderr.write(
    `[security-probe] ${passed ? 'PASS' : 'FAIL'} ${name}\n`,
  );
}

async function verify(name, action) {
  try {
    await action();
    record(name, true);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    ...options,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function rawHostRequest(baseUrl, path, headers) {
  const url = new URL(path, baseUrl);
  return new Promise((resolveRequest, rejectRequest) => {
    const requestInstance = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolveRequest({ response, body: text, text });
        });
      },
    );
    requestInstance.setTimeout(10_000, () => {
      requestInstance.destroy(new Error('security probe request timed out'));
    });
    requestInstance.on('error', rejectRequest);
    requestInstance.end();
  });
}

function expectDenied(result) {
  assert.ok(
    [400, 401, 403, 404, 405, 413, 429].includes(result.response.status),
    `expected denial, received HTTP ${result.response.status}`,
  );
  assert.doesNotMatch(result.text, /(?:at |stack|node_modules|[A-Z]:\\)/i);
}

let database;
let server;

try {
  database = await import(databaseEntry);
  const serverModule = await import(serverEntry);
  const alpha = database.createOrganization({
    name: 'Alpha',
    slug: 'alpha-probe',
  });
  const beta = database.createOrganization({
    name: 'Beta',
    slug: 'beta-probe',
  });
  const alphaAdmin = database.createAccount({
    organizationId: alpha.id,
    username: 'alpha-admin',
    password: 'Alpha-password-2026',
    name: 'Alpha Administrator',
    isAdmin: true,
  });
  const alphaMember = database.createAccount({
    organizationId: alpha.id,
    username: 'alpha-member',
    password: 'Alpha-member-password-2026',
    name: 'Alpha Member',
    isAdmin: false,
  });
  const betaMember = database.createAccount({
    organizationId: beta.id,
    username: 'beta-member',
    password: 'Beta-member-password-2026',
    name: 'Beta Member',
    isAdmin: false,
  });
  const alphaAdminSession = database.createAuthSession(alphaAdmin.id).token;
  const alphaMemberSession = database.createAuthSession(alphaMember.id).token;

  ({ server } = serverModule.createEnterpriseServer({
    host: '127.0.0.1',
    port: 0,
    adminToken,
    appVersion: 'security-probe',
    buildCommit: '0'.repeat(40),
    localAgentPairingEnabled: false,
  }));
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await verify('health response excludes deployment secrets', async () => {
    const result = await request(baseUrl, '/enterprise/health');
    assert.equal(result.response.status, 200);
    assert.doesNotMatch(
      result.text,
      /adminToken|machineFingerprint|licenseSignature|privateKey|OTTO_[A-Z_]+/i,
    );
  });

  for (const path of [
    '/enterprise/accounts',
    '/enterprise/audit',
    '/enterprise/organization/view',
    '/enterprise/privacy/export',
    `/enterprise/messages/${alphaMember.id}`,
  ]) {
    await verify(`anonymous access denied: ${path}`, async () => {
      expectDenied(await request(baseUrl, path));
    });
  }

  await verify('admin token in URL query is rejected', async () => {
    expectDenied(
      await request(
        baseUrl,
        `/enterprise/accounts?token=${encodeURIComponent(adminToken)}`,
      ),
    );
  });

  await verify('cross-origin admin mutation is rejected', async () => {
    const result = await request(baseUrl, '/enterprise/accounts', {
      method: 'POST',
      headers: {
        origin: 'https://attacker.invalid',
        'x-otto-admin-token': adminToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username: 'injected-admin',
        password: 'Injected-password-2026',
        name: 'Injected',
      }),
    });
    assert.equal(result.response.status, 403);
    assert.equal(
      database
        .listAccounts(alpha.id)
        .some((entry) => entry.username === 'injected-admin'),
      false,
    );
  });

  await verify('ordinary member cannot use administrator routes', async () => {
    const result = await request(baseUrl, '/enterprise/accounts', {
      headers: { authorization: `Bearer ${alphaMemberSession}` },
    });
    assert.equal(result.response.status, 403);
  });

  await verify('cross-tenant direct-message lookup is denied', async () => {
    const result = await request(
      baseUrl,
      `/enterprise/messages/${encodeURIComponent(betaMember.id)}`,
      { headers: { authorization: `Bearer ${alphaAdminSession}` } },
    );
    assert.equal(result.response.status, 404);
    assert.doesNotMatch(result.text, /Beta Member|beta-member/);
  });

  await verify(
    'DNS-rebinding host cannot reach tokenless administration',
    async () => {
      const tokenless = serverModule.createEnterpriseServer({
        host: '127.0.0.1',
        port: 0,
        adminToken: '',
        appVersion: 'security-probe',
        buildCommit: '0'.repeat(40),
      }).server;
      await new Promise((resolveListen, rejectListen) => {
        tokenless.once('error', rejectListen);
        tokenless.listen(0, '127.0.0.1', resolveListen);
      });
      const tokenlessAddress = tokenless.address();
      assert.ok(tokenlessAddress && typeof tokenlessAddress === 'object');
      try {
        const result = await rawHostRequest(
          `http://127.0.0.1:${tokenlessAddress.port}`,
          '/enterprise/accounts',
          {
            host: 'attacker.invalid',
            authorization: `Bearer ${alphaAdminSession}`,
          },
        );
        assert.equal(result.response.statusCode, 403);
      } finally {
        await new Promise((resolveClose) => tokenless.close(resolveClose));
      }
    },
  );

  await verify(
    'malformed JSON fails closed without stack disclosure',
    async () => {
      const result = await request(baseUrl, '/enterprise/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"identifier":',
      });
      expectDenied(result);
    },
  );

  await verify(
    'oversized JSON stays bounded and server remains healthy',
    async () => {
      const result = await request(baseUrl, '/enterprise/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          identifier: 'x'.repeat(1_100_000),
          password: 'x',
        }),
      });
      expectDenied(result);
      const health = await request(baseUrl, '/enterprise/health');
      assert.equal(health.response.status, 200);
    },
  );

  await verify(
    'path traversal and encoded script payloads are not reflected',
    async () => {
      for (const path of [
        '/enterprise/sdk/%2e%2e/%2e%2e/package.json',
        '/enterprise/join/%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      ]) {
        const result = await request(baseUrl, path);
        assert.equal(result.response.status, 404);
        assert.doesNotMatch(result.text, /<script>alert\(1\)<\/script>/i);
      }
    },
  );

  await verify(
    'password spraying is rate-limited despite forged XFF',
    async () => {
      let finalResult;
      for (let index = 0; index < 7; index += 1) {
        finalResult = await request(baseUrl, '/enterprise/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `198.51.100.${index + 1}`,
          },
          body: JSON.stringify({
            identifier: 'alpha-admin',
            password: `wrong-password-${index}`,
          }),
        });
      }
      assert.equal(finalResult?.response.status, 429);
      assert.ok(Number(finalResult?.response.headers.get('retry-after')) >= 1);
    },
  );

  await verify('local pairing endpoints are disabled by default', async () => {
    const result = await request(baseUrl, '/enterprise/local-agent/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: 'attacker' }),
    });
    assert.equal(result.response.status, 404);
  });
} finally {
  if (server?.listening) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  database?.closeEnterpriseDatabase?.();
  rmSync(dataDirectory, { recursive: true, force: true });
}

const failed = checks.filter((check) => !check.passed);
const report = {
  generatedAt: new Date().toISOString(),
  target: 'isolated Otto Enterprise Server',
  checks: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  failures: failed,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failed.length > 0 ? 1 : 0);
