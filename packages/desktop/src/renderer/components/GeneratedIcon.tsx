/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import expertCopywriting from '../assets/generated-icons/expert-copywriting.png';
import expertDataviz from '../assets/generated-icons/expert-dataviz.png';
import expertDocument from '../assets/generated-icons/expert-document.png';
import expertMeeting from '../assets/generated-icons/expert-meeting.png';
import expertPdf from '../assets/generated-icons/expert-pdf.png';
import expertPresentation from '../assets/generated-icons/expert-presentation.png';
import expertResearch from '../assets/generated-icons/expert-research.png';
import expertSpreadsheet from '../assets/generated-icons/expert-spreadsheet.png';
import statusError from '../assets/generated-icons/status-error.png';
import statusSuccess from '../assets/generated-icons/status-success.png';
import statusSync from '../assets/generated-icons/status-sync.png';
import statusUpdate from '../assets/generated-icons/status-update.png';
import statusWarning from '../assets/generated-icons/status-warning.png';
import styleAntigravity from '../assets/generated-icons/style-antigravity.png';
import styleAugment from '../assets/generated-icons/style-augment.png';
import styleClaudeCode from '../assets/generated-icons/style-claude-code.png';
import styleCodex from '../assets/generated-icons/style-codex.png';
import styleCursor from '../assets/generated-icons/style-cursor.png';
import styleDefault from '../assets/generated-icons/style-default.png';
import styleWindsurf from '../assets/generated-icons/style-windsurf.png';

const GENERATED_ICON_URLS = {
  'expert-presentation': expertPresentation,
  'expert-meeting': expertMeeting,
  'expert-document': expertDocument,
  'expert-spreadsheet': expertSpreadsheet,
  'expert-pdf': expertPdf,
  'expert-dataviz': expertDataviz,
  'expert-research': expertResearch,
  'expert-copywriting': expertCopywriting,
  'style-default': styleDefault,
  'style-codex': styleCodex,
  'style-cursor': styleCursor,
  'style-augment': styleAugment,
  'style-claude-code': styleClaudeCode,
  'style-antigravity': styleAntigravity,
  'style-windsurf': styleWindsurf,
  'status-success': statusSuccess,
  'status-warning': statusWarning,
  'status-sync': statusSync,
  'status-error': statusError,
  'status-update': statusUpdate,
} as const;

export type GeneratedIconName = keyof typeof GENERATED_ICON_URLS;

export const GENERATED_ICON_NAMES = Object.freeze(
  Object.keys(GENERATED_ICON_URLS) as GeneratedIconName[],
);

interface GeneratedIconProps {
  name: GeneratedIconName;
  size?: number;
  className?: string;
  alt?: string;
}

/**
 * Codex 内置 imagegen 生成的 Otto 刺绣图标。
 * 默认纯装饰；只有显式传入 alt 时才进入无障碍树。
 */
export function GeneratedIcon({
  name,
  size = 20,
  className,
  alt = '',
}: GeneratedIconProps): React.JSX.Element {
  return (
    <img
      src={GENERATED_ICON_URLS[name]}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={['otto-generated-icon', className].filter(Boolean).join(' ')}
      draggable={false}
      decoding="async"
    />
  );
}
