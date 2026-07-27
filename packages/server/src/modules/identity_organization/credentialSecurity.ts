/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  '12345678',
  '123456789',
  'qwerty123',
]);

export function hashIdentitySecret(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const digest = scryptSync(secret, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

export function identitySecretMatches(secret: string, stored: string): boolean {
  const [salt, expectedHex, ...unexpected] = stored.split(':');
  if (!salt || !expectedHex || unexpected.length > 0) return false;
  try {
    const actual = scryptSync(secret, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  } catch {
    return false;
  }
}

export function assertAccountPassword(password: string): void {
  if (password.length < 8) throw new Error('登录密码至少需要 8 位');
  if (password.length > 128) throw new Error('登录密码不能超过 128 位');
  if (/[^\x20-\x7E]/.test(password)) {
    throw new Error('登录密码不能包含控制字符或不可见字符');
  }
  const lower = password.toLocaleLowerCase('en-US');
  if (COMMON_PASSWORDS.has(lower)) {
    throw new Error('登录密码过于常见，请更换更安全的密码');
  }
  if (/^\d+$/.test(password) || /^[a-z]+$/i.test(password)) {
    throw new Error('登录密码不能只包含数字或字母');
  }
  if (/^(.)\1{7,}$/.test(password)) {
    throw new Error('登录密码不能使用连续重复字符');
  }
}

export function isAcceptableAccountPassword(password: string): boolean {
  try {
    assertAccountPassword(password);
    return true;
  } catch {
    return false;
  }
}
