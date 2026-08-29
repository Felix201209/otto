import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopCustomerModuleHost } from './customerModuleHostAdapter.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true }))));

const record = {
  id: 'com.acme.host', version: '1.0.0', name: 'Host', description: 'Host', enabled: true,
  backgroundEnabled: false,
  installedAt: '', artifactPath: '', iconDataUrl: '', receiptId: 'r', receiptStatus: 'committed' as const,
  permissions: [
    { kind: 'storage' as const, access: 'read-write' as const },
    { kind: 'http' as const, hosts: ['api.acme.test'], writes: false },
  ],
  manifest: {} as never,
};

describe('desktop customer module host adapter', () => {
  it('isolates storage by module and persists only approved writes', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-storage-')); roots.push(root);
    const host = createDesktopCustomerModuleHost({ record, storageRoot: root });
    await host.request({ moduleId: record.id, version: record.version, capability: 'storage', approvedCapabilities: ['storage'], externalWrite: true, idempotencyKey: 'write-1', payload: { operation: 'write', key: 'state', value: { ok: true } } });
    const result = await host.request({ moduleId: record.id, version: record.version, capability: 'storage', approvedCapabilities: ['storage'], payload: { operation: 'read', key: 'state' } });
    expect(result.data).toEqual({ ok: true });
  });

  it('allows only declared HTTPS hosts and does not follow redirects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const host = createDesktopCustomerModuleHost({ record, storageRoot: '', fetchImpl });
    await host.request({ moduleId: record.id, version: record.version, capability: 'http', approvedCapabilities: ['http'], payload: { url: 'https://api.acme.test/data' } });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
    await expect(host.request({ moduleId: record.id, version: record.version, capability: 'http', approvedCapabilities: ['http'], payload: { url: 'https://evil.test' } })).rejects.toThrow(/域名/);
  });

  it('rejects HTTP writes that try to bypass idempotency metadata', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-http-ledger-')); roots.push(root);
    const writable = { ...record, permissions: [{ kind: 'http' as const, hosts: ['api.acme.test'], writes: true }] };
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
    const host = createDesktopCustomerModuleHost({ record: writable, storageRoot: path.join(root, 'data'), fetchImpl });
    await expect(host.request({ moduleId: record.id, version: record.version, capability: 'http', approvedCapabilities: ['http'], payload: { url: 'https://api.acme.test/data', method: 'POST' } })).rejects.toThrow(/幂等键/);
    await host.request({ moduleId: record.id, version: record.version, capability: 'http', approvedCapabilities: ['http'], externalWrite: true, idempotencyKey: 'module-write-1', payload: { url: 'https://api.acme.test/data', method: 'POST' } });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: expect.objectContaining({ 'idempotency-key': 'module-write-1' }) }));
    const recovered = await host.request({ moduleId: record.id, version: record.version, capability: 'http', approvedCapabilities: ['http'], externalWrite: true, idempotencyKey: 'module-write-1', payload: { url: 'https://api.acme.test/data', method: 'POST' } });
    expect(recovered.commitStatus).toBe('recovered');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps file writes user-selected and resumes by operation instead of rerunning the module', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-module-file-ledger-')); roots.push(root);
    const target = path.join(root, 'output.txt');
    const writable = { ...record, permissions: [{ kind: 'file' as const, access: 'user-selected-write' as const }] };
    const selectWriteFile = vi.fn().mockResolvedValue(target);
    const host = createDesktopCustomerModuleHost({ record: writable, storageRoot: path.join(root, 'data'), selectWriteFile });
    const request = { moduleId: record.id, version: record.version, capability: 'file' as const, approvedCapabilities: ['file' as const], externalWrite: true, idempotencyKey: 'file-write-1', payload: { operation: 'write', name: 'output.txt', base64: Buffer.from('ok').toString('base64') } };
    await host.request(request);
    expect(await fs.promises.readFile(target, 'utf8')).toBe('ok');
    expect((await host.request(request)).commitStatus).toBe('recovered');
    expect(selectWriteFile).toHaveBeenCalledTimes(1);
  });

  it('surfaces 429/5xx and timeout failures without retrying a whole run', async () => {
    const httpOnly = { ...record, permissions: [{ kind: 'http' as const, hosts: ['api.acme.test'], writes: false }] };
    const request = { moduleId: record.id, version: record.version, capability: 'http' as const, approvedCapabilities: ['http' as const], payload: { url: 'https://api.acme.test/data' } };
    for (const status of [429, 503]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('failed', { status }));
      const host = createDesktopCustomerModuleHost({ record: httpOnly, storageRoot: '', fetchImpl });
      await expect(host.request(request)).rejects.toThrow(`HTTP ${status}`);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const host = createDesktopCustomerModuleHost({ record: httpOnly, storageRoot: '', fetchImpl: fetchImpl as typeof fetch, httpTimeoutMs: 5 });
    await expect(host.request(request)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
