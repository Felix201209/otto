/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

export function resolveVideoEditorIndex(input: {
  isPackaged: boolean;
  resourcesPath: string;
  moduleDir: string;
}): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, 'video-editor', 'index.html');
  }
  return path.resolve(
    input.moduleDir,
    '..',
    '..',
    '..',
    '..',
    'resources',
    'video-editor',
    'index.html',
  );
}
