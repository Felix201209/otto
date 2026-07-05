#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import './src/otto.js';
import { main } from './src/otto.js';
import { handleEnterpriseArgs } from './src/join.js';

// --- Global Entry Point ---
// 企业员工瘦客户端：otto --join <邀请码> --server <host:port> / otto --admin。
// 命中就走企业客户端流程（入职引导 / 看板地址），不进常规 Otto CLI 主流程。
const cliArgs = process.argv.slice(2);
const entry =
  cliArgs.includes('--join') || cliArgs.includes('--admin')
    ? handleEnterpriseArgs(cliArgs)
    : main();

entry.catch((error) => {
  console.error('An unexpected critical error occurred:');
  if (error instanceof Error) {
    console.error(error.stack);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});
