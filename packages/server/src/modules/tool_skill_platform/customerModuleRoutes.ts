import type { CustomerModuleMarketplace } from './customerModuleMarketplace.js';

export interface CustomerModuleRouteRequest {
  method: string;
  path: string;
  actor: { accountId: string; isPlatformReviewer: boolean } | null;
  body: Record<string, unknown>;
}

export interface CustomerModuleRouteResponse {
  status: number;
  body: unknown;
}

export function handleCustomerModuleMarketplaceRequest(
  market: CustomerModuleMarketplace,
  request: CustomerModuleRouteRequest,
  options: {
    signApprovedVersion?(moduleId: string, version: string): { keyId: string; value: string };
  } = {},
): CustomerModuleRouteResponse {
  if (request.path === '/enterprise/customer-modules' && request.method === 'GET') {
    return { status: 200, body: { modules: market.listPublic() } };
  }
  if (!request.actor) return { status: 401, body: { error: 'authentication required' } };
  try {
    if (request.path === '/enterprise/customer-modules/drafts' && request.method === 'POST') {
      const manifest = request.body.manifest as { publisher?: { id?: string } } | undefined;
      if (manifest?.publisher?.id !== request.actor.accountId) return { status: 403, body: { error: 'publisher identity mismatch' } };
      return { status: 201, body: { module: market.createDraft(request.actor.accountId, manifest) } };
    }
    const statusMatch = request.path.match(/^\/enterprise\/customer-modules\/([a-z0-9.-]+)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/status$/u);
    if (statusMatch && request.method === 'GET') {
      const record = market.get(statusMatch[1], statusMatch[2]);
      return record
        ? { status: 200, body: { moduleId: record.manifest.id, version: record.manifest.version, status: record.status, updatedAt: record.updatedAt } }
        : { status: 404, body: { error: 'customer module version not found' } };
    }
    const match = request.path.match(/^\/enterprise\/(?:platform\/)?customer-modules\/([a-z0-9.-]+)\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/(submit|review|install|withdraw|suspend)$/u);
    if (!match || request.method !== 'POST') return { status: 404, body: { error: 'customer module route not found' } };
    const [, moduleId, version, action] = match;
    if (action === 'submit') return { status: 200, body: { module: market.submitForReview(request.actor.accountId, moduleId, version) } };
    if (action === 'withdraw') return { status: 200, body: { module: market.withdraw(request.actor.accountId, moduleId, version) } };
    if (action === 'install') {
      const receiptId = typeof request.body.receiptId === 'string' ? request.body.receiptId.trim() : '';
      if (!receiptId) return { status: 400, body: { error: 'receiptId is required' } };
      return { status: 200, body: { module: market.recordInstall(moduleId, version, receiptId) } };
    }
    if (!request.actor.isPlatformReviewer) return { status: 403, body: { error: 'platform reviewer required' } };
    if (action === 'suspend') return { status: 200, body: { module: market.suspend(moduleId, version) } };
    const decision = request.body.decision === 'approve' ? 'approve' : 'reject';
    const signature = decision === 'approve'
      ? options.signApprovedVersion?.(moduleId, version)
      : undefined;
    if (decision === 'approve' && !signature) {
      return { status: 503, body: { error: 'platform signing service unavailable' } };
    }
    return { status: 200, body: { module: market.review(request.actor.accountId, moduleId, version, decision, signature) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: /own|reviewer|approved/u.test(message) ? 403 : 400, body: { error: message } };
  }
}
