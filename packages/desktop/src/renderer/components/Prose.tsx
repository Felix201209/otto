/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 轻量正文渲染（零额外依赖，不引 react-markdown —— 与渲染层「独立可编译、无重依赖」
 * 的设计一致）。渐进增强地支持对编程助手最要紧的几种 Markdown：
 *   - 围栏代码块 ```lang …```：等宽 <pre>，带语言标签 + 一键复制（编程场景高频）。
 *   - 行内代码 `x`：等宽浅底 <code>。
 *   - 加粗 **x**：<strong>。
 *   - 保留换行（white-space: pre-wrap）。
 * 其余 Markdown 语法暂按纯文本原样显示（表格/列表/标题等为后续增强点）。
 * 流式友好：末尾未闭合的 ``` 也按「进行中的代码块」渲染，不会漏字或错位。
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

// ── 分段：把正文切成「代码块」与「普通文本」交替的段 ──

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

// ── 行内：代码 `x` 与加粗 **x** ──

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(<code key={`${keyPrefix}-c-${key++}`}>{m[1].slice(1, -1)}</code>);
    } else if (m[2]) {
      nodes.push(
        <strong key={`${keyPrefix}-b-${key++}`}>{m[2].slice(2, -2)}</strong>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
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

/** 渲染正文：代码块 + 含行内代码/加粗的文本段，保留换行；流式时带闪烁光标。 */
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
          <span className="otto-prose__text" key={`s-${i}`}>
            {renderInline(seg.value, `s-${i}`)}
          </span>
        ),
      )}
      {streaming ? <span className="otto-caret" aria-hidden /> : null}
    </div>
  );
}
