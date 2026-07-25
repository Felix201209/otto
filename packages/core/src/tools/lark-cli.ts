/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { Type } from '@google/genai';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Throttle interval for pushing live output to the UI.
 */
const OUTPUT_UPDATE_INTERVAL_MS = 500;

/**
 * 安全:npx 兜底执行时锁定的 lark-cli 版本。避免使用 @latest——否则一旦注册表
 * 被劫持或上游被投毒,npx 会静默拉取被篡改的新版本造成 RCE。需要升级时在此
 * 显式更新版本号(并复核 changelog),不要回退到 @latest。
 */
const LARK_CLI_PINNED_VERSION = '1.0.53';

/**
 * Fallback watchdog timeout. The device-flow authorization (`auth login` /
 * `config init`) intentionally blocks for up to ~10 minutes while the user
 * authorizes in their browser, so we must NOT impose the 5-minute shell
 * timeout here. We allow a generous 15-minute ceiling purely to guard against
 * a permanently hung child process — normal commands return in well under a
 * second and never reach it.
 */
const FALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

const AUTH_URL_CANDIDATE_REGEX = /https:\/\/[^\s<>"'`]+/gi;
const AUTH_ACCOUNTS_HOSTS = new Set([
  'accounts.feishu.cn',
  'accounts.larksuite.com',
]);
const AUTH_OPEN_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com']);
const AUTH_USER_CODE_RE = /^[a-z0-9][a-z0-9_-]{3,63}$/i;
const AUTH_APP_ID_RE = /^[a-z0-9_-]{3,128}$/i;
const ANSI_ESCAPE = String.fromCharCode(27);

/**
 * Extract an official lark-cli authorization URL. Core must enforce the
 * same boundary as Desktop; otherwise a compromised tool output could turn an
 * attacker-controlled lookalike URL into an `auth_required` link.
 */
function extractAuthorizationUrl(output: string): string | undefined {
  const candidates =
    output.split(ANSI_ESCAPE).join('\n').match(AUTH_URL_CANDIDATE_REGEX) ?? [];

  for (const candidate of candidates) {
    const clean = candidate.replace(/[\])},.;，。；]+$/u, '');
    if (clean.length > 4096) continue;
    try {
      const url = new URL(clean);
      if (
        url.protocol !== 'https:' ||
        url.port !== '' ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== ''
      ) {
        continue;
      }

      const userCode = url.searchParams.get('user_code') ?? '';
      if (AUTH_ACCOUNTS_HOSTS.has(url.hostname)) {
        if (
          url.pathname === '/oauth/v1/device/verify' &&
          AUTH_USER_CODE_RE.test(userCode)
        ) {
          return clean;
        }
        continue;
      }

      if (!AUTH_OPEN_HOSTS.has(url.hostname)) continue;
      if (
        (url.pathname === '/page/cli' || url.pathname === '/page/launcher') &&
        AUTH_USER_CODE_RE.test(userCode)
      ) {
        return clean;
      }
      if (
        url.pathname === '/open-apis/authen/v1/index' &&
        AUTH_APP_ID_RE.test(url.searchParams.get('app_id') ?? '')
      ) {
        return clean;
      }
    } catch {
      // Ignore truncated or malformed candidates and inspect the next URL.
    }
  }
  return undefined;
}

/**
 * Commands that themselves perform authorization. We must never trigger the
 * automatic device-flow takeover for these, or we would recurse forever.
 */
function isAuthCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  return (
    c.startsWith('config init') ||
    c.startsWith('auth login') ||
    c.startsWith('auth logout')
  );
}

/**
 * 安全:校验 JSON.parse 出来的值是否为「可信结构化数据」——即纯对象或数组。
 * lark-cli 的输出可被供应链/MITM/prompt-injection 污染,顶层标量(字符串、
 * 数字、布尔、null)会被直接当成 data 注入 llmContent 交给模型。这里只放行
 * 结构化容器,其余一律退回纯文本兜底,杜绝把任意标量当成可信结果。
 */
function isPlainStructuredData(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * 安全:只透传 lark-cli / npx 子进程运行所必需的环境变量。
 * 绝不把 OPENAI_API_KEY / ANTHROPIC_API_KEY / GITHUB_TOKEN 等密钥泄露给
 * 第三方 CLI 子进程(最小权限原则)。lark-cli 通过自身配置目录鉴权,不需要这些密钥。
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const allowExact = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LANGUAGE',
    'TERM',
    'TMPDIR',
    'TEMP',
    'TMP',
    'TZ',
    'PWD',
    'COLUMNS',
    'LINES',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
  ]);
  // 安全:刻意不透传 NPM_*(如 NPM_CONFIG_REGISTRY / NPM_TOKEN / NPM_CONFIG_*)。
  // npx 兜底执行第三方 CLI 时,这些变量可被用于劫持 registry(供应链投毒/RCE)
  // 或把 npm 凭据泄露给子进程。npx 仍可读 .npmrc 完成正常安装,无需环境变量。
  const allowPrefix = ['LC_', 'LARK', 'FEISHU', 'NODE_', 'NVM_'];
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (allowExact.has(k) || allowPrefix.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Raw outcome of a single child-process run, before it is translated into a
 * user-facing LarkCliResult. Kept internal so execute() can inspect failures
 * and decide whether to auto-start the device-flow login.
 */
interface RawRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  authUrl?: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process failed to even launch (spawn error). */
  launchError?: string;
}

/**
 * Parameters for the LarkCliTool.
 */
export interface LarkCliParams {
  /**
   * The lark-cli command to run. Supports both shortcut style (with +) and normal API commands.
   */
  command: string;

  /**
   * List of arguments to append to the command.
   */
  args?: string[];

  /**
   * Switch authentication identity.
   */
  as?: 'user' | 'bot';
}

/**
 * Robust output structure for LarkCliTool, extending base ToolResult.
 */
export interface LarkCliResult extends ToolResult {
  status: 'success' | 'failed' | 'auth_required';
  data?: any;
  authUrl?: string;
  error?: string;
}

