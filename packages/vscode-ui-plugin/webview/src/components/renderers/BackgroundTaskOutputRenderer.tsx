/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import './BackgroundTaskOutputRenderer.css';

interface BackgroundTaskOutputRendererProps {
  data: {
    data: string | { output: string; taskId: string };
    toolName: string;
    taskId?: string;
    [key: string]: any;
  };
}

export const BackgroundTaskOutputRenderer: React.FC<BackgroundTaskOutputRendererProps> = ({ data }) => {
  // 🎯 鲁棒的数据解析逻辑
  let output = '';

  if (typeof data === 'string') {
    output = data;
  } else if (data && typeof data === 'object') {
    // 优先取 data.data (如果是 result 对象)
    if (typeof data.data === 'string') {
      output = data.data;
    } else if (data.data && typeof data.data === 'object') {
      output = (data.data as any).output || '';
    } else if ((data as any).output) {
      // 兼容直接包含 output 的情况
      output = (data as any).output;
    }
  }

  // 🎯 强制撑开 100% 宽度，并进一步微调字号和行高
  const terminalStyle = {
    whiteSpace: 'pre' as const,
    overflowX: 'auto' as const,
    overflowY: 'auto' as const,
    wordBreak: 'normal' as const,
    wordWrap: 'normal' as const,
    maxWidth: '100%', // 🎯 改为 maxWidth
    boxSizing: 'border-box' as const,
    display: 'block',
    margin: 0,
    padding: 0
    // 🎯 移除 fontSize 和 lineHeight，完全继承 ToolCalls.css 中的 .compact-json-result 定义 (11px)
  };

  return (
    <pre className="compact-json-result" style={terminalStyle}>
      {output.trimEnd()} {/* 🎯 去除尾部换行符 */}
    </pre>
  );
};
