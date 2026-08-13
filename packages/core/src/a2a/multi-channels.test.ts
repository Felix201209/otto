import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MultiChannelGateway } from './multi-channels.js';

describe('MultiChannelGateway', () => {
  it('authenticates and sends WeCom messages', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'channels-'));
    const http = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: 't' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, access_token: 't' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0 })));
    try { const gateway = new MultiChannelGateway(http, dir); expect((await gateway.connectChannel('wecom', { appId: 'corp', appSecret: 'secret', agentId: '1', targetUsers: 'u1' })).success).toBe(true); expect((await gateway.broadcastUpdate('T', 'B')).wecom).toBe(true); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('fails loudly on authentication error and stays unconfigured', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'channels-'));
    try { const gateway = new MultiChannelGateway(vi.fn().mockResolvedValue(new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corp' }))), dir); const result = await gateway.connectChannel('wecom', { appId: 'bad', appSecret: 'bad' }); expect(result.success).toBe(false); expect(result.message).toContain('invalid corp'); expect(gateway.isChannelReady('wecom')).toBe(false); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports unconfigured delivery as false', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'channels-')); try { expect((await new MultiChannelGateway(vi.fn(), dir).broadcastUpdate('T', 'B')).dingtalk).toBe(false); } finally { await rm(dir, { recursive: true, force: true }); } });
});
