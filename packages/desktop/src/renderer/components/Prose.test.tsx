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

  it('代码块内的 ``` 不作定界符：只按行首独占的 ``` 结束', () => {
    const { container } = render(
      <Prose
        text={'```markdown\n用 ```js\ncode\n``` 这样写代码块\n```\n后面正文'}
      />,
    );
    // 只有一个代码块，内嵌的 ``` 原样保留在代码内容里
    expect(container.querySelectorAll('.otto-code')).toHaveLength(1);
    expect(container.querySelector('.otto-code__lang')?.textContent).toBe(
      'markdown',
    );
    expect(container.querySelector('pre.otto-code__pre')?.textContent).toBe(
      '用 ```js\ncode\n``` 这样写代码块',
    );
    expect(container.textContent).toContain('后面正文');
  });

  it('行中间的 ``` 不当围栏，正文不被吞', () => {
    const { container } = render(<Prose text={'这是 ```code``` 的例子'} />);
    expect(container.querySelector('.otto-code')).toBeNull();
    expect(container.textContent).toContain('这是');
    expect(container.textContent).toContain('code');
    expect(container.textContent).toContain('的例子');
  });

  it('未闭合围栏按 GFM 算到文末', () => {
    const { container } = render(
      <Prose text={'```py\na = 1\n后面这些也算代码'} />,
    );
    expect(container.querySelector('pre.otto-code__pre')?.textContent).toBe(
      'a = 1\n后面这些也算代码',
    );
    expect(container.querySelector('.otto-code__lang')?.textContent).toBe('py');
  });

  it('``` 后无语言 → 默认标签 code', () => {
    const { container } = render(<Prose text={'```\nplain\n```'} />);
    expect(container.querySelector('.otto-code__lang')?.textContent).toBe(
      'code',
    );
    expect(container.querySelector('pre.otto-code__pre')?.textContent).toBe(
      'plain',
    );
  });

  it('代码块内的单/双反引号原样保留', () => {
    const { container } = render(
      <Prose text={'```md\n`inline` 和 ``double`` 原样\n```'} />,
    );
    expect(container.querySelector('pre.otto-code__pre')?.textContent).toBe(
      '`inline` 和 ``double`` 原样',
    );
  });

  it('结束行允许尾随空白', () => {
    const { container } = render(<Prose text={'```js\nx\n```   \n尾巴'} />);
    expect(container.querySelector('pre.otto-code__pre')?.textContent).toBe(
      'x',
    );
    expect(container.textContent).toContain('尾巴');
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
