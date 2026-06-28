/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 极简正文渲染：把 MessageContentPart 拼成纯文本，并把行内代码 `xxx` 渲染为
 * <code>（spec：收尾正文带行内代码 validateLoginInput 用等宽+浅灰底）。
 *
 * 故意不引 react-markdown（webview 的重依赖）—— 渲染层零额外依赖独立可编译。
 * 后续要全 Markdown 渲染时可在此替换实现，调用方不变。
 */

import React from 'react';
import type { MessageContentPart } from 'otto-server';

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

const INLINE_CODE = /`([^`]+)`/g;

/** 渲染含行内代码的纯文本段落。 */
export function Prose({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}): React.JSX.Element {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  INLINE_CODE.lastIndex = 0;
  while ((match = INLINE_CODE.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    nodes.push(<code key={`c-${key++}`}>{match[1]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));

  return (
    <div className="otto-prose">
      {nodes}
      {streaming ? <span className="otto-caret" aria-hidden /> : null}
    </div>
  );
}
