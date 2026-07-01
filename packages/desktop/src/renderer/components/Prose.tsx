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

/** 匹配闭合的围栏代码块：```lang\n…``` */
const FENCE = /```([^\n`]*)\n?([\s\S]*?)```/g;

function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', value: text.slice(last, m.index) });
    }
    segments.push({ type: 'code', lang: m[1].trim() || undefined, value: m[2] });
    last = m.index + m[0].length;
  }
  // 处理剩余部分：流式期间可能有「已开头但未闭合」的代码块。
  const rest = text.slice(last);
  const open = rest.indexOf('```');
  if (open >= 0) {
    if (open > 0) segments.push({ type: 'text', value: rest.slice(0, open) });
    const after = rest.slice(open + 3);
    const nl = after.indexOf('\n');
    const lang = (nl >= 0 ? after.slice(0, nl) : after).trim();
    const body = nl >= 0 ? after.slice(nl + 1) : '';
    segments.push({ type: 'code', lang: lang || undefined, value: body });
  } else if (rest.length > 0) {
    segments.push({ type: 'text', value: rest });
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
