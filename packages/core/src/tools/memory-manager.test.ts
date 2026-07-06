import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryManagerTool } from './memory-manager.js';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import type { Config } from '../config/config.js';
import type { UsageRecord } from '../memory/orgMemoryTypes.js';

describe('MemoryManagerTool project actions', () => {
  let root: string;
  let tool: MemoryManagerTool;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-memory-manager-'));
    tool = new MemoryManagerTool({ getProjectRoot: () => root, getMcpServers: () => undefined } as unknown as Config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates, lists, adds to, and archives project memory', async () => {
    const created = await tool.execute({
      action: 'project_create',
      project_id: 'project-review',
      project_name: 'Review Project',
      project_goal: 'Create repeatable review process',
      project_type: 'marketing',
      company_id: 'company-1',
      team_id: 'team-1',
      user_id: 'user-1',
    }, new AbortController().signal);
    expect(created.llmContent).toContain('project created: project-review');

    const added = await tool.execute({
      action: 'project_add',
      project_id: 'project-review',
      memory_title: 'Workflow',
      content: 'Collect metrics, compare goal, summarize lessons.',
      user_id: 'user-1',
    }, new AbortController().signal);
    expect(added.llmContent).toContain('project memory added');

    const listed = await tool.execute({ action: 'project_list' }, new AbortController().signal);
    expect(listed.llmContent).toContain('Review Project');

    const archived = await tool.execute({ action: 'project_archive', project_id: 'project-review', user_id: 'user-1' }, new AbortController().signal);
    expect(archived.llmContent).toContain('project archived: project-review');

    const data = await new OrgMemoryStore(root).load();
    expect(data.projects[0].status).toBe('archived');
    expect(data.memories.some((memory) => memory.type === 'summary')).toBe(true);
  });

  it('creates a candidate skill during archive when project usage qualifies', async () => {
    await tool.execute({ action: 'project_create', project_id: 'project-skill', project_name: 'Skill Project' }, new AbortController().signal);
    const store = new OrgMemoryStore(root);
    for (let index = 0; index < 5; index += 1) {
      const usage: UsageRecord = {
        id: 'usage-' + index,
        companyId: 'default-company',
        teamId: 'default-team',
        projectId: 'project-skill',
        userId: 'user-1',
        taskType: 'skill_project',
        model: 'test-model',
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        estimatedCost: 0.01,
        outputAccepted: true,
        revisionCount: 1,
        estimatedTimeSavedMinutes: 10,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      await store.addUsage(usage);
    }

    const archived = await tool.execute({ action: 'project_archive', project_id: 'project-skill', user_id: 'user-1' }, new AbortController().signal);
    expect(archived.llmContent).toContain('candidate skill: skill_project-skill');
    expect((await store.load()).skills).toHaveLength(1);
  });


  it('configures codebase memory for a project and reports status', async () => {
    await tool.execute({ action: 'project_create', project_id: 'project-code', project_name: 'Code Project' }, new AbortController().signal);

    const configured = await tool.execute({
      action: 'project_code_config',
      project_id: 'project-code',
      repo_path: root,
      mcp_server: 'codebase-memory',
    }, new AbortController().signal);
    expect(configured.llmContent).toContain('project codebase memory configured: project-code');
    expect(configured.llmContent).toContain('not configured');

    const status = await tool.execute({ action: 'project_code_status', project_id: 'project-code' }, new AbortController().signal);
    expect(status.llmContent).toContain('indexStatus: failed');

    const data = await new OrgMemoryStore(root).load();
    expect(data.projects[0].codebase?.mcpServerName).toBe('codebase-memory');
  });
});
