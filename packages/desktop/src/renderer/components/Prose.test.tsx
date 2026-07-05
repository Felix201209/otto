/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** Prose 轻量 Markdown 渲染单测：围栏代码块 / 行内代码 / 加粗 / 流式未闭合。 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
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

  it('GFM 表格 → <table> + thead/tbody + 列对齐', () => {
    const md = '| 名称 | 价格 |\n|:--|--:|\n| A | 10 |\n| B | 20 |';
    const { container } = render(<Prose text={md} />);
    expect(container.querySelector('table.otto-prose__table')).toBeTruthy();
    expect(container.querySelectorAll('thead th').length).toBe(2);
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
    // 末列分隔为 --: → 右对齐
    const ths = container.querySelectorAll('thead th');
    expect((ths[1] as HTMLElement).style.textAlign).toBe('right');
    expect(container.textContent).toContain('名称');
    expect(container.textContent).toContain('20');
  });

  it('段落后紧跟的表格也能识别（不被并进段落）', () => {
    const { container } = render(
      <Prose text={'下面是数据：\n| a | b |\n| - | - |\n| 1 | 2 |'} />,
    );
    expect(container.querySelector('table.otto-prose__table')).toBeTruthy();
    expect(container.querySelector('p.otto-prose__p')?.textContent).toContain(
      '下面是数据',
    );
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

  it('标题 # / ## / ### → <h1>–<h3>', () => {
    const { container } = render(
      <Prose text={'# 大标题\n## 中标题\n### 小标题'} />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('大标题');
    expect(container.querySelector('h2')?.textContent).toBe('中标题');
    expect(container.querySelector('h3')?.textContent).toBe('小标题');
  });

  it('无序列表 - / * / + → <ul><li>', () => {
    const { container } = render(<Prose text={'- 第一\n- 第二\n* 第三'} />);
    const lis = container.querySelectorAll('ul.otto-prose__ul li');
    expect(lis).toHaveLength(3);
    expect(lis[0].textContent).toBe('第一');
    expect(lis[2].textContent).toBe('第三');
  });

  it('有序列表 1. → <ol><li>，保留起始号', () => {
    const { container } = render(<Prose text={'2. 甲\n3. 乙'} />);
    const ol = container.querySelector('ol.otto-prose__ol');
    expect(ol?.getAttribute('start')).toBe('2');
    expect(ol?.querySelectorAll('li')).toHaveLength(2);
  });

  it('列表项内的加粗照常渲染（截图里"– **文件操作**"场景）', () => {
    const { container } = render(<Prose text={'- **文件操作** — 读写文件'} />);
    const li = container.querySelector('ul.otto-prose__ul li');
    expect(li?.querySelector('strong')?.textContent).toBe('文件操作');
    expect(li?.textContent).toContain('读写文件');
  });

  it('引用 > → <blockquote>', () => {
    const { container } = render(<Prose text={'> 一句引用'} />);
    expect(
      container.querySelector('blockquote.otto-prose__quote')?.textContent,
    ).toBe('一句引用');
  });

  it('水平线 --- → <hr>，前后正文保留', () => {
    const { container } = render(<Prose text={'上\n\n---\n\n下'} />);
    expect(container.querySelector('hr.otto-prose__hr')).toBeTruthy();
    expect(container.textContent).toContain('上');
    expect(container.textContent).toContain('下');
  });

  it('斜体 *x*（含中文）→ <em>', () => {
    const { container } = render(<Prose text={'这是 *斜体* 示例'} />);
    expect(container.querySelector('em')?.textContent).toBe('斜体');
  });

  it('代码块与列表混排：代码块不被块级解析吞', () => {
    const { container } = render(
      <Prose text={'- 项\n\n```js\nx\n```\n\n1. 甲'} />,
    );
    expect(container.querySelectorAll('.otto-code')).toHaveLength(1);
    expect(container.querySelector('ul.otto-prose__ul li')?.textContent).toBe(
      '项',
    );
    expect(container.querySelector('ol.otto-prose__ol li')?.textContent).toBe(
      '甲',
    );
  });

  // 每个用例后清掉注入到 window 的 otto 桩，避免相互污染。
  afterEach(() => {
    delete (window as unknown as { otto?: unknown }).otto;
    vi.restoreAllMocks();
  });

  it('[文本](url) → <a>，显示文本、href 指向 url', () => {
    const { container } = render(
      <Prose text={'见 [Otto 仓库](https://github.com/Felix201209/otto) 了解'} />,
    );
    const a = container.querySelector('a.otto-prose__link');
    expect(a?.textContent).toBe('Otto 仓库');
    expect(a?.getAttribute('href')).toBe('https://github.com/Felix201209/otto');
    // 链接前后正文保留。
    expect(container.textContent).toContain('见');
    expect(container.textContent).toContain('了解');
  });

  it('裸 http(s) URL 自动成链，文本与目标同为该 url', () => {
    const { container } = render(
      <Prose text={'文档在 https://example.com/docs 这里'} />,
    );
    const a = container.querySelector('a.otto-prose__link');
    expect(a?.textContent).toBe('https://example.com/docs');
    expect(a?.getAttribute('href')).toBe('https://example.com/docs');
  });

  it('裸 URL 末尾的中文标点不被吞进链接', () => {
    const { container } = render(
      <Prose text={'打开 https://example.com。然后关掉'} />,
    );
    const a = container.querySelector('a.otto-prose__link');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(container.textContent).toContain('。然后关掉');
  });

  it('点击链接走 window.otto.openExternal（系统浏览器），并阻止 app 内导航', () => {
    const openExternal = vi.fn(() => Promise.resolve());
    (window as unknown as { otto: { openExternal: typeof openExternal } }).otto =
      { openExternal };
    const { container } = render(
      <Prose text={'[链接](https://example.com/x)'} />,
    );
    const a = container.querySelector('a.otto-prose__link') as HTMLAnchorElement;
    // fireEvent.click 返回 false 表示某个 handler 调了 preventDefault（默认导航被拦）。
    const notPrevented = fireEvent.click(a);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/x');
    expect(notPrevented).toBe(false);
  });

  it('链接与加粗混排互不破坏', () => {
    const { container } = render(
      <Prose text={'**重点**：见 [这里](https://a.co)'} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('重点');
    expect(container.querySelector('a.otto-prose__link')?.textContent).toBe(
      '这里',
    );
  });

  it('代码块内的 URL 不被当链接渲染', () => {
    const { container } = render(
      <Prose text={'```\ncurl https://example.com\n```'} />,
    );
    expect(container.querySelector('a.otto-prose__link')).toBeNull();
    expect(container.querySelector('pre.otto-code__pre')?.textContent).toContain(
      'https://example.com',
    );
  });

  it('行内代码内的 URL 不被当链接渲染', () => {
    const { container } = render(
      <Prose text={'用 `https://example.com` 作示例'} />,
    );
    expect(container.querySelector('a.otto-prose__link')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(
      'https://example.com',
    );
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
