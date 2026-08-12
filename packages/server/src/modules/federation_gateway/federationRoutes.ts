/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { OrganizationFeatureKey } from '../../productModules.js';
import type {
  FederationMessageType,
  FederationQueueInput,
} from './federationContracts.js';
import { isFederationMessageType } from './federationRepository.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SCOPE = /^[a-z][a-z0-9._:-]{1,63}$/u;

interface FederationMemberPrincipal {
  id: string;
  organizationId: string;
}

interface FederationAdminPrincipal {
  organizationId: string;
}

export interface FederationRouteServices {
  getFederationStatus(): unknown;
  getFederationProvisioningManifest(): unknown;
  getFederationMemberIdentity(principalId: string): unknown;
  runFederationCycle(): Promise<unknown>;
  listFederationBlocks(): unknown;
  blockFederationDeployment(input: {
    deploymentId: string;
    reason: string;
  }): void;
  unblockFederationDeployment(deploymentId: string): boolean;
  lookupFederationDeployment(deploymentId: string): Promise<unknown>;
  saveFederationChatContact(input: {
    ownerAccountId: string;
    remoteDeploymentId: string;
    remotePrincipalId: string;
    displayName: string;
  }): Promise<unknown>;
  listFederationChatContacts(ownerAccountId: string): unknown;
  removeFederationChatContact(input: {
    ownerAccountId: string;
    contactId: string;
  }): boolean;
  createFederationChatAttachmentUpload(input: {
    ownerAccountId: string;
    contactId: string;
    attachmentId: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
    expiresInMs?: number;
  }): Promise<unknown>;
  completeFederationChatAttachmentUpload(input: {
    ownerAccountId: string;
    contactId: string;
    attachmentId: string;
  }): Promise<unknown>;
  createFederationChatAttachmentDownload(input: {
    ownerAccountId: string;
    contactId: string;
    attachmentId: string;
  }): Promise<unknown>;
  queueFederationChatMessage(input: {
    ownerAccountId: string;
    contactId: string;
    ciphertext: string;
    messageId?: string;
    inReplyTo?: string;
    attachmentIds?: string[];
    expiresInMs?: number;
  }): Promise<unknown>;
  listFederationChatMessages(input: {
    ownerAccountId: string;
    contactId: string;
    afterSequence?: number;
    limit?: number;
  }): unknown;
  markFederationChatMessageRead(input: {
    ownerAccountId: string;
    contactId: string;
    messageId: string;
  }): boolean;
  queueFederationMessage(input: FederationQueueInput): Promise<unknown>;
  listFederationInbox(input: {
    recipientPrincipalId: string;
    afterCursor?: number;
    limit?: number;
  }): unknown;
  consumeFederationInbox(input: {
    recipientPrincipalId: string;
    messageId: string;
  }): boolean;
  createFederationA2aGrant(input: {
    requesterDeploymentId: string;
    ownerPrincipalId: string;
    requesterPrincipalId: string;
    scopes: string[];
    expiresInMs?: number;
  }): Promise<unknown>;
  revokeFederationA2aGrant(grantId: string): Promise<void>;
  isLicenseUsableForOrganizationFeature(feature: OrganizationFeatureKey): boolean;
  isOrganizationFeatureEnabled(
    organizationId: string,
    feature: OrganizationFeatureKey,
  ): boolean;
}

export interface FederationRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: FederationMemberPrincipal | null;
  adminPrincipal: FederationAdminPrincipal | null;
  services: FederationRouteServices;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function requiredIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value.trim())) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function optionalIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : requiredIdentifier(value, label);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(maximum, Math.floor(parsed)))
    : fallback;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function attachmentIdentifiers(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 6) {
    throw new Error('attachment ids are invalid');
  }
  const ids = value.map((item) => requiredIdentifier(item, 'attachment id'));
  if (new Set(ids).size !== ids.length) {
    throw new Error('attachment ids must be unique');
  }
  return ids;
}

function requireFeature(
  deps: FederationRouteDeps,
  feature: OrganizationFeatureKey,
): boolean {
  const member = deps.memberAccount;
  if (!member) {
    deps.sendJSON(deps.res, 401, { error: 'enterprise login required' });
    return false;
  }
  if (!deps.services.isLicenseUsableForOrganizationFeature(feature)) {
    deps.sendJSON(deps.res, 402, {
      error: 'commercial module is not entitled',
      code: 'commercial_module_not_entitled',
      feature,
    });
    return false;
  }
  if (!deps.services.isOrganizationFeatureEnabled(member.organizationId, feature)) {
    deps.sendJSON(deps.res, 403, {
      error: 'organization feature is disabled',
      code: 'organization_feature_disabled',
      feature,
    });
    return false;
  }
  return true;
}

