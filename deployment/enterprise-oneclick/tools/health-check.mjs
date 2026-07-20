#!/usr/bin/env node

function fail(message) {
  process.stderr.write(`[Otto Health] ${message}\n`);
  process.exit(5);
}

const baseUrl = process.argv[2];
const expectedVersion = process.argv[3];
const expectedBuild = process.argv[4];
const requireSms = process.argv[5] !== 'allow-sms-disabled';
if (!baseUrl || !expectedVersion || !expectedBuild) {
  fail('用法：health-check.mjs <base-url> <version> <build-id> [allow-sms-disabled]');
}

let body;
try {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/enterprise/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  body = await response.json();
  if (!response.ok) fail(`HTTP ${response.status}: ${JSON.stringify(body)}`);
} catch (error) {
  fail(`健康检查请求失败：${error instanceof Error ? error.message : String(error)}`);
}

const requiredCapabilities = [
  'password_auth',
  'sms_registration',
  'organization_invites',
  'usage_summary',
  'admin_console',
  'direct_messages',
  'atoa',
  'position_invites',
  'park_service_push',
  'park_repair_v1',
];
const missing = requiredCapabilities.filter(
  (capability) => !body.capabilities?.includes(capability),
);
if (
  body.status !== 'ok'
  || body.service !== 'otto-enterprise'
  || body.apiVersion !== 3
  || body.version !== expectedVersion
  || body.buildCommit !== expectedBuild
  || body.schemaVersion !== 3
  || body.db !== 'connected'
  || missing.length > 0
) {
  fail(`健康身份不匹配：${JSON.stringify(body)}`);
}
if (requireSms && body.sms?.configured !== true) {
  fail('短信通道未配置，邀请码注册不可用');
}
process.stdout.write(`${JSON.stringify({ ok: true, health: body })}\n`);
