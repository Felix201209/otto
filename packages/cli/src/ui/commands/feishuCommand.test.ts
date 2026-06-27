/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config, Content, OttoClient } from 'otto-core';
import {
  feishuCommand,
  buildBoundProjectsLines,
  shortenProjectPath,
  safeTruncateForLog,
  interceptFeishuLifecycleCommand,
  normalizeAskUserQuestionArgs,
} from './feishuCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import * as credentials from '../../services/feishu/credentials.js';
import type { CommandContext } from './types.js';
import type { FeishuCredentials } from '../../services/feishu/credentials.js';

vi.mock('../../services/feishu/credentials.js', () => ({
    loadCredentials: vi.fn(),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    isSenderAuthorized: vi.fn(() => true),
    CredentialsLoadError: class extends Error {},
  }));

vi.mock('../../services/feishu/gateway.js', () => ({
    FeishuGateway: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        sendMessage: vi.fn(),
        sendMarkdown: vi.fn(),
        updateMessageMarkdown: vi.fn(),
        getChatName: vi.fn().mockResolvedValue(null),
      })),
  }));

// probeCredentials 走真实网络，测试中 mock 掉避免不稳定 & 加速。
vi.mock('../../services/feishu/registration.js', () => ({
    initRegistration: vi.fn(),
    beginRegistration: vi.fn(),
    pollRegistration: vi.fn(),
    probeCredentials: vi.fn().mockResolvedValue(null),
  }));

describe('feishuCommand', () => {
  let context: CommandContext;

  beforeEach(() => {
    context = createMockCommandContext();
    vi.clearAllMocks();
  });

  it('should have correct metadata', () => {
    expect(feishuCommand.name).toBe('feishu');
    expect(feishuCommand.altNames).toContain('飞书');
    expect(feishuCommand.subCommands).toBeDefined();
  });

  it('should show help text', async () => {
    const helpCmd = feishuCommand.subCommands?.find(c => c.name === 'help');
    expect(helpCmd).toBeDefined();

    const result = await helpCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/feishu/i);
  });

  it('should handle stop when not running', async () => {
    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    expect(stopCmd).toBeDefined();

    const result = await stopCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/not running|未运行/i);
  });

  it('should handle status when credentials are missing', async () => {
    vi.mocked(credentials.loadCredentials).mockResolvedValue(null);
    const statusCmd = feishuCommand.subCommands?.find(c => c.name === 'status');
    expect(statusCmd).toBeDefined();

    const result = await statusCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/not configured|未配置/i);
  });

  it('should include the bound-projects section when credentials exist', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      botName: 'StatusBot',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const statusCmd = feishuCommand.subCommands?.find(c => c.name === 'status');
    const result = await statusCmd?.action!(context, '');
    expect(result?.type).toBe('message');
    // 绑定项目段落标题应出现（无论是否已绑定项目）
    expect(result?.content).toMatch(/Bound Projects|绑定项目/i);
  });

  it('should allow adding open_id to allowlist', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const allowCmd = feishuCommand.subCommands?.find(c => c.name === 'allow');
    expect(allowCmd).toBeDefined();

    const result = await allowCmd?.action!(context, 'ou_test_user');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/Added|成功加入/i);
    expect(credentials.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({
      allowlist: ['ou_test_user'],
    }));
  });

  it('should deny and remove open_id from allowlist', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      ownerOpenId: 'ou_owner',
      allowlist: ['ou_test_user'],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const denyCmd = feishuCommand.subCommands?.find(c => c.name === 'deny');
    expect(denyCmd).toBeDefined();

    const result = await denyCmd?.action!(context, 'ou_test_user');
    expect(result?.type).toBe('message');
    expect(result?.content).toMatch(/Removed|已移除/i);
    expect(credentials.saveCredentials).toHaveBeenCalledWith(expect.objectContaining({
      allowlist: [],
    }));
  });

  it('should handle stop correctly and reset state', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    const stopResult = await stopCmd?.action!(context, '');
    expect(stopResult?.type).toBe('message');
    expect(stopResult?.content).toMatch(/stopped|停止|🛑/i);
  });

  it('should emit FeishuBotProcessingEnd when stopping feishu bot', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    const { appEvents, AppEvent } = await import('../../utils/events.js');
    const endSpy = vi.fn();
    appEvents.on(AppEvent.FeishuBotProcessingEnd, endSpy);

    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    await stopCmd?.action!(context, '');

    appEvents.off(AppEvent.FeishuBotProcessingEnd, endSpy);
  });

  it('should emit FeishuBotStarted with botName and platform payload', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_123',
      appSecret: 'sec_123',
      domain: 'feishu',
      botName: 'MyTestBot',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const { appEvents, AppEvent } = await import('../../utils/events.js');
    const startedSpy = vi.fn();
    appEvents.on(AppEvent.FeishuBotStarted, startedSpy);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    appEvents.off(AppEvent.FeishuBotStarted, startedSpy);

    expect(startedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ botName: 'MyTestBot', platform: 'feishu' }),
    );

    // cleanup running gateway
    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    await stopCmd?.action!(context, '');
  });

  it('should emit FeishuBotStarted with lark platform when domain is lark', async () => {
    const mockCreds: FeishuCredentials = {
      appId: 'cli_456',
      appSecret: 'sec_456',
      domain: 'lark',
      botName: 'LarkBot',
      ownerOpenId: 'ou_owner',
      allowlist: [],
    };
    vi.mocked(credentials.loadCredentials).mockResolvedValue(mockCreds);

    const { appEvents, AppEvent } = await import('../../utils/events.js');
    const startedSpy = vi.fn();
    appEvents.on(AppEvent.FeishuBotStarted, startedSpy);

    const startCmd = feishuCommand.subCommands?.find(c => c.name === 'start');
    await startCmd?.action!(context, '');

    appEvents.off(AppEvent.FeishuBotStarted, startedSpy);

    expect(startedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ botName: 'LarkBot', platform: 'lark' }),
    );

    const stopCmd = feishuCommand.subCommands?.find(c => c.name === 'stop');
    await stopCmd?.action!(context, '');
  });
});

