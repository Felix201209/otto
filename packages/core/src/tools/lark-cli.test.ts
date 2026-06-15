/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { LarkCliTool, LarkCliParams } from './lark-cli.js';
import { Config } from '../config/config.js';
import { spawn } from 'node:child_process';

// Mock child_process. We stream output through spawn, and probe the global
// binary via spawnSync (synchronous --version check).
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    spawnSync: vi.fn(),
  };
});

/**
 * A controllable fake child process for driving spawn-based streaming tests.
 * Tests push data through `emitStdout` / `emitStderr` and finish the process
 * with `close(code)` to simulate real-time output and exit semantics.
 */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });

  emitStdout(chunk: string) {
    this.stdout.emit('data', Buffer.from(chunk));
  }

  emitStderr(chunk: string) {
    this.stderr.emit('data', Buffer.from(chunk));
  }

  /** Simulate the process exiting with the given code. */
  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

/** Helper: queue the next FakeChildProcess that spawn() will return. */
function nextChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  return child;
}

/**
 * Asserts the child process was terminated. Cross-platform: on Windows the
 * implementation shells out to `taskkill` (a fresh spawn call) rather than
 * calling child.kill(); on POSIX it calls child.kill('SIGTERM').
 */
function expectChildKilled(child: FakeChildProcess) {
  const taskkillSpawned = mockSpawn.mock.calls.some(
    (call) => call[0] === 'taskkill',
  );
  expect(child.kill.mock.calls.length > 0 || taskkillSpawned).toBe(true);
}

