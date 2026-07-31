/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRepairFeishuSenderFromEnv,
  createRepairSmsSenderFromEnv,
} from './repairNotificationSenders.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('repair notification senders', () => {
  it('does not create external senders without complete server credentials', () => {
    vi.stubEnv('ALIYUN_SMS_ACCESS_KEY_ID', '');
    vi.stubEnv('ALIYUN_SMS_ACCESS_KEY_SECRET', '');
    vi.stubEnv('ALIYUN_SMS_SIGN_NAME', '');
    vi.stubEnv('ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID', '');
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_APP_ID', '');
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_APP_SECRET', '');

    expect(createRepairSmsSenderFromEnv()).toBeNull();
    expect(createRepairFeishuSenderFromEnv()).toBeNull();
  });

  it('rejects malformed Feishu recipients before making a network request', async () => {
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_APP_ID', 'app-id');
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_APP_SECRET', 'app-secret');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sender = createRepairFeishuSenderFromEnv();

    await expect(sender?.send('not-an-open-id', 'title', 'body')).resolves.toBe(
      false,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the configured Lark endpoint and sends a text message', async () => {
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_APP_ID', 'app-id');
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_APP_SECRET', 'app-secret');
    vi.stubEnv('OTTO_ENTERPRISE_FEISHU_DOMAIN', 'lark');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 0, data: { message_id: 'message-1' } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const sender = createRepairFeishuSenderFromEnv();

    await expect(sender?.send('ou_member-1', 'Repair', 'Ready')).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tenant-token',
        }),
      }),
    );
  });
});
