/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Config } from './config.js';
import { EnterpriseCollaborationTool } from '../tools/enterprise-collaboration.js';

describe('Config enterprise collaboration registration', () => {
  it('把结构化企业协作工具注册进 Core ToolRegistry', async () => {
    const config = new Config({
      sessionId: 'enterprise-collaboration-registration',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      coreTools: [EnterpriseCollaborationTool.Name],
    });

    const registry = await config.createToolRegistry();

    const registered = registry.getTool(EnterpriseCollaborationTool.Name);
    expect(registered).toBeInstanceOf(EnterpriseCollaborationTool);
    expect(registry.getAllTools().map((tool) => tool.name)).toEqual([
      EnterpriseCollaborationTool.Name,
    ]);
    expect(Object.hasOwn(registered as object, 'execute')).toBe(false);
  });
});
