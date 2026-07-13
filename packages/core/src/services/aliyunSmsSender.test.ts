/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AliyunSmsAuthenticationSender,
  AliyunSmsSender,
} from './aliyunSmsSender.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AliyunSmsSender', () => {
  it('send 透传 sendWithCode 的布尔发送结果', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ Code: 'OK', Message: 'OK', BizId: 'biz-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sender = new AliyunSmsSender({
      accessKeyId: 'id',
      accessKeySecret: 'secret',
      signName: 'Otto',
      templateId: 'SMS_1',
      endpoint: 'https://sms.example.test',
    });

    await expect(sender.send('13800138000', '园区报修', '空调故障')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendVerificationCode 使用默认验证码模板且只发送 code 变量', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ Code: 'OK', Message: 'OK', BizId: 'biz-code' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sender = new AliyunSmsSender({
      accessKeyId: 'id',
      accessKeySecret: 'secret',
      signName: 'Otto',
      templateId: 'SMS_336505228',
      endpoint: 'https://sms.example.test',
    });

    await expect(sender.sendVerificationCode('13800138000', '042731')).resolves.toBe(true);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    const params = new URL(requestUrl).searchParams;
    expect(params.get('TemplateCode')).toBe('SMS_336505228');
    expect(JSON.parse(params.get('TemplateParam') || '{}')).toEqual({ code: '042731' });
  });

  it('个人开发者短信认证使用 PNVS SendSmsVerifyCode 与系统签名模板', async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ Code: 'OK', Success: true, Model: { BizId: 'pnvs-biz' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sender = new AliyunSmsAuthenticationSender({
      accessKeyId: 'id',
      accessKeySecret: 'secret',
      signName: '速通互联验证码',
      templateId: '100001',
      endpoint: 'https://pnvs.example.test',
    });

    await expect(sender.sendVerificationCode('13800138000', '042731')).resolves.toBe(true);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    const params = new URL(requestUrl).searchParams;
    expect(params.get('Action')).toBe('SendSmsVerifyCode');
    expect(params.get('PhoneNumber')).toBe('13800138000');
    expect(params.get('PhoneNumbers')).toBeNull();
    expect(params.get('SignName')).toBe('速通互联验证码');
    expect(params.get('TemplateCode')).toBe('100001');
    expect(params.get('ValidTime')).toBe('300');
    expect(params.get('Timestamp')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(JSON.parse(params.get('TemplateParam') || '{}')).toEqual({ code: '042731', min: '5' });
  });
});
