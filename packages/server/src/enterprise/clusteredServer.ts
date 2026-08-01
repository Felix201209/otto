/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * PostgreSQL-backed enterprise HTTP entry point. It deliberately imports no
 * legacy SQLite repository module, so clustered mode cannot create a hidden
 * local authority or split writes between databases.
 */

import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import type {
  E2eeAttachmentCiphertextInput,
  E2eeMessageEnvelope,
} from '../modules/collaboration/index.js';
import {
  buildNodePostgresPoolConfig,
  createNodePostgresPool,
  createPostgresDatabaseLifecycle,
  describeEnterpriseDatabaseTopology,
  resolveEnterpriseDatabaseTopology,
  type PostgresDatabaseReadiness,
} from '../modules/data_platform/index.js';
import {
  createPostgresEnterpriseCoreRepository,
  type PostgresEnterpriseAccountView,
  type PostgresEnterpriseCoreRepository,
  type UpdatePostgresEnterpriseAccountInput,
} from './postgresCoreRepository.js';
import { ENTERPRISE_POSTGRES_MIGRATIONS } from './postgresMigrations.js';

const DEFAULT_PORT = 7777;
const DEFAULT_BODY_LIMIT = 1_000_000;
const E2EE_BODY_LIMIT = 30 * 1024 * 1024;

export interface ClusteredEnterpriseServerOptions {
  host?: string;
  port?: number;
  adminToken?: string;
  appVersion?: string;
  buildCommit?: string;
  repository?: PostgresEnterpriseCoreRepository;
  databaseReadiness?: () => Promise<PostgresDatabaseReadiness>;
  closeDatabase?: () => Promise<void>;
  bootstrapAdmin?: {
    username: string;
    password: string;
    name: string;
  };
}

type JsonBody = Record<string, unknown>;

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
  if (/not found|unavailable/i.test(message)) return 404;
  if (/already|unique|duplicate|retain one active administrator/i.test(message)) {
    return 409;
  }
  return 400;
}

function safeRouteError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'request failed';
  if (/postgres(?:ql)?:\/\//i.test(message)) return 'database operation failed';
  return message.slice(0, 500);
}

async function requireMember(
  repository: PostgresEnterpriseCoreRepository,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<PostgresEnterpriseAccountView | null> {
  const account = await repository.getAccountBySession(bearerToken(req));
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
}): Promise<
  | { kind: 'system'; organizationId: string }
  | { kind: 'account'; organizationId: string; account: PostgresEnterpriseAccountView }
  | null
