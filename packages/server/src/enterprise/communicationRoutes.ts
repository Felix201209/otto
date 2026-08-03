/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as db from './db.js';

interface CommunicationRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView;
  atoaClaims: Map<string, number>;
  atoaClaimTtlMs: number;
  readBody(
    req: IncomingMessage,
    maxLength?: number,
  ): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function mlsErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/rate limit|inventory quota/i.test(message)) return 429;
  if (/cursor expired|reset source group is no longer active/i.test(message)) {
    return 409;
  }
  return 400;
}

export function organizationViewPayload(organizationId: string) {
  const organization = db.getOrganization(organizationId);
  const accounts = db.listAccounts(organizationId);
  const employees = db.listEmployees(undefined, organizationId);
  const park = db.getParkForOrganization(organizationId);
  const presenceByAccountId = new Map(
    db
      .listAccountPresence(organizationId)
      .map((presence) => [presence.accountId, presence]),
  );
  return {
    organization: organization
      ? {
          id: organization.id,
          name: organization.name,
          status: organization.status,
          parkId: organization.parkId,
          industry: organization.industry ?? null,
          createdAt: organization.createdAt,
        }
      : null,
    members: accounts.map((account) => ({
      id: account.id,
      username: account.username,
      name: account.name,
      role: account.role,
      department: account.department,
      departmentId: account.departmentId,
      positionId: account.positionId,
      positionTitle: account.positionTitle,
      avatarUrl: account.avatarUrl,
      isAdmin: account.isAdmin,
      status: account.status,
      ottoOnline: presenceByAccountId.get(account.id)?.online ?? false,
      ottoLastSeenAt: presenceByAccountId.get(account.id)?.lastSeenAt ?? null,
    })),
    employeeCount: employees.length,
    structure: db.listOrganizationStructure(organizationId),
    features: db.getOrganizationFeatures(organizationId),
    park: park
      ? {
          ...park,
          isAdminOrganization: park.adminOrganizationId === organizationId,
          services: db.listParkServices(park.id),
        }
      : null,
  };
}

