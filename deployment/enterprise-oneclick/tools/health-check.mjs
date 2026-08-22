#!/usr/bin/env node

function fail(message) {
  process.stderr.write(`[Otto Health] ${message}\n`);
  process.exit(5);
}

async function fetchJson(url, headers = undefined, method = 'GET') {
  try {
    const response = await fetch(url, {
      headers,
      method,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok) {
      fail(`HTTP ${response.status} from ${url}: ${JSON.stringify(body)}`);
    }
    return body;
  } catch (error) {
    fail(
      `health request failed for ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const baseUrl = process.argv[2]?.replace(/\/+$/, '');
const expectedVersion = process.argv[3];
const expectedBuild = process.argv[4];
const expectedSchema = Number(process.argv[5]);
const requireSms = process.argv[6] !== 'allow-sms-disabled';
const adminToken =
  process.env.OTTO_ENTERPRISE_ADMIN_TOKEN?.trim() || process.argv[7]?.trim();
const requireDeploymentActivation =
  process.argv[8] !== 'allow-unactivated-deployment';
if (
  !baseUrl ||
  !expectedVersion ||
  !/^[a-f0-9]{40}$/i.test(expectedBuild || '') ||
  !Number.isInteger(expectedSchema) ||
  !adminToken
) {
  fail(
    'usage: health-check.mjs <base-url> <version> <40-char-build-id> <schema> [allow-sms-disabled] [admin-token] [allow-unactivated-deployment]',
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
  'managed_model_gateway_v1',
];

const publicHealth = await fetchJson(`${baseUrl}/enterprise/health`);
const missingCapabilities = requiredCapabilities.filter(
  (capability) => !publicHealth.capabilities?.includes(capability),
);
const privatePublicFields = [
  'buildCommit',
  'schemaVersion',
  'db',
  'deployment',
  'machineFingerprint',
  'license',
  'runtimeHealth',
  'sms',
].filter((field) => Object.hasOwn(publicHealth, field));

if (
  publicHealth.status !== 'ok' ||
  publicHealth.service !== 'otto-enterprise' ||
  publicHealth.apiVersion !== 4 ||
  publicHealth.version !== expectedVersion ||
  missingCapabilities.length > 0
) {
  fail(`public health identity mismatch: ${JSON.stringify(publicHealth)}`);
}
if (privatePublicFields.length > 0) {
  fail(`public health leaks private fields: ${privatePublicFields.join(', ')}`);
}

const deploymentStatus = await fetchJson(
  `${baseUrl}/enterprise/deployment/status`,
  { 'x-otto-admin-token': adminToken },
);
const runtime = deploymentStatus.runtime;
if (
  runtime?.version !== expectedVersion ||
  runtime?.buildCommit !== expectedBuild ||
  runtime?.database?.ready !== true ||
  runtime?.database?.schemaVersion !== expectedSchema
) {
  fail(
    `private runtime readiness mismatch: ${JSON.stringify({
      version: runtime?.version,
      buildCommit: runtime?.buildCommit,
      database: runtime?.database,
    })}`,
  );
}
if (deploymentStatus.license?.enforce !== true) {
  fail('deployment License enforcement is not active');
}
if (deploymentStatus.operationsSecurity?.sqlCipher?.state !== 'active') {
  fail('SQLCipher encryption is not active');
}
let deploymentReady = false;
if (requireDeploymentActivation) {
  const usableLicenseStates = new Set(['active', 'expiring', 'grace']);
  if (
    !usableLicenseStates.has(deploymentStatus.license?.status) ||
    (deploymentStatus.license?.lease?.required === true &&
      deploymentStatus.license?.lease?.status !== 'active')
  ) {
    fail('deployment License is not usable');
  }
  const bootstrap = await fetchJson(
    `${baseUrl}/enterprise/bootstrap/prepare`,
    undefined,
    'POST',
  );
  if (
    bootstrap.readiness?.canAuthenticate !== true ||
    bootstrap.readiness?.canUseLicensedFeatures !== true ||
    !['ready', 'degraded'].includes(bootstrap.readiness?.state)
  ) {
    fail(
      `private deployment bootstrap is not ready: ${JSON.stringify(bootstrap)}`,
    );
  }
  deploymentReady = true;
}

if (requireSms) {
  if (runtime?.smsConfigured !== true) {
    fail('SMS runtime configuration is incomplete');
  }
  const missingSmsConfiguration = [
    'ALIYUN_SMS_ACCESS_KEY_ID',
    'ALIYUN_SMS_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_ID',
  ].filter((key) => !process.env[key]?.trim());
  if (missingSmsConfiguration.length > 0) {
    fail(
      `SMS configuration is incomplete: ${missingSmsConfiguration.join(', ')}`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    service: publicHealth.service,
    version: expectedVersion,
    buildCommit: expectedBuild,
    schemaVersion: expectedSchema,
    sqlCipher: 'active',
    licenseEnforced: true,
    deploymentReady,
    smsRequired: requireSms,
  })}\n`,
);
