/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  EdgeGatewayAccessTokenError,
  requestEdgeGatewayAccessToken,
  type EdgeGatewayDeploymentCredentials,
} from '../modules/model_gateway/index.js';
import { loadEnterpriseModelCatalog } from '../modelCatalog.js';
import type { AccountView } from './db.js';

interface ModelGatewayRouteServices {
  getDeploymentEdgeGatewayCredentials(): EdgeGatewayDeploymentCredentials | null;
  logAudit(
    event: string,
    employeeId: string | null,
    message: string,
    organizationId: string,
  ): void;
}

export async function handleModelGatewayRoute(input: {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: AccountView | null;
  services: ModelGatewayRouteServices;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (
    input.path !== '/enterprise/model-gateway/access-token' ||
    input.method !== 'POST'
  ) {
    return false;
  }
  if (!input.memberAccount) {
    input.sendJSON(input.res, 401, { error: '登录已失效，请重新登录' });
    return true;
  }
  const body = await input.readBody(input.req);
  if (Object.keys(body).length > 0) {
    input.sendJSON(input.res, 400, {
      error: '模型网关凭据由服务器根据当前账号生成，不接受客户端参数',
      code: 'managed_model_request_invalid',
    });
    return true;
  }
  const credentials = input.services.getDeploymentEdgeGatewayCredentials();
  if (
    !credentials ||
    credentials.organizationId !== input.memberAccount.organizationId
  ) {
    input.sendJSON(input.res, 503, {
      error: '企业托管模型尚未完成授权或网关配置',
      code: 'managed_model_gateway_unavailable',
    });
    return true;
  }
  const allowedModels = loadEnterpriseModelCatalog().map((model) => model.id);
  try {
    const grant = await requestEdgeGatewayAccessToken({
      credentials,
      subjectId: input.memberAccount.id,
      allowedModels,
      fetchImpl: input.fetchImpl,
    });
    input.services.logAudit(
      'managed_model_gateway_token_issued',
      input.memberAccount.id,
      JSON.stringify({
        subjectId: input.memberAccount.id,
        modelCount: grant.allowedModels.length,
        expiresAt: new Date(grant.expiresAtMs).toISOString(),
      }),
      input.memberAccount.organizationId,
    );
    input.res.setHeader('Cache-Control', 'no-store');
    input.sendJSON(input.res, 201, {
      gateway: {
        baseUrl: grant.baseUrl,
        accessToken: grant.accessToken,
        expiresAt: new Date(grant.expiresAtMs).toISOString(),
        allowedModels: grant.allowedModels,
      },
    });
  } catch (error) {
    input.services.logAudit(
      'managed_model_gateway_token_failed',
      input.memberAccount.id,
      JSON.stringify({
        subjectId: input.memberAccount.id,
        reason:
          error instanceof EdgeGatewayAccessTokenError
            ? 'control_rejected'
            : 'internal_error',
      }),
      input.memberAccount.organizationId,
    );
    input.sendJSON(input.res, 503, {
      error: '企业托管模型网关暂不可用，请稍后重试',
      code: 'managed_model_gateway_unavailable',
    });
  }
  return true;
}
