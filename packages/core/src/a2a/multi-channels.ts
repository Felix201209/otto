import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ChannelType = 'wechat' | 'wecom' | 'dingtalk' | 'feishu';
export interface ChannelCredentials {
  appId: string; appSecret: string; agentId?: string;
  targetUsers?: string; targetTags?: string; targetParties?: string;
}
type Http = typeof fetch;
const labels: Record<ChannelType, string> = { wechat: '微信', wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书' };

export class MultiChannelGateway {
  private readonly connected = new Map<ChannelType, ChannelCredentials>();
  constructor(private readonly http: Http = fetch, private readonly userDir = process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user')) {}

  isChannelReady(channel: ChannelType): boolean { return this.connected.has(channel); }

  private async secretPath(channel: ChannelType) {
    const dir = path.join(this.userDir, 'secrets', 'multi-channel');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    return path.join(dir, `${channel}.json`);
  }

  private async save(channel: ChannelType, creds: ChannelCredentials) {
    const file = await this.secretPath(channel);
    await writeFile(file, `${JSON.stringify(creds)}\n`, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  }

  private async load(channel: ChannelType) {
    if (this.connected.has(channel)) return this.connected.get(channel)!;
    try { const value = JSON.parse(await readFile(await this.secretPath(channel), 'utf8')) as ChannelCredentials;
      this.connected.set(channel, value); return value; } catch { return null; }
  }

  async connectChannel(channel: ChannelType, creds: ChannelCredentials) {
    if (channel === 'wechat') return { success: false, message: '个人微信无官方开放的应用消息 API，未接入。' };
    if (channel === 'feishu') return { success: false, message: '飞书请使用独立飞书网关。' };
    try {
      if (channel === 'wecom') await this.wecomToken(creds);
      else await this.dingtalkToken(creds);
      await this.save(channel, creds); this.connected.set(channel, creds);
      return { success: true, message: `${labels[channel]}鉴权成功，凭证已安全保存。` };
    } catch (error) { return { success: false, message: `${labels[channel]}鉴权失败: ${(error as Error).message}` }; }
  }

  private async json(url: string, init?: RequestInit) {
    const response = await this.http(url, init); const body = await response.json() as Record<string, unknown>;
    if (!response.ok || Number(body.errcode ?? 0) !== 0) throw new Error(String(body.errmsg || body.message || `HTTP ${response.status}`));
    return body;
  }
  private async wecomToken(c: ChannelCredentials) { const b = await this.json(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(c.appId)}&corpsecret=${encodeURIComponent(c.appSecret)}`); const token = String(b.access_token || ''); if (!token) throw new Error('access_token missing'); return token; }
  private async dingtalkToken(c: ChannelCredentials) { const b = await this.json('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appKey: c.appId, appSecret: c.appSecret }) }); const token = String(b.accessToken || ''); if (!token) throw new Error('accessToken missing'); return token; }

  async broadcastUpdate(title: string, body: string): Promise<Record<ChannelType, boolean>> {
    const result = { feishu: false, wecom: false, dingtalk: false, wechat: false };
    for (const channel of ['wecom', 'dingtalk'] as const) {
      const c = await this.load(channel); if (!c) continue;
      try {
        if (channel === 'wecom') { const token = await this.wecomToken(c); await this.json(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ touser: c.targetUsers || '', toparty: c.targetParties || '', totag: c.targetTags || '', msgtype: 'text', agentid: Number(c.agentId), text: { content: `${title}\n${body}` }, safe: 0 }) }); }
        else { const token = await this.dingtalkToken(c); await this.json('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', { method: 'POST', headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token }, body: JSON.stringify({ robotCode: c.agentId || c.appId, userIds: (c.targetUsers || '').split(',').filter(Boolean), msgKey: 'sampleText', msgParam: JSON.stringify({ content: `${title}\n${body}` }) }) }); }
        result[channel] = true;
      } catch { result[channel] = false; }
    }
    return result;
  }
}
