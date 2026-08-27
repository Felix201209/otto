/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL-backed enterprise HTTP entry point. It deliberately imports no
 * legacy SQLite repository module, so clustered mode cannot create a hidden
 * local authority or split writes between databases.
 */

import { randomBytes, randomInt } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createAliyunLoginSmsFromEnv } from 'otto-core';

import {
  commercialFeatureForEnterpriseRoute,
  isLicenseMaintenanceRoute,
} from '../modules/authorization/index.js';
import type {
  E2eeAttachmentCiphertextInput,
  E2eeMessageEnvelope,
} from '../modules/collaboration/index.js';
import { E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES } from '../modules/collaboration/index.js';
import {
  evaluateClusteredLicense,
  parsePublicKeyList,
  type ClusteredLicenseDecision,
} from '../modules/commercial_control/index.js';
import {
  currentLegalDocumentReferences,
  requireCurrentLegalDocumentReferences,
  sendLegalPage,
} from '../modules/data_governance/index.js';
import {
  buildOrganizationInviteLink,
  isAcceptableAccountPassword,
  isOrganizationInviteCode,
  resolveEnterprisePublicBaseUrl,
} from '../modules/identity_organization/index.js';
import {
  buildNodePostgresPoolConfig,
  ciphertextSha256,
  createNodePostgresPool,
  createPostgresDatabaseLifecycle,
  resolveEnterpriseDatabaseTopology,
  type ClusteredEnterpriseInfrastructureReadiness,
  type AttachmentMultipartPart,
  type AttachmentMlsAccessContext,
  type AttachmentMlsAuthorization,
  type createAttachmentStorageService,
  type PostgresDatabaseReadiness,
} from '../modules/data_platform/index.js';
import { createClusteredAttachmentMaintenance } from './clusteredAttachmentMaintenance.js';
import { handleClusteredBusinessRoute } from './clusteredBusinessRoutes.js';
import { createClusteredMlsMaintenance } from './clusteredMlsMaintenance.js';
import { e2eeProductionCapabilities } from './e2eeProductionReleasePolicy.js';
import {
  createClusteredEnterpriseInfrastructure,
  type ClusteredEnterpriseInfrastructure,
} from './clusteredInfrastructure.js';
import type { ClusteredEnterpriseSharedState } from './clusteredSharedState.js';
import {
  PostgresEnterpriseLicenseAdmissionError,
  PostgresEnterpriseSeatLimitError,
} from './postgresLicenseSeatAdmission.js';
import {
  createPostgresEnterpriseCoreRepository,
  normalizePostgresEnterprisePhone,
  type PostgresEnterpriseAccountView,
  type PostgresEnterpriseCoreRepository,
  type PostgresE2eeAttachmentReferenceInput,
  type UpdatePostgresEnterpriseAccountInput,
} from './postgresCoreRepository.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';
import { sendPublicInvitePage } from './publicInvitePage.js';

const DEFAULT_PORT = 7777;
const DEFAULT_BODY_LIMIT = 1_000_000;
const E2EE_BODY_LIMIT = 30 * 1024 * 1024;

export interface ClusteredEnterpriseServerOptions {
  host?: string;
  port?: number;
  adminToken?: string;
  appVersion?: string;
  buildCommit?: string;
  publicUrl?: string;
  smsSender?: ClusteredEnterpriseSmsSender | null;
  licensePublicKeys?: readonly string[];
  infrastructure?: ClusteredEnterpriseInfrastructure;
  /** @deprecated Inject the complete clustered infrastructure instead. */
  repository?: PostgresEnterpriseCoreRepository;
  /** @deprecated Inject the complete clustered infrastructure instead. */
  databaseReadiness?: () => Promise<PostgresDatabaseReadiness>;
  /** @deprecated Inject the complete clustered infrastructure instead. */
  closeDatabase?: () => Promise<void>;
  bootstrapAdmin?: {
    username: string;
    password: string;
    name: string;
  };
}

export interface ClusteredEnterpriseSmsSender {
  sendVerificationCode(phone: string, code: string): Promise<boolean>;
}

type JsonBody = Record<string, unknown>;
type AttachmentStorageService = ReturnType<
  typeof createAttachmentStorageService
>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  limit = DEFAULT_BODY_LIMIT,
): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = text ? (JSON.parse(text) as unknown) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('request body must be a JSON object');
        }
        resolve(parsed as JsonBody);
      } catch {
        reject(new Error('request body is invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization?.trim() || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || '';
}

function constantTimeTokenEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function routeErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/MLS .*rate limit|MLS .*inventory quota/i.test(message)) return 429;
  if (
    /MLS event cursor expired|MLS reset source group is no longer active/i.test(
      message,
    )
  ) {
    return 409;
  }
  if (
    /redis|s3|shared infrastructure|database operation failed|econn|socket|timeout|timed out|connection closed/i.test(
      message,
    )
  ) {
    return 503;
  }
  if (/attachment access denied/i.test(message)) return 404;
  if (/attachment storage quota exceeded/i.test(message)) return 413;
  if (/not found|unavailable/i.test(message)) return 404;
  if (
    /already|unique|duplicate|retain one active administrator/i.test(message)
  ) {
    return 409;
  }
  return 400;
}

function safeRouteError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'request failed';
  if (/postgres(?:ql)?:\/\//i.test(message)) return 'database operation failed';
  if (/redis(?:s)?:\/\/|s3|shared infrastructure|econn|socket/i.test(message)) {
    return 'shared infrastructure operation failed';
  }
  return message.replace(/https?:\/\/[^\s]+/giu, '[REDACTED]').slice(0, 500);
}

function exactMlsDeviceRoster(
  raw: unknown,
  expected: Array<{ accountId: string; deviceId: string }>,
): boolean {
  return (
    Array.isArray(raw) &&
    raw.length === expected.length &&
    raw.every((candidate, index) => {
      const device = candidate as Record<string, unknown> | null;
      return (
        device?.accountId === expected[index]!.accountId &&
        device?.deviceId === expected[index]!.deviceId
      );
    })
  );
}

async function resolveMlsAttachmentAccess(
  repository: PostgresEnterpriseCoreRepository,
  member: PostgresEnterpriseAccountView,
  peerAccountId: unknown,
  deviceId: unknown,
): Promise<AttachmentMlsAccessContext | undefined> {
  const peer = typeof peerAccountId === 'string' ? peerAccountId : '';
  const device = typeof deviceId === 'string' ? deviceId : '';
  if (!peer && !device) return undefined;
  if (!peer || !device)
    throw new Error('MLS attachment request identity is invalid');
  const session = await repository.getMlsAttachmentSession({
    organizationId: member.organizationId,
    accountId: member.id,
    peerAccountId: peer,
    deviceId: device,
  });
  return { deviceId: device, session };
}

async function resolveMlsAttachmentAuthorization(
  repository: PostgresEnterpriseCoreRepository,
  member: PostgresEnterpriseAccountView,
  body: JsonBody,
): Promise<AttachmentMlsAuthorization> {
  const binding =
    body.mlsBinding && typeof body.mlsBinding === 'object'
      ? (body.mlsBinding as Record<string, unknown>)
      : null;
  const peerAccountId =
    typeof body.peerAccountId === 'string' ? body.peerAccountId : '';
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  if (!binding || !peerAccountId || !deviceId) {
    throw new Error('MLS attachment binding is invalid');
  }
  const session = await repository.getMlsAttachmentSession({
    organizationId: member.organizationId,
    accountId: member.id,
    peerAccountId,
    deviceId,
  });
  if (
    binding.organizationId !== member.organizationId ||
    binding.conversationId !== session.conversationId ||
    Number(binding.sessionGeneration) !== session.sessionGeneration ||
    binding.groupId !== session.groupId ||
    Number(binding.epoch) !== session.epoch ||
    typeof binding.messageId !== 'string' ||
    !exactMlsDeviceRoster(body.authorizedDevices, session.authorizedDevices)
  ) {
    throw new Error('MLS attachment session binding is invalid');
  }
  return {
    conversationId: session.conversationId,
    sessionGeneration: session.sessionGeneration,
    groupId: session.groupId,
    epoch: session.epoch,
    messageId: binding.messageId,
    participantAccountIds: session.participantAccountIds,
    authorizedDevices: session.authorizedDevices,
  };
}

async function requireMember(
  repository: PostgresEnterpriseCoreRepository,
  req: IncomingMessage,
  res: ServerResponse,
  sharedState?: ClusteredEnterpriseSharedState,
): Promise<PostgresEnterpriseAccountView | null> {
  const token = bearerToken(req);
  const account = sharedState
    ? await sharedState.getAccountBySession(token)
    : await repository.getAccountBySession(token);
  if (!account) {
    sendJson(res, 401, { error: 'login expired', code: 'AUTH_REQUIRED' });
    return null;
  }
  return account;
}

function isSystemAdmin(req: IncomingMessage, adminToken: string): boolean {
  const supplied =
    (Array.isArray(req.headers['x-otto-admin-token'])
      ? req.headers['x-otto-admin-token'][0]
      : req.headers['x-otto-admin-token']) || '';
  return constantTimeTokenEqual(supplied, adminToken);
}

async function requireAdministrator(input: {
  repository: PostgresEnterpriseCoreRepository;
  req: IncomingMessage;
  res: ServerResponse;
  adminToken: string;
  sharedState?: ClusteredEnterpriseSharedState;
}): Promise<
  | { kind: 'system'; organizationId: string }
  | {
      kind: 'account';
      organizationId: string;
      account: PostgresEnterpriseAccountView;
    }
  | null
