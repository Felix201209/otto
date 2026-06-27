/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { ColorsTheme, Theme } from './theme.js';

// opencode 默认深色主题调色板。色值精确取自 opencode 源码
// (packages/tui/src/theme/assets/opencode.json 的 dark 档),把它的语义角色
// 映射到 Otto 的 ColorsTheme:
//   primary(#fab283 暖橙) → AccentOrange   secondary(#5c9cf5) → AccentBlue
//   accent(#9d7cd8)       → AccentPurple   info(#56b6c2)      → AccentCyan
//   success(#7fd88f)      → AccentGreen    error(#e06c75)     → AccentRed
//   background(#0a0a0a)   → Background      text(#eeeeee)     → Foreground
//   textMuted(#808080)    → Gray / Comment
// 招牌就是「近黑底 + 暖橙主色」,改这一个主题,全屏观感立刻贴 opencode。
export const opencodeDark: ColorsTheme = {
  type: 'dark',
  Background: '#0a0a0a',
  Foreground: '#f5f5f5',
  LightBlue: '#5c9cf5',
  AccentBlue: '#5c9cf5',
  AccentPurple: '#9d7cd8',
  AccentCyan: '#56b6c2',
  AccentGreen: '#7fd88f',
  AccentYellow: '#e5c07b',
  AccentOrange: '#fab283',
  AccentRed: '#e06c75',
  DiffAdded: '#20303b',
  DiffRemoved: '#37222c',
  Comment: '#b0b0b0',
  Gray: '#c2c2c2',
  InfoColor: '#e5c07b',
  GradientColors: ['#fab283', '#ffc09f', '#eeeeee'],
};

const c = opencodeDark;

// 语法高亮映射,沿用 opencode 的语法配色取向:
// keyword→紫、function→暖橙、string→绿、variable→红、type→黄、operator→青。
export const OpenCode: Theme = new Theme(
  'opencode',
  'dark',
  {
    hljs: {
      display: 'block',
      overflowX: 'auto',
      padding: '0.5em',
      background: c.Background,
      color: c.Foreground,
    },
    'hljs-keyword': { color: c.AccentPurple },
    'hljs-literal': { color: c.AccentPurple },
    'hljs-symbol': { color: c.AccentPurple },
    'hljs-name': { color: c.AccentBlue },
    'hljs-link': { color: c.AccentBlue, textDecoration: 'underline' },
    'hljs-built_in': { color: c.AccentCyan },
    'hljs-type': { color: c.AccentYellow },
    'hljs-number': { color: c.AccentOrange },
    'hljs-class': { color: c.AccentYellow },
    'hljs-string': { color: c.AccentGreen },
    'hljs-meta-string': { color: c.AccentGreen },
    'hljs-regexp': { color: c.AccentRed },
    'hljs-template-tag': { color: c.AccentRed },
    'hljs-subst': { color: c.Foreground },
    'hljs-function': { color: c.AccentOrange },
    'hljs-title': { color: c.AccentOrange },
    'hljs-params': { color: c.Foreground },
    'hljs-formula': { color: c.Foreground },
    'hljs-comment': { color: c.Comment, fontStyle: 'italic' },
    'hljs-quote': { color: c.Comment, fontStyle: 'italic' },
    'hljs-doctag': { color: c.Comment },
    'hljs-meta': { color: c.Gray },
    'hljs-meta-keyword': { color: c.Gray },
    'hljs-tag': { color: c.Gray },
    'hljs-variable': { color: c.AccentRed },
    'hljs-template-variable': { color: c.AccentRed },
    'hljs-attr': { color: c.LightBlue },
    'hljs-attribute': { color: c.LightBlue },
    'hljs-builtin-name': { color: c.LightBlue },
    'hljs-section': { color: c.AccentYellow },
    'hljs-emphasis': { fontStyle: 'italic' },
    'hljs-strong': { fontWeight: 'bold' },
    'hljs-bullet': { color: c.AccentOrange },
    'hljs-selector-tag': { color: c.AccentYellow },
    'hljs-selector-id': { color: c.AccentYellow },
    'hljs-selector-class': { color: c.AccentYellow },
    'hljs-selector-attr': { color: c.AccentYellow },
    'hljs-selector-pseudo': { color: c.AccentYellow },
    'hljs-addition': {
      backgroundColor: c.DiffAdded,
      display: 'inline-block',
      width: '100%',
    },
    'hljs-deletion': {
      backgroundColor: c.DiffRemoved,
      display: 'inline-block',
      width: '100%',
    },
  },
  opencodeDark,
);
