/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 自带 SVG 图标集 —— 故意不引 lucide-react，让渲染层零额外依赖、独立可编译。
 * 全部用 currentColor，跟随父级文字色，hover 态由 CSS 控制。
 * Otto 头像是简洁吉祥物占位（spec：先用 SVG，Felix 后续替换）。
 */

import React from 'react';
import ottoAvatarUrl from '../assets/otto-avatar.png';

type IconProps = { size?: number; className?: string; strokeWidth?: number };

function base(size = 16): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export function IconCompose({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function IconPlus({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** 智能体/机器人：带天线的方脑袋 + 双眼 + 两侧耳，作「智能体」入口图标。 */
export function IconAgent({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 4.5V8" />
      <circle cx="12" cy="4" r="1.1" />
      <path d="M9.2 13h.01M14.8 13h.01" />
      <path d="M2.5 12.5v3M21.5 12.5v3" />
    </svg>
  );
}

export function IconList({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function IconChevron({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function IconChevronDown({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** 文件（编辑文件卡）。 */
export function IconFile({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14 3v5h5" />
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    </svg>
  );
}

/** 终端运行卡。 */
export function IconTerminal({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m5 8 4 4-4 4M13 16h6" />
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
    </svg>
  );
}

export function IconCheck({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** 已读双勾。 */
export function IconCheckCheck({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m2 12 5 5L18 6" />
      <path d="m12 13 1.5 1.5L22 6" />
    </svg>
  );
}

export function IconCopy({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconRegenerate({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export function IconThumbUp({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 10v11" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  );
}

export function IconThumbDown({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M17 14V3" />
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
    </svg>
  );
}

export function IconPaperclip({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function IconArrowUp({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} strokeWidth={2.2}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/** 停止（流式生成中的中止按钮）：实心圆角方块。 */
export function IconStop({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

/** 本地来源徽章用的小方块勾选图标。 */
export function IconLocalMark({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} strokeWidth={2}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  );
}

/**
 * 飞书花瓣徽章图标。圆角实心四瓣 + 中心点，整体更「实」，
 * 在 11px 小尺寸下不退化成十字/加号。用 fill 跟随 currentColor。
 */
export function IconFeishuPetal({ size = 14, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      {/* 四枚饱满圆瓣，半径偏大、相互交叠，小尺寸下仍读得出花形 */}
      <circle cx="12" cy="6.4" r="4.1" />
      <circle cx="17.6" cy="12" r="4.1" />
      <circle cx="12" cy="17.6" r="4.1" />
      <circle cx="6.4" cy="12" r="4.1" />
      {/* 中心留白点，制造花蕊层次 */}
      <circle cx="12" cy="12" r="2.5" fill="#fff" />
    </svg>
  );
}

/** 设置齿轮（模型菜单「管理模型」入口）。 */
export function IconSettings({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

/** 视频编辑器（摄像机图标）。 */
export function IconVideo({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M22 8l-6 4 6 4V8z" />
    </svg>
  );
}

/** 关闭 ✕（toast 关闭等）。 */
export function IconClose({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} strokeWidth={2}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

/** 眼睛（显示明文 API key）。线性描边，与图标集统一。 */
export function IconEye({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** 眼睛带斜杠（隐藏 API key，遮回掩码）。 */
export function IconEyeOff({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.8 17.8 0 0 1-2.9 3.9" />
      <path d="M6.3 6.3A17.8 17.8 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 4.2-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

/** 警告三角（落盘失败等提示条）。 */
export function IconWarning({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** 向下箭头（滚动到底浮标）。 */
export function IconArrowDown({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} strokeWidth={2.2}>
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

/** 火花 ✦（品牌字标旁）。 */
export function IconSparkle({ size = 12, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M12 2c.5 4.8 2.4 6.7 7.2 7.2-4.8.5-6.7 2.4-7.2 7.2-.5-4.8-2.4-6.7-7.2-7.2C9.6 8.7 11.5 6.8 12 2Z" />
    </svg>
  );
}

/**
 * Otto 吉祥物头像（Codex 原生 imagegen 生成，1 号：白屏笑脸 + <> 代码括号耳）。
 * 源图 build/avatar/otto-avatar-1.png → 缩至 256² 落 assets/，webpack 内联为 data URI。
 */
export function OttoAvatar({ size = 30, className }: IconProps): React.JSX.Element {
  return (
    <img
      src={ottoAvatarUrl}
      width={size}
      height={size}
      alt="Otto"
      className={className}
      draggable={false}
      style={{ borderRadius: '50%', display: 'block', objectFit: 'cover' }}
    />
  );
}