> {
  if (isSystemAdmin(input.req, input.adminToken)) {
    return {
      kind: 'system',
      organizationId: input.repository.defaultOrganizationId,
    };
  }
  const account = await requireMember(
    input.repository,
    input.req,
    input.res,
    input.sharedState,
  );
  if (!account) return null;
  if (!account.isAdmin) {
    sendJson(input.res, 403, {
      error: 'administrator permission required',
      code: 'ADMIN_REQUIRED',
    });
    return null;
  }
  return { kind: 'account', organizationId: account.organizationId, account };
}

function accountPatch(
  body: JsonBody,
  organizationId: string,
  accountId: string,
): UpdatePostgresEnterpriseAccountInput {
  return {
    organizationId,
    accountId,
    ...(typeof body.username === 'string' ? { username: body.username } : {}),
    ...(typeof body.password === 'string' ? { password: body.password } : {}),
    ...(typeof body.name === 'string' ? { name: body.name } : {}),
    ...(body.phone === null || typeof body.phone === 'string'
      ? { phone: body.phone }
      : {}),
    ...(body.feishuOpenId === null || typeof body.feishuOpenId === 'string'
      ? { feishuOpenId: body.feishuOpenId }
      : {}),
    ...(body.role === null || typeof body.role === 'string'
      ? { role: body.role }
      : {}),
    ...(body.department === null || typeof body.department === 'string'
      ? { department: body.department }
      : {}),
    ...(body.departmentId === null || typeof body.departmentId === 'string'
      ? { departmentId: body.departmentId }
      : {}),
    ...(body.positionId === null || typeof body.positionId === 'string'
      ? { positionId: body.positionId }
      : {}),
    ...(body.positionTitle === null || typeof body.positionTitle === 'string'
      ? { positionTitle: body.positionTitle }
      : {}),
    ...(body.avatarUrl === null || typeof body.avatarUrl === 'string'
      ? { avatarUrl: body.avatarUrl }
      : {}),
    ...(typeof body.isAdmin === 'boolean' ? { isAdmin: body.isAdmin } : {}),
    ...(body.status === 'active' || body.status === 'disabled'
      ? { status: body.status }
      : {}),
    ...(Array.isArray(body.tags)
      ? {
          tags: body.tags.filter(
            (tag): tag is string => typeof tag === 'string',
          ),
        }
      : {}),
  };
}

function attachmentCiphertext(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('attachment ciphertext is required');
  }
  const normalized = value.trim();
  const ciphertext = Buffer.from(normalized, 'base64');
  if (
    ciphertext.length <= 16 ||
    ciphertext.length > E2EE_ATTACHMENT_MAX_CIPHERTEXT_BYTES ||
    ciphertext.toString('base64').replace(/=+$/u, '') !==
      normalized.replace(/=+$/u, '')
  ) {
    throw new Error('attachment ciphertext is invalid');
  }
  return ciphertext;
}

function publicAttachmentMetadata(metadata: {
  id: string;
  state: string;
  ciphertextBytes: number;
  ciphertextSha256: string;
  encryption: string;
  expiresAt: string;
}) {
  return {
    id: metadata.id,
    state: metadata.state,
    ciphertextBytes: metadata.ciphertextBytes,
    ciphertextSha256: metadata.ciphertextSha256,
    encryption: metadata.encryption,
    expiresAt: metadata.expiresAt,
  };
}

function sendLicenseSeatAdmissionError(
  res: ServerResponse,
  error: unknown,
): boolean {
  if (error instanceof PostgresEnterpriseSeatLimitError) {
    sendJson(res, 402, {
      error: 'deployment seat limit is exceeded',
      code: 'deployment_seat_limit_exceeded',
    });
    return true;
  }
  if (error instanceof PostgresEnterpriseLicenseAdmissionError) {
    sendJson(res, 402, {
      error: 'deployment license changed; retry authorization',
      code: 'deployment_license_inactive',
    });
    return true;
  }
  return false;
}

async function requireClusteredLicense(input: {
  repository: PostgresEnterpriseCoreRepository;
  organizationId: string;
  actorAccountId: string | null;
  actorEmployeeId: string | null;
  res: ServerResponse;
  deploymentId: string;
  publicKeys: readonly string[];
  requiredFeature?: ReturnType<typeof commercialFeatureForEnterpriseRoute>;
  seatIncrement?: number;
  allowSeatOverage?: boolean;
  sendDenial?: boolean;
}): Promise<ClusteredLicenseDecision | null> {
  const [stored, accounts] = await Promise.all([
    input.repository.getBusinessRecord<Record<string, unknown>>({
      organizationId: input.organizationId,
      domain: 'commercial_control',
      resourceType: 'license',
      resourceId: 'current',
    }),
    input.repository.listAccounts(input.organizationId),
  ]);
  const decision = evaluateClusteredLicense({
    stored,
    organizationId: input.organizationId,
    deploymentId: input.deploymentId,
    activeSeatCount:
      accounts.filter(
        (account) =>
          account.accountType === 'enterprise' && account.status === 'active',
      ).length + Math.max(0, input.seatIncrement ?? 0),
    requiredFeature: input.requiredFeature,
    allowSeatOverage: input.allowSeatOverage,
    publicKeys: input.publicKeys,
  });
  if (decision.allowed || input.sendDenial === false) return decision;
  try {
    await input.repository.logAudit(
      'commercial_license_denied',
      input.organizationId,
      input.actorEmployeeId,
      {
        actorAccountId: input.actorAccountId,
        code: decision.code,
        feature: decision.feature ?? null,
        licenseStatus: decision.summary.status,
        activeSeatCount: decision.summary.activeSeatCount,
        seatLimit: decision.summary.seatLimit,
      },
    );
  } catch (error) {
    console.error('[Otto Enterprise] clustered license audit failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  sendJson(input.res, decision.statusCode, {
    error: decision.error,
    code: decision.code,
    ...(decision.feature ? { feature: decision.feature } : {}),
    license: decision.summary,
    allowed: ['login', 'license update', 'data export', 'diagnostics'],
  });
  return null;
}

