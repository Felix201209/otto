/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** Prose 轻量 Markdown 渲染单测：围栏代码块 / 行内代码 / 加粗 / 流式未闭合。 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Prose, contentToText } from './Prose.js';

describe('Prose 轻量 Markdown', () => {
  it('围栏代码块 → <pre> + 语言标签 + 复制按钮，前后正文分离', () => {
    const { container } = render(
      <Prose text={'前言\n```python\nprint("hi")\n```\n后语'} />,
    );
    const pre = container.querySelector('pre.otto-code__pre');
    expect(pre?.textContent).toContain('print("hi")');
    expect(container.querySelector('.otto-code__lang')?.textContent).toBe(
      'python',
    );
    expect(container.querySelector('.otto-code__copy')).toBeTruthy();
    expect(container.textContent).toContain('前言');
    expect(container.textContent).toContain('后语');
  });

  it('行内代码 `x` 与加粗 **x**', () => {
    const { container } = render(<Prose text={'用 `npm i` 装，**重要**'} />);
    // 无代码块时的 <code> 即行内代码
    expect(container.querySelector('code')?.textContent).toBe('npm i');
    expect(container.querySelector('strong')?.textContent).toBe('重要');
  });

  it('流式未闭合的围栏也按代码块渲染（不漏字）', () => {
    const { container } = render(<Prose text={'```js\nconst a = 1'} />);
    const pre = container.querySelector('pre.otto-code__pre');
    expect(pre?.textContent).toContain('const a = 1');
    expect(container.querySelector('.otto-code__lang')?.textContent).toBe('js');
  });

  it('无标记纯文本原样渲染 + 流式光标', () => {
    const { container } = render(<Prose text="只是一段普通文本" streaming />);
    expect(container.textContent).toContain('只是一段普通文本');
    expect(container.querySelector('.otto-caret')).toBeTruthy();
  });

  it('contentToText 折叠片段为纯文本', () => {
    expect(
      contentToText([
        { type: 'text', value: 'a' },
        { type: 'text', value: 'b' },
      ]),
    ).toBe('ab');
  });
});
