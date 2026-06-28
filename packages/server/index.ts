/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server 包根入口（对齐 cli 的 index.ts 在 src 同级的布局，
 * 让 tsc --build 把 dist/index.js 产在 dist 根，与 package.json main 对齐）。
 */

export * from './src/index.js';