> {
  if (isSystemAdmin(input.req, input.adminToken)) {
    return { kind: 'system', organizationId: input.repository.defaultOrganizationId };
  }
  const account = await requireMember(input.repository, input.req, input.res);
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
    ...(body.phone === null || typeof body.phone === 'string' ? { phone: body.phone } : {}),
    ...(body.feishuOpenId === null || typeof body.feishuOpenId === 'string'
      ? { feishuOpenId: body.feishuOpenId }
      : {}),
    ...(body.role === null || typeof body.role === 'string' ? { role: body.role } : {}),
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
      ? { tags: body.tags.filter((tag): tag is string => typeof tag === 'string') }
      : {}),
  };
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
  const adminToken = options.adminToken?.trim() || randomBytes(24).toString('base64url');
  const startedAt = options.startedAt ?? new Date().toISOString();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method || 'GET';
    try {
      if (path === '/enterprise/health' && method === 'GET') {
        const [database, authority] = await Promise.all([
          options.databaseReadiness?.(),
          repository.readiness(),
        ]);
        sendJson(res, 200, {
          status: 'ok',
          apiVersion: 4,
          deployment: {
            version: options.appVersion || 'unknown',
            buildCommit: options.buildCommit || 'unknown',
            startedAt,
          },
          topology: { mode: 'clustered-enterprise', database: 'postgresql' },
          database: database ?? authority,
          authority,
          capabilities: [
            'password_auth',
            'multi_organization',
            'organization_structure_v1',
            'e2ee_private_messages_v1',
            'e2ee_device_trust_v1',
            'postgresql_authority_v1',
          ],
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
        const retryAfter = await repository.getLoginRetryAfter(identifier);
        if (retryAfter > 0) {
          res.setHeader('Retry-After', String(retryAfter));
          sendJson(res, 429, {
            error: 'too many login attempts',
            code: 'LOGIN_RATE_LIMITED',
            retryAfterSeconds: retryAfter,
          });
          return;
        }
        const account = await repository.authenticateAccount(identifier, password);
        if (!account) {
          const failureRetryAfter = await repository.recordLoginFailure(identifier);
          if (failureRetryAfter > 0) {
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
        await repository.clearLoginFailures(identifier);
        const session = await repository.createAuthSession(account.id);
        sendJson(res, 200, { account, ...session });
        return;
      }

      if (path === '/enterprise/auth/me' && method === 'GET') {
        const account = await requireMember(repository, req, res);
        if (account) sendJson(res, 200, { account });
        return;
      }

      if (path === '/enterprise/auth/logout' && method === 'POST') {
        const token = bearerToken(req);
        const account = await requireMember(repository, req, res);
        if (!account) return;
        await repository.revokeAuthSession(token);
        sendJson(res, 200, { status: 'logged_out' });
        return;
      }

      if (path === '/enterprise/accounts' && method === 'GET') {
        const principal = await requireAdministrator({ repository, req, res, adminToken });
        if (!principal) return;
        sendJson(res, 200, {
          accounts: await repository.listAccounts(principal.organizationId),
        });
        return;
      }

      if (path === '/enterprise/accounts' && method === 'POST') {
        const principal = await requireAdministrator({ repository, req, res, adminToken });
        if (!principal) return;
        const body = await readJsonBody(req);
        const account = await repository.createAccount({
          organizationId: principal.organizationId,
          username: typeof body.username === 'string' ? body.username : '',
          password: typeof body.password === 'string' ? body.password : '',
          name: typeof body.name === 'string' ? body.name : '',
          phone: typeof body.phone === 'string' ? body.phone : null,
          feishuOpenId: typeof body.feishuOpenId === 'string' ? body.feishuOpenId : null,
          role: typeof body.role === 'string' ? body.role : null,
          department: typeof body.department === 'string' ? body.department : null,
          departmentId: typeof body.departmentId === 'string' ? body.departmentId : null,
          positionId: typeof body.positionId === 'string' ? body.positionId : null,
          positionTitle: typeof body.positionTitle === 'string' ? body.positionTitle : null,
          avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : null,
          tags: Array.isArray(body.tags)
            ? body.tags.filter((tag): tag is string => typeof tag === 'string')
            : [],
          isAdmin: body.isAdmin === true,
          status: body.status === 'disabled' ? 'disabled' : 'active',
        });
        sendJson(res, 201, { account });
        return;
      }

      const accountRoute = /^\/enterprise\/accounts\/([^/]+)$/.exec(path);
      if (accountRoute && (method === 'PATCH' || method === 'DELETE')) {
        const principal = await requireAdministrator({ repository, req, res, adminToken });
        if (!principal) return;
        const accountId = decodeURIComponent(accountRoute[1]!);
        if (method === 'DELETE') {
          const deleted = await repository.deleteAccount(principal.organizationId, accountId);
          sendJson(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: 'account not found' });
        } else {
          const body = await readJsonBody(req);
          const account = await repository.updateAccount(
            accountPatch(body, principal.organizationId, accountId),
          );
          sendJson(res, 200, { account });
        }
        return;
      }

      if (path === '/enterprise/audit' && method === 'GET') {
        const principal = await requireAdministrator({ repository, req, res, adminToken });
        if (!principal) return;
        sendJson(res, 200, {
          logs: await repository.listAuditLogs(
            principal.organizationId,
            Number(url.searchParams.get('limit') || 200),
          ),
        });
        return;
      }

      const member = await requireMember(repository, req, res);
      if (!member) return;

      if (path === '/enterprise/organization/view' && method === 'GET') {
        const [organization, members, structure, features] = await Promise.all([
          repository.getOrganization(member.organizationId),
          repository.listAccounts(member.organizationId),
          repository.listOrganizationStructure(member.organizationId),
          repository.getOrganizationFeatures(member.organizationId),
        ]);
        sendJson(res, 200, {
          organization,
          members,
          employeeCount: members.filter((account) => account.employeeId).length,
          structure,
          features,
          park: null,
        });
        return;
      }

      if (path === '/enterprise/organization/features' && method === 'GET') {
        sendJson(res, 200, {
          features: await repository.getOrganizationFeatures(member.organizationId),
        });
        return;
      }

      if (path === '/enterprise/organization/features' && method === 'PUT') {
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
        ] as const;
        const patch: Partial<Record<(typeof featureNames)[number], boolean>> = {};
        for (const feature of featureNames) {
          if (typeof body[feature] === 'boolean') patch[feature] = body[feature];
        }
        sendJson(res, 200, {
          features: await repository.updateOrganizationFeatures(
            member.organizationId,
            patch,
          ),
        });
        return;
      }

      if (path === '/enterprise/organization/departments' && method === 'POST') {
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
            ...(body.roleMapping === null || typeof body.roleMapping === 'string'
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
          deviceName: typeof body.deviceName === 'string' ? body.deviceName : '',
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

      const approveDevice = /^\/enterprise\/e2ee\/devices\/([^/]+)\/approve$/.exec(path);
      if (approveDevice && method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        const device = await repository.approveE2eeDevice({
          organizationId: member.organizationId,
          accountId: member.id,
          approverDeviceId:
            typeof body.approverDeviceId === 'string' ? body.approverDeviceId : '',
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
        sendJson(res, revoked ? 200 : 404, revoked ? { revoked: true } : { error: 'device not found' });
        return;
      }

      if (path === '/enterprise/messages/unread' && method === 'GET') {
        const features = await repository.getOrganizationFeatures(member.organizationId);
        if (!features.direct_messages) {
          sendJson(res, 403, { error: 'enterprise direct messages are disabled' });
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

      const messageRoute = /^\/enterprise\/messages\/([^/]+)$/.exec(path);
      if (messageRoute && (method === 'GET' || method === 'POST')) {
        const features = await repository.getOrganizationFeatures(member.organizationId);
        if (!features.direct_messages) {
          sendJson(res, 403, { error: 'enterprise direct messages are disabled' });
          return;
        }
        const peerAccountId = decodeURIComponent(messageRoute[1]!);
        const peer = await repository.getAccount(peerAccountId, member.organizationId);
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
        const message = await repository.sendE2eeDirectMessage({
          organizationId: member.organizationId,
          senderAccountId: member.id,
          recipientAccountId: peerAccountId,
          messageId: typeof body.messageId === 'string' ? body.messageId : '',
          senderDeviceId:
            typeof body.senderDeviceId === 'string' ? body.senderDeviceId : '',
          protocolVersion: body.protocolVersion === 1 ? 1 : (body.protocolVersion as 1),
          contentType:
            body.contentType === 'atoa_request' || body.contentType === 'atoa_response'
              ? body.contentType
              : 'message',
          inReplyToMessageId:
            typeof body.inReplyToMessageId === 'string'
              ? body.inReplyToMessageId
              : null,
          ciphertext: typeof body.ciphertext === 'string' ? body.ciphertext : '',
          nonce: typeof body.nonce === 'string' ? body.nonce : '',
          signature: typeof body.signature === 'string' ? body.signature : '',
          envelopes: Array.isArray(body.envelopes)
            ? (body.envelopes as E2eeMessageEnvelope[])
            : [],
          attachments: Array.isArray(body.attachments)
            ? (body.attachments as E2eeAttachmentCiphertextInput[])
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
  const topology = resolveEnterpriseDatabaseTopology({
    environment: process.env,
    sqliteDatabasePath: 'clustered-mode-does-not-open-sqlite.db',
  });
  if (topology.backend !== 'postgresql') {
    throw new Error('clustered enterprise server requires PostgreSQL mode');
  }

  let repository = options.repository;
  let readiness = options.databaseReadiness;
  let closeDatabase = options.closeDatabase;
  if (!repository || !readiness || !closeDatabase) {
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
    } catch (error) {
      await database.close();
      throw error;
    }
    repository = createPostgresEnterpriseCoreRepository({ pool });
    readiness = database.getReadiness;
    closeDatabase = database.close;
  } else {
    await readiness();
  }

  if (options.bootstrapAdmin) {
    const accounts = await repository.listAccounts(repository.defaultOrganizationId);
    if (accounts.length > 0) {
      await closeDatabase();
      throw new Error('bootstrap refused: PostgreSQL accounts already exist');
    }
    await repository.createAccount({
      organizationId: repository.defaultOrganizationId,
      username: options.bootstrapAdmin.username,
      password: options.bootstrapAdmin.password,
      name: options.bootstrapAdmin.name,
      isAdmin: true,
    });
  }

  const created = createClusteredEnterpriseServer(repository, {
    host: options.host ?? process.env.OTTO_ENTERPRISE_HOST,
    port:
      options.port ??
      Number(process.env.OTTO_ENTERPRISE_PORT || String(DEFAULT_PORT)),
    adminToken:
      options.adminToken ?? process.env.OTTO_ENTERPRISE_ADMIN_TOKEN,
    appVersion: options.appVersion ?? process.env.OTTO_APP_VERSION,
    buildCommit:
      options.buildCommit ??
      process.env.OTTO_BUILD_COMMIT ??
      process.env.GITHUB_SHA,
    databaseReadiness: readiness,
  });
  created.server.once('close', () => {
    void closeDatabase!();
  });
  created.server.listen(created.port, created.host, () => {
    const target = describeEnterpriseDatabaseTopology(topology);
    console.log(
      `[Otto Enterprise] PostgreSQL authority ready at http://${created.host}:${created.port}`,
    );
    console.log(
      `[Otto Enterprise] database ${target.target}, replicas ${target.replicas}`,
    );
  });
  return created.server;
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
    });
  } finally {
    await database.close();
  }
}
