import * as fs from 'fs/promises';
import * as http from 'http';
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

describe('MemoryManagerTool recall — department/company knowledge unification', () => {
  let tool: MemoryManagerTool;
  let root: string;
  let server: http.Server | undefined;
  let serverUrl: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-memory-recall-'));
    tool = new MemoryManagerTool({ getProjectRoot: () => root, getMcpServers: () => undefined } as unknown as Config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.OTTO_ENTERPRISE_URL;
    delete process.env.OTTO_ENTERPRISE_ADMIN_TOKEN;
    delete process.env.OTTO_ENTERPRISE_RECALL_TIMEOUT_MS;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('merges knowledge from a real enterprise server (real HTTP, not a stub) into recall output', async () => {
    // 起一个真实的最小 HTTP server 模拟 enterprise server 的
    // GET /enterprise/knowledge 端点（真实网络往返，不是对 fetch 打桩）。
    let receivedPath: string | undefined;
    server = http.createServer((req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        knowledge: [
          { department: 'sales', category: 'contract_review', content: '合同审查先查违约条款', confidence: 0.9 },
        ],
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
    process.env.OTTO_ENTERPRISE_URL = serverUrl;

    const result = await tool.execute({
      action: 'recall',
      task_type: 'otto-recall-unification-test-' + Date.now(),
      department_id: 'sales',
    }, new AbortController().signal);

    expect(result.llmContent).toContain('Department/Company Knowledge (enterprise server, shared across machines)');
    expect(result.llmContent).toContain('合同审查先查违约条款');
    expect(receivedPath).toContain('/enterprise/knowledge');
    expect(receivedPath).toContain('department=sales');
  });

  it('sends the admin token header when OTTO_ENTERPRISE_ADMIN_TOKEN is set', async () => {
    let receivedAuth: string | undefined;
    server = http.createServer((req, res) => {
      receivedAuth = req.headers['x-otto-admin-token'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ knowledge: [{ content: 'secured knowledge item' }] }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    process.env.OTTO_ENTERPRISE_URL = `http://127.0.0.1:${port}`;
    process.env.OTTO_ENTERPRISE_ADMIN_TOKEN = 'secret-token-123';

    const result = await tool.execute({
      action: 'recall',
      task_type: 'otto-recall-token-test-' + Date.now(),
    }, new AbortController().signal);

    expect(receivedAuth).toBe('secret-token-123');
    expect(result.llmContent).toContain('secured knowledge item');
  });

  it('gracefully degrades (no crash, no error content) when the enterprise server is unreachable', async () => {
    // 指向一个必然连不上的端口（服务端未启动 —— 绝大多数个人用户的常态）。
    process.env.OTTO_ENTERPRISE_URL = 'http://127.0.0.1:1';
    process.env.OTTO_ENTERPRISE_RECALL_TIMEOUT_MS = '300';

    const result = await tool.execute({
      action: 'recall',
      task_type: 'otto-recall-unreachable-test-' + Date.now(),
    }, new AbortController().signal);

    // 不应报错、不应包含企业知识库的标题（因为没有可合并的数据）。
    expect(result.llmContent).not.toContain('memory FAIL');
    expect(result.llmContent).not.toContain('enterprise server');
  });
});

describe('MemoryManagerTool project_create — topic identification & merge', () => {
  let tool: MemoryManagerTool;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-memory-topic-'));
    tool = new MemoryManagerTool({ getProjectRoot: () => root, getMcpServers: () => undefined } as unknown as Config);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a new project for a genuinely new topic (no false merge)', async () => {
    const first = await tool.execute({
      action: 'project_create', project_name: '合同审查流程优化', company_id: 'acme',
    }, new AbortController().signal);
    expect(first.llmContent).toContain('project created:');

    const second = await tool.execute({
      action: 'project_create', project_name: '公司年度财务报表审计', company_id: 'acme',
    }, new AbortController().signal);
    expect(second.llmContent).toContain('project created:');

    const data = await new OrgMemoryStore(root).load();
    expect(data.projects).toHaveLength(2);
  });

  it('merges a reworded duplicate topic into the existing project instead of creating a new one', async () => {
    const first = await tool.execute({
      action: 'project_create', project_name: '合同审查流程优化', company_id: 'acme',
    }, new AbortController().signal);
    expect(first.llmContent).toContain('project created:');

    // 同一件事，换了个说法（典型的"识别到同一话题"场景）。
    const second = await tool.execute({
      action: 'project_create', project_name: '优化合同审查的流程', company_id: 'acme',
    }, new AbortController().signal);
    expect(second.llmContent).toContain('topic merged into existing project:');
    expect(second.llmContent).not.toContain('project created:');

    // 断言：仍然只有 1 个项目（没有产出重复项目），且合并记录被写成了一条项目记忆。
    const data = await new OrgMemoryStore(root).load();
    expect(data.projects).toHaveLength(1);
    expect(data.memories.some((m) => m.tags.includes('topic-merge'))).toBe(true);
  });

  it('does NOT merge across different companies even if the topic text is identical', async () => {
    await tool.execute({
      action: 'project_create', project_name: '合同审查流程优化', company_id: 'company-a',
    }, new AbortController().signal);

    const second = await tool.execute({
      action: 'project_create', project_name: '合同审查流程优化', company_id: 'company-b',
    }, new AbortController().signal);

    // 不同公司，即便话题文本完全相同也不应合并——公司间数据必须隔离。
    expect(second.llmContent).toContain('project created:');
    const data = await new OrgMemoryStore(root).load();
    expect(data.projects).toHaveLength(2);
  });

  it('does NOT merge into an archived project (a re-raised topic after completion starts fresh)', async () => {
    const first = await tool.execute({
      action: 'project_create', project_id: 'proj-1', project_name: '合同审查流程优化', company_id: 'acme',
    }, new AbortController().signal);
    expect(first.llmContent).toContain('project created:');

    await tool.execute({ action: 'project_archive', project_id: 'proj-1' }, new AbortController().signal);

    const second = await tool.execute({
      action: 'project_create', project_name: '优化合同审查的流程', company_id: 'acme',
    }, new AbortController().signal);
    expect(second.llmContent).toContain('project created:');

    const data = await new OrgMemoryStore(root).load();
    // proj-1 (archived) + 新建的第二个 = 2 个项目记录。
    expect(data.projects).toHaveLength(2);
  });

  it('skips topic-merge detection when an explicit project_id is provided (explicit intent wins)', async () => {
    await tool.execute({
      action: 'project_create', project_name: '合同审查流程优化', company_id: 'acme',
    }, new AbortController().signal);

    // 显式指定 project_id，即便话题文本高度相似，也应按用户的明确意图新建
    // （用户可能就是想手动建一个关联的独立子项目，不该被自动合并覆盖判断）。
    const second = await tool.execute({
      action: 'project_create', project_id: 'explicit-id', project_name: '优化合同审查的流程', company_id: 'acme',
    }, new AbortController().signal);
    expect(second.llmContent).toContain('project created: explicit-id');

    const data = await new OrgMemoryStore(root).load();
    expect(data.projects).toHaveLength(2);
  });
});