export function createClusteredEnterpriseServer(
  repository: PostgresEnterpriseCoreRepository,
  options: {
    host?: string;
    port?: number;
    adminToken?: string;
    appVersion?: string;
    buildCommit?: string;
    databaseReadiness?: () => Promise<PostgresDatabaseReadiness>;
    infrastructureReadiness?: () => Promise<ClusteredEnterpriseInfrastructureReadiness>;
    topologyDescription?: Record<string, unknown>;
    sharedState?: ClusteredEnterpriseSharedState;
    attachmentStorage?: AttachmentStorageService;
    publicUrl?: string;
    smsSender?: ClusteredEnterpriseSmsSender | null;
    licensePublicKeys?: readonly string[];
    startedAt?: string;
  } = {},
): {
  server: Server;
  host: string;
  port: number;
  adminToken: string;
} {
  const host = options.host?.trim() || '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;
  const adminToken =
    options.adminToken?.trim() || randomBytes(24).toString('base64url');
  const startedAt = options.startedAt ?? new Date().toISOString();
  const publicBaseUrl = resolveEnterprisePublicBaseUrl({
    configuredUrl: options.publicUrl,
  });
  const deploymentId =
    process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise';
  const licensePublicKeys =
    options.licensePublicKeys ??
    parsePublicKeyList(
      process.env.OTTO_LICENSE_PUBLIC_KEYS,
      process.env.OTTO_LICENSE_REVOKED_KEY_IDS,
    );
  const governanceAuthorization = {
    deploymentId:
      process.env.OTTO_DEPLOYMENT_ID?.trim() || 'clustered-enterprise',
    license: {
      status: 'unavailable',
      plan: 'unconfigured',
      expiresAt: '',
      seatLimit: 0,
      activeSeatCount: 0,
      modules: [] as string[],
      offline: false,
      enforce: true,
    },
    telemetry: { enabled: false, contentMode: 'metadata_only' },
    dataBoundary: {
      authority: 'postgresql',
      messageContent: 'client_e2ee_ciphertext_only',
      attachmentContent: 'client_e2ee_ciphertext_only',
      clientIdentityPrivateKeys: 'client_only',
    },
  };
  const governanceAuthorizationFor = async (
    account: PostgresEnterpriseAccountView,
    res: ServerResponse,
  ) => {
    const decision = await requireClusteredLicense({
      repository,
      organizationId: account.organizationId,
      actorAccountId: account.id,
      actorEmployeeId: account.employeeId,
      res,
      deploymentId,
      publicKeys: licensePublicKeys,
      sendDenial: false,
    });
    return {
      ...governanceAuthorization,
      license: decision!.summary,
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    try {
      if (path === '/enterprise/health' && method === 'GET') {
        const [infrastructure, databaseProbe, authority] = await Promise.all([
          options.infrastructureReadiness?.(),
          options.databaseReadiness?.(),
          repository.readiness(),
        ]);
        const database = infrastructure?.database ?? databaseProbe ?? authority;
        sendJson(res, 200, {
          status: 'ok',
          apiVersion: 4,
          deployment: {
            version: options.appVersion || 'unknown',
            buildCommit: options.buildCommit || 'unknown',
            startedAt,
          },
          topology: options.topologyDescription ?? {
            mode: 'clustered-enterprise',
            database: 'postgresql',
          },
          database,
          services: infrastructure
            ? {
                cache: infrastructure.cache,
                attachments: infrastructure.attachments,
              }
            : undefined,
          authority,
          capabilities: [
            'password_auth',
            'sms_registration',
            'personal_registration',
            'organization_invites',
            'position_invites',
            'personal_enterprise_upgrade',
            'multi_organization',
            'organization_structure_v1',
            'organization_feature_switches_v1',
            'direct_messages',
            'unread_message_notifications_v1',
            'e2ee_private_messages_v1',
            'e2ee_device_trust_v1',
            'e2ee_mls_transport_v1',
            'e2ee_mls_resource_governance_v1',
            'e2ee_mls_transport_session_reset_v1',
            ...e2eeProductionCapabilities(),
            'postgresql_authority_v1',
            'postgresql_registration_v1',
            'organization_invites_v1',
            'data_governance_v1',
            'legal_documents_v1',
            'account_data_sync_v1',
            'enterprise_knowledge_v1',
            'enterprise_skill_market_v1',
            'enterprise_park_services_v1',
            'enterprise_ticketing_v1',
            'commercial_control_v1',
            'modular_update_push_v1',
            'signed_update_policy_v1',
            'privacy_export_delete_v1',
            ...(options.attachmentStorage
              ? [
                  'direct_message_attachments_v1',
                  'e2ee_attachment_objects_v1',
                  's3_multipart_uploads_v1',
                ]
              : []),
            ...(options.sharedState ? ['redis_shared_state_v1'] : []),
          ],
        });
        return;
      }

      if (path === '/enterprise/legal' && method === 'GET') {
        const profile = await repository.getDataGovernanceProfile(null);
        if ((req.headers.accept || '').includes('text/html')) {
          sendLegalPage(res, profile);
        } else {
          sendJson(res, 200, profile);
        }
        return;
      }

      if (path === '/enterprise/privacy' && method === 'GET') {
        const account = await requireMember(
          repository,
          req,
          res,
          options.sharedState,
        );
        if (!account) return;
        sendJson(res, 200, {
          ...(await repository.getDataGovernanceProfile(account)),
          authorization: await governanceAuthorizationFor(account, res),
        });
        return;
      }

      if (path === '/enterprise/privacy/accept' && method === 'POST') {
        const account = await requireMember(
          repository,
          req,
          res,
          options.sharedState,
        );
        if (!account) return;
        const body = await readJsonBody(req);
        if (body.accepted !== true) {
          sendJson(res, 400, { error: '请明确同意当前用户协议和隐私规则' });
          return;
        }
        try {
          const documents = requireCurrentLegalDocumentReferences(
            body.documents,
          );
          await repository.recordCurrentLegalConsent(account, documents);
        } catch (error) {
          sendJson(res, 409, {
            error: error instanceof Error ? error.message : '协议版本校验失败',
          });
          return;
        }
        sendJson(res, 200, {
          ...(await repository.getDataGovernanceProfile(account)),
          authorization: await governanceAuthorizationFor(account, res),
        });
        return;
      }

      if (path.startsWith('/enterprise/join/') && method === 'GET') {
        let code = '';
        try {
          code = decodeURIComponent(path.slice('/enterprise/join/'.length));
        } catch {
          sendPublicInvitePage(res, 404);
          return;
        }
        if (!isOrganizationInviteCode(code)) {
          sendPublicInvitePage(res, 404);
          return;
        }
        const invite = await repository.inspectOrganizationInvite(code);
        if (invite.status === 'invalid') {
          sendPublicInvitePage(res, 404);
        } else if (invite.status !== 'active') {
          sendPublicInvitePage(res, 410);
        } else {
          sendPublicInvitePage(res, 200, code, publicBaseUrl);
        }
        return;
      }

      if (
        path === '/enterprise/auth/register/sms/request' &&
        method === 'POST'
      ) {
        if (!options.smsSender) {
          sendJson(res, 503, {
            error: 'SMS registration is not configured',
            code: 'SMS_UNAVAILABLE',
          });
          return;
        }
        const body = await readJsonBody(req);
        const inviteCode =
          typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
        if (inviteCode) {
          const invite = await repository.inspectOrganizationInvite(inviteCode);
          if (invite.status === 'active' && invite.organizationId) {
            const admission = await requireClusteredLicense({
              repository,
              organizationId: invite.organizationId,
              actorAccountId: null,
              actorEmployeeId: null,
              res,
              deploymentId,
              publicKeys: licensePublicKeys,
              requiredFeature: 'enterprise_tree',
              seatIncrement: 1,
              sendDenial: false,
            });
            if (!admission?.allowed) {
              sendJson(res, 402, {
                error: 'organization registration is unavailable',
                code: admission?.code ?? 'deployment_license_inactive',
              });
              return;
            }
          }
        }
        const phone = typeof body.phone === 'string' ? body.phone : '';
        const localPhone = normalizePostgresEnterprisePhone(phone).slice(3);
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const issued = await repository.requestSmsRegistration({
          phone,
          code,
          inviteCode:
            typeof body.inviteCode === 'string' ? body.inviteCode : null,
        });
        if (issued.state === 'phone-conflict') {
          sendJson(res, 409, { error: 'phone is already registered' });
          return;
        }
        if (issued.state === 'invalid-invite') {
          sendJson(res, 403, {
            error: 'organization invitation is unavailable',
          });
          return;
        }
        if (issued.state === 'cooldown' || issued.state === 'hourly-limit') {
          res.setHeader('Retry-After', String(issued.retryAfterSeconds));
          sendJson(res, 429, {
            error: 'SMS verification requests are rate limited',
            retryAfterSeconds: issued.retryAfterSeconds,
          });
          return;
        }
        if (issued.state !== 'issued') {
          sendJson(res, 503, {
            error: 'SMS registration state is unavailable',
          });
          return;
        }
        let sent = false;
        try {
          sent = await options.smsSender.sendVerificationCode(localPhone, code);
        } catch {
          sent = false;
        }
        if (!sent) {
          await repository.discardSmsRegistrationChallenge(issued.challengeId);
          sendJson(res, 502, { error: 'SMS verification delivery failed' });
          return;
        }
        sendJson(res, 200, {
          challengeId: issued.challengeId,
          expiresAt: issued.expiresAt,
          retryAfterSeconds: issued.retryAfterSeconds,
          registrationMode: issued.registrationMode,
          organization: issued.organization,
          legalDocuments: currentLegalDocumentReferences(),
        });
        return;
      }

      if (
        path === '/enterprise/auth/register/sms/verify' &&
        method === 'POST'
      ) {
        const body = await readJsonBody(req);
        const challengeId =
          typeof body.challengeId === 'string' ? body.challengeId : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (body.legalConsent !== true) {
          sendJson(res, 400, { error: 'legal consent is required' });
          return;
        }
        let legalDocuments;
        try {
          legalDocuments = requireCurrentLegalDocumentReferences(
            body.legalDocuments,
          );
        } catch (error) {
          sendJson(res, 409, {
            error:
              error instanceof Error
                ? error.message
                : 'legal document version is invalid',
          });
          return;
        }
        if (
          !challengeId.startsWith('smsreg_') ||
          !/^\d{6}$/u.test(code) ||
          !name ||
          name.length > 120 ||
          !isAcceptableAccountPassword(password)
        ) {
          sendJson(res, 400, { error: 'registration details are invalid' });
          return;
        }
        const challenge =
          await repository.inspectSmsRegistrationChallenge(challengeId);
        let seatAdmission;
        if (challenge?.registrationMode === 'enterprise') {
          const license = await requireClusteredLicense({
            repository,
            organizationId: challenge.organizationId,
            actorAccountId: null,
            actorEmployeeId: null,
            res,
            deploymentId,
            publicKeys: licensePublicKeys,
            requiredFeature: 'enterprise_tree',
            seatIncrement: 1,
            sendDenial: false,
          });
          if (!license?.allowed) {
            sendJson(res, 402, {
              error: 'organization registration is unavailable',
              code: license?.code ?? 'deployment_license_inactive',
            });
            return;
          }
          seatAdmission = license.seatAdmission;
        }
        const completed = await repository.completeSmsRegistration({
          challengeId,
          code,
          name,
          password,
          legalConsent: true,
          legalDocuments,
          licenseSeatAdmission: seatAdmission,
        });
        if (completed.state === 'phone-conflict') {
          sendJson(res, 409, { error: 'phone is already registered' });
          return;
        }
        if (completed.state === 'invite-unavailable') {
          sendJson(res, 409, {
            error: 'organization invitation is unavailable',
          });
          return;
        }
        if (completed.state === 'seat-limit-exceeded') {
          sendJson(res, 402, {
            error: 'deployment seat limit is exceeded',
            code: 'deployment_seat_limit_exceeded',
          });
          return;
        }
        if (completed.state === 'license-admission-invalid') {
          sendJson(res, 402, {
            error: 'deployment license changed; retry authorization',
            code: 'deployment_license_inactive',
          });
          return;
        }
        if (completed.state !== 'registered') {
          sendJson(res, 401, {
            error: 'SMS verification code is invalid or unavailable',
            reason: completed.state,
            attemptsRemaining:
              'attemptsRemaining' in completed
                ? completed.attemptsRemaining
                : undefined,
          });
          return;
        }
        const session = await repository.createAuthSession(
          completed.account.id,
        );
        await options.sharedState?.cacheSession(
          session.token,
          session.expiresAt,
          completed.account,
        );
        sendJson(res, 200, {
          account: completed.account,
          ...session,
          legalConsentRecorded: true,
        });
        return;
      }

      if (path === '/enterprise/auth/login' && method === 'POST') {
        const body = await readJsonBody(req);
        const identifier =
          typeof body.identifier === 'string'
            ? body.identifier
            : typeof body.username === 'string'
              ? body.username
              : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const retryAfter = options.sharedState
          ? await options.sharedState.getLoginRetryAfter(identifier)
          : await repository.getLoginRetryAfter(identifier);
        if (retryAfter > 0) {
          res.setHeader('Retry-After', String(retryAfter));
          sendJson(res, 429, {
            error: 'too many login attempts',
            code: 'LOGIN_RATE_LIMITED',
            retryAfterSeconds: retryAfter,
          });
          return;
        }
        const account = await repository.authenticateAccount(
          identifier,
          password,
        );
        if (!account) {
          const failureRetryAfter =
            await repository.recordLoginFailure(identifier);
          if (failureRetryAfter > 0) {
            await options.sharedState?.recordLoginBlock(
              identifier,
              failureRetryAfter,
            );
            res.setHeader('Retry-After', String(failureRetryAfter));
            sendJson(res, 429, {
              error: 'too many login attempts',
              code: 'LOGIN_RATE_LIMITED',
              retryAfterSeconds: failureRetryAfter,
            });
            return;
          }
          sendJson(res, 401, { error: 'account or password is invalid' });
          return;
        }
        if (options.sharedState) {
          await options.sharedState.clearLoginFailures(identifier);
        } else {
          await repository.clearLoginFailures(identifier);
        }
        const session = await repository.createAuthSession(account.id);
        await options.sharedState?.cacheSession(
          session.token,
          session.expiresAt,
          account,
        );
        sendJson(res, 200, { account, ...session });
        return;
      }

      if (path === '/enterprise/auth/me' && method === 'GET') {
        const account = await requireMember(
          repository,
          req,
          res,
          options.sharedState,
        );
        if (account) sendJson(res, 200, { account });
        return;
      }

      if (path === '/enterprise/auth/logout' && method === 'POST') {
        const token = bearerToken(req);
        const account = await requireMember(
          repository,
          req,
          res,
          options.sharedState,
        );
        if (!account) return;
        if (options.sharedState) await options.sharedState.revokeSession(token);
        else await repository.revokeAuthSession(token);
        sendJson(res, 200, { status: 'logged_out' });
        return;
      }

      if (path === '/enterprise/accounts' && method === 'GET') {
        const principal = await requireAdministrator({
          repository,
          req,
          res,
          adminToken,
          sharedState: options.sharedState,
        });
        if (!principal) return;
        const license = await requireClusteredLicense({
          repository,
          organizationId: principal.organizationId,
          actorAccountId:
            principal.kind === 'account' ? principal.account.id : null,
          actorEmployeeId:
            principal.kind === 'account' ? principal.account.employeeId : null,
          res,
          deploymentId,
          publicKeys: licensePublicKeys,
          requiredFeature: 'enterprise_tree',
        });
        if (!license) return;
        sendJson(res, 200, {
          accounts: await repository.listAccounts(principal.organizationId),
        });
        return;
      }

      if (path === '/enterprise/accounts' && method === 'POST') {
        const principal = await requireAdministrator({
          repository,
          req,
          res,
          adminToken,
          sharedState: options.sharedState,
        });
        if (!principal) return;
        const body = await readJsonBody(req);
        const license = await requireClusteredLicense({
          repository,
          organizationId: principal.organizationId,
          actorAccountId:
            principal.kind === 'account' ? principal.account.id : null,
          actorEmployeeId:
            principal.kind === 'account' ? principal.account.employeeId : null,
          res,
          deploymentId,
          publicKeys: licensePublicKeys,
          requiredFeature: 'enterprise_tree',
          seatIncrement: body.status === 'disabled' ? 0 : 1,
        });
        if (!license) return;
        let account: PostgresEnterpriseAccountView;
        try {
          account = await repository.createAccount({
            organizationId: principal.organizationId,
            username: typeof body.username === 'string' ? body.username : '',
            password: typeof body.password === 'string' ? body.password : '',
            name: typeof body.name === 'string' ? body.name : '',
            phone: typeof body.phone === 'string' ? body.phone : null,
            feishuOpenId:
              typeof body.feishuOpenId === 'string' ? body.feishuOpenId : null,
            role: typeof body.role === 'string' ? body.role : null,
            department:
              typeof body.department === 'string' ? body.department : null,
            departmentId:
              typeof body.departmentId === 'string' ? body.departmentId : null,
            positionId:
              typeof body.positionId === 'string' ? body.positionId : null,
            positionTitle:
              typeof body.positionTitle === 'string' ? body.positionTitle : null,
            avatarUrl:
              typeof body.avatarUrl === 'string' ? body.avatarUrl : null,
            tags: Array.isArray(body.tags)
              ? body.tags.filter((tag): tag is string => typeof tag === 'string')
              : [],
            isAdmin: body.isAdmin === true,
            status: body.status === 'disabled' ? 'disabled' : 'active',
            licenseSeatAdmission: license.allowed
              ? license.seatAdmission
              : undefined,
          });
        } catch (error) {
          if (sendLicenseSeatAdmissionError(res, error)) return;
          throw error;
        }
        sendJson(res, 201, { account });
        return;
      }

      const accountRoute = /^\/enterprise\/accounts\/([^/]+)$/.exec(path);
      if (accountRoute && (method === 'PATCH' || method === 'DELETE')) {
        const principal = await requireAdministrator({
          repository,
          req,
          res,
          adminToken,
          sharedState: options.sharedState,
        });
        if (!principal) return;
        const accountId = decodeURIComponent(accountRoute[1]!);
        const body = method === 'PATCH' ? await readJsonBody(req) : null;
        const existing = await repository.getAccount(
          accountId,
          principal.organizationId,
        );
        const activatesSeat =
          method === 'PATCH' &&
          existing?.status === 'disabled' &&
          body?.status === 'active';
        const reducesSeats =
          method === 'DELETE' ||
          (method === 'PATCH' &&
            existing?.status === 'active' &&
            body?.status === 'disabled');
        const license = await requireClusteredLicense({
          repository,
          organizationId: principal.organizationId,
          actorAccountId:
            principal.kind === 'account' ? principal.account.id : null,
          actorEmployeeId:
            principal.kind === 'account' ? principal.account.employeeId : null,
          res,
          deploymentId,
          publicKeys: licensePublicKeys,
          requiredFeature: 'enterprise_tree',
          seatIncrement: activatesSeat ? 1 : 0,
          allowSeatOverage: reducesSeats,
        });
        if (!license) return;
        if (method === 'DELETE') {
          const deleted = await repository.deleteAccount(
            principal.organizationId,
            accountId,
          );
          sendJson(
            res,
            deleted ? 200 : 404,
            deleted ? { deleted: true } : { error: 'account not found' },
          );
        } else {
          let account: PostgresEnterpriseAccountView;
          try {
            account = await repository.updateAccount({
              ...accountPatch(body!, principal.organizationId, accountId),
              ...(activatesSeat && license.allowed
                ? { licenseSeatAdmission: license.seatAdmission }
                : {}),
            });
          } catch (error) {
            if (sendLicenseSeatAdmissionError(res, error)) return;
            throw error;
          }
          sendJson(res, 200, { account });
        }
        return;
      }

      if (path === '/enterprise/audit' && method === 'GET') {
        const principal = await requireAdministrator({
          repository,
          req,
          res,
          adminToken,
          sharedState: options.sharedState,
        });
        if (!principal) return;
        const license = await requireClusteredLicense({
          repository,
          organizationId: principal.organizationId,
          actorAccountId:
            principal.kind === 'account' ? principal.account.id : null,
          actorEmployeeId:
            principal.kind === 'account' ? principal.account.employeeId : null,
          res,
          deploymentId,
          publicKeys: licensePublicKeys,
        });
        if (!license) return;
        sendJson(res, 200, {
          logs: await repository.listAuditLogs(
            principal.organizationId,
            Number(url.searchParams.get('limit') || 200),
          ),
        });
        return;
      }

      if (
        path === '/enterprise/organization/invite' &&
        (method === 'GET' || method === 'POST')
      ) {
        const principal = await requireAdministrator({
          repository,
          req,
          res,
          adminToken,
          sharedState: options.sharedState,
        });
        if (!principal) return;
        const license = await requireClusteredLicense({
          repository,
          organizationId: principal.organizationId,
          actorAccountId:
            principal.kind === 'account' ? principal.account.id : null,
          actorEmployeeId:
            principal.kind === 'account' ? principal.account.employeeId : null,
          res,
          deploymentId,
          publicKeys: licensePublicKeys,
          requiredFeature: 'enterprise_tree',
        });
        if (!license) return;
        const invite =
          method === 'POST'
            ? await (async () => {
                const body = await readJsonBody(req);
                return repository.issueOrganizationInvite({
                  organizationId: principal.organizationId,
                  createdByAccountId:
                    principal.kind === 'account' ? principal.account.id : null,
                  defaultDepartment:
                    typeof body.defaultDepartment === 'string'
                      ? body.defaultDepartment
                      : null,
                  departmentId:
                    typeof body.departmentId === 'string'
                      ? body.departmentId
                      : null,
                  positionId:
                    typeof body.positionId === 'string'
                      ? body.positionId
                      : null,
                  positionTitle:
                    typeof body.positionTitle === 'string'
                      ? body.positionTitle
                      : null,
                  defaultRole:
                    typeof body.defaultRole === 'string'
                      ? body.defaultRole
                      : null,
                  maxUses: body.maxUses == null ? null : Number(body.maxUses),
                });
              })()
            : await repository.getOrganizationInvite(principal.organizationId);
        if (!invite) {
          sendJson(res, 404, { error: 'organization invitation not found' });
          return;
        }
        sendJson(res, method === 'POST' ? 201 : 200, {
          invite: {
            ...invite,
            link: buildOrganizationInviteLink(publicBaseUrl, invite.code),
          },
        });
        return;
      }

      if (path === '/enterprise/auth/join-organization' && method === 'POST') {
        const account = await requireMember(
          repository,
          req,
          res,
          options.sharedState,
        );
        if (!account) return;
        const body = await readJsonBody(req);
        const inviteCode =
          typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
        if (!isOrganizationInviteCode(inviteCode)) {
          sendJson(res, 400, { error: 'organization invitation is invalid' });
          return;
        }
        const inspectedInvite =
          await repository.inspectOrganizationInvite(inviteCode);
        let licenseSeatAdmission;
        if (
          inspectedInvite.status === 'active' &&
          inspectedInvite.organizationId
        ) {
          const license = await requireClusteredLicense({
            repository,
            organizationId: inspectedInvite.organizationId,
            actorAccountId: account.id,
            actorEmployeeId: account.employeeId,
            res,
            deploymentId,
            publicKeys: licensePublicKeys,
            requiredFeature: 'enterprise_tree',
            seatIncrement: 1,
          });
          if (!license?.allowed) return;
          licenseSeatAdmission = license.seatAdmission;
        }
        const joined = await repository.joinOrganizationWithInvite({
          accountId: account.id,
          inviteCode,
          licenseSeatAdmission,
        });
        if (joined.state === 'invalid-invite') {
          sendJson(res, 403, {
            error: 'organization invitation is unavailable',
          });
          return;
        }
        if (joined.state === 'not-personal') {
          sendJson(res, 409, {
            error: 'only personal accounts can join an organization',
          });
          return;
        }
        if (joined.state === 'security-state-present') {
          sendJson(res, 409, {
            error: 'local E2EE security state must be reset before joining',
            code: 'E2EE_STATE_RESET_REQUIRED',
          });
          return;
        }
        if (joined.state === 'seat-limit-exceeded') {
          sendJson(res, 402, {
            error: 'deployment seat limit is exceeded',
            code: 'deployment_seat_limit_exceeded',
          });
          return;
        }
        if (joined.state === 'license-admission-invalid') {
          sendJson(res, 402, {
            error: 'deployment license changed; retry authorization',
            code: 'deployment_license_inactive',
          });
          return;
        }
        if (joined.state !== 'joined') {
          sendJson(res, 503, {
            error: 'organization join state is unavailable',
          });
          return;
        }
        await options.sharedState?.revokeSession(bearerToken(req));
        sendJson(res, 200, {
          account: joined.account,
          requiresLogin: true,
        });
        return;
      }

      const member = await requireMember(
        repository,
        req,
        res,
        options.sharedState,
      );
      if (!member) return;

      if (path === '/enterprise/privacy/export' && method === 'GET') {
        sendJson(res, 200, await repository.exportAccountData(member));
        return;
      }

      if (path === '/enterprise/privacy/account' && method === 'DELETE') {
        const body = await readJsonBody(req);
        const password = typeof body.password === 'string' ? body.password : '';
        if (body.confirmation !== '注销我的 Otto 账号' || !password) {
          sendJson(res, 400, {
            error:
              'password and exact account deletion confirmation are required',
          });
          return;
        }
        const verified = await repository.authenticateAccount(
          member.username,
          password,
        );
        if (!verified || verified.id !== member.id) {
          sendJson(res, 403, { error: 'account password is invalid' });
          return;
        }
        const receipt = await repository.deleteOwnAccountData(member);
        await options.sharedState?.revokeSession(bearerToken(req));
        sendJson(res, 200, receipt);
        return;
      }

      if (!isLicenseMaintenanceRoute(path, method)) {
        const license = await requireClusteredLicense({
          repository,
          organizationId: member.organizationId,
          actorAccountId: member.id,
          actorEmployeeId: member.employeeId,
          res,
          deploymentId,
          publicKeys: licensePublicKeys,
          requiredFeature: commercialFeatureForEnterpriseRoute(path),
        });
        if (!license) return;
      }

      if (
        await handleClusteredBusinessRoute({
          path,
          method,
          url,
          req,
          res,
          member,
          repository,
          readBody: readJsonBody,
          sendJson,
          requireCommercialFeature: async (feature) => {
            const decision = await requireClusteredLicense({
              repository,
              organizationId: member.organizationId,
              actorAccountId: member.id,
              actorEmployeeId: member.employeeId,
              res,
              deploymentId,
              publicKeys: licensePublicKeys,
              requiredFeature: feature,
            });
            return decision?.allowed === true;
          },
          commercialFeatureAvailable: async (feature) => {
            const decision = await requireClusteredLicense({
              repository,
              organizationId: member.organizationId,
              actorAccountId: member.id,
              actorEmployeeId: member.employeeId,
              res,
              deploymentId,
              publicKeys: licensePublicKeys,
              requiredFeature: feature,
              sendDenial: false,
            });
            return decision?.allowed === true;
          },
          commercialLicenseSummary: async () => {
            const decision = await requireClusteredLicense({
              repository,
              organizationId: member.organizationId,
              actorAccountId: member.id,
              actorEmployeeId: member.employeeId,
              res,
              deploymentId,
              publicKeys: licensePublicKeys,
              sendDenial: false,
            });
            return decision!.summary;
          },
        })
      ) {
        return;
      }

      if (
        options.attachmentStorage &&
        path === '/enterprise/attachments/inline' &&
        method === 'POST'
      ) {
        const body = await readJsonBody(req, E2EE_BODY_LIMIT);
        const peerAccountId =
          typeof body.peerAccountId === 'string' ? body.peerAccountId : '';
        const peer = await repository.getAccount(
          peerAccountId,
          member.organizationId,
        );
        if (!peer || peer.status !== 'active') {
          sendJson(res, 404, { error: 'member not found or disabled' });
          return;
        }
        if (peer.id === member.id) {
          sendJson(res, 400, {
            error: 'attachment peer must be another member',
          });
          return;
        }
        const ciphertext = attachmentCiphertext(body.ciphertext);
        const expectedChecksum =
          typeof body.ciphertextSha256 === 'string'
            ? body.ciphertextSha256
            : ciphertextSha256(ciphertext);
        const metadata = await options.attachmentStorage.putInlineCiphertext({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId:
            typeof body.attachmentId === 'string' ? body.attachmentId : '',
          ciphertext,
          ciphertextSha256: expectedChecksum,
          encryption: 'e2ee-client-v1',
          authorizedAccountIds: [peer.id],
        });
        sendJson(res, 201, {
          attachment: publicAttachmentMetadata(metadata),
        });
        return;
      }

      if (
        options.attachmentStorage &&
        path === '/enterprise/attachments/uploads' &&
        method === 'POST'
      ) {
        const body = await readJsonBody(req, 32 * 1024);
        const peerAccountId =
          typeof body.peerAccountId === 'string' ? body.peerAccountId : '';
        const peer = await repository.getAccount(
          peerAccountId,
          member.organizationId,
        );
        if (!peer || peer.status !== 'active') {
          sendJson(res, 404, { error: 'member not found or disabled' });
          return;
        }
        if (peer.id === member.id) {
          sendJson(res, 400, {
            error: 'attachment peer must be another member',
          });
          return;
        }
        const mlsAuthorization =
          body.mlsBinding === undefined
            ? undefined
            : await resolveMlsAttachmentAuthorization(repository, member, body);
        const upload = await options.attachmentStorage.initiateMultipartUpload({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId:
            typeof body.attachmentId === 'string' ? body.attachmentId : '',
          ciphertextBytes: Number(body.ciphertextBytes),
          ciphertextSha256:
            typeof body.ciphertextSha256 === 'string'
              ? body.ciphertextSha256
              : '',
          encryption: mlsAuthorization ? 'mls-client-v1' : 'e2ee-client-v1',
          authorizedAccountIds: [peer.id],
          mlsAuthorization,
        });
        sendJson(res, 201, { upload: { attachmentId: upload.attachmentId } });
        return;
      }

      const attachmentPartPresign =
        /^\/enterprise\/attachments\/([^/]+)\/parts\/(\d+)\/presign$/.exec(
          path,
        );
      if (
        options.attachmentStorage &&
        attachmentPartPresign &&
        method === 'POST'
      ) {
        const body = await readJsonBody(req, 16 * 1024);
        const mlsAccess = await resolveMlsAttachmentAccess(
          repository,
          member,
          body.peerAccountId,
          body.deviceId,
        );
        const request = await options.attachmentStorage.presignUploadPart({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId: decodeURIComponent(attachmentPartPresign[1]!),
          partNumber: Number(attachmentPartPresign[2]),
          ciphertextBytes: Number(body.ciphertextBytes),
          ciphertextSha256:
            typeof body.ciphertextSha256 === 'string'
              ? body.ciphertextSha256
              : '',
          mlsAccess,
        });
        sendJson(res, 200, { request });
        return;
      }

      const attachmentParts =
        /^\/enterprise\/attachments\/([^/]+)\/parts$/.exec(path);
      if (options.attachmentStorage && attachmentParts && method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        const mlsAccess = await resolveMlsAttachmentAccess(
          repository,
          member,
          body.peerAccountId,
          body.deviceId,
        );
        await options.attachmentStorage.recordUploadedPart({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId: decodeURIComponent(attachmentParts[1]!),
          part: {
            partNumber: Number(body.partNumber),
            eTag: typeof body.eTag === 'string' ? body.eTag : '',
            ciphertextBytes: Number(body.ciphertextBytes),
            ciphertextSha256:
              typeof body.ciphertextSha256 === 'string'
                ? body.ciphertextSha256
                : '',
          },
          mlsAccess,
        });
        sendJson(res, 200, { recorded: true });
        return;
      }

      const attachmentComplete =
        /^\/enterprise\/attachments\/([^/]+)\/complete$/.exec(path);
      if (
        options.attachmentStorage &&
        attachmentComplete &&
        method === 'POST'
      ) {
        const body = await readJsonBody(req, 512 * 1024);
        const mlsAccess = await resolveMlsAttachmentAccess(
          repository,
          member,
          body.peerAccountId,
          body.deviceId,
        );
        const metadata =
          await options.attachmentStorage.completeMultipartUpload({
            organizationId: member.organizationId,
            accountId: member.id,
            attachmentId: decodeURIComponent(attachmentComplete[1]!),
            parts: Array.isArray(body.parts)
              ? (body.parts as AttachmentMultipartPart[])
              : [],
            mlsAccess,
          });
        sendJson(res, 200, {
          attachment: publicAttachmentMetadata(metadata),
        });
        return;
      }

      const attachmentResume =
        /^\/enterprise\/attachments\/([^/]+)\/resume$/.exec(path);
      if (options.attachmentStorage && attachmentResume && method === 'GET') {
        const mlsAccess = await resolveMlsAttachmentAccess(
          repository,
          member,
          url.searchParams.get('peerAccountId'),
          url.searchParams.get('deviceId'),
        );
        const upload = await options.attachmentStorage.resumeMultipartUpload({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId: decodeURIComponent(attachmentResume[1]!),
          mlsAccess,
        });
        sendJson(res, 200, { upload });
        return;
      }

      const attachmentDownload =
        /^\/enterprise\/attachments\/([^/]+)\/download$/.exec(path);
      if (options.attachmentStorage && attachmentDownload && method === 'GET') {
        const mlsAccess = await resolveMlsAttachmentAccess(
          repository,
          member,
          url.searchParams.get('peerAccountId'),
          url.searchParams.get('deviceId'),
        );
        const download = await options.attachmentStorage.download({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId: decodeURIComponent(attachmentDownload[1]!),
          mlsAccess,
        });
        sendJson(res, 200, {
          attachment:
            download.kind === 'presigned'
              ? download
              : {
                  ...download,
                  ciphertext: download.ciphertext.toString('base64'),
                },
        });
        return;
      }

      if (path === '/enterprise/organization/view' && method === 'GET') {
        const [organization, members, structure, features] = await Promise.all([
          repository.getOrganization(member.organizationId),
          repository.listAccounts(member.organizationId),
          repository.listOrganizationStructure(member.organizationId),
          repository.getOrganizationFeatures(member.organizationId),
        ]);
        const presence = options.sharedState
          ? await options.sharedState.listAccountPresence(
              member.organizationId,
              members.map((account) => account.id),
            )
          : [];
        const presenceByAccount = new Map(
          presence.map((entry) => [entry.accountId, entry] as const),
        );
        sendJson(res, 200, {
          organization,
          members: members.map((account) => ({
            ...account,
            ottoOnline: presenceByAccount.get(account.id)?.online ?? false,
            ottoLastSeenAt:
              presenceByAccount.get(account.id)?.lastSeenAt ?? null,
          })),
          employeeCount: members.filter((account) => account.employeeId).length,
          structure,
          features,
          park: null,
        });
        return;
      }

      if (path === '/enterprise/presence/heartbeat' && method === 'POST') {
        if (!options.sharedState) {
          sendJson(res, 503, {
            error: 'shared presence state is unavailable',
            code: 'PRESENCE_UNAVAILABLE',
          });
          return;
        }
        const body = await readJsonBody(req);
        const presence = await options.sharedState.touchAccountPresence({
          organizationId: member.organizationId,
          accountId: member.id,
          clientId:
            typeof body.clientId === 'string' ? body.clientId : 'desktop',
        });
        sendJson(res, 200, { presence });
        return;
      }

      if (path === '/enterprise/organization/features' && method === 'GET') {
        sendJson(res, 200, {
          features: await repository.getOrganizationFeatures(
            member.organizationId,
          ),
        });
        return;
      }

      if (
        path === '/enterprise/organization/features' &&
        (method === 'PUT' || method === 'PATCH')
      ) {
        if (!member.isAdmin) {
          sendJson(res, 403, { error: 'administrator permission required' });
          return;
        }
        const body = await readJsonBody(req);
        const featureNames = [
          'enterprise_tree',
          'direct_messages',
          'atoa',
          'park_services',
          'knowledge',
          'skill_market',
        ] as const;
        const patch: Partial<Record<(typeof featureNames)[number], boolean>> =
          {};
        for (const feature of featureNames) {
          if (typeof body[feature] === 'boolean')
            patch[feature] = body[feature];
        }
        sendJson(res, 200, {
          features: await repository.updateOrganizationFeatures(
            member.organizationId,
            patch,
          ),
        });
        return;
      }

      if (
        path === '/enterprise/organization/departments' &&
        method === 'POST'
      ) {
        if (!member.isAdmin) {
          sendJson(res, 403, { error: 'administrator permission required' });
          return;
        }
        const body = await readJsonBody(req);
        const department = await repository.createOrganizationDepartment({
          organizationId: member.organizationId,
          name: typeof body.name === 'string' ? body.name : '',
        });
        sendJson(res, 201, { department });
        return;
      }

      const departmentRoute =
        /^\/enterprise\/organization\/departments\/([^/]+)$/.exec(path);
      if (departmentRoute && (method === 'PATCH' || method === 'DELETE')) {
        if (!member.isAdmin) {
          sendJson(res, 403, { error: 'administrator permission required' });
          return;
        }
        const departmentId = decodeURIComponent(departmentRoute[1]!);
        if (method === 'DELETE') {
          const deleted = await repository.deleteOrganizationDepartment({
            organizationId: member.organizationId,
            departmentId,
          });
          sendJson(
            res,
            deleted ? 200 : 404,
            deleted ? { deleted: true } : { error: 'department not found' },
          );
        } else {
          const body = await readJsonBody(req);
          const department = await repository.updateOrganizationDepartment({
            organizationId: member.organizationId,
            departmentId,
            name: typeof body.name === 'string' ? body.name : '',
          });
          sendJson(res, 200, { department });
        }
        return;
      }

      if (path === '/enterprise/organization/positions' && method === 'POST') {
        if (!member.isAdmin) {
          sendJson(res, 403, { error: 'administrator permission required' });
          return;
        }
        const body = await readJsonBody(req);
        const position = await repository.createOrganizationPosition({
          organizationId: member.organizationId,
          departmentId:
            typeof body.departmentId === 'string' ? body.departmentId : '',
          title: typeof body.title === 'string' ? body.title : '',
          roleMapping:
            typeof body.roleMapping === 'string' ? body.roleMapping : null,
        });
        sendJson(res, 201, { position });
        return;
      }

      const positionRoute =
        /^\/enterprise\/organization\/positions\/([^/]+)$/.exec(path);
      if (positionRoute && (method === 'PATCH' || method === 'DELETE')) {
        if (!member.isAdmin) {
          sendJson(res, 403, { error: 'administrator permission required' });
          return;
        }
        const positionId = decodeURIComponent(positionRoute[1]!);
        if (method === 'DELETE') {
          const deleted = await repository.deleteOrganizationPosition({
            organizationId: member.organizationId,
            positionId,
          });
          sendJson(
            res,
            deleted ? 200 : 404,
            deleted ? { deleted: true } : { error: 'position not found' },
          );
        } else {
          const body = await readJsonBody(req);
          const position = await repository.updateOrganizationPosition({
            organizationId: member.organizationId,
            positionId,
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(body.roleMapping === null ||
            typeof body.roleMapping === 'string'
              ? { roleMapping: body.roleMapping }
              : {}),
          });
          sendJson(res, 200, { position });
        }
        return;
      }

      if (path === '/enterprise/e2ee/devices' && method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        const device = await repository.registerE2eeDevice({
          organizationId: member.organizationId,
          accountId: member.id,
          deviceId: typeof body.deviceId === 'string' ? body.deviceId : '',
          deviceName:
            typeof body.deviceName === 'string' ? body.deviceName : '',
          identitySigningPublicKey:
            typeof body.identitySigningPublicKey === 'string'
              ? body.identitySigningPublicKey
              : '',
          deviceExchangePublicKey:
            typeof body.deviceExchangePublicKey === 'string'
              ? body.deviceExchangePublicKey
              : '',
        });
        sendJson(res, 200, { device });
        return;
      }

      if (path === '/enterprise/e2ee/devices' && method === 'GET') {
        const accountIds = url.searchParams.getAll('accountId');
        const devices = await repository.listE2eeDevices({
          organizationId: member.organizationId,
          requesterAccountId: member.id,
          accountIds: accountIds.length > 0 ? accountIds : [member.id],
          includeRevoked: url.searchParams.get('includeRevoked') === 'true',
          includePending: url.searchParams.get('includePending') === 'true',
        });
        sendJson(res, 200, { devices });
        return;
      }

      if (path === '/enterprise/e2ee/key-transparency' && method === 'GET') {
        const transparency = await repository.listE2eeKeyTransparency({
          organizationId: member.organizationId,
          requesterAccountId: member.id,
          accountId: url.searchParams.get('accountId') || member.id,
        });
        sendJson(res, 200, { transparency });
        return;
      }

      if (
        path === '/enterprise/e2ee/mls/key-packages/inventory' &&
        method === 'GET'
      ) {
        const deviceId = url.searchParams.get('deviceId') || '';
        const keyPackages = await repository.listMlsKeyPackageInventory({
          organizationId: member.organizationId,
          accountId: member.id,
          deviceId,
        });
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, { deviceId, keyPackages });
        return;
      }

      const retireMlsKeyPackageRoute =
        /^\/enterprise\/e2ee\/mls\/key-packages\/([0-9a-f]{64})$/.exec(path);
      if (retireMlsKeyPackageRoute && method === 'DELETE') {
        const deviceId = url.searchParams.get('deviceId') || '';
        const reference = retireMlsKeyPackageRoute[1] ?? '';
        const retired = await repository.retireMlsKeyPackage({
          organizationId: member.organizationId,
          accountId: member.id,
          deviceId,
          reference,
        });
        if (!retired) {
          sendJson(res, 409, {
            error: 'claimed MLS KeyPackage cannot be retired',
          });
        } else {
          sendJson(res, 200, { deviceId, reference, retired: true });
        }
        return;
      }

      if (path === '/enterprise/e2ee/mls/key-packages' && method === 'POST') {
        const body = await readJsonBody(req, 96 * 1024);
        const keyPackage = await repository.publishMlsKeyPackage({
          organizationId: member.organizationId,
          accountId: member.id,
          deviceId: typeof body.deviceId === 'string' ? body.deviceId : '',
          ciphersuite:
            typeof body.ciphersuite === 'string'
              ? (body.ciphersuite as Parameters<
                  typeof repository.publishMlsKeyPackage
                >[0]['ciphersuite'])
              : ('' as Parameters<
                  typeof repository.publishMlsKeyPackage
                >[0]['ciphersuite']),
          reference:
            typeof body.keyPackageReference === 'string'
              ? body.keyPackageReference
              : undefined,
          keyPackage:
            typeof body.keyPackage === 'string' ? body.keyPackage : '',
        });
        sendJson(res, 201, { keyPackage });
        return;
      }

      if (
        path === '/enterprise/e2ee/mls/key-packages/claim' &&
        method === 'POST'
      ) {
        const body = await readJsonBody(req, 16 * 1024);
        const keyPackage = await repository.claimMlsKeyPackage({
          organizationId: member.organizationId,
          requesterAccountId: member.id,
          requesterDeviceId:
            typeof body.requesterDeviceId === 'string'
              ? body.requesterDeviceId
              : '',
          recipientAccountId:
            typeof body.recipientAccountId === 'string'
              ? body.recipientAccountId
              : '',
          recipientDeviceId:
            typeof body.recipientDeviceId === 'string'
              ? body.recipientDeviceId
              : undefined,
          conversationPeerAccountId:
            typeof body.conversationPeerAccountId === 'string'
              ? body.conversationPeerAccountId
              : undefined,
        });
        sendJson(
          res,
          keyPackage ? 200 : 404,
          keyPackage
            ? { keyPackage }
            : { error: 'no unclaimed MLS KeyPackage is available' },
        );
        return;
      }

      if (
        path === '/enterprise/e2ee/mls/inbound-conversations' &&
        method === 'GET'
      ) {
        if (url.searchParams.get('includeHeads') === '1') {
          const conversationHeads =
            await repository.listMlsInboundConversationHeads({
              organizationId: member.organizationId,
              accountId: member.id,
              deviceId: url.searchParams.get('deviceId') || '',
              afterPeerAccountId:
                url.searchParams.get('afterPeerAccountId') || undefined,
              limit: Number(url.searchParams.get('limit') || 100),
            });
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, { conversationHeads });
          return;
        }
        const peerAccountIds = await repository.listMlsInboundConversationPeers(
          {
            organizationId: member.organizationId,
            accountId: member.id,
            deviceId: url.searchParams.get('deviceId') || '',
            afterPeerAccountId:
              url.searchParams.get('afterPeerAccountId') || undefined,
            limit: Number(url.searchParams.get('limit') || 100),
          },
        );
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, { peerAccountIds });
        return;
      }

      const mlsAttachmentSessionRoute =
        /^\/enterprise\/e2ee\/mls\/conversations\/([^/]+)\/attachment-session$/.exec(
          path,
        );
      if (mlsAttachmentSessionRoute && method === 'GET') {
        const peerAccountId = decodeURIComponent(mlsAttachmentSessionRoute[1]!);
        const session = await repository.getMlsAttachmentSession({
          organizationId: member.organizationId,
          accountId: member.id,
          peerAccountId,
          deviceId: url.searchParams.get('deviceId') || '',
        });
        res.setHeader('Cache-Control', 'no-store');
        sendJson(res, 200, { session });
        return;
      }

      const mlsEventsRoute =
        /^\/enterprise\/e2ee\/mls\/conversations\/([^/]+)\/events$/.exec(path);
      if (mlsEventsRoute && (method === 'GET' || method === 'POST')) {
        const peerAccountId = decodeURIComponent(mlsEventsRoute[1]!);
        if (method === 'GET') {
          const events = await repository.listMlsTransportEvents({
            organizationId: member.organizationId,
            accountId: member.id,
            peerAccountId,
            afterSequence: Number(url.searchParams.get('afterSequence') || 0),
            limit: Number(url.searchParams.get('limit') || 100),
          });
          res.setHeader('Cache-Control', 'no-store');
          sendJson(res, 200, { events });
        } else {
          const body = await readJsonBody(req, 1400 * 1024);
          const event = await repository.appendMlsTransportEvent({
            organizationId: member.organizationId,
            senderAccountId: member.id,
            peerAccountId,
            senderDeviceId:
              typeof body.senderDeviceId === 'string'
                ? body.senderDeviceId
                : '',
            eventId: typeof body.eventId === 'string' ? body.eventId : '',
            eventType:
              typeof body.eventType === 'string'
                ? (body.eventType as Parameters<
                    typeof repository.appendMlsTransportEvent
                  >[0]['eventType'])
                : ('invalid' as Parameters<
                    typeof repository.appendMlsTransportEvent
                  >[0]['eventType']),
            epoch: Number(body.epoch),
            groupId: typeof body.groupId === 'string' ? body.groupId : '',
            payload: typeof body.payload === 'string' ? body.payload : '',
            recipientAccountId:
              typeof body.recipientAccountId === 'string'
                ? body.recipientAccountId
                : null,
            recipientDeviceId:
              typeof body.recipientDeviceId === 'string'
                ? body.recipientDeviceId
                : null,
            keyPackageReference:
              typeof body.keyPackageReference === 'string'
                ? body.keyPackageReference
                : null,
            resetFromGroupId:
              typeof body.resetFromGroupId === 'string'
                ? body.resetFromGroupId
                : null,
          });
          sendJson(res, 201, { event });
        }
        return;
      }

      const approveDevice =
        /^\/enterprise\/e2ee\/devices\/([^/]+)\/approve$/.exec(path);
      if (approveDevice && method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        const device = await repository.approveE2eeDevice({
          organizationId: member.organizationId,
          accountId: member.id,
          approverDeviceId:
            typeof body.approverDeviceId === 'string'
              ? body.approverDeviceId
              : '',
          targetDeviceId: decodeURIComponent(approveDevice[1]!),
          targetKeyFingerprint:
            typeof body.targetKeyFingerprint === 'string'
              ? body.targetKeyFingerprint
              : '',
          signature: typeof body.signature === 'string' ? body.signature : '',
        });
        sendJson(res, 200, { device });
        return;
      }

      const deviceRoute = /^\/enterprise\/e2ee\/devices\/([^/]+)$/.exec(path);
      if (deviceRoute && method === 'DELETE') {
        const revoked = await repository.revokeE2eeDevice({
          organizationId: member.organizationId,
          accountId: member.id,
          deviceId: decodeURIComponent(deviceRoute[1]!),
        });
        sendJson(
          res,
          revoked ? 200 : 404,
          revoked ? { revoked: true } : { error: 'device not found' },
        );
        return;
      }

      if (path === '/enterprise/messages/unread' && method === 'GET') {
        const features = await repository.getOrganizationFeatures(
          member.organizationId,
        );
        if (!features.direct_messages) {
          sendJson(res, 403, {
            error: 'enterprise direct messages are disabled',
          });
          return;
        }
        sendJson(res, 200, {
          notifications: await repository.listUnreadE2eeNotifications({
            organizationId: member.organizationId,
            accountId: member.id,
            limit: Number(url.searchParams.get('limit') || 50),
          }),
        });
        return;
      }

      const messageAttachmentRoute =
        /^\/enterprise\/message-attachments\/([^/]+)$/.exec(path);
      if (
        options.attachmentStorage &&
        messageAttachmentRoute &&
        method === 'GET'
      ) {
        const authority = await repository.getE2eeAttachmentAuthority({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId: decodeURIComponent(messageAttachmentRoute[1]!),
        });
        if (!authority) {
          sendJson(res, 404, {
            error: 'attachment not found or access denied',
          });
          return;
        }
        const download = await options.attachmentStorage.download({
          organizationId: member.organizationId,
          accountId: member.id,
          attachmentId: authority.attachment.id,
        });
        sendJson(res, 200, {
          attachment: {
            message: authority.message,
            attachment: {
              ...authority.attachment,
              ...(download.kind === 'presigned'
                ? { download: download.request }
                : { ciphertext: download.ciphertext.toString('base64') }),
            },
          },
        });
        return;
      }

      const messageRoute = /^\/enterprise\/messages\/([^/]+)$/.exec(path);
      if (messageRoute && (method === 'GET' || method === 'POST')) {
        const features = await repository.getOrganizationFeatures(
          member.organizationId,
        );
        if (!features.direct_messages) {
          sendJson(res, 403, {
            error: 'enterprise direct messages are disabled',
          });
          return;
        }
        const peerAccountId = decodeURIComponent(messageRoute[1]!);
        const peer = await repository.getAccount(
          peerAccountId,
          member.organizationId,
        );
        if (!peer || peer.status !== 'active') {
          sendJson(res, 404, { error: 'member not found or disabled' });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, {
            messages: await repository.listE2eeDirectMessages({
              organizationId: member.organizationId,
              accountId: member.id,
              peerAccountId,
              limit: Number(url.searchParams.get('limit') || 100),
            }),
          });
          return;
        }
        const body = await readJsonBody(req, E2EE_BODY_LIMIT);
        const contentType =
          body.contentType === 'atoa_request' ||
          body.contentType === 'atoa_response'
            ? body.contentType
            : 'message';
        if (contentType !== 'message') {
          const atoaLicense = await requireClusteredLicense({
            repository,
            organizationId: member.organizationId,
            actorAccountId: member.id,
            actorEmployeeId: member.employeeId,
            res,
            deploymentId,
            publicKeys: licensePublicKeys,
            requiredFeature: 'atoa',
          });
          if (!atoaLicense) return;
        }
        const message = await repository.sendE2eeDirectMessage({
          organizationId: member.organizationId,
          senderAccountId: member.id,
          recipientAccountId: peerAccountId,
          messageId: typeof body.messageId === 'string' ? body.messageId : '',
          senderDeviceId:
            typeof body.senderDeviceId === 'string' ? body.senderDeviceId : '',
          protocolVersion:
            body.protocolVersion === 1 ? 1 : (body.protocolVersion as 1),
          contentType:
            body.contentType === 'atoa_request' ||
            body.contentType === 'atoa_response'
              ? body.contentType
              : 'message',
          inReplyToMessageId:
            typeof body.inReplyToMessageId === 'string'
              ? body.inReplyToMessageId
              : null,
          ciphertext:
            typeof body.ciphertext === 'string' ? body.ciphertext : '',
          nonce: typeof body.nonce === 'string' ? body.nonce : '',
          signature: typeof body.signature === 'string' ? body.signature : '',
          envelopes: Array.isArray(body.envelopes)
            ? (body.envelopes as E2eeMessageEnvelope[])
            : [],
          attachments: Array.isArray(body.attachments)
            ? (body.attachments as E2eeAttachmentCiphertextInput[])
            : [],
          attachmentReferences: Array.isArray(body.attachmentReferences)
            ? (body.attachmentReferences as PostgresE2eeAttachmentReferenceInput[])
            : [],
        });
        sendJson(res, 201, { message });
        return;
      }

      sendJson(res, 503, {
        error: 'route has not been migrated to the PostgreSQL authority',
        code: 'POSTGRES_ROUTE_NOT_MIGRATED',
        path,
      });
    } catch (error) {
      if (res.headersSent) return;
      sendJson(res, routeErrorStatus(error), { error: safeRouteError(error) });
    }
  });

  return { server, host, port, adminToken };
}

