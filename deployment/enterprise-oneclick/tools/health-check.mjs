#!/usr/bin/env node

function fail(message) {
  process.stderr.write(`[Otto Health] ${message}\n`);
  process.exit(5);
}

const baseUrl = process.argv[2];
const expectedVersion = process.argv[3];
const expectedBuild = process.argv[4];
const expectedSchema = Number(process.argv[5]);
const requireSms = process.argv[6] !== 'allow-sms-disabled';
if (!baseUrl || !expectedVersion || !expectedBuild || !Number.isInteger(expectedSchema)) {
  fail('用法：health-check.mjs <base-url> <version> <build-id> <schema> [allow-sms-disabled]');
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
  'personal_enterprise_upgrade',
  'organization_invites',
  'usage_summary',
  'admin_console',
  'direct_messages',
  'atoa',
  'position_invites',
  'park_service_push',
  'park_repair_v1',
  'data_protection_v1',
  'encrypted_attachment_storage_v1',
  'data_governance_v1',
  'privacy_self_service',
];
const missing = requiredCapabilities.filter(
  (capability) => !body.capabilities?.includes(capability),
);
if (
  body.status !== 'ok'
  || body.service !== 'otto-enterprise'
  || body.apiVersion !== 4
  || body.version !== expectedVersion
  || body.buildCommit !== expectedBuild
  || body.schemaVersion !== expectedSchema
  || body.db !== 'connected'
  || body.deployment?.license?.enforce !== true
  || missing.length > 0
) {
  fail(`健康身份不匹配：${JSON.stringify(body)}`);
}
if (requireSms && body.sms?.configured !== true) {
  fail('短信通道未配置，邀请码注册不可用');
}
process.stdout.write(`${JSON.stringify({ ok: true, health: body })}\n`);
