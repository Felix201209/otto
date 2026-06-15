/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getVersion } from '../utils/version.js';
import type { MessageActionReturn } from './types.js';

/**
 * `/about` — best-effort version / environment banner for ACP clients.
 */
export async function getAboutInfo(): Promise<MessageActionReturn> {
  const version = await getVersion().catch(() => 'unknown');
  const lines = [
    `Otto CLI: ${version}`,
    `Platform: ${process.platform}`,
    `Node: ${process.version}`,
    `Architecture: ${process.arch}`,
  ];
  return {
    type: 'message',
    messageType: 'info',
    content: lines.join('\n'),
  };
}
