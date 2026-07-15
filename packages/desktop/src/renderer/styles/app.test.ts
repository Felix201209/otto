/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 关键响应式 CSS 契约。Vitest/JSDOM 不执行 media query，因此直接检查源码，
 * 防止窄窗口登录主操作再次被大幅营销区压到首屏以下。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/styles/app.css'),
  'utf8',
);

function mediaBlock(maxWidth: number): string {
  const marker = `@media (max-width: ${maxWidth}px)`;
  const start = appCss.indexOf(marker);
  if (start < 0) return '';
  const open = appCss.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < appCss.length; index += 1) {
    if (appCss[index] === '{') depth += 1;
    if (appCss[index] === '}') depth -= 1;
    if (depth === 0) return appCss.slice(start, index + 1);
  }
  return '';
}

describe('桌面端窄窗口响应式契约', () => {
  it('960px 以下优先展示登录或注册表单', () => {
    const narrow = mediaBlock(960);
    expect(narrow).toMatch(/\.otto-auth-panel\s*\{[^}]*order:\s*-1/);
    expect(narrow).toMatch(/\.otto-auth-panel\s*\{[^}]*padding:\s*24px/);
  });
});
