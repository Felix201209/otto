/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * CONTROL-12 边界模块——把签名指令队列全套接入单个 db + Control 信任根配置。
 *
 * 这是 server.ts 挂载 CONTROL-12 端点的入口：给定 db + 信任根公钥配置，
 * 构建 processor（校验+入队）→ scheduler（领取+执行+投递）→ HTTP services，
 * 暴露一个 `handleRoute` 供企业服务端路由分发器调用。
 *
 * 信任根密钥按「部署时配置」注入（默认读环境变量 OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS），
 * 与 license/telemetry 的配置模式一致。未配置信任根时 fail closed（不挂载端点），
 * 不提供任何人工导入或默认凭据静默降级。
 */

import type { Database } from '../data_platform/index.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlCommandEnvelope } from './controlCommandEnvelope.js';
import {
  createControlCommandProcessor,
  type ControlCommandProcessor,
} from './controlCommandComposition.js';
import type { ControlCommandScheduler } from './controlCommandScheduler.js';
import { createControlCommandScheduler } from './controlCommandScheduler.js';
import {
  createControlHttpServices,
  handleControlCommandRoute,
  type ControlCommandRouteServices,
  type ControlSubmitResult,
} from './controlCommandHttp.js';
import { queryControlCommandReceipt } from './controlCommandReceiptQuery.js';
import { summarizeOutboxInRepository } from './controlCommandOutbox.js';
import { verifyControlCommandSignature } from './controlCommandSignature.js';
import { parsePublicKeyList } from '../commercial_control/signedEnvelope.js';

export interface ControlCommandBoundaryDeps {
  db(): Database;
  /** 本 Server 的部署 ID（信封部署绑定校验必需）。 */
  deploymentId: string;
  /** 可注入时钟（ms epoch）。 */
  now?(): number;
  /** Control 信任根公钥（PEM 列表）。未提供则 fail closed。 */
  controlPublicKeys?: string[];
  /** 签发回执的部署签名私钥（PEM，可选；不填则回执只含 digest）。 */
  signingPrivateKey?: string;
  /** 执行企业开通/业务指令的钩子（对接 SERVER-16 原子开通）。 */
  execute(command: ControlCommandEnvelope): ControlCommandRunResultShim;
  /** 领取租约时长（ms），默认 30s。 */
  leaseMs?: number;
  /** outbox 投递批量，默认 10。 */
  outboxBatchSize?: number;
  /** outbox 最大投递尝试，默认 5。 */
  outboxMaxAttempts?: number;
  /** outbox 指数退避基数（ms），默认 1000。 */
  outboxBackoffBaseMs?: number;
  /** outbox 崩溃恢复阈值（ms），默认 60s。 */
  outboxStaleAfterMs?: number;
}

/** 与 scheduler 的 ControlCommandRunResult 对齐（避免循环依赖）。 */
export interface ControlCommandRunResultShim {
  status: 'succeeded' | 'failed' | 'unknown_outcome' | 'expired' | 'cancelled';
  resultSummary: string;
  resourceId?: string;
  errorCategory?: string;
}

export interface ControlCommandBoundary {
  /** 是否已启用（配置了信任根公钥）。未启用时为 null 且不挂载端点。 */
  enabled: boolean;
  /** 信任根公钥 ID 列表（运维可见）。 */
  publicKeyIds: string[];
  /** HTTP 路由分发器（注入 server 路由）。返回 true 表示已处理。 */
  handleRoute(deps: {
    path: string;
    method: string;
    url: URL;
    req: IncomingMessage;
    res: ServerResponse;
    readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
    sendJSON(res: ServerResponse, status: number, data: unknown): void;
  }): Promise<boolean>;
  /** 露出的 services（供测试/内部使用）。 */
  services: ControlCommandRouteServices;
  /** 直接投递一条指令（供非 HTTP 通道 / 测试使用）。 */
  submit(envelope: ControlCommandEnvelope): ControlSubmitResult;
}

/** 从环境变量解析 Control 信任根公钥；未配置返回空数组。 */
export function controlPublicKeysFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return parsePublicKeyList(
    env.OTTO_ENTERPRISE_CONTROL_PUBLIC_KEYS || '',
    env.OTTO_ENTERPRISE_CONTROL_REVOKED_KEY_IDS,
  );
}