export async function startClusteredEnterpriseServer(
  options: ClusteredEnterpriseServerOptions = {},
): Promise<Server> {
  if (
    !options.infrastructure &&
    (options.repository || options.databaseReadiness || options.closeDatabase)
  ) {
    throw new Error(
      'partial clustered dependency injection is forbidden; inject the complete infrastructure',
    );
  }
  const infrastructure =
    options.infrastructure ??
    (await createClusteredEnterpriseInfrastructure({
      environment: process.env,
    }));
  const repository = infrastructure.repository;

  try {
    if (options.bootstrapAdmin) {
      const accounts = await repository.listAccounts(
        repository.defaultOrganizationId,
      );
      if (accounts.length > 0) {
        throw new Error('bootstrap refused: PostgreSQL accounts already exist');
      }
      await repository.createAccount({
        organizationId: repository.defaultOrganizationId,
        username: options.bootstrapAdmin.username,
        password: options.bootstrapAdmin.password,
        name: options.bootstrapAdmin.name,
        isAdmin: true,
        bootstrapFirstAdministrator: true,
      });
    }

    const created = createClusteredEnterpriseServer(repository, {
      host: options.host ?? process.env.OTTO_ENTERPRISE_HOST,
      port:
        options.port ??
        Number(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT)),
      adminToken: options.adminToken ?? process.env.OTTO_ENTERPRISE_ADMIN_TOKEN,
      appVersion: options.appVersion ?? process.env.OTTO_APP_VERSION,
      buildCommit:
        options.buildCommit ??
        process.env.OTTO_BUILD_COMMIT ??
        process.env.GITHUB_SHA,
      infrastructureReadiness: infrastructure.getReadiness,
      topologyDescription: infrastructure.topologyDescription,
      sharedState: infrastructure.sharedState,
      attachmentStorage: infrastructure.attachmentStorage,
      publicUrl: options.publicUrl ?? process.env.OTTO_ENTERPRISE_PUBLIC_URL,
      licensePublicKeys: options.licensePublicKeys,
      smsSender:
        options.smsSender !== undefined
          ? options.smsSender
          : createAliyunLoginSmsFromEnv(),
    });
    const maintenance = createClusteredAttachmentMaintenance({
      storage: infrastructure.attachmentStorage,
      cache: infrastructure.cache,
      attachmentAuthority: infrastructure.repository,
      objectStore: infrastructure.attachmentStore,
      purgeMigratedLegacy: infrastructure.legacyAttachmentReadEnabled,
      onError(error) {
        console.error(
          `[Otto Enterprise] attachment maintenance failed: ${safeRouteError(error)}`,
        );
      },
    });
    const mlsMaintenance = createClusteredMlsMaintenance({
      cache: infrastructure.cache,
      authority: infrastructure.repository,
      onError(error) {
        console.error(
          `[Otto Enterprise] MLS resource maintenance failed: ${safeRouteError(error)}`,
        );
      },
    });
    created.server.once('close', () => {
      maintenance.close();
      mlsMaintenance.close();
      void infrastructure.close();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      created.server.once('error', onError);
      created.server.listen(created.port, created.host, () => {
        created.server.off('error', onError);
        resolve();
      });
    });
    maintenance.start();
    mlsMaintenance.start();
    console.log(
      `[Otto Enterprise] PostgreSQL authority ready at http://${created.host}:${created.port}`,
    );
    console.log(
      `[Otto Enterprise] shared infrastructure ${JSON.stringify(
        infrastructure.topologyDescription,
      )}`,
    );
    return created.server;
  } catch (error) {
    await infrastructure.close();
    throw error;
  }
}

