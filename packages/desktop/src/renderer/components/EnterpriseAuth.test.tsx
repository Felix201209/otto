/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  advanceTypewriterFrame,
  isSmsLoginReady,
  sanitizeSmsCode,
} from './EnterpriseLoginPage.js';

describe('企业短信登录输入规则', () => {
  it('只保留前 6 位数字，且挑战和完整验证码同时存在时才允许提交', () => {
    expect(sanitizeSmsCode('04a27 319')).toBe('042731');
    expect(isSmsLoginReady('', '042731')).toBe(false);
    expect(isSmsLoginReady('sms_1', '04273')).toBe(false);
    expect(isSmsLoginReady('sms_1', '042731')).toBe(true);
  });
});

describe('登录页能力打字机', () => {
  it('逐字输入、停留、删除并切换到下一条能力', () => {
    const phrases = ['写代码', '跑自动化'];

    expect(advanceTypewriterFrame({ phraseIndex: 0, charIndex: 2, deleting: false }, phrases))
      .toEqual({ phraseIndex: 0, charIndex: 3, deleting: false });
    expect(advanceTypewriterFrame({ phraseIndex: 0, charIndex: 3, deleting: false }, phrases))
      .toEqual({ phraseIndex: 0, charIndex: 3, deleting: true });
    expect(advanceTypewriterFrame({ phraseIndex: 0, charIndex: 0, deleting: true }, phrases))
      .toEqual({ phraseIndex: 1, charIndex: 0, deleting: false });
  });
});