function normalizedMessageType(value: unknown): FederationMessageType {
  const type = value ?? 'chat.message';
  if (!isFederationMessageType(type)) {
    throw new Error('federation message type is invalid');
  }
  return type;
}

export async function handleFederationRoute(
  deps: FederationRouteDeps,
): Promise<boolean> {
  const { path, method, url, req, res, services, readBody, sendJSON } = deps;
  if (!path.startsWith('/enterprise/federation/')) return false;

  if (path === '/enterprise/federation/admin/status' && method === 'GET') {
    if (!deps.adminPrincipal) {
      sendJSON(res, 403, { error: 'enterprise administrator required' });
    } else {
      sendJSON(res, 200, { federation: services.getFederationStatus() });
    }
    return true;
  }
  if (path === '/enterprise/federation/admin/provisioning' && method === 'GET') {
    if (!deps.adminPrincipal) {
      sendJSON(res, 403, { error: 'enterprise administrator required' });
      return true;
    }
    try {
      sendJSON(res, 200, {
        provisioning: services.getFederationProvisioningManifest(),
      });
    } catch (error) {
      sendJSON(res, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (path === '/enterprise/federation/admin/run' && method === 'POST') {
    if (!deps.adminPrincipal) {
      sendJSON(res, 403, { error: 'enterprise administrator required' });
      return true;
    }
    try {
      sendJSON(res, 200, { result: await services.runFederationCycle() });
    } catch (error) {
      sendJSON(res, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }
  if (path === '/enterprise/federation/admin/blocks') {
    if (!deps.adminPrincipal) {
      sendJSON(res, 403, { error: 'enterprise administrator required' });
      return true;
    }
    if (method === 'GET') {
      sendJSON(res, 200, { blocks: services.listFederationBlocks() });
      return true;
    }
    if (method === 'POST') {
      try {
        const body = await readBody(req);
        services.blockFederationDeployment({
          deploymentId: requiredIdentifier(body.deploymentId, 'deployment id'),
          reason: requiredText(body.reason, 'reason', 500),
        });
        sendJSON(res, 201, { blocked: true });
      } catch (error) {
        sendJSON(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
  }
  if (
    path.startsWith('/enterprise/federation/admin/blocks/') &&
    method === 'DELETE'
  ) {
    if (!deps.adminPrincipal) {
      sendJSON(res, 403, { error: 'enterprise administrator required' });
      return true;
    }
    try {
      const deploymentId = requiredIdentifier(
        decodeURIComponent(path.slice('/enterprise/federation/admin/blocks/'.length)),
        'deployment id',
      );
      sendJSON(res, services.unblockFederationDeployment(deploymentId) ? 200 : 404, {
        blocked: false,
      });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (!deps.memberAccount) {
    sendJSON(res, 401, { error: 'enterprise login required' });
    return true;
  }

  if (path === '/enterprise/federation/identity' && method === 'GET') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      sendJSON(res, 200, {
        identity: services.getFederationMemberIdentity(deps.memberAccount.id),
      });
    } catch (error) {
      sendJSON(res, 503, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (
    path.startsWith('/enterprise/federation/directory/') &&
    method === 'GET'
  ) {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const deploymentId = requiredIdentifier(
        decodeURIComponent(path.slice('/enterprise/federation/directory/'.length)),
        'deployment id',
      );
      sendJSON(res, 200, {
        deployment: await services.lookupFederationDeployment(deploymentId),
      });
    } catch (error) {
      sendJSON(res, 404, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (path === '/enterprise/federation/contacts') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    if (method === 'GET') {
      sendJSON(res, 200, {
        contacts: services.listFederationChatContacts(deps.memberAccount.id),
      });
      return true;
    }
    if (method === 'POST') {
      try {
        const body = await readBody(req);
        const contact = await services.saveFederationChatContact({
          ownerAccountId: deps.memberAccount.id,
          remoteDeploymentId: requiredIdentifier(
            body.remoteDeploymentId,
            'remote deployment id',
          ),
          remotePrincipalId: requiredIdentifier(
            body.remotePrincipalId,
            'remote principal id',
          ),
          displayName: requiredText(body.displayName, 'display name', 120).trim(),
        });
        sendJSON(res, 201, { contact });
      } catch (error) {
        sendJSON(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }
  }

  if (
    path.startsWith('/enterprise/federation/contacts/') &&
    method === 'DELETE'
  ) {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const contactId = requiredIdentifier(
        decodeURIComponent(path.slice('/enterprise/federation/contacts/'.length)),
        'contact id',
      );
      const removed = services.removeFederationChatContact({
        ownerAccountId: deps.memberAccount.id,
        contactId,
      });
      sendJSON(res, removed ? 200 : 404, { removed });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const attachmentUploads = /^\/enterprise\/federation\/conversations\/([^/]+)\/attachments\/uploads$/u
    .exec(path);
  if (attachmentUploads && method === 'POST') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const body = await readBody(req);
      const sha256 = requiredText(
        body.ciphertextSha256,
        'ciphertext SHA-256',
        64,
      ).trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/u.test(sha256)) {
        throw new Error('ciphertext SHA-256 is invalid');
      }
      const result = await services.createFederationChatAttachmentUpload({
        ownerAccountId: deps.memberAccount.id,
        contactId: requiredIdentifier(
          decodeURIComponent(attachmentUploads[1]!),
          'contact id',
        ),
        attachmentId: requiredIdentifier(body.attachmentId, 'attachment id'),
        ciphertextBytes: positiveInteger(
          body.ciphertextBytes,
          'ciphertext bytes',
          1024 * 1024 * 1024,
        ),
        ciphertextSha256: sha256,
        expiresInMs: body.expiresInMs === undefined
          ? undefined
          : positiveInteger(
              body.expiresInMs,
              'attachment lifetime',
              7 * 24 * 60 * 60_000,
            ),
      });
      sendJSON(res, 201, result);
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const attachmentAction = /^\/enterprise\/federation\/conversations\/([^/]+)\/attachments\/([^/]+)\/(complete|download)$/u
    .exec(path);
  if (attachmentAction && method === 'POST') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const input = {
        ownerAccountId: deps.memberAccount.id,
        contactId: requiredIdentifier(
          decodeURIComponent(attachmentAction[1]!),
          'contact id',
        ),
        attachmentId: requiredIdentifier(
          decodeURIComponent(attachmentAction[2]!),
          'attachment id',
        ),
      };
      const result = attachmentAction[3] === 'complete'
        ? await services.completeFederationChatAttachmentUpload(input)
        : await services.createFederationChatAttachmentDownload(input);
      sendJSON(res, 200, result);
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const conversationMessages = /^\/enterprise\/federation\/conversations\/([^/]+)\/messages$/u
    .exec(path);
  if (conversationMessages) {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const contactId = requiredIdentifier(
        decodeURIComponent(conversationMessages[1]!),
        'contact id',
      );
      if (method === 'GET') {
        sendJSON(res, 200, {
          messages: services.listFederationChatMessages({
            ownerAccountId: deps.memberAccount.id,
            contactId,
            afterSequence: integer(
              url.searchParams.get('after'),
              0,
              Number.MAX_SAFE_INTEGER,
            ),
            limit: integer(url.searchParams.get('limit'), 100, 200),
          }),
        });
        return true;
      }
      if (method === 'POST') {
        const body = await readBody(req, 2 * 1024 * 1024);
        const queued = await services.queueFederationChatMessage({
          ownerAccountId: deps.memberAccount.id,
          contactId,
          ciphertext: requiredText(body.ciphertext, 'ciphertext', 1024 * 1024),
          messageId: optionalIdentifier(body.messageId, 'message id'),
          inReplyTo: optionalIdentifier(body.inReplyTo, 'reply message id'),
          attachmentIds: attachmentIdentifiers(body.attachmentIds),
          expiresInMs: body.expiresInMs === undefined
            ? undefined
            : integer(body.expiresInMs, 0, 7 * 24 * 60 * 60_000),
        });
        sendJSON(res, 202, { queued });
        return true;
      }
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  const readMessage = /^\/enterprise\/federation\/conversations\/([^/]+)\/messages\/([^/]+)\/read$/u
    .exec(path);
  if (readMessage && method === 'POST') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const read = services.markFederationChatMessageRead({
        ownerAccountId: deps.memberAccount.id,
        contactId: requiredIdentifier(
          decodeURIComponent(readMessage[1]!),
          'contact id',
        ),
        messageId: requiredIdentifier(
          decodeURIComponent(readMessage[2]!),
          'message id',
        ),
      });
      sendJSON(res, read ? 200 : 404, { read });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (path === '/enterprise/federation/messages' && method === 'GET') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    sendJSON(res, 200, {
      messages: services.listFederationInbox({
        recipientPrincipalId: deps.memberAccount.id,
        afterCursor: integer(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER),
        limit: integer(url.searchParams.get('limit'), 50, 200),
      }),
    });
    return true;
  }

  if (path === '/enterprise/federation/messages' && method === 'POST') {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const body = await readBody(req, 2 * 1024 * 1024);
      const type = normalizedMessageType(body.type);
      if (
        (type === 'a2a.request' || type === 'a2a.response') &&
        !requireFeature(deps, 'atoa')
      ) return true;
      const recipientDeploymentId = requiredIdentifier(
        body.recipientDeploymentId,
        'recipient deployment id',
      );
      const recipientPrincipalId = requiredIdentifier(
        body.recipientPrincipalId,
        'recipient principal id',
      );
      const queue: FederationQueueInput = {
        recipientDeploymentId,
        type,
        ciphertext: requiredText(body.ciphertext, 'ciphertext', 1024 * 1024),
        routing: {
          conversationId: requiredIdentifier(body.conversationId, 'conversation id'),
          senderPrincipalId: deps.memberAccount.id,
          recipientPrincipalId,
          inReplyTo: optionalIdentifier(body.inReplyTo, 'reply message id'),
          a2aGrantId: optionalIdentifier(body.a2aGrantId, 'A2A grant id'),
          a2aScope: typeof body.a2aScope === 'string' ? body.a2aScope : undefined,
        },
        messageId: optionalIdentifier(body.messageId, 'message id'),
        expiresInMs: body.expiresInMs === undefined
          ? undefined
          : integer(body.expiresInMs, 0, 7 * 24 * 60 * 60_000),
      };
      if (
        type === 'a2a.request' &&
        (!queue.routing.a2aGrantId ||
          !queue.routing.a2aScope || !SCOPE.test(queue.routing.a2aScope))
      ) {
        throw new Error('A2A request requires a valid grant and scope');
      }
      sendJSON(res, 202, { queued: await services.queueFederationMessage(queue) });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (
    path.startsWith('/enterprise/federation/messages/') &&
    path.endsWith('/consume') && method === 'POST'
  ) {
    if (!requireFeature(deps, 'direct_messages')) return true;
    try {
      const messageId = requiredIdentifier(
        decodeURIComponent(path.slice(
          '/enterprise/federation/messages/'.length,
          -'/consume'.length,
        )),
        'message id',
      );
      const consumed = services.consumeFederationInbox({
        recipientPrincipalId: deps.memberAccount.id,
        messageId,
      });
      sendJSON(res, consumed ? 200 : 404, { consumed });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (path === '/enterprise/federation/a2a/grants' && method === 'POST') {
    if (!requireFeature(deps, 'atoa')) return true;
    try {
      const body = await readBody(req);
      const scopes = Array.isArray(body.scopes)
        ? [...new Set(body.scopes.map((scope) => String(scope).trim()))]
        : [];
      if (scopes.length < 1 || scopes.length > 16 || scopes.some((scope) => !SCOPE.test(scope))) {
        throw new Error('A2A scopes are invalid');
      }
      const grant = await services.createFederationA2aGrant({
        requesterDeploymentId: requiredIdentifier(
          body.requesterDeploymentId,
          'requester deployment id',
        ),
        ownerPrincipalId: deps.memberAccount.id,
        requesterPrincipalId: requiredIdentifier(
          body.requesterPrincipalId,
          'requester principal id',
        ),
        scopes,
        expiresInMs: body.expiresInMs === undefined
          ? undefined
          : integer(body.expiresInMs, 0, 24 * 60 * 60_000),
      });
      sendJSON(res, 201, { grant });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (
    path.startsWith('/enterprise/federation/a2a/grants/') &&
    path.endsWith('/revoke') && method === 'POST'
  ) {
    if (!requireFeature(deps, 'atoa')) return true;
    try {
      const grantId = requiredIdentifier(
        decodeURIComponent(path.slice(
          '/enterprise/federation/a2a/grants/'.length,
          -'/revoke'.length,
        )),
        'grant id',
      );
      await services.revokeFederationA2aGrant(grantId);
      sendJSON(res, 200, { revoked: true });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}
