/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 无头 core Config 构造器（server 专用，零 Ink/CLI 依赖）。
 *
 * server 每个会话 = 一个 core Config 实例。CLI 的 loadCliConfig 牵入大量
 * 终端/设置依赖（yargs/Ink 邻近），不适合 server 直接复用。这里只用
 * otto-core 顶层导出的 Config + ConfigParameters，构造一个最小可跑对话的
 * headless Config：注入 BYO-key 自定义模型，开 YOLO 审批（无人值守，工具
 * 不交互确认，与 nonInteractiveCli/ACP 的 headless 取向一致）。
 *
 * initialize() / refreshAuth() 由 CoreSessionRuntime.initialize() 负责调用，
 * 本文件只负责「new Config(params)」这一步，保持职责单一。
 */

import {
  Config,
  ApprovalMode,
  generateCustomModelId,
  isCustomModel,
  type CustomModelConfig,
} from 'otto-core';
import os from 'node:os';
import { loadCustomModels, loadPreferredModel } from './customModels.js';

export interface CreateCoreConfigOptions {
  sessionId: string;
  /** 选定模型 id（'auto' 或 'custom:...'）；缺省由 core 取默认。 */
  model?: string;
  /** 工作目录（默认 server 进程 cwd）。 */
  cwd?: string;
  /** 覆盖自定义模型注入（测试用）；缺省从 ~/.otto-user/custom-models.json 读。 */
  customModels?: CustomModelConfig[];
  /** 会话级 Agent profile，经 Config.userRules 进入 system prompt。 */
  userRules?: string;
  /** 当前 runtime 是否服务于飞书会话；注入移动端/聊天渠道环境提示。 */
  feishuMode?: boolean;
  /** edition/角色对应的运行时禁用工具，不能只靠 renderer 隐藏。 */
  excludeTools?: string[];
}

/**
 * 构造一个未初始化的 headless core Config。
 *
 * 注意：这里**不**调用 initialize()/refreshAuth()——把它留给 runtime，
 * 因为这两步是 async 且会触发网络/鉴权，构造与初始化分离便于测试。
 */
/**
 * 默认工作目录（agent 主动保存的落点根）：正常用 server 进程 cwd；但 Electron .app 启动时
 * cwd 常是 '/'（只读根目录），会让 save_memory / 文件写入落到 /OTTO.md 之类只读位置而失败
 * （截图里的 EROFS）。这种情况退回用户主目录——可写，对个人助手也合理。
 * CLI（cwd = 真实项目目录）不受影响。
 */
export function resolveDefaultCwd(): string {
  const c = process.cwd();
  if (!c || c === '/' || c === '\\') return os.homedir();
  return c;
}

export function createCoreConfig(opts: CreateCoreConfigOptions): Config {
  const cwd = opts.cwd ?? resolveDefaultCwd();
  const customModels = opts.customModels ?? loadCustomModels();

  // ── LLM-URL 崩溃根因兜底（BYO-key 化后必备）──
  // OttoServerAdapter.generateContent 只有在 getModel() 返回 `custom:...` 时才走
  // callCustomModel（用模型自身的绝对 baseUrl）；否则落入已废弃的 easycode 代理分支，
  // 用空的 OTTO_SERVER_URL 拼出相对路径 `/v1/chat/messages` → fetch 抛
  // `Failed to parse URL from /v1/...`。
  // 这里在 server 侧做兜底：当 opts.model 不是 custom id（含 undefined / 'auto'）时，
  // 解析成第一个「已启用」自定义模型的 id，让 getModel() 返回 custom，彻底绕开空代理。
  // 一个自定义模型都没配时保持原样（由 server 的空态/mock 检测拦截）。
  const enabled = customModels.filter((m) => m.enabled !== false);
  const wantsCustom =
    typeof opts.model === 'string' && isCustomModel(opts.model);
  const wantsManaged =
    typeof opts.model === 'string' && opts.model.startsWith('otto:');
  // 会话未显式选模型时的兜底次序：
  //   1) makeActive 写入的「当前生效模型」preferredModel（前提：它仍在 enabled 列表里）；
  //   2) 退回第一个 enabled 自定义模型（历史行为）。
  // 这样多模型场景下「配置后立刻用新模型」（makeActive）才真正生效，而非永远跑 enabled[0]。
  const enabledIds = new Set(enabled.map((m) => generateCustomModelId(m)));
  const preferred = opts.customModels ? undefined : loadPreferredModel();
  const preferredIfEnabled =
    preferred && enabledIds.has(preferred) ? preferred : undefined;
  const resolvedModel = wantsCustom || wantsManaged
    ? opts.model
    : (preferredIfEnabled ??
      (enabled.length > 0 ? generateCustomModelId(enabled[0]) : opts.model));

  return new Config({
    sessionId: opts.sessionId,
    targetDir: cwd,
    cwd,
    debugMode: false,
    // YOLO：headless 无人确认，非危险工具直接执行（对齐 ACP/nonInteractive 默认）。
    // 危险工具的确认未来经 tool_confirmation_request 帧上抛（见 server.ts TODO）。
    approvalMode: ApprovalMode.YOLO,
    model: resolvedModel,
    customModels,
    userRules: opts.userRules,
    feishuMode: opts.feishuMode,
    excludeTools: opts.excludeTools,
    // 关闭遥测与使用统计（与 CLI 一致的隐私基线）。
    telemetry: { enabled: false, logPrompts: false },
    usageStatisticsEnabled: false,
    // server 是无界面进程：静默 + 不开浏览器。
    silentMode: true,
    noBrowser: true,
    // -1 = 不限会话回合数（与 CLI maxSessionTurns 默认一致）。
    maxSessionTurns: -1,
    // 代理透传环境变量（与 CLI 同源）。
    proxy:
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy,
  });
}
