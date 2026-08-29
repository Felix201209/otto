import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  CustomerModuleHostBroker,
  type CustomerModuleHostAdapterResult,
  type CustomerModuleHostAuditEvent,
} from 'otto-core';
import type { InstalledCustomerModuleRecord } from './customerModuleInstaller.js';

const STORAGE_KEY = /^[A-Za-z0-9_.-]{1,120}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,160}$/u;

interface ExternalWriteLedgerEntry {
  status: 'pending' | 'committed';
  capability: 'http' | 'file';
  fingerprint: string;
  response?: unknown;
  updatedAt: string;
}

async function readLedger(filePath: string): Promise<ExternalWriteLedgerEntry | null> {
  try { return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as ExternalWriteLedgerEntry; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function writeLedger(filePath: string, entry: ExternalWriteLedgerEntry): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
  await fs.promises.rename(temporary, filePath);
}

export function createDesktopCustomerModuleHost(input: {
  record: InstalledCustomerModuleRecord;
  storageRoot: string;
  fetchImpl?: typeof fetch;
  httpTimeoutMs?: number;
  selectReadFile?(): Promise<string | null>;
  selectWriteFile?(suggestedName: string): Promise<string | null>;
  modelInvoke?(payload: unknown, signal?: AbortSignal): Promise<CustomerModuleHostAdapterResult>;
  onAudit?(event: CustomerModuleHostAuditEvent): void;
}) {
  const permission = (kind: string) => input.record.permissions.find((item) => item.kind === kind);
  return new CustomerModuleHostBroker({
    onAudit: input.onAudit,
    invoke: async (request) => {
      const payload = request.payload && typeof request.payload === 'object'
        ? request.payload as Record<string, unknown> : {};
      if (request.capability === 'storage') {
        const key = typeof payload.key === 'string' ? payload.key : '';
        if (!STORAGE_KEY.test(key)) throw new Error('客户模块存储键不安全');
        const directory = path.join(input.storageRoot, encodeURIComponent(input.record.id));
        const target = path.join(directory, `${key}.json`);
        if (payload.operation === 'read') {
          try { return { data: JSON.parse(await fs.promises.readFile(target, 'utf8')) as unknown }; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: null }; throw error; }
        }
        const storagePermission = permission('storage');
        if (payload.operation !== 'write' || storagePermission?.kind !== 'storage' || storagePermission.access !== 'read-write') throw new Error('客户模块存储写入未授权');
        const body = JSON.stringify(payload.value);
        if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('客户模块存储值超过限制');
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try { await fs.promises.writeFile(temporary, body, { mode: 0o600 }); await fs.promises.rename(temporary, target); }
        finally { await fs.promises.rm(temporary, { force: true }).catch(() => undefined); }
        return { data: { written: true }, commitStatus: 'committed' };
      }
      if (request.capability === 'http') {
        const httpPermission = permission('http');
        if (!httpPermission || httpPermission.kind !== 'http') throw new Error('HTTP 未授权');
        const url = new URL(typeof payload.url === 'string' ? payload.url : '');
        if (url.protocol !== 'https:' || !httpPermission.hosts.includes(url.hostname)) throw new Error('HTTP 域名未授权');
        const method = typeof payload.method === 'string' ? payload.method.toUpperCase() : 'GET';
        const writes = !['GET', 'HEAD'].includes(method);
        if (writes && !httpPermission.writes) throw new Error('HTTP 写操作未授权');
        if (writes && (!request.externalWrite || !request.idempotencyKey)) throw new Error('HTTP 写操作必须声明外部写入并提供幂等键');
        if (request.idempotencyKey && !IDEMPOTENCY_KEY.test(request.idempotencyKey)) throw new Error('HTTP 幂等键格式不正确');
        const ledgerPath = writes && request.idempotencyKey
          ? path.join(input.storageRoot, '..', 'operations', encodeURIComponent(input.record.id), `${encodeURIComponent(request.idempotencyKey)}.json`)
          : null;
        const fingerprint = createHash('sha256').update(JSON.stringify({ method, url: url.toString(), body: typeof payload.body === 'string' ? payload.body : '' })).digest('hex');
        const previous = ledgerPath ? await readLedger(ledgerPath) : null;
        if (previous && previous.fingerprint !== fingerprint) throw new Error('HTTP 幂等键已用于不同的外部写操作');
        if (previous?.status === 'committed') return { data: previous.response, provider: url.hostname, commitStatus: 'recovered', retryCount: 0 };
        if (ledgerPath) await writeLedger(ledgerPath, { status: 'pending', capability: 'http', fingerprint, updatedAt: new Date().toISOString() });
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        request.signal?.addEventListener('abort', cancel, { once: true });
        if (request.signal?.aborted) controller.abort();
        const timer = setTimeout(() => controller.abort(), input.httpTimeoutMs ?? 15_000);
        try {
          const response = await (input.fetchImpl ?? fetch)(url, {
            method,
            redirect: 'error',
            signal: controller.signal,
            ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
            headers: {
              'content-type': 'application/json',
              'x-otto-module': input.record.id,
              ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
            },
          });
          const text = await response.text();
          if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('HTTP 响应超过限制');
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = { status: response.status, body: text };
          if (ledgerPath) await writeLedger(ledgerPath, { status: 'committed', capability: 'http', fingerprint, response: data, updatedAt: new Date().toISOString() });
          return { data, provider: url.hostname, retryCount: previous?.status === 'pending' ? 1 : 0, commitStatus: writes ? previous?.status === 'pending' ? 'recovered' : 'committed' : 'not-applicable' };
        } finally { clearTimeout(timer); request.signal?.removeEventListener('abort', cancel); }
      }
      if (request.capability === 'file') {
        const filePermission = permission('file');
        if (!filePermission || filePermission.kind !== 'file') throw new Error('文件访问未授权');
        if (payload.operation === 'read') {
          if (filePermission.access !== 'user-selected-read') throw new Error('文件读取未授权');
          const selected = await input.selectReadFile?.();
          if (!selected) throw new Error('用户取消了文件读取');
          const body = await fs.promises.readFile(selected);
          if (body.byteLength > 16 * 1024 * 1024) throw new Error('所选文件超过限制');
          return { data: { name: path.basename(selected), base64: body.toString('base64') } };
        }
        if (filePermission.access !== 'user-selected-write') throw new Error('文件写入未授权');
        if (!request.externalWrite || !request.idempotencyKey) throw new Error('文件写入必须声明外部写入并提供幂等键');
        if (!IDEMPOTENCY_KEY.test(request.idempotencyKey)) throw new Error('文件写入幂等键格式不正确');
        const encoded = typeof payload.base64 === 'string' ? payload.base64 : '';
        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error('文件写入内容不是有效 base64');
        const body = Buffer.from(encoded, 'base64');
        if (body.byteLength > 16 * 1024 * 1024) throw new Error('文件写入内容超过限制');
        const suggestedName = typeof payload.name === 'string' ? path.basename(payload.name) : 'module-output.bin';
        const fingerprint = createHash('sha256').update(suggestedName).update(body).digest('hex');
        const ledgerPath = path.join(input.storageRoot, '..', 'operations', encodeURIComponent(input.record.id), `${encodeURIComponent(request.idempotencyKey)}.json`);
        const previous = await readLedger(ledgerPath);
        if (previous && (previous.capability !== 'file' || previous.fingerprint !== fingerprint)) throw new Error('文件幂等键已用于不同的外部写操作');
        if (previous?.status === 'committed') return { data: previous.response, commitStatus: 'recovered' };
        await writeLedger(ledgerPath, { status: 'pending', capability: 'file', fingerprint, updatedAt: new Date().toISOString() });
        const selected = await input.selectWriteFile?.(suggestedName);
        if (!selected) throw new Error('用户取消了文件写入');
        await fs.promises.writeFile(selected, body);
        const data = { written: true };
        await writeLedger(ledgerPath, { status: 'committed', capability: 'file', fingerprint, response: data, updatedAt: new Date().toISOString() });
        return { data, retryCount: previous?.status === 'pending' ? 1 : 0, commitStatus: previous?.status === 'pending' ? 'recovered' : 'committed' };
      }
      if (request.capability === 'model' && input.modelInvoke) return input.modelInvoke(request.payload, request.signal);
      throw new Error(`客户模块能力适配器不可用：${request.capability}`);
    },
  });
}
