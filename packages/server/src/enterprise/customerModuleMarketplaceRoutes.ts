import { createPrivateKey, sign } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalCustomerModuleManifest, encodeCustomerModulePackageV1 } from 'otto-core';
import {
  type CustomerModuleMarketplaceFacade,
} from '../modules/tool_skill_platform/index.js';
import type { AccountView } from './db.js';
import { getCustomerModuleMarketplace, getOrganizationFeatures } from './db.js';
import type { AdminPrincipal } from './enterpriseRouteDispatcher.js';

function platformSigner(market: CustomerModuleMarketplaceFacade) {
  const encodedKey = process.env.OTTO_CUSTOMER_MODULE_SIGNING_PRIVATE_KEY?.trim();
  const keyId = process.env.OTTO_CUSTOMER_MODULE_SIGNING_KEY_ID?.trim();
  if (!encodedKey || !keyId) return undefined;
  return (moduleId: string, version: string) => {
    const record = market.get(moduleId, version);
    if (!record) throw new Error('customer module version not found');
    const { signature: _signature, ...unsignedManifest } = record.manifest;
    const privateKey = createPrivateKey(encodedKey.replace(/\\n/gu, '\n'));
    return {
      keyId,
      value: `ed25519:${sign(null, Buffer.from(canonicalCustomerModuleManifest(unsignedManifest)), privateKey).toString('base64url')}`,
    };
  };
}

function publisherAccess(account: AccountView): boolean {
  const mode = process.env.OTTO_CUSTOMER_MODULE_MARKET_MODE?.trim() || 'internal';
  if (mode === 'public') return true;
  if (mode === 'disabled') return false;
  const allowed = new Set((process.env.OTTO_CUSTOMER_MODULE_PUBLISHER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  if (allowed.has(account.id)) return true;
  return mode === 'internal' && account.isAdmin;
}

export async function handleCustomerModuleMarketplaceRoute(input: {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: AccountView | null;
  adminPrincipal: AdminPrincipal | null;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}): Promise<boolean> {
  if (!input.path.startsWith('/enterprise/customer-modules')
    && !input.path.startsWith('/enterprise/platform/customer-modules')) return false;
  if (input.memberAccount && !getOrganizationFeatures(input.memberAccount.organizationId).skill_market) {
    input.sendJSON(input.res, 403, { error: '客户模块市场未授权或已由管理员关闭' });
    return true;
  }
  const actor = input.memberAccount
    ? { accountId: input.memberAccount.id, isPlatformReviewer: false }
    : input.adminPrincipal?.kind === 'system'
      ? { accountId: 'platform', isPlatformReviewer: true }
      : null;
  const body = input.method === 'POST' ? await input.readBody(input.req, 24_000_000) : {};
  const market = getCustomerModuleMarketplace();
  const packageMatch = input.path.match(/^\/enterprise\/customer-modules\/([a-z0-9.-]+)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/package$/u);
  if (packageMatch && input.method === 'GET') {
    const [, moduleId, version] = packageMatch;
    const record = market.get(moduleId, version);
    if (!record || record.status !== 'approved' || !record.manifest.signature) {
      input.sendJSON(input.res, 404, { error: 'approved customer module package not found' });
      return true;
    }
    const files = Object.fromEntries(
      [...market.getArtifacts(moduleId, version)].map(([path, body]) => [path, Buffer.from(body).toString('base64')]),
    );
    const archive = Buffer.from(encodeCustomerModulePackageV1({ manifest: record.manifest, files })).toString('base64');
    input.sendJSON(input.res, 200, { archive });
    return true;
  }
  if (input.path === '/enterprise/customer-modules/drafts' && input.method === 'POST') {
    if (!input.memberAccount) {
      input.sendJSON(input.res, 401, { error: 'publisher account required' });
      return true;
    }
    if (!publisherAccess(input.memberAccount)) {
      input.sendJSON(input.res, 403, { error: '客户模块发布者功能尚未向此账号开放' });
      return true;
    }
    try {
      const encodedFiles = body.files;
      if (!encodedFiles || typeof encodedFiles !== 'object' || Array.isArray(encodedFiles)) {
        throw new Error('customer module files are required');
      }
      const files = new Map<string, Uint8Array>();
      for (const [path, encoded] of Object.entries(encodedFiles as Record<string, unknown>)) {
        if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
          throw new Error(`customer module file is not valid base64: ${path}`);
        }
        files.set(path, Uint8Array.from(Buffer.from(encoded, 'base64')));
      }
      const module = await market.submit({
        publisherId: input.memberAccount.id,
        manifest: body.manifest,
        files,
      });
      input.sendJSON(input.res, 201, { module });
    } catch (error) {
      input.sendJSON(input.res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  const response = market.handle(
    { method: input.method, path: input.path, actor, body },
    { signApprovedVersion: platformSigner(market) },
  );
  input.sendJSON(input.res, response.status, response.body);
  return true;
}
