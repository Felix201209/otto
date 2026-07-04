/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 轻量正文渲染（零额外依赖，不引 react-markdown —— 与渲染层「独立可编译、无重依赖」
 * 的设计一致）。手写解析器，覆盖聊天里最常见的 Markdown：
 *   - 围栏代码块 ```lang …```：等宽 <pre>，带语言标签 + 一键复制。
 *   - 标题 # … ######：<h1>–<h6>。
 *   - 无序列表 - / * / +、有序列表 1. 2. 3.：<ul>/<ol>。
 *   - 引用块 > …：<blockquote>。
 *   - 水平线 --- / *** / ___：<hr>。
 *   - 行内：代码 `x`、加粗 **x**、斜体 *x* / _x_。
 * 表格暂按纯文本原样显示（宽表格在窄窗口/移动端渲染差，作为后续增强点）。
 * 流式友好：末尾未闭合的 ``` 也按「进行中的代码块」渲染，不漏字/错位。
 */

import React, { useEffect, useRef, useState } from 'react';
import type { MessageContentPart } from 'otto-server';
import { IconCopy, IconCheck } from './icons.js';

/** 把内容片段折叠为纯文本（非 text 片段给出可读占位）。 */
export function contentToText(content: MessageContentPart[]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.value;
        case 'file_reference':
          return `@${part.value.fileName}`;
        case 'folder_reference':
          return `@${part.value.folderName}/`;
        case 'image_reference':
          return `[图片 ${part.value.fileName}]`;
        case 'code_reference':
          return `\`${part.value.fileName}\``;
        case 'text_file_content':
          return part.value.fileName;
        default:
          return '';
      }
    })
    .join('');
}

// ── 第一层分段：把正文切成「代码块」与「普通文本」交替的段 ──

interface Segment {
  type: 'code' | 'text';
  lang?: string;
  value: string;
}

/** 围栏开启行：``` 位于行首，其余为语言信息串（GFM：信息串不含反引号）。 */
const FENCE_OPEN = /^```([^`]*)$/;
/** 围栏结束行：``` 位于行首且独占一行（允许尾随空白）。 */
const FENCE_CLOSE = /^```\s*$/;

/**
 * 按行扫描解析围栏代码块（标准 Markdown 语义）：
 *   - 开启/结束定界符必须位于行首；结束行独占一行（允许尾随空白）。
 *   - 行中间出现的 ``` 一律当普通文本/代码内容，不作定界符。
 *   - 未闭合的围栏按 GFM 行为算到文末（流式期间自然呈现为进行中的代码块）。
 */
function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let textBuf: string[] = [];
  let codeBuf: string[] | null = null;
  let lang: string | undefined;

  const flushText = (): void => {
    const value = textBuf.join('\n');
    if (value) segments.push({ type: 'text', value });
    textBuf = [];
  };

  for (const line of text.split('\n')) {
    if (codeBuf === null) {
      const m = FENCE_OPEN.exec(line);
      if (m) {
        flushText();
        lang = m[1].trim() || undefined;
        codeBuf = [];
      } else {
        textBuf.push(line);
      }
    } else if (FENCE_CLOSE.test(line)) {
      segments.push({ type: 'code', lang, value: codeBuf.join('\n') });
      codeBuf = null;
    } else {
      codeBuf.push(line);
    }
  }
  if (codeBuf !== null) {
    segments.push({ type: 'code', lang, value: codeBuf.join('\n') });
  } else {
    flushText();
  }
  return segments;
}

// ── 第二层：把「普通文本」段解析为块级元素（标题/列表/引用/水平线/段落）──

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'para'; text: string };

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*(\d+)\.\s+(.*)$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;

/** 把一个普通文本段按行解析成块级元素。空行分隔段落；同类连续行合并成列表/引用。 */
function parseBlocks(value: string): Block[] {
  const blocks: Block[] = [];
  const lines = value.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }
    const h = RE_HEADING.exec(line);
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }
    if (RE_UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && RE_UL.test(lines[i])) {
        items.push(RE_UL.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }
    const firstOl = RE_OL.exec(line);
    if (firstOl) {
      const items: string[] = [];
      const start = Number(firstOl[1]) || 1;
      while (i < lines.length && RE_OL.test(lines[i])) {
        items.push(RE_OL.exec(lines[i])![2]);
        i++;
      }
      blocks.push({ kind: 'ol', items, start });
      continue;
    }
    if (RE_QUOTE.test(line)) {
      const qs: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        qs.push(RE_QUOTE.exec(lines[i])![1]);
        i++;
      }
      blocks.push({ kind: 'quote', text: qs.join('\n') });
      continue;
    }
    // 普通段落：收集连续的非空、非块级起始行。
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        RE_HR.test(l) ||
        RE_HEADING.test(l) ||
        RE_UL.test(l) ||
        RE_OL.test(l) ||
        RE_QUOTE.test(l)
      ) {
        break;
      }
      para.push(l);
      i++;
    }
    blocks.push({ kind: 'para', text: para.join('\n') });
  }
  return blocks;
}