describe('LarkCliTool', () => {
  let mockConfig: Config;
  let tool: LarkCliTool;

  beforeEach(async () => {
    mockConfig = {
      getFeishuMode: () => false,
    } as unknown as Config;
    tool = new LarkCliTool(mockConfig);
    vi.clearAllMocks();
    // Default: global binary detection fails -> fall back to npx.
    const { spawnSync } = (await import('node:child_process')) as unknown as {
      spawnSync: ReturnType<typeof vi.fn>;
    };
    spawnSync.mockReturnValue({ status: 1, error: new Error('not found') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should initialize with correct name and schema', () => {
      expect(tool.name).toBe('lark_cli');
      expect(tool.displayName).toBe('LarkCli');
      expect(tool.schema.name).toBe('lark_cli');
      expect(tool.schema.parameters?.properties?.command).toBeDefined();
    });

    it('should declare canUpdateOutput=true so the engine streams live output', () => {
      expect(tool.canUpdateOutput).toBe(true);
    });

    it('should declare forceMarkdown=true so the auth QR code is not height-folded', () => {
      expect(tool.forceMarkdown).toBe(true);
    });
  });

  describe('validateToolParams', () => {
    it('should pass on valid parameters', () => {
      const validParams: LarkCliParams = {
        command: 'calendar +agenda',
        args: ['--chat-id', 'oc_xxx'],
        as: 'user',
      };
      expect(tool.validateToolParams(validParams)).toBeNull();
    });

    it('should fail on empty command', () => {
      const invalidParams = { command: '   ' } as LarkCliParams;
      const error = tool.validateToolParams(invalidParams);
      expect(error).toContain('non-empty string');
    });

    it('should fail on invalid args type', () => {
      const invalidParams = {
        command: 'calendar',
        args: 'not-an-array',
      } as unknown as LarkCliParams;
      const error = tool.validateToolParams(invalidParams);
      expect(error).toContain('array');
    });

    it('should fail on invalid as type', () => {
      const invalidParams = {
        command: 'calendar',
        as: 'invalid-identity',
      } as unknown as LarkCliParams;
      const error = tool.validateToolParams(invalidParams);
      expect(error).toContain('as');
    });
  });

  describe('execute - command construction', () => {
    it('should use global lark-cli when --version probe succeeds', async () => {
      const { spawnSync } = (await import('node:child_process')) as unknown as {
        spawnSync: ReturnType<typeof vi.fn>;
      };
      spawnSync.mockReturnValue({ status: 0, stdout: 'lark-cli 1.0.0' });

      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda', args: ['--chat-id', 'oc_123'] },
        new AbortController().signal,
      );
      child.emitStdout('{"success": true}');
      child.close(0);
      const result = await promise;

      expect(result.status).toBe('success');
      // We spawn with `shell: true`, so the command is a single string in arg 0.
      const cmdStr = mockSpawn.mock.calls[0][0] as string;
      expect(cmdStr).toContain('lark-cli');
      expect(cmdStr).toContain('calendar +agenda');
      expect(cmdStr).toContain('oc_123');
    });

    it('should fall back to npx when global binary is missing', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'task list' },
        new AbortController().signal,
      );
      child.emitStdout('{"status": "ok"}');
      child.close(0);
      const result = await promise;

      expect(result.status).toBe('success');
      const cmdStr = mockSpawn.mock.calls[0][0] as string;
      expect(cmdStr).toContain('@larksuite/cli');
      expect(cmdStr).toContain('task list');
    });

    it('should NOT append --format json by default (flag is command-specific)', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'task list' },
        new AbortController().signal,
      );
      child.close(0);
      await promise;
      const cmdStr = mockSpawn.mock.calls[0][0] as string;
      expect(cmdStr).not.toContain('--format json');
    });

    it('should append identity flag when "as" is provided', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda', as: 'bot' },
        new AbortController().signal,
      );
      child.close(0);
      await promise;
      const cmdStr = mockSpawn.mock.calls[0][0] as string;
      expect(cmdStr).toContain('--as bot');
    });
  });

  describe('execute - live streaming output', () => {
    it('should invoke updateOutput as data streams in (before exit)', async () => {
      const updates: string[] = [];
      const child = nextChild();
      const promise = tool.execute(
        { command: 'auth login' },
        new AbortController().signal,
        (out) => updates.push(out),
      );

      // Stream a chunk while the process is still alive.
      child.emitStdout('waiting for authorization...\n');
      // Give the throttled flush a tick.
      await new Promise((r) => setTimeout(r, 5));

      child.close(0);
      await promise;

      expect(updates.length).toBeGreaterThan(0);
      expect(updates.join('')).toContain('waiting for authorization');
    });
  });

  describe('execute - authorization URL capture', () => {
    it('should capture device-flow page/cli URL (feishu brand) as auth_required', async () => {
      const updates: string[] = [];
      const child = nextChild();
      const promise = tool.execute(
        { command: 'auth login' },
        new AbortController().signal,
        (out) => updates.push(out),
      );

      const url =
        'https://open.feishu.cn/page/cli?user_code=CJMV-5FQZ&lpv=1.0.44&ocv=1.0.44&from=cli';
      child.emitStdout(`打开以下链接配置应用:\n\n  ${url}\n\n等待配置应用...\n`);
      await new Promise((r) => setTimeout(r, 5));
      child.close(0);
      const result = await promise;

      expect(result.authUrl).toBe(url);
      // The captured URL should also surface to the user via live output.
      expect(updates.join('')).toContain(url);
    });

    it('should capture larksuite brand verification URL', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'auth login' },
        new AbortController().signal,
      );
      const url =
        'https://open.larksuite.com/page/cli?user_code=ABCD-1234&from=cli';
      child.emitStdout(`Open: ${url}\n`);
      child.close(0);
      const result = await promise;
      expect(result.authUrl).toBe(url);
    });

    it('should still capture legacy open-apis/authen URL', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'auth login' },
        new AbortController().signal,
      );
      const url =
        'https://open.feishu.cn/open-apis/authen/v1/index?app_id=cli_123456';
      child.emitStdout(`Please open:\n${url}\nwaiting...`);
      child.close(0);
      const result = await promise;
      expect(result.authUrl).toBe(url);
    });

    it('should output localized guide and format when getFeishuMode() is true', async () => {
      // Mock feishuMode to true
      mockConfig.getFeishuMode = () => true;

      const updates: string[] = [];
      const child = nextChild();
      const promise = tool.execute(
        { command: 'auth login' },
        new AbortController().signal,
        (out) => updates.push(out),
      );

      const url =
        'https://open.feishu.cn/page/cli?user_code=CJMV-5FQZ&lpv=1.0.44&ocv=1.0.44&from=cli';
      child.emitStdout(`打开以下链接配置应用:\n\n  ${url}\n\n等待配置应用...\n`);
      await new Promise((r) => setTimeout(r, 5));
      child.close(1); // non-zero exit to trigger buildResult returnDisplay
      const result = await promise;

      expect(result.authUrl).toBe(url);
      expect(result.status).toBe('auth_required');

      // The update streaming should contain the Feishu Gateway localized tip
      const updateText = updates.join('');
      expect(updateText).toContain('飞书网关模式：请点击以下链接进行授权');
      expect(updateText).toContain('选择 “已有应用”，选择本机器人即可');

      // The final result returnDisplay should also contain the Feishu Gateway localized tip
      expect(result.returnDisplay).toContain('飞书网关模式：需要登录认证，请点击以下链接进行授权');
      expect(result.returnDisplay).toContain('选择 “已有应用”，选择本机器人即可');
    });
  });

  describe('execute - exit code semantics', () => {
    it('should mark success on exit code 0', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
      );
      child.emitStdout('{"code": 0, "data": {}}');
      child.close(0);
      const result = await promise;
      expect(result.status).toBe('success');
      expect(result.data).toEqual({ code: 0, data: {} });
    });

    it('should mark failed on non-zero exit code', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
      );
      child.emitStderr('Access denied');
      child.close(1);
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.returnDisplay).toContain('Access denied');
    });
  });

  describe('execute - timeout fallback', () => {
    it('should kill the process and fail after the fallback timeout', async () => {
      vi.useFakeTimers();
      const child = nextChild();
      const promise = tool.execute(
        { command: 'auth login' },
        new AbortController().signal,
      );

      // Advance beyond the fallback timeout without the process ever exiting.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1000);
      // The watchdog must have attempted to kill the hung process.
      expectChildKilled(child);

      // Simulate the kill causing the process to close.
      child.close(null, 'SIGTERM');
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.error?.toLowerCase()).toContain('timed out');
    });
  });

  describe('execute - abort signal', () => {
    it('should kill the process when the abort signal fires', async () => {
      const controller = new AbortController();
      const child = nextChild();
      const promise = tool.execute({ command: 'auth login' }, controller.signal);

      controller.abort();
      await new Promise((r) => setTimeout(r, 5));
      expectChildKilled(child);

      child.close(null, 'SIGTERM');
      const result = await promise;
      expect(result.status).toBe('failed');
    });
  });

  describe('execute - automatic device-flow takeover', () => {
    // The "not configured" JSON that lark-cli prints when no app is bound yet.
    const NOT_CONFIGURED = JSON.stringify({
      ok: false,
      identity: 'user',
      error: {
        type: 'config',
        message: 'not configured',
        hint: 'run `lark-cli config init --new` in the background.',
      },
    });

    it('should auto-start device flow when a business command hits "not configured"', async () => {
      const updates: string[] = [];

      // 1st spawn: the business command, which fails with not-configured.
      const bizChild = nextChild();
      // 2nd spawn: the auto-triggered `config init --new` device flow.
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'calendar +agenda', as: 'user' },
        new AbortController().signal,
        (out) => updates.push(out),
      );

      // Business command reports not-configured and exits non-zero.
      bizChild.emitStdout(NOT_CONFIGURED);
      bizChild.close(1);

      // Allow the takeover to spawn the device-flow child.
      await new Promise((r) => setTimeout(r, 10));

      // The wrapper must have launched a second process for config init.
      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('config init');

      // Device flow prints its verification URL.
      const url =
        'https://open.feishu.cn/page/cli?user_code=WXYZ-7788&from=cli';
      authChild.emitStdout(`打开以下链接配置应用:\n\n  ${url}\n\n等待配置应用...\n`);
      await new Promise((r) => setTimeout(r, 5));

      // The URL must reach the user through live output, all in one tool call.
      expect(updates.join('')).toContain(url);

      // User authorizes; device flow exits 0.
      authChild.close(0);
      const result = await promise;
      expect(result.authUrl).toBe(url);
    });

    it('should NOT recurse when an auth command itself reports not configured', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'config init --new' },
        new AbortController().signal,
      );

      child.emitStdout(NOT_CONFIGURED);
      child.close(1);
      await new Promise((r) => setTimeout(r, 10));

      // Only the single spawn — no auto-takeover loop for auth commands.
      expect(mockSpawn.mock.calls.length).toBe(1);
      await promise;
    });

    it('should NOT auto-start device flow for ordinary (non-config) failures', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
      );

      child.emitStderr('permission denied');
      child.close(1);
      await new Promise((r) => setTimeout(r, 10));

      // A normal failure must not trigger the device-flow takeover.
      expect(mockSpawn.mock.calls.length).toBe(1);
      const result = await promise;
      expect(result.status).toBe('failed');
    });

    it('should surface auth_required if the takeover device flow does not complete', async () => {
      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'im.messages.create' },
        new AbortController().signal,
      );

      bizChild.emitStdout(NOT_CONFIGURED);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      const url =
        'https://open.larksuite.com/page/cli?user_code=QQQ-0001&from=cli';
      authChild.emitStdout(`Open: ${url}\n`);
      // Device flow exits non-zero (user never authorized / code expired).
      authChild.close(1);

      const result = await promise;
      expect(result.status).toBe('auth_required');
      expect(result.authUrl).toBe(url);
    });
  });

  describe('execute - --format json NOT appended by default', () => {
    it('should NOT append --format json to commands', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
      );
      child.close(0);
      await promise;
      const cmdStr = mockSpawn.mock.calls[0][0] as string;
      expect(cmdStr).not.toContain('--format json');
    });

    it('should still allow explicit --format in user-provided args', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'api', args: ['--format', 'json'] },
        new AbortController().signal,
      );
      child.close(0);
      await promise;
      const cmdStr = mockSpawn.mock.calls[0][0] as string;
      // User explicitly passed --format, it should be preserved.
      expect(cmdStr).toContain('--format');
    });
  });

  describe('execute - user login required auto-takeover', () => {
    // Simulates lark-cli calendar error: calendar_user_login_required with
    // a hint containing the exact auth login command to run.
    const CALENDAR_LOGIN_REQUIRED = [
      'calendar_user_login_required',
      'calendar commands require a valid user login by default',
      'restore user login: `lark-cli auth login --domain calendar`',
      'intentional bot usage: rerun with `--as bot`',
    ].join('\n');

    it('should auto-start auth login --domain when calendar_user_login_required appears', async () => {
      const updates: string[] = [];

      // 1st spawn: calendar business command fails with login required.
      const bizChild = nextChild();
      // 2nd spawn: auto-triggered auth login --domain calendar.
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
        (out) => updates.push(out),
      );

      bizChild.emitStderr(CALENDAR_LOGIN_REQUIRED);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      // Must have spawned a second process for auth login.
      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('auth login');
      expect(authCmd).toContain('--domain calendar');
      // CRITICAL: backticks from the hint must NOT leak into the command.
      // lark-cli wraps hints like `lark-cli auth login --domain calendar`
      // and the trailing backtick must be stripped, otherwise we get
      // "unknown domain \"calendar`\"".
      expect(authCmd).not.toContain('calendar`');

      // Auth login prints verification URL.
      const url =
        'https://open.feishu.cn/page/cli?user_code=AUTH-1234&from=cli';
      authChild.emitStdout(`打开以下链接:\n\n  ${url}\n\n等待授权...\n`);
      await new Promise((r) => setTimeout(r, 5));
      expect(updates.join('')).toContain(url);

      authChild.close(0);
      const result = await promise;
      expect(result.authUrl).toBe(url);
    });

    it('should auto-start auth login --scope when need_user_authorization with scope hint', async () => {
      // Simulates the enriched error from enrichMissingScopeError:
      // need_user_authorization + "current command requires scope(s): X"
      const NEED_AUTH_WITH_SCOPE = [
        'need_user_authorization (user: )',
        'current command requires scope(s): calendar:calendar.event:read',
      ].join('\n');

      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'calendar event create' },
        new AbortController().signal,
      );

      bizChild.emitStderr(NEED_AUTH_WITH_SCOPE);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('auth login');
      // Should map to robust --domain parameter instead of fragile --scope
      expect(authCmd).toContain('--domain calendar');

      authChild.close(0);
      await promise;
    });

    it('should fallback to domain inference from command when hint has no auth login command', async () => {
      // Simulates need_user_authorization without a usable hint line.
      // e.g. just the marker with no domain or scope info.
      const NEED_AUTH_NO_HINT =
        'need_user_authorization (user: )';

      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
      );

      bizChild.emitStderr(NEED_AUTH_NO_HINT);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('auth login');
      // Fallback: infer domain from command's first segment ("calendar").
      expect(authCmd).toContain('--domain calendar');

      authChild.close(0);
      await promise;
    });

    it('should NOT auto-trigger auth login for "not configured" (that still uses config init)', async () => {
      // The existing "not configured" path must continue to use config init --new,
      // NOT auth login.
      const NOT_CONFIGURED_LOCAL = JSON.stringify({
        ok: false,
        identity: 'user',
        error: {
          type: 'config',
          message: 'not configured',
          hint: 'run `lark-cli config init --new` in the background.',
        },
      });
      const updates: string[] = [];
      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
        (out) => updates.push(out),
      );

      bizChild.emitStdout(NOT_CONFIGURED_LOCAL);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      const authCmd = mockSpawn.mock.calls[1][0] as string;
      // Must be config init, not auth login.
      expect(authCmd).toContain('config init');
      expect(authCmd).not.toContain('auth login');

      authChild.close(0);
      await promise;
    });
  });

  describe('execute - error hint enrichment', () => {
    it('should enrich unknown_subcommand error with hint and available list', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar list' },
        new AbortController().signal,
      );

      const errorJson = JSON.stringify({
        ok: false,
        error: {
          type: 'unknown_subcommand',
          message: 'unknown subcommand "list" for "lark-cli calendar"',
          hint: 'available subcommands: +agenda, +create, +freebusy, +room-find, +rsvp, +suggestion, +update, calendars, event.attendees, events, freebusys',
          detail: {
            available: [
              '+agenda', '+create', '+freebusy', '+room-find',
              '+rsvp', '+suggestion', '+update', 'calendars',
              'event.attendees', 'events', 'freebusys',
            ],
            command_path: 'lark-cli calendar',
            unknown: 'list',
          },
        },
      });

      child.emitStdout(errorJson);
      child.close(1);

      const result = await promise;
      expect(result.status).toBe('failed');
      // The hint must be included so the AI can self-correct.
      expect(result.error).toContain('available subcommands');
      expect(result.error).toContain('+agenda');
      expect(result.error).toContain('Available:');
      // The llmContent must also carry the enriched error.
      const parsed = JSON.parse(
        typeof result.llmContent === 'string'
          ? result.llmContent
          : JSON.stringify(result.llmContent),
      );
      expect(parsed.error).toContain('available subcommands');
    });

    it('should enrich unknown flag error with hint', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda', args: ['--date', 'today'] },
        new AbortController().signal,
      );

      const errorJson = JSON.stringify({
        ok: false,
        error: {
          type: 'validation',
          message: 'unknown flag: --date',
          hint: 'Run "lark-cli calendar +agenda --help" for usage.',
        },
      });

      child.emitStdout(errorJson);
      child.close(1);

      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.error).toContain('unknown flag: --date');
      expect(result.error).toContain('Hint:');
      expect(result.error).toContain('--help');
    });

    it('should handle non-JSON errors gracefully (no enrichment)', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'calendar +agenda' },
        new AbortController().signal,
      );

      child.emitStderr('permission denied');
      child.close(1);

      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.error).toContain('permission denied');
      expect(result.error).not.toContain('Hint:');
    });

    it('should block automatic takeover and return a clear admin approval hint when pending approval appears', async () => {
      const child = nextChild();
      const promise = tool.execute(
        { command: 'mail +triage' },
        new AbortController().signal,
      );

      child.emitStderr('authorization failed: Unable to authorize. The app is pending approval.');
      child.close(1);
      await new Promise((r) => setTimeout(r, 10));

      // Only 1 spawn — should NOT trigger automatic takeover because it's blocked by pending approval
      expect(mockSpawn.mock.calls.length).toBe(1);

      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.error).toContain('pending approval');
      expect(result.error).toContain('CRITICAL INFO FOR USER & AI');
      expect(result.error).toContain('IT/Feishu administrator');
    });

    it('should auto-trigger auth login when missing_scope error appears', async () => {
      const MISSING_SCOPE = JSON.stringify({
        ok: false,
        identity: 'user',
        error: {
          type: 'missing_scope',
          message:
            'missing required scope(s): mail:user_mailbox.message:readonly, mail:user_mailbox.message.subject:read',
          hint: 'run `lark-cli auth login --scope "mail:user_mailbox.message:readonly mail:user_mailbox.message.subject:read"` in the background.',
        },
      });

      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'mail +triage' },
        new AbortController().signal,
      );

      bizChild.emitStdout(MISSING_SCOPE);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      // Must have spawned auth login, not config init.
      expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('auth login');
      // Should map to robust --domain mail instead of fragile --scope
      expect(authCmd).toContain('--domain mail');

      authChild.close(0);
      await promise;
    });

    it('should extract --scope with quoted multi-scope value from hint and map to --domain', async () => {
      // The hint contains: lark-cli auth login --scope "scope1 scope2 scope3"
      // The quoted value must be parsed and mapped to safe, robust --domain flags.
      const MISSING_SCOPE_QUOTED = [
        'missing_scope',
        'run `lark-cli auth login --scope "mail:user_mailbox.message:readonly mail:user_mailbox.message.address:read mail:user_mailbox.message.subject:read mail:user_mailbox.message.body:read"` in the background.',
      ].join('\n');

      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'mail +triage' },
        new AbortController().signal,
      );

      bizChild.emitStderr(MISSING_SCOPE_QUOTED);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('auth login');
      // Should map to robust --domain mail
      expect(authCmd).toContain('--domain mail');
      // Backticks must NOT leak into the command.
      expect(authCmd).not.toContain('read`');

      authChild.close(0);
      await promise;
    });

    it('should append --recommend and --exclude when configured in project settings', async () => {
      const MISSING_SCOPE = JSON.stringify({
        ok: false,
        identity: 'user',
        error: {
          type: 'missing_scope',
          message: 'missing scope',
          hint: 'run `lark-cli auth login --scope "mail:user_mailbox.message:readonly"` in the background.',
        },
      });

      // Mock config's getProjectSettingsManager
      const mockProjectSettings = {
        feishu: {
          recommend: true,
          excludeScopes: ['im:message.send_as_user', 'mail:user_mailbox.message.body:read'],
        },
      };
      tool['config'].getProjectSettingsManager = vi.fn().mockReturnValue({
        load: vi.fn().mockReturnValue(mockProjectSettings),
      });

      const bizChild = nextChild();
      const authChild = nextChild();

      const promise = tool.execute(
        { command: 'mail +triage' },
        new AbortController().signal,
      );

      bizChild.emitStdout(MISSING_SCOPE);
      bizChild.close(1);
      await new Promise((r) => setTimeout(r, 10));

      const authCmd = mockSpawn.mock.calls[1][0] as string;
      expect(authCmd).toContain('auth login');
      expect(authCmd).toContain('--domain mail');
      expect(authCmd).toContain('--recommend');
      expect(authCmd).toContain('--exclude "im:message.send_as_user,mail:user_mailbox.message.body:read"');

      authChild.close(0);
      await promise;
    });
  });
});
