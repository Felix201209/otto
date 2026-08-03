#!/usr/bin/env node

/**
 * Black-box acceptance for two Otto private deployments connected through a
 * staging Otto Control federation gateway. This must never run against a
 * production deployment because it temporarily disables one test deployment.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const RESPONSE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function origin(value, name, allowInsecureLoopback) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:'))
  ) {
    throw new Error(`${name} must be an HTTPS origin without credentials or path`);
  }
  return url.origin;
}

export function parseFederationStagingSmokeConfig(env = process.env) {
  if (env.OTTO_FEDERATION_SMOKE_CONFIRM !== 'STAGING_ONLY') {
    throw new Error('OTTO_FEDERATION_SMOKE_CONFIRM must be STAGING_ONLY');
  }
  const allowInsecureLoopback = env.OTTO_FEDERATION_SMOKE_ALLOW_HTTP === 'true';
  return {
    gatewayUrl: origin(
      required(env, 'OTTO_FEDERATION_SMOKE_GATEWAY_URL'),
      'OTTO_FEDERATION_SMOKE_GATEWAY_URL',
      allowInsecureLoopback,
    ),
    gatewayAdminToken: required(env, 'OTTO_FEDERATION_SMOKE_GATEWAY_ADMIN_TOKEN'),
    serverAUrl: origin(
      required(env, 'OTTO_FEDERATION_SMOKE_SERVER_A_URL'),
      'OTTO_FEDERATION_SMOKE_SERVER_A_URL',
      allowInsecureLoopback,
    ),
    serverAAdminToken: required(env, 'OTTO_FEDERATION_SMOKE_SERVER_A_ADMIN_TOKEN'),
    serverAMemberToken: required(env, 'OTTO_FEDERATION_SMOKE_SERVER_A_MEMBER_TOKEN'),
    serverBUrl: origin(
      required(env, 'OTTO_FEDERATION_SMOKE_SERVER_B_URL'),
      'OTTO_FEDERATION_SMOKE_SERVER_B_URL',
      allowInsecureLoopback,
    ),
    serverBAdminToken: required(env, 'OTTO_FEDERATION_SMOKE_SERVER_B_ADMIN_TOKEN'),
    serverBMemberToken: required(env, 'OTTO_FEDERATION_SMOKE_SERVER_B_MEMBER_TOKEN'),
    sourceCommit: env.OTTO_FEDERATION_SMOKE_SOURCE_COMMIT?.trim() || null,
  };
}

async function responseText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw new Error(`response from ${response.url} exceeded the limit`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error(`response from ${response.url} exceeded the limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestJson(fetchImpl, input) {
  const response = await fetchImpl(`${input.origin}${input.path}`, {
    method: input.method || 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel();
    throw new Error(`${input.path} returned an unexpected content type`);
  }
  const text = await responseText(response);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${input.path} returned invalid JSON`);
  }
  const expected = input.expected || [200];
  if (!expected.includes(response.status)) {
    const message = payload?.error?.message || payload?.error || response.statusText;
    throw new Error(`${input.path} failed (${response.status}): ${message}`);
  }
  return payload;
}

function encryptedPayload(options = {}) {
  return Buffer.from(JSON.stringify({
    messageCiphertext: randomBytes(48).toString('base64url'),
    ...(options.withAttachment ? {
      encryptedAttachments: [{
        contentCiphertext: randomBytes(96).toString('base64url'),
        metadataCiphertext: randomBytes(32).toString('base64url'),
      }],
    } : {}),
  })).toString('base64url');
}

function messageId(label) {
  return `fmsg_smoke_${label}_${randomUUID().replaceAll('-', '')}`;
}

async function member(fetchImpl, serverUrl, token) {
  const response = await requestJson(fetchImpl, {
    origin: serverUrl,
    path: '/enterprise/auth/me',
    token,
  });
  if (!response.account?.id || !response.account?.organizationId) {
    throw new Error('enterprise member response is incomplete');
  }
  return response.account;
}

async function provisioning(fetchImpl, serverUrl, token) {
  const response = await requestJson(fetchImpl, {
    origin: serverUrl,
    path: '/enterprise/federation/admin/provisioning',
    token,
  });
  if (!response.provisioning?.deployment?.id || !response.provisioning?.signingKey?.publicKeyPem) {
    throw new Error('federation provisioning response is incomplete');
  }
  return response.provisioning;
}

async function registerDeployment(fetchImpl, config, manifest) {
  await requestJson(fetchImpl, {
    origin: config.gatewayUrl,
    path: '/v1/admin/federation/deployments',
    method: 'POST',
    token: config.gatewayAdminToken,
    expected: [200, 201],
    body: manifest.deployment,
  });
  await requestJson(fetchImpl, {
    origin: config.gatewayUrl,
    path: `/v1/admin/federation/deployments/${encodeURIComponent(manifest.deployment.id)}/keys`,
    method: 'POST',
    token: config.gatewayAdminToken,
    expected: [200, 201],
    body: { publicKeyPem: manifest.signingKey.publicKeyPem },
  });
}

async function setDeploymentStatus(fetchImpl, config, deploymentId, statusValue) {
  await requestJson(fetchImpl, {
    origin: config.gatewayUrl,
    path: `/v1/admin/federation/deployments/${encodeURIComponent(deploymentId)}/status`,
    method: 'PATCH',
    token: config.gatewayAdminToken,
    body: { status: statusValue },
  });
}

async function runCycle(fetchImpl, serverUrl, token) {
  return requestJson(fetchImpl, {
    origin: serverUrl,
    path: '/enterprise/federation/admin/run',
    method: 'POST',
    token,
  });
}

async function status(fetchImpl, serverUrl, token) {
  const response = await requestJson(fetchImpl, {
    origin: serverUrl,
    path: '/enterprise/federation/admin/status',
    token,
  });
  return response.federation;
}

async function inbox(fetchImpl, serverUrl, token) {
  const response = await requestJson(fetchImpl, {
    origin: serverUrl,
    path: '/enterprise/federation/messages?after=0&limit=200',
    token,
  });
  return Array.isArray(response.messages) ? response.messages : [];
}

async function waitForMessage(fetchImpl, input) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await runCycle(fetchImpl, input.senderUrl, input.senderAdminToken);
    await runCycle(fetchImpl, input.recipientUrl, input.recipientAdminToken);
    const messages = await inbox(fetchImpl, input.recipientUrl, input.recipientMemberToken);
    const found = messages.find((message) => message.messageId === input.messageId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`message ${input.messageId} was not delivered before the timeout`);
}

async function queueMessage(fetchImpl, input) {
  return requestJson(fetchImpl, {
    origin: input.serverUrl,
    path: '/enterprise/federation/messages',
    method: 'POST',
    token: input.memberToken,
    expected: [202],
    body: input.body,
  });
}

async function consume(fetchImpl, serverUrl, token, id) {
  await requestJson(fetchImpl, {
    origin: serverUrl,
    path: `/enterprise/federation/messages/${encodeURIComponent(id)}/consume`,
    method: 'POST',
    token,
  });
}

function queueCount(federationStatus, name) {
  const value = Number(federationStatus?.queue?.[name]);
  if (!Number.isFinite(value)) throw new Error(`federation status is missing queue.${name}`);
  return value;
}

export async function runFederationStagingSmoke(config, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const startedAt = new Date().toISOString();
  const accountA = await member(fetchImpl, config.serverAUrl, config.serverAMemberToken);
  const accountB = await member(fetchImpl, config.serverBUrl, config.serverBMemberToken);
  const manifestA = await provisioning(fetchImpl, config.serverAUrl, config.serverAAdminToken);
  const manifestB = await provisioning(fetchImpl, config.serverBUrl, config.serverBAdminToken);
  if (manifestA.deployment.id === manifestB.deployment.id) {
    throw new Error('staging smoke requires two independent deployment IDs');
  }
  await registerDeployment(fetchImpl, config, manifestA);
  await registerDeployment(fetchImpl, config, manifestB);
  await setDeploymentStatus(fetchImpl, config, manifestA.deployment.id, 'active');
  await setDeploymentStatus(fetchImpl, config, manifestB.deployment.id, 'active');

  await requestJson(fetchImpl, {
    origin: config.serverAUrl,
    path: `/enterprise/federation/directory/${encodeURIComponent(manifestB.deployment.id)}`,
    token: config.serverAMemberToken,
  });
  await requestJson(fetchImpl, {
    origin: config.serverBUrl,
    path: `/enterprise/federation/directory/${encodeURIComponent(manifestA.deployment.id)}`,
    token: config.serverBMemberToken,
  });

  const chatId = messageId('chat');
  const chatCiphertext = encryptedPayload({ withAttachment: true });
  const chatMessage = {
    serverUrl: config.serverAUrl,
    memberToken: config.serverAMemberToken,
    body: {
      messageId: chatId,
      type: 'chat.message',
      recipientDeploymentId: manifestB.deployment.id,
      recipientPrincipalId: accountB.id,
      conversationId: `conversation_smoke_${randomUUID().replaceAll('-', '')}`,
      ciphertext: chatCiphertext,
    },
  };
  await queueMessage(fetchImpl, chatMessage);
  await queueMessage(fetchImpl, chatMessage);
  const deliveredChat = await waitForMessage(fetchImpl, {
    senderUrl: config.serverAUrl,
    senderAdminToken: config.serverAAdminToken,
    recipientUrl: config.serverBUrl,
    recipientAdminToken: config.serverBAdminToken,
    recipientMemberToken: config.serverBMemberToken,
    messageId: chatId,
  });
  if (deliveredChat.ciphertext !== chatCiphertext) {
    throw new Error('federation changed the opaque message or attachment ciphertext');
  }
  const deliveredCopies = (await inbox(
    fetchImpl,
    config.serverBUrl,
    config.serverBMemberToken,
  )).filter((message) => message.messageId === chatId);
  if (deliveredCopies.length !== 1) {
    throw new Error(`duplicate federation message was delivered ${deliveredCopies.length} times`);
  }
  await consume(fetchImpl, config.serverBUrl, config.serverBMemberToken, chatId);
  await runCycle(fetchImpl, config.serverBUrl, config.serverBAdminToken);
  if ((await inbox(fetchImpl, config.serverBUrl, config.serverBMemberToken))
    .some((message) => message.messageId === chatId)) {
    throw new Error('consumed federation message remained in the recipient inbox');
  }

  const grantResponse = await requestJson(fetchImpl, {
    origin: config.serverBUrl,
    path: '/enterprise/federation/a2a/grants',
    method: 'POST',
    token: config.serverBMemberToken,
    expected: [201],
    body: {
      requesterDeploymentId: manifestA.deployment.id,
      requesterPrincipalId: accountA.id,
      scopes: ['worklog.read'],
      expiresInMs: 10 * 60_000,
    },
  });
  const grantId = grantResponse.grant?.id;
  if (!grantId) throw new Error('A2A grant response is incomplete');
  const a2aId = messageId('a2a');
  const conversationId = `conversation_smoke_a2a_${randomUUID().replaceAll('-', '')}`;
  await queueMessage(fetchImpl, {
    serverUrl: config.serverAUrl,
    memberToken: config.serverAMemberToken,
    body: {
      messageId: a2aId,
      type: 'a2a.request',
      recipientDeploymentId: manifestB.deployment.id,
      recipientPrincipalId: accountB.id,
      conversationId,
      ciphertext: encryptedPayload(),
      a2aGrantId: grantId,
      a2aScope: 'worklog.read',
    },
  });
  await waitForMessage(fetchImpl, {
    senderUrl: config.serverAUrl,
    senderAdminToken: config.serverAAdminToken,
    recipientUrl: config.serverBUrl,
    recipientAdminToken: config.serverBAdminToken,
    recipientMemberToken: config.serverBMemberToken,
    messageId: a2aId,
  });
  await consume(fetchImpl, config.serverBUrl, config.serverBMemberToken, a2aId);

  const failedBeforeReuse = queueCount(
    await status(fetchImpl, config.serverAUrl, config.serverAAdminToken),
    'outboxFailed',
  );
  await queueMessage(fetchImpl, {
    serverUrl: config.serverAUrl,
    memberToken: config.serverAMemberToken,
    body: {
      messageId: messageId('a2a_reuse'),
      type: 'a2a.request',
      recipientDeploymentId: manifestB.deployment.id,
      recipientPrincipalId: accountB.id,
      conversationId,
      ciphertext: encryptedPayload(),
      a2aGrantId: grantId,
      a2aScope: 'worklog.read',
    },
  });
  await runCycle(fetchImpl, config.serverAUrl, config.serverAAdminToken);
  const failedAfterReuse = queueCount(
    await status(fetchImpl, config.serverAUrl, config.serverAAdminToken),
    'outboxFailed',
  );
  if (failedAfterReuse <= failedBeforeReuse) {
    throw new Error('reusing a consumed A2A grant was not rejected permanently');
  }

  const failedBeforeDisable = failedAfterReuse;
  await setDeploymentStatus(fetchImpl, config, manifestA.deployment.id, 'disabled');
  try {
    await queueMessage(fetchImpl, {
      serverUrl: config.serverAUrl,
      memberToken: config.serverAMemberToken,
      body: {
        messageId: messageId('disabled'),
        type: 'chat.message',
        recipientDeploymentId: manifestB.deployment.id,
        recipientPrincipalId: accountB.id,
        conversationId: `conversation_smoke_disabled_${randomUUID().replaceAll('-', '')}`,
        ciphertext: encryptedPayload(),
      },
    });
    await runCycle(fetchImpl, config.serverAUrl, config.serverAAdminToken);
    const failedAfterDisable = queueCount(
      await status(fetchImpl, config.serverAUrl, config.serverAAdminToken),
      'outboxFailed',
    );
    if (failedAfterDisable <= failedBeforeDisable) {
      throw new Error('disabled deployment continued to send federation traffic');
    }
  } finally {
    await setDeploymentStatus(fetchImpl, config, manifestA.deployment.id, 'active');
  }

  return {
    version: 1,
    result: 'passed',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceCommit: config.sourceCommit,
    gatewayOrigin: config.gatewayUrl,
    deployments: [
      { id: manifestA.deployment.id, keyId: manifestA.signingKey.keyId },
      { id: manifestB.deployment.id, keyId: manifestB.signingKey.keyId },
    ],
    evidence: {
      directory: 'passed',
      opaqueMessageAndAttachmentPayload: 'passed',
      inboxAcknowledgement: 'passed',
      oneTimeScopedA2aGrant: 'passed',
      disabledDeploymentFailClosed: 'passed',
    },
  };
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  Promise.resolve()
    .then(() => runFederationStagingSmoke(parseFederationStagingSmokeConfig()))
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`Federation staging smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