// ---------------------------------------------------------------------------
// shortenProjectPath — 取路径末两级，跨平台
// ---------------------------------------------------------------------------

describe('shortenProjectPath', () => {
  it('keeps only the last two segments for a deep POSIX path', () => {
    expect(shortenProjectPath('/home/user/projects/easyrouter-codingplan')).toBe(
      '.../projects/easyrouter-codingplan',
    );
  });

  it('keeps only the last two segments for a Windows path', () => {
    expect(shortenProjectPath('D:\\projects\\ottocode\\DeepCode')).toBe(
      '.../ottocode/DeepCode',
    );
  });

  it('returns the original path when it has two or fewer segments', () => {
    expect(shortenProjectPath('/var')).toBe('/var');
    expect(shortenProjectPath('foo/bar')).toBe('foo/bar');
  });

  it('returns empty string for empty input', () => {
    expect(shortenProjectPath('')).toBe('');
    expect(shortenProjectPath(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// safeTruncateForLog — 安全截断日志中文本，防止超长提示词泄露
// ---------------------------------------------------------------------------

describe('safeTruncateForLog', () => {
  it('returns empty string for empty input', () => {
    expect(safeTruncateForLog('')).toBe('');
    expect(safeTruncateForLog(undefined)).toBe('');
  });

  it('keeps text unchanged when it is within the limit and has no newlines', () => {
    expect(safeTruncateForLog('hello world')).toBe('hello world');
  });

  it('replaces newlines with spaces', () => {
    expect(safeTruncateForLog('line1\nline2\r\nline3')).toBe('line1 line2 line3');
  });

  it('truncates text and appends suffix when it exceeds the limit', () => {
    const longText = 'a'.repeat(200);
    const result = safeTruncateForLog(longText, 50);
    expect(result).toBe('a'.repeat(50) + '... (truncated, total 200 chars)');
  });
});

// ---------------------------------------------------------------------------
// buildBoundProjectsLines — 绑定项目列表渲染（群名解析 + 活跃标记）
// ---------------------------------------------------------------------------

describe('buildBoundProjectsLines', () => {
  it('renders an empty-state hint when there are no routes', () => {
    const lines = buildBoundProjectsLines({});
    const joined = lines.join('\n');
    // 标题应带数量 0
    expect(joined).toMatch(/\(0\)/);
    // 应包含「暂无绑定 / No projects」提示
    expect(joined).toMatch(/No projects|暂无绑定/i);
  });

  it('lists each bound project with its chatId and shortened path', () => {
    const routes = {
      oc_aaa: { projectRoot: '/home/user/projects/app-one' },
      oc_bbb: { projectRoot: 'D:\\work\\repos\\app-two' },
    };
    const lines = buildBoundProjectsLines(routes);
    const joined = lines.join('\n');
    expect(joined).toMatch(/\(2\)/);
    expect(joined).toContain('oc_aaa');
    expect(joined).toContain('oc_bbb');
    expect(joined).toContain('.../projects/app-one');
    expect(joined).toContain('.../repos/app-two');
  });

  it('prefers resolved group names over chatId when chatNames is provided', () => {
    const routes = { oc_aaa: { projectRoot: '/p/app-one' } };
    const lines = buildBoundProjectsLines(routes, {
      chatNames: { oc_aaa: '我的协作群' },
    });
    const joined = lines.join('\n');
    expect(joined).toContain('我的协作群');
    // chatId 不再作为主显示（仍可作为补充，这里只要求群名出现且在 chatId 之前）
    expect(joined.indexOf('我的协作群')).toBeLessThan(
      joined.indexOf('oc_aaa') === -1 ? Infinity : joined.indexOf('oc_aaa'),
    );
  });

  it('falls back to chatId when a chat name is missing', () => {
    const routes = {
      oc_named: { projectRoot: '/p/one' },
      oc_unnamed: { projectRoot: '/p/two' },
    };
    const lines = buildBoundProjectsLines(routes, {
      chatNames: { oc_named: 'Named Group' },
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Named Group');
    expect(joined).toContain('oc_unnamed');
  });

  it('marks the active chat with a green dot and an (Active) suffix', () => {
    const routes = {
      oc_active: { projectRoot: '/p/active' },
      oc_idle: { projectRoot: '/p/idle' },
    };
    const lines = buildBoundProjectsLines(routes, { activeChatIds: ['oc_active'] });
    const activeLine = lines.find((l) => l.includes('oc_active'));
    const idleLine = lines.find((l) => l.includes('oc_idle'));
    expect(activeLine).toBeDefined();
    expect(activeLine).toMatch(/Active|活跃/i);
    expect(activeLine).toContain('🟢');
    // 非活跃行不应带 Active 标记
    expect(idleLine).toBeDefined();
    expect(idleLine).not.toMatch(/\(Active\)|\(活跃中\)/);
  });

  it('marks ALL currently-working chats as active (multiple concurrent groups)', () => {
    const routes = {
      oc_a: { projectRoot: '/p/a' },
      oc_b: { projectRoot: '/p/b' },
      oc_c: { projectRoot: '/p/c' },
    };
    // oc_a 与 oc_c 同时在干活，oc_b 空闲
    const lines = buildBoundProjectsLines(routes, {
      activeChatIds: new Set(['oc_a', 'oc_c']),
    });
    const lineA = lines.find((l) => l.includes('oc_a'));
    const lineB = lines.find((l) => l.includes('oc_b'));
    const lineC = lines.find((l) => l.includes('oc_c'));
    expect(lineA).toMatch(/Active|活跃/i);
    expect(lineA).toContain('🟢');
    expect(lineC).toMatch(/Active|活跃/i);
    expect(lineC).toContain('🟢');
    // 空闲群不带活跃标记
    expect(lineB).not.toMatch(/\(Active\)|\(活跃中\)/);
    expect(lineB).not.toContain('🟢');
  });

  it('treats an empty active set as no active chats', () => {
    const routes = { oc_a: { projectRoot: '/p/a' } };
    const lines = buildBoundProjectsLines(routes, { activeChatIds: new Set() });
    const joined = lines.join('\n');
    expect(joined).not.toMatch(/\(Active\)|\(活跃中\)/);
    expect(joined).not.toContain('🟢');
  });

  it('handles routes that have no projectRoot gracefully', () => {
    const routes = { oc_nopath: {} };
    const lines = buildBoundProjectsLines(routes);
    const joined = lines.join('\n');
    expect(joined).toContain('oc_nopath');
    // 不应抛错，也不应出现 undefined 字样
    expect(joined).not.toContain('undefined');
  });

  it('renders a p2p chat as a friendly "direct message with bot" label', () => {
    const routes = { oc_p2p: { projectRoot: '/p/cli-cwd' } };
    const lines = buildBoundProjectsLines(routes, {
      p2pChatIds: ['oc_p2p'],
      botName: '糖糖Bot',
    });
    const joined = lines.join('\n');
    // 应出现私聊文案 + Bot 名
    expect(joined).toMatch(/Direct message with bot|与机器人/i);
    expect(joined).toContain('糖糖Bot');
  });

  it('falls back to an unknown-bot p2p label when botName is missing', () => {
    const routes = { oc_p2p: { projectRoot: '/p/cli-cwd' } };
    const lines = buildBoundProjectsLines(routes, { p2pChatIds: ['oc_p2p'] });
    const joined = lines.join('\n');
    expect(joined).toMatch(/Direct message with the bot|与机器人的私聊/i);
  });

  it('prefers the p2p label over a (mistakenly) resolved name for a p2p chat', () => {
    // 防御：即便上游误传了 name，p2p 判定优先级更高，避免把私聊显示成群名。
    const routes = { oc_p2p: { projectRoot: '/p/cli-cwd' } };
    const lines = buildBoundProjectsLines(routes, {
      p2pChatIds: new Set(['oc_p2p']),
      chatNames: { oc_p2p: 'Should Not Show' },
      botName: 'MyBot',
    });
    const joined = lines.join('\n');
    expect(joined).toMatch(/Direct message with bot|与机器人/i);
    expect(joined).toContain('MyBot');
    expect(joined).not.toContain('Should Not Show');
  });

  it('does NOT apply the p2p label to normal group chats', () => {
    const routes = {
      oc_p2p: { projectRoot: '/p/dm' },
      oc_group: { projectRoot: '/p/grp' },
    };
    const lines = buildBoundProjectsLines(routes, {
      p2pChatIds: ['oc_p2p'],
      chatNames: { oc_group: 'Team Group' },
      botName: 'MyBot',
    });
    const groupLine = lines.find((l) => l.includes('Team Group'));
    expect(groupLine).toBeDefined();
    // 群聊行不应带私聊文案
    expect(groupLine).not.toMatch(/Direct message with|与机器人/i);
  });

  it('still marks a p2p chat as active when it is currently working', () => {
    const routes = { oc_p2p: { projectRoot: '/p/dm' } };
    const lines = buildBoundProjectsLines(routes, {
      p2pChatIds: ['oc_p2p'],
      botName: 'MyBot',
      activeChatIds: ['oc_p2p'],
    });
    const joined = lines.join('\n');
    expect(joined).toMatch(/Direct message with bot|与机器人/i);
    expect(joined).toContain('🟢');
    expect(joined).toMatch(/Active|活跃/i);
  });
});

// ---------------------------------------------------------------------------
// interceptFeishuLifecycleCommand — 飞书侧拦截 /feishu start|stop
// ---------------------------------------------------------------------------

describe('interceptFeishuLifecycleCommand', () => {
  it('intercepts /feishu stop with a friendly hint', () => {
    const hint = interceptFeishuLifecycleCommand('/feishu stop');
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/stop|停止|断连|disconnect/i);
  });

  it('intercepts /feishu start with a friendly hint', () => {
    const hint = interceptFeishuLifecycleCommand('/feishu start');
    expect(hint).not.toBeNull();
    expect(hint).toMatch(/running|运行中|terminal|终端/i);
  });

  it('is case-insensitive and tolerates trailing whitespace', () => {
    expect(interceptFeishuLifecycleCommand('/FEISHU STOP  ')).not.toBeNull();
    expect(interceptFeishuLifecycleCommand('  /Feishu Start')).not.toBeNull();
  });

  it('supports the 飞书 alias', () => {
    expect(interceptFeishuLifecycleCommand('/飞书 stop')).not.toBeNull();
    expect(interceptFeishuLifecycleCommand('/飞书 start')).not.toBeNull();
  });

  it('returns null for /feishu status (must not be intercepted)', () => {
    expect(interceptFeishuLifecycleCommand('/feishu status')).toBeNull();
  });

  it('returns null for other /feishu subcommands and unrelated commands', () => {
    expect(interceptFeishuLifecycleCommand('/feishu allowlist')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/feishu')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/status')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/stop')).toBeNull();
    expect(interceptFeishuLifecycleCommand('hello world')).toBeNull();
  });

  it('does not intercept when start/stop appear as plain words, not the subcommand', () => {
    expect(interceptFeishuLifecycleCommand('please feishu stop')).toBeNull();
    expect(interceptFeishuLifecycleCommand('/feishustop')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// deriveUiHistoryFromClientHistory — 把 AI 客户端历史派生成 UI 视角 history，
//   用于让 SessionManager.getLastActiveSession(true) 的"含 user 消息"判断成立。
// ───────────────────────────────────────────────────────────────────────────
describe('deriveUiHistoryFromClientHistory', () => {
  it('extracts only user-role text entries as {type:user, text}', async () => {
    const { deriveUiHistoryFromClientHistory } = await import(
      './feishuCommand.js'
    );
    const clientHistory = [
      { role: 'user', parts: [{ text: '记住数字 6' }] },
      { role: 'model', parts: [{ text: '好的，记住了：6。' }] },
      { role: 'user', parts: [{ text: '刚才说的是几？' }] },
    ];
    const ui = deriveUiHistoryFromClientHistory(clientHistory);
    expect(ui).toEqual([
      { type: 'user', text: '记住数字 6' },
      { type: 'user', text: '刚才说的是几？' },
    ]);
  });

  it('skips function calls, empty text, and non-array input defensively', async () => {
    const { deriveUiHistoryFromClientHistory } = await import(
      './feishuCommand.js'
    );
    expect(deriveUiHistoryFromClientHistory([])).toEqual([]);
    expect(deriveUiHistoryFromClientHistory(null)).toEqual([]);
    expect(
      deriveUiHistoryFromClientHistory([
        { role: 'user', parts: [{ functionCall: { name: 'x' } }] },
        { role: 'user', parts: [{ text: '   ' }] },
        { role: 'user' }, // no parts
      ]),
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 飞书 session 持久化 + 续接 round-trip
//   验证 saveFeishuSessionHistory 写入的会话能被 resolveResumableSessionId
//   找回（必须经过 SessionManager 的 index.json 与 metadata.json）。
//   这是 /feishu start 自动恢复会话的核心契约。
// ───────────────────────────────────────────────────────────────────────────
describe('feishu session persistence round-trip', () => {
  it('saved session is discoverable by resolveResumableSessionId', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const { saveFeishuSessionHistory, resolveResumableSessionId } =
      await import('./feishuCommand.js');

    // 用隔离的 home 目录，避免污染真实 ~/.otto-user。
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fsh-home-'));
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'fsh-proj-'));
    const originalHome = process.env['HOME'];
    const originalUserprofile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;

    try {
      const sessionId = `feishu-oc_test_${Date.now()}`;
      const clientHistory = [
        { role: 'user', parts: [{ text: '记住数字 6' }] },
        { role: 'model', parts: [{ text: '好的，记住了：6。' }] },
      ];

      // 模拟最小化的 Config + OttoClient 接口。
      const fakeConfig = {
        getProjectRoot: () => tmpProj,
        getSessionId: () => sessionId,
      } as unknown as Config;
      const fakeClient = {
        getHistory: async () => clientHistory,
      } as unknown as OttoClient;

      await saveFeishuSessionHistory(fakeConfig, fakeClient);

      const resumed = await resolveResumableSessionId(tmpProj);
      expect(resumed.sessionId).toBe(sessionId);
      expect(resumed.clientHistory).toEqual(clientHistory);
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalUserprofile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = originalUserprofile;
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });

  it('keeps returning the latest history after multiple turns', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const { saveFeishuSessionHistory, resolveResumableSessionId } =
      await import('./feishuCommand.js');

    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fsh-home-'));
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'fsh-proj-'));
    const originalHome = process.env['HOME'];
    const originalUserprofile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;

    try {
      const sessionId = `feishu-oc_test_${Date.now()}`;
      let history: Content[] = [
        { role: 'user', parts: [{ text: '记住数字 6' }] },
        { role: 'model', parts: [{ text: '好的，记住了：6。' }] },
      ];
      const fakeConfig = {
        getProjectRoot: () => tmpProj,
        getSessionId: () => sessionId,
      } as unknown as Config;
      const fakeClient = {
        getHistory: async () => history,
      } as unknown as OttoClient;

      await saveFeishuSessionHistory(fakeConfig, fakeClient);

      history = [
        ...history,
        { role: 'user', parts: [{ text: '我刚才说的数字是几？' }] },
        { role: 'model', parts: [{ text: '6' }] },
      ];
      await saveFeishuSessionHistory(fakeConfig, fakeClient);

      const resumed = await resolveResumableSessionId(tmpProj);
      expect(resumed.sessionId).toBe(sessionId);
      expect(resumed.clientHistory).toHaveLength(4);
      expect(resumed.clientHistory?.[2]?.parts?.[0]?.text).toContain(
        '刚才说的数字',
      );
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalUserprofile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = originalUserprofile;
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });

  it('returns empty when no session was ever saved', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const { resolveResumableSessionId } = await import('./feishuCommand.js');

    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'fsh-home-'));
    const tmpProj = await fs.mkdtemp(path.join(os.tmpdir(), 'fsh-proj-'));
    const originalHome = process.env['HOME'];
    const originalUserprofile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;

    try {
      const resumed = await resolveResumableSessionId(tmpProj);
      expect(resumed.sessionId).toBeUndefined();
      expect(resumed.clientHistory).toBeUndefined();
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      if (originalUserprofile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = originalUserprofile;
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(tmpProj, { recursive: true, force: true });
    }
  });
});

/**
 * normalizeAskUserQuestionArgs — 守护飞书网关下 ask_user_question 的崩溃修复。
 *
 * 生产 bug：飞书拦截 ask_user_question 时报 `(n.questions || []).map is not a function`。
 * 根因：某些情况下 args 或 args.questions 是 JSON 字符串而非数组，
 *   `("..." || []).map` 在字符串上调用 .map 抛错。
 * 此函数把各种输入安全归一化为 { questions: AskUserQuestion[] }。
 */
describe('normalizeAskUserQuestionArgs', () => {
  it('passes through a well-formed object with questions array', () => {
    const input = {
      questions: [
        { question: 'Pick one', header: 'Choice', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    };
    const out = normalizeAskUserQuestionArgs(input);
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].question).toBe('Pick one');
  });

  it('parses args.questions when it is a JSON string (the crash case)', () => {
    const input = {
      questions: JSON.stringify([
        { question: 'Q1', options: [{ label: 'A' }] },
      ]),
    };
    const out = normalizeAskUserQuestionArgs(input);
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0].question).toBe('Q1');
  });

  it('parses the entire args when args itself is a JSON string', () => {
    const input = JSON.stringify({
      questions: [{ question: 'Whole-args string', options: [{ label: 'X' }] }],
    });
    const out = normalizeAskUserQuestionArgs(input);
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.questions[0].question).toBe('Whole-args string');
  });

  it('handles a double-encoded args (string whose parse yields questions string)', () => {
    // args 是字符串，parse 后得到 { questions: "<json string>" }
    const input = JSON.stringify({
      questions: JSON.stringify([{ question: 'Nested', options: [] }]),
    });
    const out = normalizeAskUserQuestionArgs(input);
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.questions[0].question).toBe('Nested');
  });

  it('returns empty questions for null / undefined', () => {
    expect(normalizeAskUserQuestionArgs(null).questions).toEqual([]);
    expect(normalizeAskUserQuestionArgs(undefined).questions).toEqual([]);
  });

  it('returns empty questions when questions is missing', () => {
    expect(normalizeAskUserQuestionArgs({}).questions).toEqual([]);
  });

  it('returns empty questions for non-array / non-parsable questions', () => {
    expect(normalizeAskUserQuestionArgs({ questions: 42 }).questions).toEqual([]);
    expect(normalizeAskUserQuestionArgs({ questions: 'not json at all {' }).questions).toEqual([]);
    expect(normalizeAskUserQuestionArgs({ questions: { not: 'array' } }).questions).toEqual([]);
  });

  it('never throws on garbage input (defensive)', () => {
    expect(() => normalizeAskUserQuestionArgs('@@@not-json@@@')).not.toThrow();
    expect(normalizeAskUserQuestionArgs('@@@not-json@@@').questions).toEqual([]);
  });

  it('wraps a single question object (not wrapped in questions) gracefully', () => {
    // 极端容错：模型直接把单个问题对象当 args 传
    const input = { question: 'Direct question', options: [{ label: 'A' }] };
    const out = normalizeAskUserQuestionArgs(input);
    expect(Array.isArray(out.questions)).toBe(true);
    expect(out.questions[0].question).toBe('Direct question');
  });
});