// ── 行内：代码 `x`、链接 [t](url) / 裸 URL、加粗 **x**、斜体 *x* / _x_ ──
// 顺序要紧（同一起点上左侧 alternation 优先）：
//   1. `` 代码：代码里的 [x](y) / http 不当链接，整段先吞掉。
//   2. [文本](http…) markdown 链接：优先于裸 URL，避免其 url 段被裸 URL 抢先。
//   3. 裸 http(s) URL：末尾不含常见中英文标点（避免把「。」「)」等吞进链接）。
//   4. ** 加粗 → 单 * / _ 斜体：** 先于单 * 匹配，避免被拆成两个 *。
// 组号：m[1]=code，m[2..3]=[文本](url) 的文本/url，m[4]=裸 url，m[5]=bold，m[6]=* 斜体，m[7]=_ 斜体。
const INLINE =
  /(`[^`\n]+`)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()[\]，。！？；：、）】》「」""'']+)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)/g;

/** 外链点击：阻止 app 内导航，改用系统浏览器打开（openExternal 已由 preload 暴露）。 */
function onExternalLink(
  e: React.MouseEvent<HTMLAnchorElement>,
  url: string,
): void {
  e.preventDefault();
  void window.otto?.openExternal?.(url);
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(
        <code key={`${keyPrefix}-c-${key++}`}>{m[1].slice(1, -1)}</code>,
      );
    } else if (m[2] !== undefined && m[3] !== undefined) {
      // [文本](url)：显示文本、跳目标 url。
      const url = m[3];
      nodes.push(
        <a
          key={`${keyPrefix}-l-${key++}`}
          className="otto-prose__link"
          href={url}
          onClick={(e) => onExternalLink(e, url)}
        >
          {m[2]}
        </a>,
      );
    } else if (m[4]) {
      // 裸 URL：文本与目标同为该 url。
      const url = m[4];
      nodes.push(
        <a
          key={`${keyPrefix}-a-${key++}`}
          className="otto-prose__link"
          href={url}
          onClick={(e) => onExternalLink(e, url)}
        >
          {url}
        </a>,
      );
    } else if (m[5]) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${key++}`}>{m[5].slice(2, -2)}</strong>,
      );
    } else if (m[6]) {
      nodes.push(<em key={`${keyPrefix}-i-${key++}`}>{m[6].slice(1, -1)}</em>);
    } else if (m[7]) {
      nodes.push(<em key={`${keyPrefix}-u-${key++}`}>{m[7].slice(1, -1)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** 渲染一个普通文本段的块级元素。 */
function renderTextSegment(value: string, keyPrefix: string): React.ReactNode[] {
  return parseBlocks(value).map((b, i) => {
    const k = `${keyPrefix}-b${i}`;
    switch (b.kind) {
      case 'hr':
        return <hr className="otto-prose__hr" key={k} />;
      case 'heading': {
        const Tag = `h${b.level}` as keyof React.JSX.IntrinsicElements;
        return (
          <Tag className="otto-prose__h" key={k}>
            {renderInline(b.text, k)}
          </Tag>
        );
      }
      case 'ul':
        return (
          <ul className="otto-prose__ul" key={k}>
            {b.items.map((it, j) => (
              <li key={`${k}-${j}`}>{renderInline(it, `${k}-${j}`)}</li>
            ))}
          </ul>
        );
      case 'ol':
        return (
          <ol className="otto-prose__ol" start={b.start} key={k}>
            {b.items.map((it, j) => (
              <li key={`${k}-${j}`}>{renderInline(it, `${k}-${j}`)}</li>
            ))}
          </ol>
        );
      case 'quote':
        return (
          <blockquote className="otto-prose__quote" key={k}>
            {renderInline(b.text, k)}
          </blockquote>
        );
      default:
        return (
          <p className="otto-prose__p" key={k}>
            {renderInline(b.text, k)}
          </p>
        );
    }
  });
}

/** 围栏代码块：语言标签 + 复制按钮 + 等宽预格式化正文。 */
function CodeBlock({
  lang,
  value,
}: {
  lang?: string;
  value: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = (): void => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="otto-code">
      <div className="otto-code__head">
        <span className="otto-code__lang">{lang ?? 'code'}</span>
        <button
          type="button"
          className="otto-code__copy"
          onClick={copy}
          aria-label={copied ? '已复制' : '复制代码'}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="otto-code__pre">
        <code>{value}</code>
      </pre>
    </div>
  );
}

/** 渲染正文：代码块 + 块级文本（标题/列表/引用/段落）；流式时带闪烁光标。 */
export function Prose({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}): React.JSX.Element {
  const segments = parseSegments(text);
  return (
    <div className="otto-prose">
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={`s-${i}`} lang={seg.lang} value={seg.value} />
        ) : (
          <React.Fragment key={`s-${i}`}>
            {renderTextSegment(seg.value, `s-${i}`)}
          </React.Fragment>
        ),
      )}
      {streaming ? <span className="otto-caret" aria-hidden /> : null}
    </div>
  );
}
