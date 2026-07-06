import { describe, expect, it } from 'vitest';
import { FeishuProjectCollabTool } from './feishu-project-collab.js';
import type { Config } from '../config/config.js';

describe('FeishuProjectCollabTool', () => {
  const tool = new FeishuProjectCollabTool({} as Config);

  it('renders project collaboration tables and acceptance nodes', async () => {
    const result = await tool.execute({ action: 'plan', project_name: 'Launch Plan', project_goal: 'Ship enterprise collaboration MVP', collaborators: [{ name: 'Alice', role: 'PM', responsibility: 'Acceptance criteria' }], acceptance_nodes: [{ name: 'MVP Review', due: '2026-08-01', standard: 'All tables and reminders ready', owner: 'Alice' }] }, new AbortController().signal);
    expect(result.llmContent).toContain('Project Charter');
    expect(result.llmContent).toContain('Responsibility Matrix');
    expect(result.llmContent).toContain('MVP Review');
  });

  it('requires progress content for progress sync', async () => {
    const result = await tool.execute({ action: 'progress_sync', project_name: 'Launch Plan' }, new AbortController().signal);
    expect(result.llmContent).toContain('progress sync requires progress_content');
  });

  it('renders reminder plan before acceptance nodes', async () => {
    const result = await tool.execute({ action: 'reminder_plan', project_name: 'Launch Plan', acceptance_nodes: [{ name: 'Final Acceptance', due: '2026-08-02', standard: 'Signed off', owner: 'Bob' }] }, new AbortController().signal);
    expect(result.llmContent).toContain('Acceptance node upcoming');
    expect(result.llmContent).toContain('calendar +create');
  });

  it('renders executable create base and archive actions', async () => {
    const created = await tool.execute({ action: 'create_base', project_name: 'Launch Plan' }, new AbortController().signal);
    expect(created.llmContent).toContain('base +base-create');
    const archived = await tool.execute({ action: 'archive_acceptance', project_name: 'Launch Plan', acceptance_content: 'Signed off' }, new AbortController().signal);
    expect(archived.llmContent).toContain('Executable Acceptance Archive');
  });
});