/**
 * LarkCliTool is a universal AI Agent-native wrapper around the official lark-cli.
 *
 * It runs the CLI as a long-lived child process and streams its output to the
 * UI in real time (like watching `ping` scroll). This is critical for the
 * device-flow authorization: the wrapper captures the verification URL the
 * instant lark-cli prints it and surfaces it to the user, while keeping the
 * child process alive in the background so it can keep polling. When the user
 * finishes authorizing, lark-cli exits 0 and the agent learns the flow
 * completed — all within a single tool call, with no manual shell juggling.
 */
export class LarkCliTool extends BaseTool<LarkCliParams, LarkCliResult> {
  static readonly Name: string = 'lark_cli';

  /** Reuse a verified executable instead of probing/spawning npm every call. */
  private detectedBinary?: string;

  constructor(private readonly config: Config) {
    super(
      LarkCliTool.Name,
      'LarkCli',
      [
        'Unified wrapper for the official lark-cli tool. Provides access to 18+ business domains in Lark (Feishu) for both automation and AI agent-driven workflows.',
        '',
        'RULES:',
        '- ALWAYS use this tool for every Lark/Feishu operation — NEVER run lark-cli via run_shell_command/shell.',
        '- ROUTING: When the user wants to create a project with a local directory AND a Feishu group chat bound together (e.g. "拉个群 + 项目路径", "create a project group"), use the `create_project_and_group_chat` tool instead — it handles directory creation, group creation, user invitation, and workspace binding in one call. Note: this tool is only available when the Feishu bot is running (/feishu start). If the tool is not listed, fall back to `im +chat-create` for a standalone group chat.',
        '- Authorization is fully automatic: if the CLI is not configured/authorized yet, this tool launches the browser device-flow login itself and streams the verification URL to the user in real time within the same call. Do NOT manually run "lark-cli config init" or "auth login" in a shell.',
        '- Do NOT guess subcommands or flags. If unsure what a command supports, run it with "--help" first (e.g. command="calendar --help"). Error responses include hints with available options — follow them instead of guessing.',
        '',
        'Search routing: current lark-cli does NOT support top-level command="+search". For user document/cloud-drive search, use command="drive +search"; for document body search, use command="docs +search". Legacy command="+search" is normalized to "drive +search" for compatibility.',
        'Drive list routing: current lark-cli misroutes command="drive files list" by treating "files" as a domain. Use command="drive +search" instead; legacy command="drive files list" is normalized to "drive +search" for compatibility.',
        '',
        'COMMON COMMAND CHEATSHEET (use these patterns to avoid trial-and-error):',
        '',
        '## Calendar',
        '- Today\'s agenda: command="calendar +agenda"',
        '- Agenda by date range: command="calendar +agenda" args=["--start", "2025-01-01", "--end", "2025-01-07"]',
        '- Create event: command="calendar +create" args=["--summary", "Meeting", "--start", "2025-01-01T10:00:00+08:00", "--end", "2025-01-01T11:00:00+08:00"]',
        '- Update event: command="calendar +update" args=["--event-id", "<id>", "--summary", "New Title"]',
        '- Free/busy query: command="calendar +freebusy" args=["--start", "2025-01-01", "--end", "2025-01-01"]',
        '- Find meeting rooms: command="calendar +room-find" args=["--slot", "2025-01-01T10:00:00+08:00~2025-01-01T11:00:00+08:00"]',
        '- RSVP to event: command="calendar +rsvp" args=["--event-id", "<id>", "--rsvp-status", "accept"]',
        '- Smart time suggestion: command="calendar +suggestion" args=["--start", "2025-01-01", "--end", "2025-01-07"]',
        '',
        '## Docs (Documents)',
        '- Create doc from file (RECOMMENDED for content >500 chars): command="docs +create" args=["--api-version", "v2", "--title", "Title", "--content", "@<relative-path>", "--doc-format", "markdown"]',
        '  CRITICAL: Use --content with @file (NOT inline text for long content — inline silently drops content; NOT --markdown — that flag does not exist for create). The @ prefix reads a local file (must be relative path like temp/myfile.md). For documents longer than ~500 characters, ALWAYS write content to a temp file first and use @<relative-path>. Also always include --title.',
        '- Create doc from short inline text: command="docs +create" args=["--api-version", "v2", "--title", "Title", "--content", "<short-text>", "--doc-format", "markdown"]',
        '- Fetch doc content: command="docs +fetch" args=["--api-version", "v2", "--doc", "<doc_url_or_token>"]',
        '  NOTE: The flag is --doc (NOT --document-id). Accepts document URL or plain token.',
        '- Update doc content: command="docs +update" args=["--api-version", "v2", "--doc", "<doc_url_or_token>", "--command", "overwrite", "--content", "@<relative-path>"]',
        '  CRITICAL: v2 API requires --command (overwrite|append) and --content (NOT --markdown --mode). Use --content with @file for long content. The @ prefix reads a local file (must be relative path like temp/myfile.md).',
        '- Search docs: command="docs +search" args=["--query", "<keyword>"]',
        '- Upload media to doc: command="docs +media-upload" args=["--file", "<relative-path>", "--document-id", "<id>"]',
        '',
        '## Sheets (Spreadsheets)',
        '- Create spreadsheet: command="sheets +create" args=["--title", "My Sheet"]',
        '- Read cells: command="sheets +read" args=["--spreadsheet-token", "<token>", "--range", "A1:D10"]',
        '- Write cells: command="sheets +write" args=["--spreadsheet-token", "<token>", "--range", "A1", "--value", "hello"]',
        '- Append rows: command="sheets +append" args=["--spreadsheet-token", "<token>", "--range", "A1:D1", "--values", "[[1,2,3,4]]"]',
        '- Find in sheet: command="sheets +find" args=["--spreadsheet-token", "<token>", "--find", "keyword"]',
        '- Export sheet: command="sheets +export" args=["--spreadsheet-token", "<token>", "--file", "output.xlsx"]',
        '',
        '## IM (Messaging)',
        '- Send message: command="im +messages-send" args=["--receive-id-type", "chat_id", "--receive-id", "<id>", "--msg-type", "text", "--content", "{\\"text\\":\\"hello\\"}"]',
        '- List chats: command="im +chat-list"',
        '- Search chats: command="im +chat-search" args=["--query", "<keyword>"]',
        '- List messages in chat: command="im +chat-messages-list" args=["--chat-id", "<id>"]',
        '- Reply to message: command="im +messages-reply" args=["--message-id", "<id>", "--msg-type", "text", "--content", "{\\"text\\":\\"reply\\"}"]',
        '- Create group chat (standalone, no project binding): command="im +chat-create" args=["--name", "Group Name"]',
        '- Search messages: command="im +messages-search" args=["--query", "<keyword>"]',
        '- Pin (flag) a message: command="im +flag-create" args=["--message-id", "<id>"]',
        '- Download message resource: command="im +messages-resources-download" args=["--message-id", "<id>", "--file-key", "<key>", "--file", "output.png"]',
        '',
        '## Drive (Cloud Drive)',
        '- Upload file: command="drive +upload" args=["--file", "<relative-path>"]',
        '- Download file: command="drive +download" args=["--file-token", "<token>", "--file", "output.bin"]',
        '- Create folder: command="drive +create-folder" args=["--name", "New Folder"]',
        '- Search files: command="drive +search" args=["--query", "<keyword>"]',
        '- Export document: command="drive +export" args=["--file-token", "<token>", "--type", "pdf"]',
        '',
        '## Tasks',
        '- My tasks: command="task +get-my-tasks"',
        '- Create task: command="task +create" args=["--summary", "Task title"]',
        '- Complete task: command="task +complete" args=["--task-id", "<id>"]',
        '- Search tasks: command="task +search" args=["--query", "<keyword>"]',
        '- Create tasklist: command="task +tasklist-create" args=["--name", "My List"]',
        '',
        '## Mail',
        '- List emails (triage): command="mail +triage" args=["--max", "20", "--format", "json"]',
        '- Filter emails by folder: command="mail +triage" args=["--filter", "{\\"folder\\":\\"INBOX\\"}", "--format", "json"]',
        '- Search emails by keyword: command="mail +triage" args=["--query", "keyword", "--format", "json"]',
        '- Read single email: command="mail +message" args=["--message-id", "<id>"]',
        '- Read multiple emails: command="mail +messages" args=["--message-ids", "id1,id2,id3"]',
        '- Send email: command="mail +send" args=["--to", "user@example.com", "--subject", "Hello", "--body", "Content", "--confirm-send"]',
        '- Reply to email: command="mail +reply" args=["--message-id", "<id>", "--body", "Reply content", "--confirm-send"]',
        '- Create draft: command="mail +draft-create" args=["--to", "user@example.com", "--subject", "Draft"]',
        '- View email thread: command="mail +thread" args=["--thread-id", "<id>"]',
        '',
        '## Wiki (Knowledge Base)',
        '- List spaces: command="wiki +space-list"',
        '- List nodes in space: command="wiki +node-list" args=["--space-id", "<id>"]',
        '- Create wiki node with content (TWO-STEP REQUIRED — do both steps in one turn, do NOT stop between them):',
        '  Step 1 — Create node (auto-creates empty docx): command="wiki +node-create" args=["--space-id", "<id>", "--title", "Title", "--node-type", "origin", "--obj-type", "docx"]',
        '  Step 2 — Fill auto-created doc with content: command="docs +update" args=["--api-version", "v2", "--doc", "<obj_token_from_step1_response>", "--command", "overwrite", "--content", "@<relative-path>"]',
        '  IMPORTANT: wiki +node-create does NOT have --obj-token flag (it has --obj-type and --origin-node-token). It always creates an empty backing document. The correct flow is: create node -> read obj_token from response -> docs +update to fill it.',
        '- Link a pre-existing doc to wiki (skip node-create, use raw API):',
        '  command="api" args=["POST", "/open-apis/wiki/v2/spaces/<space_id>/nodes", "--data", "{\"obj_type\":\"docx\",\"parent_node_token\":\"<parent_or_space_id>\",\"node_type\":\"origin\",\"origin_node_token\":\"<obj_token_of_doc>\",\"title\":\"Title\"}"]',
        '  Use this if you already created a doc via docs +create and now want to add it to the wiki.',
        '- Get node info: command="wiki +node-get" args=["--node-token", "<token>"]',
        '  NOTE: Returns node metadata including obj_type and obj_token. To read the actual content, use docs +fetch with the obj_token from the node-get result.',
        '  READING WIKI CONTENT (full workflow):',
        '    1. Get node info: command="wiki +node-get" args=["--node-token", "<wiki_token>"]',
        '    2. Read doc content: command="docs +fetch" args=["--api-version", "v2", "--doc", "<obj_token_from_step1>", "--doc-format", "markdown"]',
        '    3. If step 2 fails with old doc error, fall back to raw API (see lark_doc_read for details)',
        '- DELETE wiki node (including dead nodes): command="wiki +node-delete" args=["--space-id", "<id>", "--node-token", "<token>"]',
        '  FALLBACK for dead nodes (error 131005): If wiki +node-delete fails because the underlying document was already deleted, use the raw API:',
        '    command="api" args=["DELETE", "/open-apis/wiki/v2/spaces/<space_id>/nodes/<node_token>", "--data", "{\\\"obj_token\\\": \\\"<obj_token>\\\", \\\"obj_type\\\": \\\"wiki\\\"}"]',
        '  CRITICAL: First use wiki +node-get to obtain the obj_token, then pass it in the DELETE body. Without the explicit obj_token in the body, the API cannot identify the dead node.',
        '  KNOWN API LIMITATION: After a successful deletion, wiki +node-list may still show the deleted node for a short period (Feishu API caching delay). This is a Feishu API-side issue, not an Otto bug. If the node still appears, wait 1-2 minutes and list again — it should be gone. Do NOT attempt to delete it again if the first deletion returned success.',
        '',
        '## VC (Video Conference)',
        '- Search meetings: command="vc +search" args=["--start", "2025-01-01", "--end", "2025-01-07"]',
        '- Get meeting recording: command="vc +recording" args=["--meeting-id", "<id>"]',
        '- Get meeting notes: command="vc +notes" args=["--meeting-id", "<id>"]',
        '',
        '## Minutes (Meeting Minutes)',
        '- Search minutes: command="minutes +search" args=["--query", "<keyword>"]',
        '- Download minutes: command="minutes +download" args=["--minutes-id", "<id>"]',
        '',
        '## OKR',
        '- List OKR cycles: command="okr +cycle-list"',
        '- Get cycle detail: command="okr +cycle-detail" args=["--cycle-id", "<id>"]',
        '- Create progress: command="okr +progress-create" args=["--objective-id", "<id>", "--content", "Update"]',
        '',
        '## Contact',
        '- Search user: command="contact +search-user" args=["--query", "<name>"]',
        '- Get user info: command="contact +get-user" args=["--user-id", "<id>"]',
        '',
        '## Slides (Presentations)',
        '- Create slides: command="slides +create" args=["--title", "My Deck"]',
        '',
        '## Approval',
        '- Use API-style: command="approval" (then run --help for subcommands)',
        '',
        'HELP: Run command="<domain> --help" (e.g. "docs --help", "im --help") for full flag details of any domain.',
      ].join('\n'),
      Icon.Hammer,
      {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description:
              'The lark-cli subcommand or shortcut (e.g., "calendar +agenda", "im.messages.create").',
          },
          args: {
            type: Type.ARRAY,
            items: {
              type: Type.STRING,
            },
            description: 'Optional arguments/flags to append to the command.',
          },
          as: {
            type: Type.STRING,
            enum: ['user', 'bot'],
            description:
              'Optional identity under which the command will be run.',
          },
        },
        required: ['command'],
      },
      true, // isOutputMarkdown
      true, // forceMarkdown — render output in full (do not height-truncate), so the device-flow authorization QR code stays scannable in the terminal instead of being folded into "... omitted N lines ..."
      true, // canUpdateOutput — stream live output (URL capture, auth waiting)
    );
  }

  /**
   * Validates parameters using standard SchemaValidator and custom business rules.
   */
  validateToolParams(params: LarkCliParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      LarkCliTool.Name,
    );
    if (errors) {
      return errors;
    }

    if (
      !params.command ||
      typeof params.command !== 'string' ||
      params.command.trim() === ''
    ) {
      return 'Parameter "command" must be a non-empty string.';
    }

    // 安全:command 会直接拼进 shell:true 的命令串。lark-cli 合法 command 形如
    // "calendar +agenda" / "docs +create" / "config init",只含字母数字与空格及 _ + - . / : =。
    // 拦截一切 shell 元字符(; | & $ ` ( ) < > 等),防命令注入(LLM 工具调用 → RCE)。
    if (!/^[A-Za-z0-9 _+./:=-]+$/.test(params.command)) {
      return 'Parameter "command" contains disallowed characters; only letters, digits, spaces and _ + - . / : = are allowed (shell metacharacters are blocked for security).';
    }

    if (params.args !== undefined) {
      if (!Array.isArray(params.args)) {
        return 'Parameter "args" must be an array of strings.';
      }
      for (const arg of params.args) {
        if (typeof arg !== 'string') {
          return 'Each argument in "args" array must be a string.';
        }
      }
    }

    if (params.as !== undefined) {
      if (params.as !== 'user' && params.as !== 'bot') {
        return 'Parameter "as" must be either "user" or "bot".';
      }
    }

    return null;
  }

  getDescription(params: LarkCliParams): string {
    const command = this.normalizeCommand(params.command);
    const argsStr = params.args ? ` with args [${params.args.join(', ')}]` : '';
    const identityStr = params.as ? ` as ${params.as}` : '';
    const normalizedStr =
      command === params.command.trim()
        ? ''
        : ` (normalized from "${params.command}")`;
    return `Running lark-cli command: "${command}"${normalizedStr}${argsStr}${identityStr}`;
  }

  /**
   * Detects whether lark-cli is installed globally on the user's system,
   * otherwise falls back to a zero-installation npx on-demand execution.
   */
  private detectBinary(): string {
    if (this.detectedBinary) return this.detectedBinary;

    // `npx @larksuite/cli` resolves npm and starts a Node wrapper on every
    // invocation (roughly two seconds even after the package is warm). Once
    // npm has installed our exact pinned version, call its platform-native
    // binary directly. This keeps the first-run zero-install experience while
    // making every later Feishu operation pay only the CLI/API cost.
    const cachedNativeBinary = this.findPinnedNpxNativeBinary();
    if (cachedNativeBinary) {
      this.detectedBinary = this.sanitizeArg(cachedNativeBinary);
      return this.detectedBinary;
    }

    try {
      // Probing local environment for globally-installed binary. Use a
      // synchronous probe with a short timeout so it never blocks the flow.
      const probe = spawnSync('lark-cli', ['--version'], {
        timeout: 5000,
        shell: true,
        env: buildChildEnv(),
      });
      if (probe.status === 0) {
        this.detectedBinary = 'lark-cli';
        return this.detectedBinary;
      }
    } catch {
      // ignore and fall through to npx
    }
    // Graceful fallback to avoid sudo/permission blocks.
    // 安全:固定版本而非 @latest,避免供应链/registry 劫持时 npx 静默拉取
    // 被篡改的新版本(@latest 每次解析为注册表当下返回的内容)。升级 lark-cli
    // 时显式 bump 此处版本号即可。
    return `npx @larksuite/cli@${LARK_CLI_PINNED_VERSION}`;
  }

  /**
   * Finds the native executable installed by npx for the exact pinned package.
   * We deliberately inspect only npm's standard per-user cache and verify the
   * package name/version before using it; arbitrary similarly named binaries
   * elsewhere on disk are ignored.
   */
  private findPinnedNpxNativeBinary(): string | undefined {
    const npmCacheRoots = [path.join(os.homedir(), '.npm')];
    if (os.platform() === 'win32' && process.env.LOCALAPPDATA) {
      npmCacheRoots.unshift(path.join(process.env.LOCALAPPDATA, 'npm-cache'));
    }

    for (const npmCacheRoot of npmCacheRoots) {
      const npxRoot = path.join(npmCacheRoot, '_npx');
      let installs: string[];
      try {
        installs = readdirSync(npxRoot);
      } catch {
        continue;
      }

      for (const install of installs) {
        const packageDir = path.join(
          npxRoot,
          install,
          'node_modules',
          '@larksuite',
          'cli',
        );
        try {
          const manifest = JSON.parse(
            readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
          ) as { name?: string; version?: string };
          if (
            manifest.name !== '@larksuite/cli' ||
            manifest.version !== LARK_CLI_PINNED_VERSION
          ) {
            continue;
          }

          const nativeBinary = path.join(
            packageDir,
            'bin',
            os.platform() === 'win32' ? 'lark-cli.exe' : 'lark-cli',
          );
          if (existsSync(nativeBinary)) return nativeBinary;
        } catch {
          // Ignore incomplete/invalid npm cache entries and inspect the next.
        }
      }
    }
    return undefined;
  }

  /**
   * Escapes arguments to secure the command execution against shell command injections.
   *
   * 安全:这些参数最终会拼进 `spawn(cmdString, { shell: true })` 的命令串,交给
   * /bin/sh 执行。先剥掉换行/回车(\r\n),再用双引号包裹并转义 " $ ` \,做到:
   *   1. 换行/回车被中和,绝不可能断出新的 shell 命令(防换行注入,纵深防御);
   *   2. 双引号转义防止提前闭合引号、反引号/$ 转义防止命令替换与变量展开。
   * lark-cli 的长内容一律走 @file(见 cheatsheet),内联参数本就不应含裸换行,
   * 因此剥离换行不会破坏正常用法。
   */
  private sanitizeArg(arg: string): string {
    const withoutNewlines = arg.replace(/[\r\n]+/g, ' ');
    return `"${withoutNewlines.replace(/(["$`\\])/g, '\\$1')}"`;
  }

  /**
   * Keeps Otto compatible with older prompts and broken lark-cli routes that
   * have safe shortcut equivalents.
   */
  private normalizeCommand(command: string): string {
    const normalized = command.trim().replace(/\s+/g, ' ');
    if (normalized === '+search' || normalized === 'drive files list') {
      return 'drive +search';
    }
    return normalized;
  }

  /**
   * Builds the full command string passed to the shell.
   */
  private buildCommand(params: LarkCliParams, binary: string): string {
    const command = this.normalizeCommand(params.command);
    let cmdString = `${binary} ${command}`;

    if (params.args && params.args.length > 0) {
      const sanitized = params.args.map((arg) => this.sanitizeArg(arg));
      cmdString += ` ${sanitized.join(' ')}`;
    }

    // NOTE: --format is a local flag only supported by api/service/shortcut
    // subcommands. Many commands (config init, auth login, --help, etc.) reject
    // it with "unknown flag: --format". Moreover, api/service subcommands
    // already default to JSON output, so adding it is both unnecessary and
    // harmful. Do NOT append --format here.

    if (params.as) {
      cmdString += ` --as ${params.as}`;
    }

    return cmdString;
  }

  async execute(
    params: LarkCliParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<LarkCliResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        status: 'failed',
        error: validationError,
        llmContent: JSON.stringify({
          status: 'failed',
          error: validationError,
        }),
        returnDisplay: `Parameter validation failed: ${validationError}`,
      };
    }

    const binary = this.detectBinary();
    const cmdString = this.buildCommand(params, binary);

    // Run the requested command.
    const raw = await this.runStreaming(cmdString, signal, updateOutput);

    // Automatic device-flow takeover: if a business command fails purely
    // because the CLI is not configured/authorized yet, transparently start
    // the appropriate auth flow in the SAME tool call instead of bubbling up
    // lark-cli's hints (which would tempt the agent to fall back to a raw
    // shell command, hiding the URL from the user). We skip this for auth
    // commands themselves to avoid infinite recursion.
    const normalizedCommand = this.normalizeCommand(params.command);
    if (!isAuthCommand(normalizedCommand) && this.needsAuthorization(raw)) {
      const failureType = this.classifyAuthFailure(raw);
      let authCmd: string;

      if (failureType === 'login') {
        // User login required: extract the auth login command from the hint
        // or infer domain from the original command.
        authCmd = this.extractAuthLoginCommand(raw, normalizedCommand, binary);

        // Apply project-level Feishu/Lark authorization scope minimization rules
        let feishuSettings:
          | { recommend?: boolean; excludeScopes?: string[] }
          | undefined;
        if (typeof this.config.getProjectSettingsManager === 'function') {
          try {
            const projectSettings = this.config
              .getProjectSettingsManager()
              .load();
            feishuSettings = projectSettings?.feishu;
          } catch {
            // ignore
          }
        }

        // 默认不强制排除任何 scope。早期版本默认排除 "im:message.send_as_user",
        // 但按域登录(task / calendar 等)的请求 scope 集里根本没有这个 scope,
        // lark-cli 会因 "--exclude 的 scope 不在请求集中" 直接报错,导致这些域
        // 一律登录失败(例如今日任务一条都查不到)。需要收紧权限的企业可通过
        // settings.json 的 feishu.excludeScopes 显式配置。
        const defaultExcludes: string[] = [];
        const configuredExcludes = feishuSettings?.excludeScopes || [];
        const uniqueExcludes = Array.from(
          new Set([...defaultExcludes, ...configuredExcludes]),
        );

        if (feishuSettings?.recommend && !authCmd.includes('--recommend')) {
          authCmd += ' --recommend';
        }

        if (uniqueExcludes.length > 0 && !authCmd.includes('--exclude')) {
          // 安全:excludeScopes 来自用户可写的 settings.json,过滤为合法 scope 格式后再转义,
          // 防止经 shell:true 注入命令。
          // 合法 Lark scope 可含多段冒号与数字(如 mail:user_mailbox.message.body:read、
          // docx:document:readonly、im:message.receive_v1)。只放行字母/数字/下划线/点/冒号——
          // 均非 shell 元字符,杜绝经 shell:true 注入;随后还会经 sanitizeArg 加引号转义。
          const safeExcludes = uniqueExcludes.filter((s) =>
            /^[a-z0-9_]+:[a-z0-9_.:]+$/i.test(s),
          );
          if (safeExcludes.length > 0) {
            authCmd += ` --exclude ${this.sanitizeArg(safeExcludes.join(','))}`;
          }
        }

        if (updateOutput) {
          if (this.config.getFeishuMode()) {
            updateOutput(
              '🔑 Lark CLI 需要用户登录。正在启动浏览器授权，请稍候...\n',
            );
          } else {
            updateOutput(
              '🔑 Lark CLI requires user login. Starting browser authorization...\n',
            );
          }
        }
      } else {
        // App not configured: use config init --new.
        authCmd = `${binary} config init --new`;
        if (updateOutput) {
          if (this.config.getFeishuMode()) {
            updateOutput(
              '⚙️  Lark CLI 尚未配置。正在启动应用配置，请稍候...\n',
            );
          } else {
            updateOutput(
              '⚙️  Lark CLI is not configured yet. Starting app setup...\n',
            );
          }
        }
      }

      const authRaw = await this.runStreaming(authCmd, signal, updateOutput);
      return this.buildResult(authRaw);
    }

    return this.buildResult(raw);
  }

  /**
   * Detects authorization-related failures that warrant an automatic device-flow
   * takeover. Covers two distinct scenarios:
   *
   * 1. "not configured" — the CLI has no app bound yet. Needs `config init --new`.
   * 2. "user_login_required" / "need_user_authorization" — the CLI has an app
   *    but no user is logged in. Needs `auth login --domain <X>` or `--scope <Y>`.
   */
  private needsAuthorization(raw: RawRunResult): boolean {
    if (raw.code === 0 || raw.timedOut || raw.aborted) return false;
    const haystack = `${raw.stdout}\n${raw.stderr}`.toLowerCase();

    // If the app is pending approval by the enterprise admin, automatic takeover
    // will never succeed and will only loop. We must not trigger takeover here.
    if (haystack.includes('pending approval')) {
      return false;
    }

    return (
      haystack.includes('not configured') ||
      haystack.includes('"type": "config"') ||
      haystack.includes('"type":"config"') ||
      /lark-cli\s+config\s+init/.test(haystack) ||
      haystack.includes('user_login_required') ||
      haystack.includes('need_user_authorization') ||
      haystack.includes('missing_scope')
    );
  }

  /**
   * Classifies the authorization failure to determine the correct takeover
   * command. Returns one of:
   *   - 'config'  → app not bound, needs `config init --new`
   *   - 'login'   → user not logged in, needs `auth login`
   */
  private classifyAuthFailure(raw: RawRunResult): 'config' | 'login' {
    const haystack = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
    if (
      haystack.includes('user_login_required') ||
      haystack.includes('need_user_authorization') ||
      haystack.includes('missing_scope')
    ) {
      return 'login';
    }
    return 'config';
  }

  /**
   * Extracts the `auth login` command from lark-cli's error hint. lark-cli
   * enriches its errors with lines like:
   *   "restore user login: `lark-cli auth login --domain calendar`"
   *   "current command requires scope(s): calendar:calendar.event:read"
   *
   * Priority:
   *   1. Exact auth login command from hint (most reliable).
   *   2. Scope from "requires scope(s):" hint → `auth login --scope <scope>`.
   *   3. Domain fallback from the command's first segment → `auth login --domain <seg>`.
   */
  private extractAuthLoginCommand(
    raw: RawRunResult,
    originalCommand: string,
    binary: string,
  ): string {
    // 安全:lark-cli 输出受供应链/MITM 影响,可能被恶意撑到超大体积。在用于正则
    // 匹配前先截断到 8KB 上限,作为 ReDoS 的兜底防线(配合下面的线性正则)。
    const haystack = `${raw.stdout}\n${raw.stderr}`.slice(0, 8 * 1024);

    // 1. Look for an explicit "lark-cli auth login --domain/--scope" in the hint.
    //    lark-cli wraps the command in backticks for display, so we must
    //    exclude trailing backticks from the captured value (e.g.
    //    "`lark-cli auth login --domain calendar`" — the closing backtick is
    //    NOT part of the domain).
    //
    //    The --scope value may be quoted and contain spaces:
    //    `lark-cli auth login --scope "scope1 scope2 scope3"`
    //    So we match both unquoted (--scope foo) and quoted (--scope "foo bar")
    //    forms, stopping at a closing backtick or end-of-string.
    //
    //    CRITICAL PRO-TIP: On Windows/win32 systems (and for general stability),
    //    requesting raw scopes with spaces/quotes can get mangled by shell argument
    //    escaping, or fail because the open platform rejects specific scope granularities.
    //    Instead, we dynamically map any extracted "--scope" list into a safe,
    //    quote-free, comma-separated "--domain" list (e.g. "--domain mail").
    //
    //    安全:旧式 --scope 分支用过 `[^\s`]+(?:\s+[^\s`]+)*` 的嵌套量词,在对抗性
    //    输入下会发生灾难性回溯(ReDoS)。改用单一字符类 `[^`\n]+` 一次性吃到换行
    //    或闭合反引号,语义不变(同样在闭合反引号/行尾停下,可含空格),但回溯线性。
    const authCmdMatch = haystack.match(
      /lark-cli\s+auth\s+login\s+(--domain\s+[^\s`]+|--scope\s+(?:"[^"]*"|[^`\n]+))/,
    );
    if (authCmdMatch) {
      const matchStr = authCmdMatch[1]; // e.g., --domain calendar or --scope "mail:..."
      if (matchStr.startsWith('--scope')) {
        // Extract raw scope string inside quotes or unquoted.
        // 安全:非引号分支同样改用单一字符类 `[^`\n]+`(线性,无嵌套量词),
        // 避免 ReDoS;语义不变,仍可含空格、停在反引号/行尾。
        const scopeContentMatch =
          matchStr.match(/--scope\s+"([^"]*)"/) ||
          matchStr.match(/--scope\s+([^`\n]+)/);
        if (scopeContentMatch) {
          // Strip literal backslashes and quotes (e.g. from escaped \" in JSON errors)
          const rawScopes = scopeContentMatch[1].replace(/[\\'"]+/g, '');
          // Split scopes by space or comma
          const scopes = rawScopes.split(/[\s,]+/).filter(Boolean);
          // Extract unique domain prefixes (before the first colon, e.g. "mail" from "mail:user_mailbox.message")
          const domains = Array.from(
            new Set(
              scopes
                .map((s) => s.split(':')[0])
                .filter((d) => d && d.length > 0),
            ),
          );
          // 安全:domain 来自 lark-cli 输出(供应链/MITM 可控),仅接受安全字符防注入。
          const safeDomains = domains.filter((d) => /^[a-z_]+$/i.test(d));
          if (safeDomains.length > 0) {
            // Map the scopes to robust, quote-free --domain parameters!
            return `${binary} auth login --domain ${safeDomains.join(',')}`;
          }
        }
      }

      // If it is --domain, extract & whitelist the domain value. Never re-attach the
      // raw matched text — it could carry shell metacharacters from upstream output.
      const domainOnly = matchStr.match(/--domain\s+([^\s`]+)/);
      if (domainOnly) {
        const safe = domainOnly[1]
          .split(',')
          .filter((d) => /^[a-z_]+$/i.test(d));
        if (safe.length > 0) {
          return `${binary} auth login --domain ${safe.join(',')}`;
        }
      }
      return `${binary} auth login`;
    }

    // 2. Look for "current command requires scope(s): X, Y"
    const scopeMatch = haystack.match(
      /current command requires scope\(s\):\s*(.+)/i,
    );
    if (scopeMatch) {
      // Use the first scope listed; strip trailing punctuation/backticks.
      const scope = scopeMatch[1]
        .split(',')[0]
        .trim()
        .replace(/[`'"]+$/, '');
      const domain = scope.split(':')[0];
      // 安全:scope/domain 来自 lark-cli 输出,白名单校验后再拼,杜绝命令注入。
      if (/^[a-z_]+$/i.test(domain)) {
        return `${binary} auth login --domain ${domain}`;
      }
      if (/^[a-z_]+:[a-z_.]+$/i.test(scope)) {
        return `${binary} auth login --scope ${scope}`;
      }
      return `${binary} auth login`;
    }

    // 3. Fallback: infer domain from the command's first segment.
    //    e.g. "calendar +agenda" → domain="calendar"
    const domain = originalCommand.trim().split(/\s+/)[0];
    if (/^[a-z_]+$/i.test(domain)) {
      return `${binary} auth login --domain ${domain}`;
    }

    // Last resort: plain auth login (user will pick domain interactively).
    return `${binary} auth login`;
  }

  /**
   * Spawns the CLI as a long-lived child process and streams its stdout/stderr
   * to the UI in real time. Resolves when the process exits (the exit code
   * tells us whether the device-flow authorization completed), is aborted, or
   * trips the fallback watchdog timeout. Returns the raw execution outcome;
   * callers translate it into a structured LarkCliResult.
   */
  private runStreaming(
    cmdString: string,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<RawRunResult> {
    return new Promise<RawRunResult>((resolve) => {
      const child = spawn(cmdString, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildChildEnv(),
      });

      let stdout = '';
      let stderr = '';
      let combined = '';
      let authUrl: string | undefined;
      let lastUpdateTime = 0;
      let settled = false;

      const flush = (force = false) => {
        if (!updateOutput) return;
        const now = Date.now();
        if (!force && now - lastUpdateTime < OUTPUT_UPDATE_INTERVAL_MS) return;
        lastUpdateTime = now;
        // When we have already captured an auth URL, keep it pinned at the top
        // so the user always sees the actionable link while the process waits.
        let banner = '';
        if (authUrl) {
          if (this.config.getFeishuMode()) {
            banner = `🔑 飞书网关模式：请点击以下链接进行授权。打开链接后，选择 “已有应用”，选择本机器人即可：\n🔗 ${authUrl}\n\n`;
          } else {
            banner = `🔑 Authorization required — open this URL to continue:\n${authUrl}\n\n`;
          }
        }
        updateOutput(banner + combined);
      };

      const onData = (buf: Buffer, isErr: boolean) => {
        const str = buf.toString('utf8');
        if (isErr) {
          stderr += str;
        } else {
          stdout += str;
        }
        combined += str;

        // Capture the authorization URL the instant it is printed and push it
        // to the user immediately (force flush, bypassing throttle).
        if (!authUrl) {
          const captured = extractAuthorizationUrl(combined);
          if (captured) {
            authUrl = captured;
            flush(true);
            return;
          }
        }
        flush();
      };

      child.stdout?.on('data', (buf: Buffer) => onData(buf, false));
      child.stderr?.on('data', (buf: Buffer) => onData(buf, true));

      const killChild = () => {
        if (child.killed) return;
        try {
          if (os.platform() === 'win32' && child.pid) {
            spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          // best effort
        }
      };

      let timedOut = false;
      let aborted = false;

      // Fallback watchdog: guard against a permanently hung process. Normal
      // commands finish in milliseconds; only a stuck device-flow would linger.
      const timeoutId = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killChild();
      }, FALLBACK_TIMEOUT_MS);

      const onAbort = () => {
        if (settled) return;
        aborted = true;
        killChild();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = () => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
      };

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        const errMessage = err.message || 'Failed to launch lark-cli';
        resolve({
          code: null,
          stdout,
          stderr,
          authUrl,
          timedOut,
          aborted,
          launchError: errMessage,
        });
      });

      child.on('exit', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        flush(true);
        resolve({ code, stdout, stderr, authUrl, timedOut, aborted });
      });
    });
  }

  /**
   * Translates the terminated child process into a structured LarkCliResult.
   */
  private buildResult(ctx: RawRunResult): LarkCliResult {
    const { code, stdout, stderr, authUrl, timedOut, aborted, launchError } =
      ctx;
    const output = stdout.trim();

    if (launchError) {
      const data = { status: 'failed', error: launchError, stderr };
      return {
        status: 'failed',
        error: launchError,
        llmContent: JSON.stringify(data),
        returnDisplay: `❌ lark-cli execution failed: ${launchError}`,
        summary: 'Failed',
      };
    }

    if (timedOut) {
      const errMessage = `lark-cli timed out after ${FALLBACK_TIMEOUT_MS / 60000} minutes`;
      const data = { status: 'failed', error: errMessage, stderr };
      return {
        status: 'failed',
        error: errMessage,
        llmContent: JSON.stringify(data),
        returnDisplay: `❌ ${errMessage}`,
        summary: 'Timed out',
      };
    }

    if (aborted) {
      const errMessage = 'lark-cli execution was cancelled';
      const data = { status: 'failed', error: errMessage, stderr };
      return {
        status: 'failed',
        error: errMessage,
        llmContent: JSON.stringify(data),
        returnDisplay: `⏹️ ${errMessage}`,
        summary: 'Cancelled',
      };
    }

    // Successful exit. If an auth URL was seen and exit code is 0, the
    // device-flow authorization completed successfully.
    if (code === 0) {
      // 安全:output 来自 lark-cli(供应链/MITM/prompt-injection 可控)。盲目
      // JSON.parse 后直接塞进 data/llmContent 交给模型,等于把任意结构(甚至
      // 顶层标量、被精心构造的字段)当成可信结构化结果。这里做基本类型/结构校验:
      // 仅接受「纯对象」或「数组」作为结构化 data;其余(标量、null、解析失败)
      // 一律当作不可信纯文本 {rawOutput},不信任其内部内容。
      let parsedData: any;
      try {
        const candidate = JSON.parse(output || '{}');
        parsedData = isPlainStructuredData(candidate)
          ? candidate
          : { rawOutput: output };
      } catch {
        parsedData = { rawOutput: output };
      }

      const result: LarkCliResult = {
        status: 'success',
        data: parsedData,
        llmContent: JSON.stringify({ status: 'success', data: parsedData }),
        returnDisplay: output || 'lark-cli executed successfully.',
        summary: 'Success',
      };
      if (authUrl) {
        result.authUrl = authUrl;
      }
      return result;
    }

    // Non-zero exit. If we captured an auth URL, the user likely has not
    // finished authorizing yet — surface it as auth_required so the agent can
    // re-prompt instead of treating it as a hard failure.
    if (authUrl) {
      const data = { status: 'auth_required', authUrl };
      let returnDisplay = `🔑 Authentication Required: Please authorize via: ${authUrl}`;
      if (this.config.getFeishuMode()) {
        returnDisplay = `🔑 飞书网关模式：需要登录认证，请点击以下链接进行授权。打开链接后，选择 “已有应用”，选择本机器人即可：\n🔗 ${authUrl}`;
      }
      return {
        status: 'auth_required',
        authUrl,
        llmContent: JSON.stringify(data),
        returnDisplay,
        summary: 'Auth Required',
      };
    }

    const errMessage =
      stderr.trim() || output || `lark-cli exited with code ${code}`;

    // Enrich the error with structured hints from lark-cli's JSON error
    // response so the AI can self-correct instead of guessing. lark-cli
    // returns errors like:
    //   { error: { type: "unknown_subcommand", message: "...",
    //     hint: "available subcommands: +agenda, +create, ...",
    //     detail: { available: [...], unknown: "list" } } }
    // or:
    //   { error: { type: "validation", message: "unknown flag: --date",
    //     hint: "..." } }
    let enrichedHint = '';

    if (errMessage.toLowerCase().includes('pending approval')) {
      enrichedHint += `\n\n🔒 CRITICAL INFO FOR USER & AI:\nThe Feishu/Lark application is currently pending approval by your corporate enterprise administrator.\n👉 Action required: Please contact your IT/Feishu administrator to approve this custom app in the Feishu Admin Console (飞书管理后台 - 版本管理与发布) first, then run this command again. Do NOT try other authentication or login commands because they will also be blocked until approved.`;
    }

    try {
      const parsed = JSON.parse(errMessage);
      const errObj = parsed?.error;
      if (errObj) {
        if (errObj.hint) {
          enrichedHint += `\n💡 Hint: ${errObj.hint}`;
        }
        if (errObj.detail?.available) {
          enrichedHint += `\n📋 Available: ${errObj.detail.available.join(', ')}`;
        }
        if (errObj.message && !errMessage.includes(errObj.message)) {
          enrichedHint += `\n📄 ${errObj.message}`;
        }
      }
    } catch {
      // Not JSON — nothing to enrich.
    }

    const enrichedMessage = enrichedHint
      ? `${errMessage}${enrichedHint}`
      : errMessage;

    const data = { status: 'failed', error: enrichedMessage, stderr };
    return {
      status: 'failed',
      error: enrichedMessage,
      llmContent: JSON.stringify(data),
      returnDisplay: `❌ lark-cli execution failed: ${enrichedMessage}`,
      summary: 'Failed',
    };
  }
}
