#!/usr/bin/env node
/**
 * Otto Enterprise - Production Launcher
 *
 * Usage:
 *   node start-enterprise.cjs
 *   node start-enterprise.cjs --host 0.0.0.0 --port 8888
 *   node start-enterprise.cjs --dashboard
 */

const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const host = option('--host', process.env.OTTO_ENTERPRISE_HOST || '127.0.0.1');
const port = Number(
  option('--port', process.env.OTTO_ENTERPRISE_PORT || '7777'),
);
const openDashboard = args.includes('--dashboard');
if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(
    '[Otto Enterprise] --host 不能为空，--port 必须是 1-65535 的整数。',
  );
  process.exit(2);
}

process.env.OTTO_ENTERPRISE_HOST = host;
process.env.OTTO_ENTERPRISE_PORT = String(port);
const appVersion = process.env.OTTO_APP_VERSION
  || JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
let buildCommit = process.env.OTTO_BUILD_COMMIT || process.env.GITHUB_SHA || '';
if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
  try {
    buildCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Public listeners fail closed below; local development reports unknown.
  }
}
if (!/^[0-9a-f]{40}$/i.test(buildCommit)) {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.error(
      '[Otto Enterprise] 对外部署必须设置 OTTO_BUILD_COMMIT 为完整 40 位提交 SHA。',
    );
    process.exit(2);
  }
  buildCommit = 'unknown';
}

console.log('');
console.log('=============================================');
console.log('  Otto Enterprise - Production Launch');
console.log('=============================================');
console.log(`  Server:    http://${host}:${port}`);
console.log(`  Dashboard: http://localhost:${port}/enterprise/dashboard`);
console.log('  Data:       ~/.otto-enterprise/data.db');
console.log('=============================================');
console.log('');

// dist/server.js 不再在 import 时隐式 listen，启动器必须显式转发 startEnterpriseServer。
const {
  startEnterpriseServer,
} = require('./packages/server/dist/src/enterprise/server.js');
const server = startEnterpriseServer({
  host,
  port,
  appVersion,
  buildCommit,
});

if (openDashboard) {
  const url = `http://localhost:${port}/enterprise/dashboard`;
  server.once('listening', () => {
    execFile('open', [url], (error) => {
      if (error) {
        console.error(`[Otto Enterprise] 无法打开浏览器: ${error.message}`);
      }
    });
    console.log(`[Otto Enterprise] 正在浏览器打开: ${url}`);
  });
}

function shutdown() {
  console.log('\n[Otto Enterprise] Shutting down...');
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
