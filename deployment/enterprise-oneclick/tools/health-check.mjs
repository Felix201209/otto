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
const adminToken = process.argv[7];
if (
  !baseUrl ||
  !expectedVersion ||
  !/^[0-9a-f]{40}$/i.test(expectedBuild ?? '') ||
  !Number.isInteger(expectedSchema) ||
  !adminToken
) {
  fail(
    '用法：health-check.mjs <base-url> <version> <build-id> <schema> <allow-sms-disabled|require-sms> <admin-token>',
  );
}

const origin = baseUrl.replace(/\/+$/, '');
let publicHealth;
let deploymentStatus;
try {
  const response = await fetch(`${origin}/enterprise/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  publicHealth = await response.json();
  if (!response.ok) {
    fail(
      `公开健康检查 HTTP ${response.status}: ${JSON.stringify(publicHealth)}`,
    );
  }

  const protectedResponse = await fetch(
    `${origin}/enterprise/deployment/status`,
    {
      headers: { 'x-otto-admin-token': adminToken },
      signal: AbortSignal.timeout(10_000),
    },
  );
  deploymentStatus = await protectedResponse.json();
  if (!protectedResponse.ok) {
    fail(
      `受保护健康检查 HTTP ${protectedResponse.status}: ${JSON.stringify(deploymentStatus)}`,
    );
  }
} catch (error) {
  fail(
    `健康检查请求失败：${error instanceof Error ? error.message : String(error)}`,
  );
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
  'encrypted_message_storage_v1',
  'signed_telemetry_transport_v1',
  'data_governance_v1',
  'privacy_self_service',
];
const missing = requiredCapabilities.filter(
  (capability) => !publicHealth.capabilities?.includes(capability),
);
if (
  publicHealth.status !== 'ok' ||
  publicHealth.service !== 'otto-enterprise' ||
  publicHealth.apiVersion !== 4 ||
  publicHealth.version !== expectedVersion ||
  missing.length > 0
) {
  fail(`公开健康身份不匹配：${JSON.stringify(publicHealth)}`);
}

const runtime = deploymentStatus.runtime;
if (
  runtime?.version !== expectedVersion ||
  runtime?.buildCommit !== expectedBuild ||
  runtime?.database?.ready !== true ||
  runtime?.database?.schemaVersion !== expectedSchema ||
  deploymentStatus.license?.enforce !== true
) {
  fail('受保护运行身份、数据库 Schema 或 License 强制策略不匹配');
}
if (deploymentStatus.operationsSecurity?.sqlCipher?.state !== 'active') {
  fail('SQLCipher 整库加密未处于 active 状态');
}
if (requireSms && runtime.smsConfigured !== true) {
  fail('短信通道未配置，邀请码注册不可用');
}
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: runtime.version,
    buildCommit: runtime.buildCommit,
    schemaVersion: runtime.database.schemaVersion,
    sqlCipher: 'active',
    smsConfigured: runtime.smsConfigured === true,
  })}\n`,
);
