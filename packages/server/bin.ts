#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * otto-server bin 根入口（对齐 cli 布局，让 tsc 产 dist/bin.js 在 dist 根，
 * 与 package.json bin 字段对齐）。实际命令逻辑在 src/bin.ts。
 */

import './src/bin.js';