export async function handleCommunicationRoute({
  path,
  method,
  url,
  req,
  res,
  memberAccount,
  atoaClaims,
  atoaClaimTtlMs,
  readBody,
  sendJSON,
}: CommunicationRouteDeps): Promise<boolean> {
  if (path === '/enterprise/account-sync' && method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    sendJSON(res, 200, {
      snapshots: db.listAccountSyncSnapshots(memberAccount.id),
    });
    return true;
  }

  if (path === '/enterprise/account-sync' && method === 'PUT') {
    res.setHeader('Cache-Control', 'no-store');
    const body = await readBody(req, 12 * 1024 * 1024);
    const scope = typeof body.scope === 'string' ? body.scope : '';
    if (!(db.ACCOUNT_SYNC_SCOPES as readonly string[]).includes(scope)) {
      sendJSON(res, 400, { error: 'account sync scope is invalid' });
      return true;
    }
    try {
      const snapshot = db.putAccountSyncSnapshot({
        accountId: memberAccount.id,
        scope: scope as db.AccountSyncScope,
        expectedVersion: Number(body.expectedVersion),
        payload: body.payload,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      });
      sendJSON(res, 200, { snapshot });
    } catch (error) {
      if (error instanceof db.AccountSyncConflictError) {
        sendJSON(res, 409, {
          error: error.message,
          currentVersion: error.currentVersion,
        });
        return true;
      }
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (path === '/enterprise/organization/view' && method === 'GET') {
    const requestedOrganizationId = url.searchParams.get('organizationId');
    const organizationId = requestedOrganizationId || memberAccount.organizationId;
    if (organizationId !== memberAccount.organizationId) {
      const park = db.getParkForOrganization(memberAccount.organizationId);
      const targetPark = db.getParkForOrganization(organizationId);
      if (!memberAccount.isAdmin || park?.adminOrganizationId !== memberAccount.organizationId
        || targetPark?.id !== park.id) {
        sendJSON(res, 403, { error: '无权查看该企业组织架构' });
        return true;
      }
    }
    if (!db.getOrganizationFeatures(organizationId).enterprise_tree) {
      sendJSON(res, 403, { error: '企业树功能已由管理员关闭' });
      return true;
    }
    sendJSON(res, 200, organizationViewPayload(organizationId));
    return true;
  }

  if (path === '/enterprise/organization/sync' && method === 'GET') {
    const organizationId = memberAccount.organizationId;
    const features = db.getOrganizationFeatures(organizationId);
    if (!features.enterprise_tree) {
      sendJSON(res, 403, { error: '企业树同步功能已由管理员关闭' });
      return true;
    }
    sendJSON(res, 200, organizationViewPayload(organizationId));
    return true;
  }

  if (path === '/enterprise/presence/heartbeat' && method === 'POST') {
    const body = await readBody(req);
    const clientId =
      typeof body.clientId === 'string' ? body.clientId : 'desktop';
    const presence = db.touchAccountPresence({
      organizationId: memberAccount.organizationId,
      accountId: memberAccount.id,
      clientId,
    });
    sendJSON(res, 200, { presence });
    return true;
  }

  if (path === '/enterprise/e2ee/devices' && method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    try {
      const requestedDeviceId =
        typeof body.deviceId === 'string' ? body.deviceId : '';
      const alreadyRegistered = db
        .listE2eeDevices({
          organizationId: memberAccount.organizationId,
          requesterAccountId: memberAccount.id,
          accountIds: [memberAccount.id],
          includeRevoked: true,
        })
        .some((candidate) => candidate.deviceId === requestedDeviceId);
      const device = db.registerE2eeDevice({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        deviceId: requestedDeviceId,
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
      if (!alreadyRegistered) {
        db.logAudit(
          'e2ee_device_registered',
          memberAccount.employeeId,
          JSON.stringify({
            accountId: memberAccount.id,
            deviceId: device.deviceId,
            deviceName: device.deviceName,
          }),
          memberAccount.organizationId,
        );
      }
      sendJSON(res, 200, { device });
    } catch (error) {
      sendJSON(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : 'E2EE device registration failed',
      });
    }
    return true;
  }

  if (path === '/enterprise/e2ee/devices' && method === 'GET') {
    try {
      const accountIds = url.searchParams.getAll('accountId');
      const devices = db.listE2eeDevices({
        organizationId: memberAccount.organizationId,
        requesterAccountId: memberAccount.id,
        accountIds: accountIds.length > 0 ? accountIds : [memberAccount.id],
        includeRevoked: url.searchParams.get('includeRevoked') === 'true',
        includePending: url.searchParams.get('includePending') === 'true',
      });
      res.setHeader('Cache-Control', 'no-store');
      sendJSON(res, 200, { devices });
    } catch (error) {
      sendJSON(res, 400, {
        error:
          error instanceof Error ? error.message : 'E2EE device lookup failed',
      });
    }
    return true;
  }

  if (path === '/enterprise/e2ee/key-transparency' && method === 'GET') {
    try {
      const accountId = url.searchParams.get('accountId') || memberAccount.id;
      const transparency = db.listE2eeKeyTransparency({
        organizationId: memberAccount.organizationId,
        requesterAccountId: memberAccount.id,
        accountId,
      });
      res.setHeader('Cache-Control', 'no-store');
      sendJSON(res, 200, { transparency });
    } catch (error) {
      sendJSON(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : 'E2EE transparency lookup failed',
      });
    }
    return true;
  }

  if (
    path === '/enterprise/e2ee/mls/key-packages/inventory' &&
    method === 'GET'
  ) {
    const deviceId = url.searchParams.get('deviceId') || '';
    try {
      const keyPackages = db.listMlsKeyPackageInventory({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        deviceId,
      });
      res.setHeader('Cache-Control', 'no-store');
      sendJSON(res, 200, { deviceId, keyPackages });
    } catch (error) {
      sendJSON(res, mlsErrorStatus(error), {
        error:
          error instanceof Error
            ? error.message
            : 'MLS KeyPackage inventory lookup failed',
      });
    }
    return true;
  }

  const retireMlsKeyPackageMatch = path.match(
    /^\/enterprise\/e2ee\/mls\/key-packages\/([0-9a-f]{64})$/,
  );
  if (retireMlsKeyPackageMatch && method === 'DELETE') {
    const deviceId = url.searchParams.get('deviceId') || '';
    try {
      const reference = retireMlsKeyPackageMatch[1] ?? '';
      const retired = db.retireMlsKeyPackage({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        deviceId,
        reference,
      });
      if (!retired) {
        sendJSON(res, 409, {
          error: 'claimed MLS KeyPackage cannot be retired',
        });
      } else {
        sendJSON(res, 200, { deviceId, reference, retired: true });
      }
    } catch (error) {
      sendJSON(res, mlsErrorStatus(error), {
        error:
          error instanceof Error
            ? error.message
            : 'MLS KeyPackage retirement failed',
      });
    }
    return true;
  }

  if (path === '/enterprise/e2ee/mls/key-packages' && method === 'POST') {
    const body = await readBody(req, 96 * 1024);
    try {
      const keyPackage = db.publishMlsKeyPackage({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : '',
        ciphersuite:
          typeof body.ciphersuite === 'string'
            ? (body.ciphersuite as Parameters<
                typeof db.publishMlsKeyPackage
              >[0]['ciphersuite'])
            : ('' as Parameters<
                typeof db.publishMlsKeyPackage
              >[0]['ciphersuite']),
        reference:
          typeof body.keyPackageReference === 'string'
            ? body.keyPackageReference
            : undefined,
        keyPackage: typeof body.keyPackage === 'string' ? body.keyPackage : '',
      });
      sendJSON(res, 201, { keyPackage });
    } catch (error) {
      sendJSON(res, mlsErrorStatus(error), {
        error:
          error instanceof Error
            ? error.message
            : 'MLS KeyPackage publication failed',
      });
    }
    return true;
  }

  if (path === '/enterprise/e2ee/mls/key-packages/claim' && method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    try {
      const keyPackage = db.claimMlsKeyPackage({
        organizationId: memberAccount.organizationId,
        requesterAccountId: memberAccount.id,
        requesterDeviceId:
          typeof body.requesterDeviceId === 'string'
            ? body.requesterDeviceId
            : '',
        recipientAccountId:
          typeof body.recipientAccountId === 'string'
            ? body.recipientAccountId
            : '',
      });
      sendJSON(
        res,
        keyPackage ? 200 : 404,
        keyPackage
          ? { keyPackage }
          : { error: 'no unclaimed MLS KeyPackage is available' },
      );
    } catch (error) {
      sendJSON(res, mlsErrorStatus(error), {
        error:
          error instanceof Error
            ? error.message
            : 'MLS KeyPackage claim failed',
      });
    }
    return true;
  }

  if (
    path === '/enterprise/e2ee/mls/inbound-conversations' &&
    method === 'GET'
  ) {
    try {
      const peerAccountIds = db.listMlsInboundConversationPeers({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        deviceId: url.searchParams.get('deviceId') || '',
        afterPeerAccountId:
          url.searchParams.get('afterPeerAccountId') || undefined,
        limit: Number(url.searchParams.get('limit') || 100),
      });
      res.setHeader('Cache-Control', 'no-store');
      sendJSON(res, 200, { peerAccountIds });
    } catch (error) {
      sendJSON(res, mlsErrorStatus(error), {
        error:
          error instanceof Error
            ? error.message
            : 'MLS inbound conversation discovery failed',
      });
    }
    return true;
  }

  const mlsEventsMatch = path.match(
    /^\/enterprise\/e2ee\/mls\/conversations\/([^/]+)\/events$/,
  );
  if (mlsEventsMatch && (method === 'GET' || method === 'POST')) {
    let peerAccountId = '';
    try {
      peerAccountId = decodeURIComponent(mlsEventsMatch[1] ?? '');
    } catch {
      // Invalid identifiers are rejected by the repository.
    }
    try {
      if (method === 'GET') {
        const events = db.listMlsTransportEvents({
          organizationId: memberAccount.organizationId,
          accountId: memberAccount.id,
          peerAccountId,
          afterSequence: Number(url.searchParams.get('afterSequence') || 0),
          limit: Number(url.searchParams.get('limit') || 100),
        });
        res.setHeader('Cache-Control', 'no-store');
        sendJSON(res, 200, { events });
      } else {
        const body = await readBody(req, 1400 * 1024);
        const event = db.appendMlsTransportEvent({
          organizationId: memberAccount.organizationId,
          senderAccountId: memberAccount.id,
          peerAccountId,
          senderDeviceId:
            typeof body.senderDeviceId === 'string' ? body.senderDeviceId : '',
          eventId: typeof body.eventId === 'string' ? body.eventId : '',
          eventType:
            typeof body.eventType === 'string'
              ? (body.eventType as Parameters<
                  typeof db.appendMlsTransportEvent
                >[0]['eventType'])
              : ('invalid' as Parameters<
                  typeof db.appendMlsTransportEvent
                >[0]['eventType']),
          epoch: Number(body.epoch),
          groupId: typeof body.groupId === 'string' ? body.groupId : '',
          payload: typeof body.payload === 'string' ? body.payload : '',
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
        sendJSON(res, 201, { event });
      }
    } catch (error) {
      sendJSON(res, mlsErrorStatus(error), {
        error:
          error instanceof Error ? error.message : 'MLS event relay failed',
      });
    }
    return true;
  }

  const approveDeviceMatch = path.match(
    /^\/enterprise\/e2ee\/devices\/([^/]+)\/approve$/,
  );
  if (approveDeviceMatch && method === 'POST') {
    let targetDeviceId = '';
    try {
      targetDeviceId = decodeURIComponent(approveDeviceMatch[1] ?? '');
    } catch {
      // Invalid identifiers are rejected by the repository.
    }
    const body = await readBody(req, 16 * 1024);
    try {
      const device = db.approveE2eeDevice({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        approverDeviceId:
          typeof body.approverDeviceId === 'string'
            ? body.approverDeviceId
            : '',
        targetDeviceId,
        targetKeyFingerprint:
          typeof body.targetKeyFingerprint === 'string'
            ? body.targetKeyFingerprint
            : '',
        signature: typeof body.signature === 'string' ? body.signature : '',
      });
      db.logAudit(
        'e2ee_device_approved',
        memberAccount.employeeId,
        JSON.stringify({
          accountId: memberAccount.id,
          approverDeviceId: device.approvedByDeviceId,
          targetDeviceId: device.deviceId,
          targetKeyFingerprint: device.keyFingerprint,
        }),
        memberAccount.organizationId,
      );
      sendJSON(res, 200, { device });
    } catch (error) {
      sendJSON(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : 'E2EE device approval failed',
      });
    }
    return true;
  }

  if (path.startsWith('/enterprise/e2ee/devices/') && method === 'DELETE') {
    let deviceId = '';
    try {
      deviceId = decodeURIComponent(
        path.slice('/enterprise/e2ee/devices/'.length),
      );
    } catch {
      // Invalid identifiers are rejected by the repository.
    }
    try {
      const revoked = db.revokeE2eeDevice({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        deviceId,
      });
      if (revoked) {
        db.logAudit(
          'e2ee_device_revoked',
          memberAccount.employeeId,
          JSON.stringify({ accountId: memberAccount.id, deviceId }),
          memberAccount.organizationId,
        );
      }
      sendJSON(
        res,
        revoked ? 200 : 404,
        revoked ? { revoked: true } : { error: 'E2EE device not found' },
      );
    } catch (error) {
      sendJSON(res, 400, {
        error:
          error instanceof Error
            ? error.message
            : 'E2EE device revocation failed',
      });
    }
    return true;
  }

  if (path === '/enterprise/atoa/inbox' && method === 'GET') {
    if (!db.getOrganizationFeatures(memberAccount.organizationId).atoa) {
      sendJSON(res, 403, { error: '企业协作功能已由管理员关闭' });
      return true;
    }
    const now = Date.now();
    for (const [key, expiresAt] of atoaClaims) {
      if (expiresAt <= now) atoaClaims.delete(key);
    }
    const pending = db.listPendingE2eeAtoaRequests({
      organizationId: memberAccount.organizationId,
      accountId: memberAccount.id,
      limit: Number(url.searchParams.get('limit') || 50),
    });
    const claimed = pending.find((request) => {
      const peer = db.getAccount(
        request.peerAccountId,
        memberAccount.organizationId,
      );
      if (!peer || peer.status !== 'active') return false;
      const key = `${memberAccount.organizationId}:${memberAccount.id}:${request.id}`;
      if ((atoaClaims.get(key) ?? 0) > now) return false;
      atoaClaims.set(key, now + atoaClaimTtlMs);
      return true;
    });
    const peer = claimed
      ? db.getAccount(claimed.peerAccountId, memberAccount.organizationId)
      : null;
    sendJSON(res, 200, {
      requests:
        claimed && peer
          ? [
              {
                ...claimed,
                peer: {
                  id: peer.id,
                  username: peer.username,
                  name: peer.name,
                  department: peer.department,
                  positionTitle: peer.positionTitle,
                  role: peer.role,
                },
              },
            ]
          : [],
    });
    return true;
  }

  if (path === '/enterprise/messages/unread' && method === 'GET') {
    if (
      !db.getOrganizationFeatures(memberAccount.organizationId).direct_messages
    ) {
      sendJSON(res, 403, { error: '企业内部消息功能已由管理员关闭' });
      return true;
    }
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    sendJSON(res, 200, {
      notifications: db.listUnreadE2eeNotifications({
        organizationId: memberAccount.organizationId,
        accountId: memberAccount.id,
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
      }),
    });
    return true;
  }

  if (path.startsWith('/enterprise/message-attachments/') && method === 'GET') {
    if (
      !db.getOrganizationFeatures(memberAccount.organizationId).direct_messages
    ) {
      sendJSON(res, 403, { error: 'enterprise direct messages are disabled' });
      return true;
    }
    let attachmentId = '';
    try {
      attachmentId = decodeURIComponent(
        path.slice('/enterprise/message-attachments/'.length),
      );
    } catch {
      // Invalid encoded ids are handled as missing attachments.
    }
    try {
      sendJSON(res, 200, {
        attachment: db.getE2eeAttachment({
          organizationId: memberAccount.organizationId,
          accountId: memberAccount.id,
          attachmentId,
        }),
      });
    } catch {
      sendJSON(res, 404, { error: 'attachment not found or access denied' });
    }
    return true;
  }

  if (
    path.startsWith('/enterprise/messages/') &&
    (method === 'GET' || method === 'POST')
  ) {
    if (
      !db.getOrganizationFeatures(memberAccount.organizationId).direct_messages
    ) {
      sendJSON(res, 403, { error: '企业内部消息功能已由管理员关闭' });
      return true;
    }
    const peerAccountId = decodeURIComponent(
      path.slice('/enterprise/messages/'.length),
    );
    const peer = db.getAccount(peerAccountId, memberAccount.organizationId);
    if (!peer || peer.status !== 'active') {
      sendJSON(res, 404, { error: '成员不存在或已停用' });
      return true;
    }
    if (peer.id === memberAccount.id) {
      sendJSON(res, 400, { error: '不能给自己发送消息' });
      return true;
    }
    if (method === 'GET') {
      sendJSON(res, 200, {
        messages: db.listE2eeDirectMessages({
          organizationId: memberAccount.organizationId,
          accountId: memberAccount.id,
          peerAccountId,
          limit: Number(url.searchParams.get('limit') || 100),
        }),
      });
      return true;
    }
    const body = await readBody(req, 30 * 1024 * 1024);
    if (
      typeof body.messageId !== 'string' ||
      typeof body.senderDeviceId !== 'string' ||
      body.protocolVersion !== 1 ||
      typeof body.ciphertext !== 'string' ||
      typeof body.nonce !== 'string' ||
      typeof body.signature !== 'string' ||
      !Array.isArray(body.envelopes) ||
      (body.attachments != null && !Array.isArray(body.attachments))
    ) {
      sendJSON(res, 400, { error: '消息内容不能为空' });
      return true;
    }
    const contentType =
      body.contentType === 'atoa_request' ||
      body.contentType === 'atoa_response'
        ? body.contentType
        : 'message';
    const isAtoaProtocolMessage = contentType !== 'message';
    if (
      isAtoaProtocolMessage &&
      !db.isLicenseUsableForOrganizationFeature('atoa')
    ) {
      sendJSON(res, 402, {
        error: 'commercial module is not entitled',
        code: 'commercial_module_not_entitled',
        feature: 'atoa',
      });
      return true;
    }
    if (
      isAtoaProtocolMessage &&
      !db.isOrganizationFeatureEnabled(memberAccount.organizationId, 'atoa')
    ) {
      sendJSON(res, 403, {
        error: 'organization feature is disabled',
        code: 'organization_feature_disabled',
        feature: 'atoa',
      });
      return true;
    }
    try {
      const message = db.sendE2eeDirectMessage({
        organizationId: memberAccount.organizationId,
        senderAccountId: memberAccount.id,
        recipientAccountId: peerAccountId,
        messageId: body.messageId as string,
        senderDeviceId: body.senderDeviceId as string,
        protocolVersion: 1,
        contentType,
        inReplyToMessageId:
          typeof body.inReplyToMessageId === 'string'
            ? body.inReplyToMessageId
            : null,
        ciphertext: body.ciphertext as string,
        nonce: body.nonce as string,
        signature: body.signature as string,
        envelopes: body.envelopes as db.E2eeMessageEnvelope[],
        attachments: body.attachments as
          db.E2eeAttachmentCiphertextInput[] | undefined,
      });
      if (message.inReplyToMessageId) {
        atoaClaims.delete(
          `${memberAccount.organizationId}:${memberAccount.id}:${message.inReplyToMessageId}`,
        );
      }
      sendJSON(res, 201, { message });
    } catch (error) {
      sendJSON(res, 400, {
        error: error instanceof Error ? error.message : '消息发送失败',
      });
    }
    return true;
  }

  return false;
}
