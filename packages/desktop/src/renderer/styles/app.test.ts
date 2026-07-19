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

describe('工作日志日历样式契约', () => {
  it('重置日期按钮，并让最后一行的明细弹层向上展开', () => {
    const dayRule = appCss.match(/\.otto-wcal__day\s*\{([^}]*)\}/)?.[1] ?? '';
    const gridRule = appCss.match(/\.otto-wcal__grid\s*\{([^}]*)\}/)?.[1] ?? '';
    const popRule = appCss.match(/\.otto-wcal__pop\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(dayRule).toMatch(/border:\s*0/);
    expect(dayRule).toMatch(/background:\s*transparent/);
    expect(dayRule).toMatch(/padding:\s*0/);
    expect(dayRule).toMatch(/cursor:\s*pointer/);
    expect(gridRule).toMatch(/--otto-wcal-gap:\s*2px/);
    expect(gridRule).toMatch(/--otto-wcal-popover-width:\s*min\(240px,\s*calc\(100vw\s*-\s*32px\)\)/);
    expect(popRule).toMatch(/width:\s*var\(--otto-wcal-popover-width\)/);
    expect(appCss).toContain(
      '.otto-wcal__day:nth-last-child(-n+7) .otto-wcal__pop',
    );
    expect(appCss).toContain('.otto-wcal__day.is-pop-left .otto-wcal__pop');
    expect(appCss).toContain('.otto-wcal__day.is-pop-right .otto-wcal__pop');
    expect(appCss).toContain('.otto-wcal__day.is-pop-col-5 .otto-wcal__pop');
  });
});

describe('附件类型封面样式契约', () => {
  it('封面缩写不会继承集合容器的零号字体', () => {
    const coverRule = appCss.match(
      /\.otto-attachment__type-icon::before\s*\{([^}]*)\}/,
    )?.[1] ?? '';

    expect(coverRule).toMatch(/display:\s*block/);
    expect(coverRule).toMatch(/font:\s*700\s+8px\/1/);
  });
});
