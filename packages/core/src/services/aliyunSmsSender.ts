/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Aliyun SMS Sender — 阿里云短信服务
 *
 * 文档: https://help.aliyun.com/zh/sms/
 *
 * 使用方式：
 *   1. 阿里云控制台 → 短信服务 → 申请签名 + 模板
 *   2. 获取 AccessKeyId / AccessKeySecret
 *   3. 在 .env 中配置:
 *      ALIYUN_SMS_ACCESS_KEY_ID=xxx
 *      ALIYUN_SMS_ACCESS_KEY_SECRET=xxx
 *      ALIYUN_SMS_SIGN_NAME=宏创园区
 *      ALIYUN_SMS_TEMPLATE_ID=SMS_123456789
 */

import crypto from 'node:crypto';
import type { SmsNotifySender } from './notificationService.js';

/** 阿里云短信发送参数 */
export interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;          // 短信签名
  templateId: string;        // 模板CODE
  /** 短信API域名（默认国内） */
  endpoint?: string;
}

/** 阿里云API通用参数 */
function buildAliyunSignature(
  params: Record<string, string>,
  secret: string,
  method: string = 'POST',
): string {
  // 1. 按key排序
  const sortedKeys = Object.keys(params).sort();
  // 2. 拼规范请求串
  const canonicalQuery = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  // 3. 拼签名字符串
  const stringToSign = `${method}&${encodeURIComponent('/')}&${encodeURIComponent(canonicalQuery)}`;
  // 4. HMAC-SHA1签名
  const hmac = crypto.createHmac('sha1', `${secret}&`);
  hmac.update(stringToSign);
  return Buffer.from(hmac.digest()).toString('base64');
}

/** 阿里云短信发送结果 */
export interface SmsSendResult {
  success: boolean;
  bizId?: string;
  code?: string;
  message?: string;
}

export class AliyunSmsSender implements SmsNotifySender {
  readonly channel = 'sms' as const;

  private config: AliyunSmsConfig;
  private endpoint: string;

  constructor(config: AliyunSmsConfig) {
    this.config = config;
    this.endpoint = config.endpoint || 'https://dysmsapi.aliyuncs.com';
  }

  /**
   * 发送通知短信。
   *
   * @param phone 手机号（11位）
   * @param title 标题（会作为模板变量传入）
   * @param body 正文（会作为模板变量传入）
   */
  async send(phone: string, title: string, body: string): Promise<boolean> {
    const result = await this.sendWithCode(phone, this.config.templateId, {
      title: title.slice(0, 20),
      body: body.slice(0, 100),
    });
    return result.success;
  }

  /**
   * 使用模板发送短信（支持模板变量）。
   *
   * @param phone 目标手机号
   * @param templateId 模板CODE
   * @param params 模板变量
   */
  async sendWithCode(
    phone: string,
    templateId: string,
    params: Record<string, string>,
  ): Promise<boolean> {
    try {
      const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
      const nonce = crypto.randomUUID().replace(/-/g, '');

      const queryParams: Record<string, string> = {
        AccessKeyId: this.config.accessKeyId,
        Action: 'SendSms',
        Format: 'JSON',
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        SignatureNonce: nonce,
        Timestamp: timestamp,
        Version: '2017-05-25',
        PhoneNumbers: phone,
        SignName: this.config.signName,
        TemplateCode: templateId,
        TemplateParam: JSON.stringify(params),
      };

      const signature = buildAliyunSignature(queryParams, this.config.accessKeySecret);
      queryParams.Signature = signature;

      // 构建 query string
      const qs = Object.entries(queryParams)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const resp = await fetch(`${this.endpoint}/?${qs}`, { method: 'POST' });
      const data = await resp.json() as { Code: string; Message: string; BizId?: string };

      if (data.Code === 'OK') {
        console.log(`[AliyunSms] 发送成功: ${phone}, BizId=${data.BizId}`);
        return true;
      }

      console.warn(`[AliyunSms] 发送失败: ${phone}, Code=${data.Code}, Message=${data.Message}`);
      return false;
    } catch (err) {
      console.error(`[AliyunSms] 发送异常: ${phone}, ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

/**
 * 从环境变量创建默认的阿里云短信发送器。
 * 必须在 .env 中设置 ALIYUN_SMS_* 系列变量。
 */
export function createAliyunSmsFromEnv(): AliyunSmsSender | null {
  const accessKeyId = process.env.ALIYUN_SMS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET;
  const signName = process.env.ALIYUN_SMS_SIGN_NAME;
  const templateId = process.env.ALIYUN_SMS_TEMPLATE_ID;

  if (!accessKeyId || !accessKeySecret || !signName || !templateId) {
    console.warn('[AliyunSms] 缺少环境变量，短信通道不可用。需要: ALIYUN_SMS_ACCESS_KEY_ID, ALIYUN_SMS_ACCESS_KEY_SECRET, ALIYUN_SMS_SIGN_NAME, ALIYUN_SMS_TEMPLATE_ID');
    return null;
  }

  return new AliyunSmsSender({
    accessKeyId,
    accessKeySecret,
    signName,
    templateId,
  });
}
