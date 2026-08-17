/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import { handleModelGatewayRoute } from './modelGatewayRoutes.js';

const member = {
  id: 'account-1',
  organizationId: 'org-1',
} as never;

const credentials = {
  licenseId: 'license-1',
  deploymentId: 'deployment-1',
  organizationId: 'org-1',
  machineFingerprint: 'a'.repeat(64),
  leaseToken: 'lease-token-at-least-thirty-two-characters',
  leaseEndpoint: 'https://control.otto.test/v1/licenses/lease',
  edgeGatewayUrl: 'https://edge.otto.test',
};

function harness(input: {
  body?: Record<string, unknown>;
  currentCredentials?: typeof credentials | null;
  fetchImpl?: typeof fetch;
} = {}) {
  const sendJSON = vi.fn();
  const logAudit = vi.fn();
  const res = { setHeader: vi.fn() } as unknown as ServerResponse;
  return {
    sendJSON,
    logAudit,
    res,
    run: () =>
      handleModelGatewayRoute({
        path: '/enterprise/model-gateway/access-token',
        method: 'POST',
        req: {} as IncomingMessage,
        res,
        memberAccount: member,
        services: {
          getDeploymentEdgeGatewayCredentials: () =>
            input.currentCredentials === undefined
              ? credentials
              : input.currentCredentials,
          logAudit,
        },
        readBody: async () => input.body ?? {},
        sendJSON,
        fetchImpl: input.fetchImpl,
      }),
  };
}

describe('enterprise managed model gateway route', () => {
  it('derives account and model bindings on the server and returns only a short Edge token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const now = Date.now();
      const envelope = {
        token: {
          version: 1,
          tokenId: 'edge-token-1',
          deploymentId: body.deploymentId,
          organizationId: body.organizationId,
          subjectId: body.subjectId,
          scope: 'model_gateway',
          policyVersion: 'policy-v1',
          allowedModels: body.allowedModels,
          issuedAtMs: now,
          expiresAtMs: now + 5 * 60_000,
        },
        signingKeyId: 'signing-key-1',
        signature: `ed25519:${'A'.repeat(86)}`,
      };
      return new Response(
        JSON.stringify({
          envelope,
          encodedToken: Buffer.from(JSON.stringify(envelope)).toString(
            'base64url',
          ),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const test = harness({ fetchImpl });

    await expect(test.run()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const controlBody = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body),
    );
    expect(controlBody).toMatchObject({
      organizationId: 'org-1',
      subjectId: 'account-1',
    });
    expect(controlBody.allowedModels).toContain('otto:deepseek');
    expect(test.sendJSON).toHaveBeenCalledWith(
      test.res,
      201,
      expect.objectContaining({
        gateway: expect.objectContaining({
          baseUrl: 'https://edge.otto.test/v1',
          allowedModels: expect.arrayContaining(['otto:deepseek']),
        }),
      }),
    );
    expect(JSON.stringify(test.logAudit.mock.calls)).not.toContain(
      credentials.leaseToken,
    );
    expect(test.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('fails closed when deployment credentials are unavailable', async () => {
    const fetchImpl = vi.fn();
    const test = harness({ currentCredentials: null, fetchImpl });

    await test.run();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(test.sendJSON).toHaveBeenCalledWith(test.res, 503, {
      error: '企业托管模型尚未完成授权或网关配置',
      code: 'managed_model_gateway_unavailable',
    });
  });

  it('rejects client-selected models or endpoints', async () => {
    const test = harness({ body: { allowedModels: ['attacker-model'] } });

    await test.run();
    expect(test.sendJSON).toHaveBeenCalledWith(
      test.res,
      400,
      expect.objectContaining({ code: 'managed_model_request_invalid' }),
    );
  });
});

