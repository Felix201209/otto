/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Control 网络端点 / HTTP 传输（CONTROL-12）——把调度器/处理器接到真实 HTTP 请求。
 *
 * 端点：
 *  - POST /control/v1/commands        Control 下发签名指令 → 校验 + 入队，返回接受结果
 *  - GET  /control/v1/commands/poll   Control 长轮询：服务端主动领取并执行一条
 *  - GET  /control/v1/receipts?commandId=...  响应丢失恢复：查询既有签名回执
 *  - POST /control/v1/outbox/tick     触发一次 outbox 投递（把已执行指令的回执投给 Control）
 *  - GET  /control/v1/outbox/status   运维查看 outbox/queue 状态
 *
 * 纯路由分发：本模块只做 HTTP 映射，业务逻辑委托给注入的 services，便于单元测试
 * （注入 fake services / readBody / sendJSON）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlCommandEnvelope } from './controlCommandEnvelope.js';
import type { ControlCommandReceipt } from './controlCommandReceipt.js';
import type { ControlCommandScheduler } from './controlCommandScheduler.js';

export type ControlSubmitResult =
  | { kind: 'accepted'; commandId: string; status: string; replayed: boolean }
  | { kind: 'invalid_signature'; keyId: string | null }
  | { kind: 'rejected'; code: string; reason?: string };

export interface ControlCommandRouteServices {
  /** 提交一条指令：校验签名 + 字段 + 入队。返回接受或失败分类。 */
  submit(envelope: ControlCommandEnvelope): ControlSubmitResult;
  /** 主动领取并执行一条；返回是否执行了。 */
  drainOnce(): { executed: boolean };
  /** 投递一批已完成的回执。 */
  flushOutbox(targetNow?: number): { delivered: number; recovered: number };
  /** 查询既有回执（响应丢失恢复）。 */
  queryReceipt(commandId: string): ControlCommandReceipt | null;
  /** 触发一次崩溃恢复。 */
  recoverOutbox(): { recovered: number };
  /** 运维状态。 */
  summarize(): Record<string, unknown>;
}

export interface ControlCommandRouteDeps {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  services: ControlCommandRouteServices;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function isEnvelopeShape(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 从请求体解析信封；字段缺失/类型错误返回 null。 */
export function parseEnvelope(body: Record<string, unknown>): ControlCommandEnvelope | null {
  if (!isEnvelopeShape(body)) return null;
  const need = [
    'commandId', 'deploymentId', 'type', 'schemaVersion', 'sequence',
    'issuedAt', 'expiresAt', 'payloadDigest', 'signature',
  ];
  for (const k of need) {
    if (body[k] === undefined) return null;
  }
  if (typeof body.commandId !== 'string' || typeof body.deploymentId !== 'string') return null;
  if (typeof body.type !== 'string' || typeof body.schemaVersion !== 'number') return null;
  if (typeof body.sequence !== 'number' || typeof body.issuedAt !== 'string') return null;
  if (typeof body.expiresAt !== 'string' || typeof body.payloadDigest !== 'string') return null;
  if (typeof body.signature !== 'string') return null;
  if (!isEnvelopeShape(body.payload)) return null;
  return {
    commandId: body.commandId,
    deploymentId: body.deploymentId,
    type: body.type as ControlCommandEnvelope['type'],
    schemaVersion: body.schemaVersion,
    sequence: body.sequence,
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
    idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
    payloadDigest: body.payloadDigest,
    payload: body.payload as Record<string, unknown>,
    signature: body.signature,
  };
}

/**
 * Control HTTP 路由分发器。返回 true 表示已处理。
 */
export async function handleControlCommandRoute({
  path,
  method,
  req,
  res,
  url,
  services,
  readBody,
  sendJSON,
}: ControlCommandRouteDeps): Promise<boolean> {
  // POST /control/v1/commands —— Control 下发签名指令
  if (path === '/control/v1/commands' && method === 'POST') {
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const envelope = parseEnvelope(body);
    if (!envelope) {
      sendJSON(res, 400, { error: 'malformed_command', reason: 'envelope fields missing or invalid' });
      return true;
    }
    const result = services.submit(envelope);
    if (result.kind === 'accepted') {
      sendJSON(res, 201, {
        commandId: result.commandId,
        status: result.status,
        replayed: result.replayed,
      });
    } else if (result.kind === 'invalid_signature') {
      sendJSON(res, 401, { error: 'invalid_signature', keyId: result.keyId });
    } else {
      sendJSON(res, 422, { error: result.code, reason: result.reason });
    }
    return true;
  }

  // GET /control/v1/commands/poll —— 长轮询：主动领取并执行一条
  if (path === '/control/v1/commands/poll' && method === 'GET') {
    const r = services.drainOnce();
    sendJSON(res, 200, { executed: r.executed });
    return true;
  }

  // GET /control/v1/receipts?commandId=... —— 响应丢失恢复
  if (path === '/control/v1/receipts' && method === 'GET') {
    const commandId = url.searchParams.get('commandId');
    if (!commandId) {
      sendJSON(res, 400, { error: 'missing_commandId' });
      return true;
    }
    const receipt = services.queryReceipt(commandId);
    if (!receipt) {
      sendJSON(res, 404, { error: 'no_receipt', reason: 'command not in terminal state' });
      return true;
    }
    sendJSON(res, 200, receipt);
    return true;
  }

  // POST /control/v1/outbox/tick —— 触发一次回执投递
  if (path === '/control/v1/outbox/tick' && method === 'POST') {
    const r = services.flushOutbox();
    sendJSON(res, 200, r);
    return true;
  }

  // GET /control/v1/outbox/status —— 运维状态
  if (path === '/control/v1/outbox/status' && method === 'GET') {
    sendJSON(res, 200, services.summarize());
    return true;
  }

  return false;
}

/**
 * 把 processor（校验+入队）与 scheduler（领取+执行+投递）适配为路由 services，
 * 便于 HTTP 层直接挂载。
 */
export function createControlHttpServices(input: {
  submit(envelope: ControlCommandEnvelope): ControlSubmitResult;
  scheduler: ControlCommandScheduler;
  queryReceipt(commandId: string): ControlCommandReceipt | null;
  summarize(): Record<string, unknown>;
}): ControlCommandRouteServices {
  return {
    submit: input.submit,
    drainOnce: () => input.scheduler.drainOnce(),
    flushOutbox: (t) => input.scheduler.flushOutbox(t),
    queryReceipt: input.queryReceipt,
    recoverOutbox: () => input.scheduler.recoverOutbox(),
    summarize: input.summarize,
  };
}
