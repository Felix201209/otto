/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 园区报修的真实外部通知通道。企业服务端只认服务器环境变量，不读取桌面端
 * renderer 配置，避免把 App Secret 暴露给普通成员设备。
 */

import { AliyunSmsSender } from 'otto-core';

export interface RepairNotificationSender {
  readonly channel: 'sms' | 'feishu';
  send(recipientId: string, title: string, body: string): Promise<boolean>;
}

export function createRepairSmsSenderFromEnv(): RepairNotificationSender | null {
  const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim();
  const signName = process.env.ALIYUN_SMS_SIGN_NAME?.trim();
  const templateId = process.env.ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID?.trim();
  if (!accessKeyId || !accessKeySecret || !signName || !templateId) return null;
  const sender = new AliyunSmsSender({ accessKeyId, accessKeySecret, signName, templateId });
  return {
    channel: 'sms',
    async send(recipientId, title, body) {
      return sender.send(recipientId.replace(/^\+86/, ''), title, body);
    },
  };
}

interface FeishuTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuMessageResponse {
  code?: number;
  msg?: string;
  data?: { message_id?: string };
}

class EnterpriseFeishuSender implements RepairNotificationSender {
  readonly channel = 'feishu' as const;
  private token = '';
  private tokenExpiresAt = 0;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async tenantToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      },
    );
    const data = await response.json() as FeishuTokenResponse;
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
      throw new Error(data.msg || `飞书令牌接口返回 ${response.status}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, data.expire ?? 7200) * 1000;
    return this.token;
  }

  async send(openId: string, title: string, body: string): Promise<boolean> {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) return false;
    try {
      const token = await this.tenantToken();
      const response = await this.fetchImpl(
        `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            receive_id: openId,
            msg_type: 'text',
            content: JSON.stringify({ text: `${title}\n${body}` }),
          }),
        },
      );
      const data = await response.json() as FeishuMessageResponse;
      return response.ok && data.code === 0 && Boolean(data.data?.message_id);
    } catch (error) {
      console.warn('[otto-enterprise] 园区报修飞书通知失败:', error instanceof Error ? error.message : error);
      return false;
    }
  }
}

export function createRepairFeishuSenderFromEnv(): RepairNotificationSender | null {
  const appId = process.env.OTTO_ENTERPRISE_FEISHU_APP_ID?.trim();
  const appSecret = process.env.OTTO_ENTERPRISE_FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  const domain = process.env.OTTO_ENTERPRISE_FEISHU_DOMAIN?.trim().toLowerCase();
  const apiBaseUrl = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  return new EnterpriseFeishuSender(appId, appSecret, apiBaseUrl);
}
