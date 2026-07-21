/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** 来源徽章：Feishu（蓝青 + 花瓣）/ Local（绿 + 方块勾）。spec §左侧栏 4。 */

import React from 'react';
import type { MessageSource } from 'otto-server';
import { IconFeishuPetal, IconLocalMark } from './icons.js';

export function SourceBadge({
  source,
}: {
  source: MessageSource;
}): React.JSX.Element {
  if (source === 'feishu') {
    return (
      <span className="otto-badge otto-badge--feishu">
        <IconFeishuPetal size={11} />
        飞书
      </span>
    );
  }
  if (source === 'atoa') {
    return (
      <span className="otto-badge otto-badge--atoa">
        <IconLocalMark size={11} />
        企业协作
      </span>
    );
  }
  if (source === 'enterprise') {
    return (
      <span className="otto-badge otto-badge--enterprise">
        <IconLocalMark size={11} />
        企业通知
      </span>
    );
  }
  if (source === 'park') {
    return (
      <span className="otto-badge otto-badge--park">
        <IconLocalMark size={11} />
        园区服务
      </span>
    );
  }
  // 'local' 与 'tui' 都按本地展示（TUI 只读会话视作本地来源）。
  return (
    <span className="otto-badge otto-badge--local">
      <IconLocalMark size={11} />
      本地
    </span>
  );
}
