/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  EnterpriseRegistrationIntentStore,
  parseEnterpriseRegistrationIntent,
} from './enterprise-registration-intent.js';

describe('企业注册链接安全解析', () => {
  it('只接受 exact otto://enterprise/join，并规范化邀请码', () => {
    expect(parseEnterpriseRegistrationIntent(
      'otto://enterprise/join?invite=abcd-efgh',
    )).toEqual({
      inviteCode: 'ABCD-EFGH',
    });
  });

  it.each([
    'otto://enterprise/register?invite=ABCD-EFGH',
    'otto://other/join?invite=ABCD-EFGH',
    'otto://enterprise/join?token=signed&key=public',
    'otto://enterprise/join?invite=BAD',
    'otto://enterprise/join?invite=ABCI-EFGH',
    'otto://user:pass@enterprise/join?invite=ABCD-EFGH',
    'otto://enterprise:123/join?invite=ABCD-EFGH',
    'otto://enterprise/join?invite=ABCD-EFGH&server=https%3A%2F%2Fenterprise.otto.test',
    'otto://enterprise/join?invite=ABCD-EFGH&extra=1',
    'otto://enterprise/join?invite=ABCD-EFGH&invite=WXYZ-2345',
    'otto://enterprise/join?invite=ABCD-EFGH#fragment',
  ])('拒绝非中心注册链接、旧签名链接或可疑参数：%s', (url) => {
    expect(parseEnterpriseRegistrationIntent(url)).toBeNull();
  });
});

describe('企业注册 intent 缓存', () => {
  it('cold-start argv 能缓存有效链接并由 renderer 一次性取走', () => {
    const store = new EnterpriseRegistrationIntentStore();
    expect(store.acceptArgv([
      '/Applications/Otto.app/Contents/MacOS/Otto',
      '--flag',
      'otto://enterprise/join?invite=ABCD-EFGH',
    ])).toBe(true);
    expect(store.take()).toEqual({
      inviteCode: 'ABCD-EFGH',
    });
    expect(store.take()).toBeNull();
  });

  it('无效 second-instance 参数不会覆盖已缓存的有效 intent', () => {
    const store = new EnterpriseRegistrationIntentStore();
    store.acceptUrl(
      'otto://enterprise/join?invite=ABCD-EFGH',
    );
    expect(store.acceptArgv(['otto://enterprise/join?token=signed&key=public'])).toBe(false);
    expect(store.take()?.inviteCode).toBe('ABCD-EFGH');
  });
});