export async function bootstrapClusteredEnterpriseAdmin(input: {
  username: string;
  password: string;
  name: string;
}): Promise<PostgresEnterpriseAccountView> {
  const topology = resolveEnterpriseDatabaseTopology({
    environment: process.env,
    sqliteDatabasePath: 'clustered-mode-does-not-open-sqlite.db',
  });
  if (topology.backend !== 'postgresql') {
    throw new Error('clustered enterprise bootstrap requires PostgreSQL mode');
  }
  const pool = createNodePostgresPool(
    buildNodePostgresPoolConfig({
      connectionString: topology.connectionString,
      environment: process.env,
    }),
  );
  const database = createPostgresDatabaseLifecycle({
    pool,
    migrations: ENTERPRISE_POSTGRES_MIGRATIONS,
  });
  try {
    await database.initialize();
    const repository = createPostgresEnterpriseCoreRepository({ pool });
    const accounts = await repository.listAccounts(
      repository.defaultOrganizationId,
    );
    if (accounts.length > 0) {
      throw new Error('bootstrap refused: PostgreSQL accounts already exist');
    }
    return await repository.createAccount({
      organizationId: repository.defaultOrganizationId,
      username: input.username,
      password: input.password,
      name: input.name,
      isAdmin: true,
      bootstrapFirstAdministrator: true,
    });
  } finally {
    await database.close();
  }
}
