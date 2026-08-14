#!/usr/bin/env node
/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Credential-free local HTTP load test for Otto Enterprise Server. The script
 * creates an isolated temporary database and never targets a remote server.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const serverEntry = resolve(
  repoRoot,
  'packages/server/dist/src/enterprise/bin.js',
);
const serverDatabaseEntry = resolve(
  repoRoot,
  'packages/server/dist/src/enterprise/db.js',
);
const clusteredServerEntry = resolve(
  repoRoot,
  'packages/server/dist/src/enterprise/clusteredServer.js',
);
const dataDirectory = mkdtempSync(resolve(tmpdir(), 'otto-enterprise-load-'));
const username = 'load-test-admin';
const password = 'load-test-password-2026';
const requestTimeoutMs = 10_000;

const profiles = Object.freeze({
  smoke: Object.freeze([
    { name: 'health-c5', route: 'health', concurrency: 5, requests: 50 },
    {
      name: 'organization-c5',
      route: 'organization',
      concurrency: 5,
      requests: 50,
    },
    { name: 'heartbeat-c5', route: 'heartbeat', concurrency: 5, requests: 50 },
  ]),
  quick: Object.freeze([
    { name: 'health-c20', route: 'health', concurrency: 20, requests: 2_000 },
    { name: 'health-c100', route: 'health', concurrency: 100, requests: 5_000 },
    {
      name: 'organization-c20',
      route: 'organization',
      concurrency: 20,
      requests: 2_000,
    },
    {
      name: 'organization-c100',
      route: 'organization',
      concurrency: 100,
      requests: 5_000,
    },
    {
      name: 'heartbeat-c20',
      route: 'heartbeat',
      concurrency: 20,
      requests: 1_000,
    },
    {
      name: 'heartbeat-c50',
      route: 'heartbeat',
      concurrency: 50,
      requests: 2_000,
    },
  ]),
  high: Object.freeze([
    { name: 'health-c20', route: 'health', concurrency: 20, requests: 4_000 },
    {
      name: 'health-c100',
      route: 'health',
      concurrency: 100,
      requests: 10_000,
    },
    {
      name: 'health-c200',
      route: 'health',
      concurrency: 200,
      requests: 15_000,
    },
    {
      name: 'organization-c20',
      route: 'organization',
      concurrency: 20,
      requests: 4_000,
    },
    {
      name: 'organization-c100',
      route: 'organization',
      concurrency: 100,
      requests: 10_000,
    },
    {
      name: 'organization-c200',
      route: 'organization',
      concurrency: 200,
      requests: 15_000,
    },
    {
      name: 'heartbeat-c20',
      route: 'heartbeat',
      concurrency: 20,
      requests: 2_000,
    },
    {
      name: 'heartbeat-c50',
      route: 'heartbeat',
      concurrency: 50,
      requests: 5_000,
    },
    {
      name: 'heartbeat-c100',
      route: 'heartbeat',
      concurrency: 100,
      requests: 8_000,
    },
  ]),
});

function argumentValue(name, fallback) {
  const prefix = `--${name}=`;
  return (
    process.argv
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length) ?? fallback
  );
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * value) - 1,
  );
  return sorted[index];
}

async function reservePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('failed to reserve a loopback port'));
        else resolvePort(port);
      });
    });
  });
}

function serverMemory(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{workingSet=$p.WorkingSet64; privateBytes=$p.PrivateMemorySize64; cpuSeconds=$p.CPU} | ConvertTo-Json -Compress`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const value = JSON.parse(output);
    return {
      workingSetMb: Number((value.workingSet / 1048576).toFixed(1)),
      privateMb: Number((value.privateBytes / 1048576).toFixed(1)),
      cpuSeconds: Number(Number(value.cpuSeconds ?? 0).toFixed(2)),
    };
  } catch {
    return null;
  }
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `enterprise server exited before health check (code ${child.exitCode})`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/enterprise/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error('enterprise server did not become healthy within 30 seconds');
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/enterprise/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`load-test login failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error('load-test login did not return a token');
  }
  return body.token;
}

