/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as db from './db.js';

type SecureMessagingRouteServices = Pick<
  typeof db,
  | 'approveE2eeDevice'
  | 'getAccount'
  | 'getE2eeCapabilityStatus'
  | 'getE2eeDeviceDirectory'
  | 'getE2eeTransparencyInclusionProof'
  | 'registerE2eeAccountRoot'
  | 'registerE2eeDevice'
  | 'revokeE2eeDevice'
>;

interface SecureMessagingRouteDeps {
  path: string;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: db.AccountView | null;
  services: SecureMessagingRouteServices;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

const E2EE_ROUTE_PREFIX = '/enterprise/e2ee/';
const E2EE_BODY_LIMIT = 128 * 1024;

function hasAuthenticatedScope(
  body: Record<string, unknown>,
  memberAccount: db.AccountView,
): boolean {
  return body.organizationId === memberAccount.organizationId
    && body.accountId === memberAccount.id;
}

function isExpectedProtocolError(error: unknown): error is Error {
  return error instanceof Error && /^(?:E2EE|MLS KeyPackage|first E2EE|device |actor device |target device |stored E2EE)/u
    .test(error.message);
}

function isMissingDirectoryError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'E2EE account trust root is not registered'
    || error.message === 'E2EE account is not active in organization'
  );
}

function resolveDirectoryAccount(
  services: SecureMessagingRouteServices,
  memberAccount: db.AccountView,
  requestedAccountId: string | null,
): db.AccountView | null {
  const accountId = requestedAccountId?.trim() || memberAccount.id;
  const account = services.getAccount(accountId, memberAccount.organizationId);
  return account?.status === 'active' ? account : null;
}

export async function handleSecureMessagingRoute({
  path,
  method,
  url,
  req,
  res,
  memberAccount,
  services,
  readBody,
  sendJSON,
}: SecureMessagingRouteDeps): Promise<boolean> {
  if (!path.startsWith(E2EE_ROUTE_PREFIX)) return false;
  if (!memberAccount) {
    sendJSON(res, 401, { error: 'login required' });
    return true;
  }

  res.setHeader('Cache-Control', 'no-store');

  if (path === '/enterprise/e2ee/status' && method === 'GET') {
    sendJSON(res, 200, { status: services.getE2eeCapabilityStatus() });
    return true;
  }

  if (path === '/enterprise/e2ee/directory' && method === 'GET') {
    const account = resolveDirectoryAccount(
      services,
      memberAccount,
      url.searchParams.get('accountId'),
    );
    if (!account) {
      sendJSON(res, 404, { error: 'E2EE device directory not found' });
      return true;
    }
    try {
      sendJSON(res, 200, {
        directory: services.getE2eeDeviceDirectory(
          memberAccount.organizationId,
          account.id,
        ),
      });
    } catch (error) {
      if (!isMissingDirectoryError(error)) throw error;
      sendJSON(res, 404, { error: 'E2EE device directory not found' });
    }
    return true;
  }

  if (path === '/enterprise/e2ee/transparency' && method === 'GET') {
    const account = resolveDirectoryAccount(
      services,
      memberAccount,
      url.searchParams.get('accountId'),
    );
    const accountSequence = Number(url.searchParams.get('sequence'));
    if (!account) {
      sendJSON(res, 404, { error: 'E2EE transparency proof not found' });
      return true;
    }
    if (!Number.isSafeInteger(accountSequence) || accountSequence < 1) {
      sendJSON(res, 400, { error: 'E2EE transparency sequence is invalid' });
      return true;
    }
    try {
      sendJSON(res, 200, {
        proof: services.getE2eeTransparencyInclusionProof(
          memberAccount.organizationId,
          account.id,
          accountSequence,
        ),
      });
    } catch (error) {
      if (
        !isMissingDirectoryError(error)
        && !(error instanceof Error
          && error.message === 'E2EE transparency leaf index is out of range')
      ) {
        throw error;
      }
      sendJSON(res, 404, { error: 'E2EE transparency proof not found' });
    }
    return true;
  }

  const mutation = (
    path === '/enterprise/e2ee/account-root'
    || path === '/enterprise/e2ee/devices/register'
    || path === '/enterprise/e2ee/devices/approve'
    || path === '/enterprise/e2ee/devices/revoke'
  ) && method === 'POST';
  if (!mutation) return false;

  const body = await readBody(req, E2EE_BODY_LIMIT);
  if (!hasAuthenticatedScope(body, memberAccount)) {
    sendJSON(res, 403, { error: 'E2EE device trust scope does not match the authenticated account' });
    return true;
  }

  try {
    if (path === '/enterprise/e2ee/account-root') {
      sendJSON(res, 200, {
        directory: services.registerE2eeAccountRoot(
          body as unknown as db.E2eeAccountRootRegistration,
        ),
      });
      return true;
    }
    if (path === '/enterprise/e2ee/devices/register') {
      sendJSON(res, 201, {
        directory: services.registerE2eeDevice(
          body as unknown as db.E2eeDeviceRegistration,
        ),
      });
      return true;
    }
    if (path === '/enterprise/e2ee/devices/approve') {
      sendJSON(res, 200, {
        directory: services.approveE2eeDevice(
          body as unknown as db.E2eeDeviceApprovalProof,
        ),
      });
      return true;
    }
    sendJSON(res, 200, {
      directory: services.revokeE2eeDevice(
        body as unknown as db.E2eeDeviceRevocationProof,
      ),
    });
  } catch (error) {
    if (!isExpectedProtocolError(error)) throw error;
    sendJSON(res, 400, { error: error.message });
  }
  return true;
}