/**
 * 构建 CONTROL-12 边界。未配置信任根公钥时返回 enabled=false（fail closed），
 * 不提供任何静默降级或默认凭据。
 */
export function createControlCommandBoundary(
  deps: ControlCommandBoundaryDeps,
): ControlCommandBoundary {
  const now = deps.now ?? (() => Date.now());
  const keys = deps.controlPublicKeys ?? [];
  const enabled = keys.length > 0;

  // 未配置 → fail closed 空边界（不执行、不挂载）。
  if (!enabled) {
    const disabled: ControlCommandBoundary = {
      enabled: false,
      publicKeyIds: [],
      handleRoute: () => Promise.resolve(false),
      services: {
        submit: () => ({ kind: 'rejected', code: 'not_configured', reason: 'Control trust root not configured' }),
        drainOnce: () => ({ executed: false }),
        flushOutbox: () => ({ delivered: 0, recovered: 0 }),
        queryReceipt: () => null,
        recoverOutbox: () => ({ recovered: 0 }),
        summarize: () => ({ control: 'disabled' }),
      },
      submit: () => ({ kind: 'rejected', code: 'not_configured', reason: 'Control trust root not configured' }),
    };
    return disabled;
  }

  const store = { db: deps.db, now };
  const executeShim = (command: ControlCommandEnvelope) =>
    deps.execute(command) as ControlCommandRunResultShim;

  const processor: ControlCommandProcessor = createControlCommandProcessor({
    db: deps.db,
    now,
    deploymentId: deps.deploymentId,
    verifyControlSignature: (e) => verifyControlCommandSignature(e, keys),
    execute: executeShim,
    signingPrivateKey: deps.signingPrivateKey,
  });

  const scheduler: ControlCommandScheduler = createControlCommandScheduler({
    queue: store,
    outbox: store,
    now,
    execute: executeShim,
    signingPrivateKey: deps.signingPrivateKey,
    leaseMs: deps.leaseMs,
    outboxBatchSize: deps.outboxBatchSize,
    outboxMaxAttempts: deps.outboxMaxAttempts,
    outboxBackoffBaseMs: deps.outboxBackoffBaseMs,
    outboxStaleAfterMs: deps.outboxStaleAfterMs,
  });

  const submit = (envelope: ControlCommandEnvelope): ControlSubmitResult => {
    const sig = verifyControlCommandSignature(envelope, keys);
    if (!sig.valid) return { kind: 'invalid_signature', keyId: sig.keyId };
    const result = processor.ingest(envelope);
    if (result instanceof Promise) {
      // ingest 的可选异步路径不应在 CONTROL-12 边界出现；同步兜底为 rejected。
      return { kind: 'rejected', code: 'async_ingest_unsupported' };
    }
    if ('error' in result) {
      return { kind: 'rejected', code: result.error };
    }
    return {
      kind: 'accepted',
      commandId: result.receipt.commandId,
      status: result.receipt.status,
      replayed: result.receipt.resultSummary === 'replayed',
    };
  };

  const queryReceipt = (commandId: string) =>
    queryControlCommandReceipt(store, commandId, deps.signingPrivateKey);

  const summarize = () => {
    const outbox = summarizeOutboxInRepository(store);
    const pending = deps.db().prepare(
      "SELECT COUNT(*) AS c FROM control_command_queue WHERE status = 'accepted'",
    ).get() as { c: number };
    return { enabled: true, outbox, pendingCommands: pending.c };
  };

  const services: ControlCommandRouteServices = createControlHttpServices({
    submit,
    scheduler,
    queryReceipt,
    summarize,
  });

  const handleRoute: ControlCommandBoundary['handleRoute'] = (deps2) =>
    handleControlCommandRoute({
      path: deps2.path,
      method: deps2.method,
      req: deps2.req,
      res: deps2.res,
      url: deps2.url,
      services,
      readBody: deps2.readBody,
      sendJSON: deps2.sendJSON,
    });

  return {
    enabled: true,
    publicKeyIds: keys.map((k) => {
      const m = /BEGIN PUBLIC KEY[\s\S]*?([A-Za-z0-9+/=]{16})[\s\S]*?\n-----END/.exec(k);
      return m ? m[1] : '(unknown)';
    }),
    handleRoute,
    services,
    submit,
  };
}
