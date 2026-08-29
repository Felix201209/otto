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

export function IconPlus({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Lucide SquarePen：新建并编辑一段内容。 */
export function IconSquarePen({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </svg>
  );
}

/** Lucide LayoutDashboard：综合工作台入口。 */
export function IconLayoutDashboard({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect width="7" height="9" x="3" y="3" rx="1" />
      <rect width="7" height="5" x="14" y="3" rx="1" />
      <rect width="7" height="9" x="14" y="12" rx="1" />
      <rect width="7" height="5" x="3" y="16" rx="1" />
    </svg>
  );
}

/** Lucide Network：组织层级与节点关系。 */
export function IconNetwork({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8" />
    </svg>
  );
}

/** Lucide MessageCircle：消息与沟通入口。 */
export function IconMessageCircle({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
    </svg>
  );
}

/** Lucide BriefcaseBusiness：个人工作与业务事项。 */
export function IconBriefcaseBusiness({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 12h.01M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M22 13a18.15 18.15 0 0 1-20 0" />
      <rect width="20" height="14" x="2" y="6" rx="2" />
    </svg>
  );
}

/** Lucide Building2：企业与组织管理。 */
export function IconBuilding2({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 12h4M10 8h4M14 21v-3a2 2 0 0 0-4 0v3" />
      <path d="M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2" />
      <path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16" />
    </svg>
  );
}

export function IconMicrophone({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
    </svg>
  );
}

/** 专家/机器人：带天线的方脑袋 + 双眼 + 两侧耳，作「专家」入口图标。 */
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

/** 默认账户头像：简洁的人形轮廓，避免用字母或高饱和色块占位。 */
export function IconUserAvatar({ size = 28, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden
    >
      <circle cx="16" cy="16" r="15" fill="currentColor" opacity=".14" />
      <circle cx="16" cy="12" r="5" fill="currentColor" opacity=".82" />
      <path
        d="M7.5 26c1.4-4.2 4.3-6.3 8.5-6.3s7.1 2.1 8.5 6.3"
        fill="currentColor"
        opacity=".82"
      />
      <path d="M10 26.5h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".35" />
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

/** DSH `ic_ds_personalization_outline_16`：任务视图选项。 */
export function IconPersonalization({ size = 16, className }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        transform="translate(1.292 1.3)"
        d="M10.3232 9.18164C11.2868 9.18164 12.0985 9.82833 12.3506 10.7109H13.415V11.8711H12.3496C12.0971 12.7532 11.2864 13.3994 10.3232 13.3994C9.36031 13.3992 8.55012 12.7531 8.29785 11.8711H0V10.7109H8.29688C8.54876 9.82845 9.35988 9.18186 10.3232 9.18164ZM10.3232 10.3418C9.7999 10.3421 9.37534 10.7667 9.375 11.29C9.375 11.8137 9.79969 12.239 10.3232 12.2393C10.847 12.2393 11.2725 11.8138 11.2725 11.29C11.2721 10.7666 10.8468 10.3418 10.3232 10.3418ZM3.08301 4.59082C4.04605 4.59095 4.85696 5.23717 5.10938 6.11914H13.415V7.2793H5.11035C4.85833 8.16202 4.04648 8.80846 3.08301 8.80859C2.11972 8.80843 1.30963 8.16179 1.05762 7.2793H0V6.11914H1.05762C1.30994 5.23728 2.12006 4.59098 3.08301 4.59082ZM3.08301 5.75098C2.55962 5.75117 2.13512 6.17587 2.13477 6.69922C2.13477 7.22287 2.5594 7.64824 3.08301 7.64844C3.60665 7.64828 4.03223 7.2229 4.03223 6.69922C4.03187 6.17585 3.60643 5.75113 3.08301 5.75098ZM10.3232 0C11.2869 0 12.0986 0.646596 12.3506 1.5293H13.415V2.68945H12.3496C12.0971 3.5716 11.2864 4.21777 10.3232 4.21777C9.36037 4.21756 8.55018 3.57139 8.29785 2.68945H0V1.5293H8.29688C8.5487 0.646717 9.35981 0.00021854 10.3232 0ZM10.3232 1.16016C9.79984 1.16042 9.37524 1.58499 9.375 2.1084C9.375 2.63201 9.79969 3.05735 10.3232 3.05762C10.847 3.05762 11.2725 2.63217 11.2725 2.1084C11.2722 1.58483 10.8469 1.16016 10.3232 1.16016Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Lucide panel-right：聊天顶栏中的右侧栏显隐入口。 */
export function IconPanelRight({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

export function IconSearch({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4.5 4.5" />
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

/** 外部链接：方框右上箭头。 */
export function IconExternalLink({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
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

/** 文件夹：用于在系统文件管理器中定位输出文件。 */
export function IconFolder({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2 2h7.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
    </svg>
  );
}

/** 打开的文件夹：用于表示侧栏中的工作目录。 */
export function IconFolderOpen({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className} strokeWidth={2}>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.45 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
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

/** Lucide Hand：手动确认、暂停并等待用户操作。 */
export function IconHand({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  );
}

/** Lucide ShieldEllipsis：受保护范围内的临时自动授权。 */
export function IconShieldEllipsis({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M8 12h.01M12 12h.01M16 12h.01" />
    </svg>
  );
}

/** Lucide ShieldCheck：持续生效且仍受安全边界保护的授权。 */
export function IconShieldCheck({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
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

/** 退出登录（Lucide LogOut 线性路径）。 */
export function IconLogOut({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
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

/** 关闭图标（toast 关闭等）。 */
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

// ── 园区服务（ParkServicesPlugin）─────────────────────────────────

/** 园区/办公楼：主楼 + 副楼 + 窗格。 */
export function IconBuilding({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 21h18" />
      <path d="M5 21V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16" />
      <path d="M14 9h4a1 1 0 0 1 1 1v11" />
      <path d="M8 8h3M8 12h3M8 16h3" />
    </svg>
  );
}

/** 访客证：卡片 + 头像 + 信息行。 */
export function IconIdBadge({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2" />
      <path d="M6.2 16a3 3 0 0 1 4.6 0" />
      <path d="M14 9h4M14 13h4" />
    </svg>
  );
}

/** 会议室预订：日历 + 对勾。 */
export function IconCalendarCheck({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <path d="m9 15.5 2 2 4-4" />
    </svg>
  );
}

/** IT 报修：扳手。 */
export function IconWrench({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** 行政后勤：立体纸箱。 */
export function IconPackage({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

/** 班车通勤：巴士。 */
export function IconBus({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M19 17h1a1 1 0 0 0 1-1V7a5 5 0 0 0-5-5H8a5 5 0 0 0-5 5v9a1 1 0 0 0 1 1h1" />
      <path d="M3 11h18" />
      <circle cx="7.5" cy="17.5" r="1.8" />
      <circle cx="16.5" cy="17.5" r="1.8" />
      <path d="M9.3 17.5h5.4" />
    </svg>
  );
}

/** 餐饮服务：刀叉。 */
export function IconUtensils({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 2v6a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2" />
      <path d="M7 2v20" />
      <path d="M19 15V2a4 4 0 0 0-4 5v6a2 2 0 0 0 2 2h2Z" />
      <path d="M19 15v7" />
    </svg>
  );
}

/** 太阳（浅色模式指示，顶栏主题切换钮）。 */
export function IconSun({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** 月亮（深色模式指示，顶栏主题切换钮）。 */
export function IconMoon({ size, className }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)} className={className}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

/** Module workspace icons. Each business module has a distinct local glyph. */
export function IconDashboard({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="4" rx="1" /><rect x="14" y="11" width="7" height="10" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg>;
}

export function IconMegaphone({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="m3 11 15-6v14L3 13z" /><path d="M11 16v4a2 2 0 0 1-4 0v-5" /><path d="M21 9v6" /></svg>;
}

export function IconClipboardCheck({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2h6v2M8 12l2.5 2.5L16 9" /></svg>;
}

export function IconHammer({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="m14 4 6 6-3 3-6-6zM12 9 4 17l3 3 8-8" /><path d="m12 3 2-2 7 7-2 2" /></svg>;
}

export function IconParking({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><circle cx="12" cy="12" r="9" /><path d="M9 17V7h4a3 3 0 0 1 0 6H9" /></svg>;
}

export function IconPhone({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4c0 1-1 2-2 2C10 21 3 14 3 5c0-1 1-2 2-2Z" /><path d="M15 5a5 5 0 0 1 4 4" /></svg>;
}

export function IconDoorOpen({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="M4 21h16M6 21V4l10-2v19M16 5h3v16" /><circle cx="13" cy="12" r=".7" fill="currentColor" stroke="none" /></svg>;
}

export function IconCreditCard({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h3" /></svg>;
}

export function IconRepair({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 3-4-4z" /><path d="m16 4 1-2M20 6l2-1" /></svg>;
}

export function IconCar({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="m5 16-2-2 2-6h14l2 6-2 2zM7 8l2-4h6l2 4" /><circle cx="7" cy="16" r="2" /><circle cx="17" cy="16" r="2" /></svg>;
}

export function IconClipboardList({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h4" /></svg>;
}

export function IconHistory({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>;
}

export function IconBrain({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="M9 4a3 3 0 0 0-5 2 3 3 0 0 0 0 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V6a3 3 0 0 0-3-2ZM15 4a3 3 0 0 1 5 2 3 3 0 0 1 0 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1V6a3 3 0 0 1 3-2Z" /><path d="M8 9h4M12 13h4" /></svg>;
}

export function IconWand({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="m4 20 11-11 4 4L8 24zM13 5l1-3M18 7l3-1M17 2l1 2M5 8l3 1" /><path d="m14 10 4 4" /></svg>;
}

export function IconStore({ size, className }: IconProps): React.JSX.Element {
  return <svg {...base(size)} className={className}><path d="M4 10v10h16V10M3 10l2-6h14l2 6" /><path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M9 20v-6h6v6" /></svg>;
}
