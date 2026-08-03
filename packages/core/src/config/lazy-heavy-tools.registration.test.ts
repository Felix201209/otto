/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Config } from './config.js';

const HEAVY_STATIC_IMPORTS = [
  '../tools/ppt/pptOutlineTool.js',
  '../tools/ppt/pptGenerateTool.js',
  '../tools/desktop-automation.js',
  '../tools/video-editor.js',
  '../tools/convert-document.js',
  '../tools/generate-document.js',
  '../tools/analyze-data.js',
  '../tools/web-automation.js',
  '../tools/rpa-run.js',
  '../tools/durable-workflow.js',
  '../tools/multi-channel.js',
  '../tools/memory-manager.js',
  '../tools/feishu-project-collab.js',
  '../tools/enterprise-collaboration.js',
  '../tools/voice-bridge.js',
];

describe('Config lazy heavy tool registration', () => {
  it('keeps optional heavy tools out of Config static imports', async () => {
    const source = await readFile(fileURLToPath(new URL('./config.ts', import.meta.url)), 'utf8');

    for (const specifier of HEAVY_STATIC_IMPORTS) {
      expect(source).not.toContain(`from '${specifier}'`);
      expect(source).not.toContain(`from "${specifier}"`);
    }
  });

  it('still registers a lazy heavy tool when selected by tool name', async () => {
    const config = new Config({
      sessionId: 'lazy-heavy-tool-by-name',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      coreTools: ['ppt_outline'],
    });

    const registry = await config.createToolRegistry();

    expect(registry.getAllTools().map((tool) => tool.name)).toEqual(['ppt_outline']);
  });

  it('still registers a lazy heavy tool when selected by class name', async () => {
    const config = new Config({
      sessionId: 'lazy-heavy-tool-by-class',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      coreTools: ['EnterpriseCollaborationTool'],
    });

    const registry = await config.createToolRegistry();

    expect(registry.getAllTools().map((tool) => tool.name)).toEqual(['enterprise_collaboration']);
  });

  it('registers the durable RPA and workflow tool entries without eager imports', async () => {
    const config = new Config({
      sessionId: 'lazy-durable-tools',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      coreTools: ['rpa_run', 'durable_workflow'],
    });

    const registry = await config.createToolRegistry();

    expect(registry.getAllTools().map((tool) => tool.name)).toEqual(['durable_workflow', 'rpa_run']);
  });
});
