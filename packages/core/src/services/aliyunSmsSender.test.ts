/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AliyunSmsSender } from './aliyunSmsSender.js';

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
});