function requestFor(baseUrl, token, route, requestIndex) {
  if (route === 'health') {
    return [`${baseUrl}/enterprise/health`, { method: 'GET' }];
  }
  if (route === 'organization') {
    return [
      `${baseUrl}/enterprise/organization/view`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    ];
  }
  if (route === 'heartbeat') {
    return [
      `${baseUrl}/enterprise/presence/heartbeat`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ clientId: `load-client-${requestIndex % 32}` }),
      },
    ];
  }
  throw new Error(`unsupported route ${route}`);
}

async function runPhase(baseUrl, token, phase, serverPid) {
  const latencies = [];
  const statuses = new Map();
  const failures = [];
  let nextRequest = 0;
  const started = performance.now();

  async function worker() {
    while (true) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      if (requestIndex >= phase.requests) return;
      const [url, init] = requestFor(baseUrl, token, phase.route, requestIndex);
      const requestStarted = performance.now();
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        await response.arrayBuffer();
        latencies.push(performance.now() - requestStarted);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        if (!response.ok && failures.length < 10) {
          failures.push(`HTTP ${response.status}`);
        }
      } catch (error) {
        latencies.push(performance.now() - requestStarted);
        statuses.set('network-error', (statuses.get('network-error') ?? 0) + 1);
        if (failures.length < 10) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: phase.concurrency }, () => worker()));
  const elapsedMs = performance.now() - started;
  latencies.sort((left, right) => left - right);
  const successful = [...statuses.entries()]
    .filter(
      ([status]) => typeof status === 'number' && status >= 200 && status < 300,
    )
    .reduce((total, [, count]) => total + count, 0);
  const errorCount = phase.requests - successful;
  return {
    ...phase,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    requestsPerSecond: Number((phase.requests / (elapsedMs / 1000)).toFixed(1)),
    successful,
    errorCount,
    errorRate: Number((errorCount / phase.requests).toFixed(6)),
    latencyMs: {
      min: Number((latencies[0] ?? 0).toFixed(1)),
      p50: Number(percentile(latencies, 0.5).toFixed(1)),
      p95: Number(percentile(latencies, 0.95).toFixed(1)),
      p99: Number(percentile(latencies, 0.99).toFixed(1)),
      max: Number((latencies.at(-1) ?? 0).toFixed(1)),
    },
    statuses: Object.fromEntries(statuses),
    sampleFailures: failures,
    serverMemory: serverMemory(serverPid),
  };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const profileName = argumentValue('profile', 'high');
  const backendName = argumentValue('backend', 'sqlite').toLowerCase();
  const skipBootstrap = process.argv.includes('--skip-bootstrap');
  if (!['sqlite', 'postgresql'].includes(backendName)) {
    throw new Error('--backend must be sqlite or postgresql');
  }
  const configuredPhases = profiles[profileName];
  if (!configuredPhases) {
    throw new Error(
      `unknown profile ${profileName}; expected ${Object.keys(profiles).join(', ')}`,
    );
  }
  const onlyRoute = argumentValue('only', '');
  const phases = onlyRoute
    ? configuredPhases.filter((phase) => phase.route === onlyRoute)
    : configuredPhases;
  if (phases.length === 0) {
    throw new Error(`profile ${profileName} has no route named ${onlyRoute}`);
  }
  const outputArgument = argumentValue('output', '');
  const outputPath = outputArgument ? resolve(repoRoot, outputArgument) : null;
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    OTTO_ENTERPRISE_DIR: dataDirectory,
    OTTO_ENTERPRISE_HOST: '127.0.0.1',
    OTTO_ENTERPRISE_PORT: String(port),
    OTTO_BOOTSTRAP_USERNAME: username,
    OTTO_BOOTSTRAP_PASSWORD: password,
    OTTO_BOOTSTRAP_NAME: 'Load Test Administrator',
    OTTO_APP_VERSION: 'load-test',
    OTTO_BUILD_COMMIT: '0000000000000000000000000000000000000000',
    ...(backendName === 'sqlite'
      ? {
          NODE_ENV: 'test',
          OTTO_DATABASE_ENCRYPTION: 'disabled',
          OTTO_ENTERPRISE_DATABASE_BACKEND: 'sqlite',
        }
      : { OTTO_ENTERPRISE_DATABASE_BACKEND: 'postgresql' }),
  };

  const bootstrap = skipBootstrap
    ? { status: 0, stdout: '', stderr: '' }
    : backendName === 'postgresql'
      ? (() => {
          const bootstrapSource = `
          const clustered = await import(${JSON.stringify(pathToFileURL(clusteredServerEntry).href)});
          await clustered.bootstrapClusteredEnterpriseAdmin({
            username: ${JSON.stringify(username)},
            password: ${JSON.stringify(password)},
            name: 'Load Test Administrator',
          });
          process.exit(0);
        `;
          return spawnSync(
            process.execPath,
            ['--input-type=module', '--eval', bootstrapSource],
            {
              cwd: repoRoot,
              env: environment,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 60_000,
            },
          );
        })()
      : (() => {
          const bootstrapSource = `
          const database = await import(${JSON.stringify(pathToFileURL(serverDatabaseEntry).href)});
          database.createAccount({
            username: ${JSON.stringify(username)},
            password: ${JSON.stringify(password)},
            name: 'Load Test Administrator',
            role: 'Administrator',
            department: 'IT',
            tags: ['IT'],
            isAdmin: true,
          });
          process.exit(0);
        `;
          return spawnSync(
            process.execPath,
            ['--input-type=module', '--eval', bootstrapSource],
            {
              cwd: repoRoot,
              env: environment,
              encoding: 'utf8',
              windowsHide: true,
              timeout: 30_000,
            },
          );
        })();
  if (bootstrap.status !== 0) {
    throw new Error(
      `enterprise bootstrap failed: ${bootstrap.stderr || bootstrap.stdout}`,
    );
  }

  const server = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-8_000);
  });
  server.stderr.on('data', (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-8_000);
  });

  try {
    await waitForHealth(baseUrl, server);
    const token = await login(baseUrl);
    const results = [];
    for (const phase of phases) {
      process.stderr.write(
        `[load-test] ${phase.name}: ${phase.requests} requests at concurrency ${phase.concurrency}\n`,
      );
      results.push(await runPhase(baseUrl, token, phase, server.pid));
      if (outputPath) {
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(
          outputPath,
          `${JSON.stringify({ status: 'running', profile: profileName, phases: results }, null, 2)}\n`,
        );
      }
    }
    const totalRequests = results.reduce(
      (sum, result) => sum + result.requests,
      0,
    );
    const totalErrors = results.reduce(
      (sum, result) => sum + result.errorCount,
      0,
    );
    const report = {
      generatedAt: new Date().toISOString(),
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      profile: profileName,
      storageMode:
        backendName === 'postgresql'
          ? 'isolated PostgreSQL clustered mode'
          : 'isolated SQLite compatibility mode',
      totalRequests,
      totalErrors,
      pass: totalErrors === 0,
      phases: results,
    };
    console.log(JSON.stringify(report, null, 2));
    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report.pass ? 0 : 1;
  } catch (error) {
    if (serverOutput)
      process.stderr.write(`\n[enterprise-server]\n${serverOutput}\n`);
    throw error;
  } finally {
    await stopChild(server);
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

let finalExitCode = 0;
try {
  finalExitCode = await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  rmSync(dataDirectory, { recursive: true, force: true });
  finalExitCode = 1;
}
process.exit(finalExitCode);
