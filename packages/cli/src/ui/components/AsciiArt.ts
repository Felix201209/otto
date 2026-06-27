/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// 像素风格的机器人 logo（灵感来自 Claude Code）
export const pixelRobotLogo = `
 ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝
`;

// Otto 品牌图标 —— 原创极简标志(粗体 "O",代表 Otto)。Header/紧凑视图沿用。
export const cuteVLogo = `
 ▟██▙
 █  █
 ▜██▛
`;

// Otto 启动大字标(ANSI Shadow 风格,拼出 OTTO)。保留备用。
// 每行宽 36,两个 O 形状一致;不要 trim 行内前导/尾随空格,否则会错位。
export const ottoWordmark = [
  ' ██████╗ ████████╗████████╗ ██████╗ ',
  '██╔═══██╗╚══██╔══╝╚══██╔══╝██╔═══██╗',
  '██║   ██║   ██║      ██║   ██║   ██║',
  '██║   ██║   ██║      ██║   ██║   ██║',
  '╚██████╔╝   ██║      ██║   ╚██████╔╝',
  ' ╚═════╝    ╚═╝      ╚═╝    ╚═════╝ ',
];

// Otto 紧凑字标(细半块风,3 行,拼出 OTTO)。保留备用。
export const ottoWordmarkCompact = [
  '█▀█ ▀█▀ ▀█▀ █▀█',
  '█ █  █   █  █ █',
  '▀▀▀  ▀   ▀  ▀▀▀',
];

// opencode 风格的阴影字标数据(拼大写 "OTTO")。沿用 opencode 的做法
// (packages/tui/src/logo.ts):字母用 █▀▄ 画,内部空腔用「标记位」着成阴影实块,
// 由 WelcomeScreen 的 draw 渲染器把标记位换成带背景色的块,做出立体阴影。
// 'O' 字形取自 opencode,'T' 按同风格设计(细顶栏 + 居中竖干)。
// 左半("OT")用较暗调、右半("TO")用较亮调,形成从左到右的渐变
// (与 opencode "open|code" 的双色调同理)。每行宽 9:字母(4)+空格(1)+字母(4)。
// 标记位:_ = 内部阴影实块(背景色空格),^ = 前景叠背景的顶块,~ = 阴影色顶块。
// 不要 trim 行内空格,否则字形错位。
export const ottoGlyphs = {
  left: ['█▀▀█ ▀▀▀▀', '█__█  ██ ', '▀▀▀▀  ▀▀ '],
  right: ['▀▀▀▀ █▀▀█', ' ██  █__█', ' ▀▀  ▀▀▀▀'],
};

// OTTO 大字标(给全屏 Home 屏用)—— ANSI Shadow 风格描边阴影字体。
// 每个字母 9 宽 6 高,字母紧贴(figlet 风格);由程序 join 出每行,
// 6 行严格等宽(36),保证逐列对齐(box 字符手敲极易差一格)。
const SHADOW_O = [
  ' ██████╗ ',
  '██╔═══██╗',
  '██║   ██║',
  '██║   ██║',
  '╚██████╔╝',
  ' ╚═════╝ ',
];
const SHADOW_T = [
  '████████╗',
  '╚══██╔══╝',
  '   ██║   ',
  '   ██║   ',
  '   ██║   ',
  '   ╚═╝   ',
];
export const ottoThickLogo: string[] = [0, 1, 2, 3, 4, 5].map(
  (i) => SHADOW_O[i] + SHADOW_T[i] + SHADOW_T[i] + SHADOW_O[i],
);

export const shortAsciiLogo = `
  OTTO
`;

export const longAsciiLogo = `
  ╶────────────────────────────────╴
     OTTO  ·  终端 & 飞书 AI 同事
     Consider it Otto.
  ╶────────────────────────────────╴
`;
