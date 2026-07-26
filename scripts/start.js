/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(
  npmCommand,
  ['run', 'start', '--workspace=packages/desktop', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      DEV: 'true',
    },
  },
);

child.on('close', (code) => {
  process.exit(code ?? 0);
});
