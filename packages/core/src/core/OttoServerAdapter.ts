/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import {
  GenerateContentResponse,
  GenerateContentParameters,
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  FinishReason,
} from '@google/genai';
import { stripUIFieldsFromArray } from '../types/extendedContent.js';
import { ContentGenerator } from './contentGenerator.js';
import { Config } from '../config/config.js';
import { UserTierId } from '../code_assist/types.js';
import { proxyAuthManager } from './proxyAuth.js';
import { getActiveProxyServerUrl } from '../config/proxyConfig.js';
import { logger } from '../utils/enhancedLogger.js';
import { getDefaultAuthHandler } from '../auth/authNavigator.js';
import { UnauthorizedError, isOurAuthError } from '../utils/errors.js';
import { SceneType, SceneManager } from './sceneManager.js';
import { retryWithBackoff, getErrorStatus } from '../utils/retry.js';
import { isDeepXQuotaError } from '../utils/quotaErrorDetection.js';

import { realTimeTokenEventManager } from '../events/realTimeTokenEvents.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { getGlobalDispatcher } from 'undici';
import { isCustomModel, resolveThinkingConfig, effortToGeminiLevel, effortToGeminiBudget, effortToOpenAIEffort, effortToAnthropicEffort, effortToAnthropicBudget, ThinkingConfig, isAdaptiveThinkingClaude, applyAnthropicAdaptiveThinking } from '../types/customModel.js';
import { callCustomModel, callCustomModelStream } from './customModelAdapter.js';
import { getGitRemotes, getGitBranch, getSubdirectoryGitInfos, getGitCommitSha, getGitProjectPath } from '../utils/gitUtils.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * 把出站请求体落盘到 ~/.deepv/last-N-requests/ 用于事后诊断。
 *
 * 用途：当用户报告"X 模型 Y 现象不对"时，用 scripts/probe-replay-cli-request.mjs
 * 直接读取这个文件做字节级对账，避免依赖协议层猜测。
 *
 * - 滚动保留最近 5 次（按调用时间命名）
 * - 同时维护 last-stream-request.json 软链等价文件指向最新一次（兼容旧 probe 脚本）
 * - 异步写入，失败只 warn 不阻塞主流程
 * - 不阻塞 fetch：调用方"fire and forget"
 *
 * @param kind  'stream' | 'unified'  区分流式 / 非流式路径
 * @param body  即将作为 JSON.stringify 出站的请求体对象
 */
const REQUEST_DUMP_DIR = path.join(os.homedir(), '.otto-user', 'last-requests');
const REQUEST_DUMP_LATEST = path.join(os.homedir(), '.otto-user', 'last-stream-request.json');
const REQUEST_DUMP_RING_SIZE = 5;
function dumpOutboundRequest(kind: 'stream' | 'unified', body: unknown): void {
  // 同步部分尽量短；真正落盘走 promise 异步
  let serialized: string;
  let size: number;
  try {
    serialized = JSON.stringify(body, null, 2);
    size = serialized.length;
  } catch {
    return; // 含循环引用等极端情况，直接放弃
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ringFile = path.join(REQUEST_DUMP_DIR, `${ts}_${kind}.json`);

  // 异步执行，错误吞掉避免污染主流程
  void (async () => {
    try {
      await fs.promises.mkdir(REQUEST_DUMP_DIR, { recursive: true });
      await fs.promises.writeFile(ringFile, serialized, 'utf8');

      // 维护 ring：保留最近 N 个，删掉更老的
      const entries = await fs.promises.readdir(REQUEST_DUMP_DIR);
      const sorted = entries
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse(); // 最新在前
      const toDelete = sorted.slice(REQUEST_DUMP_RING_SIZE);
      await Promise.all(
        toDelete.map((f) =>
          fs.promises.unlink(path.join(REQUEST_DUMP_DIR, f)).catch(() => {}),
        ),
      );

      // 兼容旧 probe 脚本：写一份 last-stream-request.json 指向最新
      // （仅 stream 路径写，避免 unified 请求覆盖掉 stream 路径的诊断价值）
      if (kind === 'stream') {
        await fs.promises.writeFile(REQUEST_DUMP_LATEST, serialized, 'utf8');
      }
    } catch (err) {
      // 落盘失败不影响主流程，记一条 warn 即可
      logger.warn?.('[DeepV Server] request dump failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // 同步打一行简短日志，便于在 export-debug 里看到落盘行为发生过
  console.log(
    `[request-dump] ${kind} body dumped (${size}B) → ~/.deepv/last-requests/${path.basename(ringFile)}`,
  );
}

/**
 * Check if a model supports Server-Sent Events (SSE) streaming.
 * Uses broad pattern matching to automatically support new model versions.
 *
 * @param modelName - The model name/ID to check
 * @returns true if the model supports SSE streaming
 */
/**
 * 过滤 HTTP header 值中的非 Latin-1 字符（如中文分支名）。
 * HTTP/1.1 header 值只允许 Latin-1 字符集（\x00-\xFF）。
 * 非法字符静默移除，保证请求不因 header 格式错误而崩溃。
 */
function toSafeHeaderValue(value: string): string {
  return value.replace(/[^\x00-\xFF]/g, '');
}

function supportsSSEStreaming(modelName: string): boolean {
  const name = modelName.toLowerCase();

  // Claude series - all versions support SSE
  if (name.includes('claude')) return true;

  // Gemini series - all versions support SSE
  if (name.includes('gemini')) return true;

  // Kimi series (moonshotai)
  if (name.includes('kimi') || name.includes('moonshot')) return true;

  // GPT series (openai)
  if (name.includes('gpt')) return true;

  // Qwen series
  if (name.includes('qwen')) return true;

  // Grok series (x-ai)
  if (name.includes('grok')) return true;

  // GLM series (zhipu)
  if (name.includes('glm')) return true;

  // DeepSeek series
  if (name.includes('deepseek')) return true;

  // MiniMax series
  if (name.startsWith('minimax')) return true;

  return false;
}

/**
 * 按模型关键词适配走 GenAI 格式（DeepV 服务端代理）的思考模式配置
 */
function applyGenAIThinkingConfig(model: string, reqConfig: any, thinkingConfig: ThinkingConfig | undefined): any {
  // 🐛 [thinking-debug] 入口处先把"用户/项目配置中的 thinkingConfig"打印出来
  // 这是用户在 CLI 里通过 /thinking 设置或项目 settings 注入的原始值
  // eslint-disable-next-line no-console
  console.log(
    `\x1b[35m[thinking-debug]\x1b[0m model=\x1b[36m${model}\x1b[0m  userThinkingConfig=${
      thinkingConfig === undefined ? 'undefined (走默认 auto)' : JSON.stringify(thinkingConfig)
    }`
  );

  if (!thinkingConfig) return reqConfig;

  const modelLower = model.toLowerCase();
  const config = { ...reqConfig };

  // 🐛 FIX: thinkingConfig 应该写到 config.thinkingConfig（@google/genai SDK
  // GenerateContentConfig 标准位置），不是嵌套在 config.generationConfig 里。
  // 之前嵌套到 generationConfig 后，上游在请求复杂时（带 system+tools+长 history）
  // 不再做容错读取，直接当 thinkingConfig 缺失处理 → 不下发 reasoning。
  // 实证：byte-level diff probe 验证移到顶层后 reasoning chunks 从 0 → 9。
  //
  // 注意：Gemini 走 config.thinkingConfig（顶层），其他模型（Claude / GLM /
  // OpenAI）目前仍然走 config.generationConfig.thinking / .reasoning_effort，
  // 所以非 Gemini 路径需要先确保 generationConfig 是个对象再写字段，
  // 否则 reqConfig.generationConfig 为 undefined 时会抛
  // "Cannot set properties of undefined (setting 'reasoning_effort')"。

  if (modelLower.includes('gemini')) {
    // 1. Gemini 系列自适应适配
    const isGemini3 = modelLower.includes('gemini-3') || modelLower.includes('gemini-3.5');
    if (thinkingConfig.mode === 'off') {
      if (isGemini3) {
        config.thinkingConfig = {
          thinkingLevel: 'minimal' // 🌟 Gemini 3/3.5 官方推荐的 "no thinking" 最小延迟档位
        };
      } else {
        config.thinkingConfig = {
          thinkingBudget: 0 // 🌟 Gemini 2.5 官方标准的 "disable thinking" 档位
        };
      }
    } else {
      // 检查是否为 Gemini 3 / 3.5 系列 (未来/现代模型)
      if (isGemini3) {
        const thinkingLevel = effortToGeminiLevel(thinkingConfig.effort) || 'medium';
        config.thinkingConfig = {
          thinkingLevel,
          includeThoughts: true
        };
      } else {
        // Gemini 2.5 系列
        const thinkingBudget = thinkingConfig.budgetTokens !== undefined
          ? thinkingConfig.budgetTokens
          : (effortToGeminiBudget(thinkingConfig.effort) || 2048); // 默认使用 2048 (或 -1 启用自适应)
        config.thinkingConfig = {
          thinkingBudget,
          includeThoughts: true
        };
      }
    }
    // 同时清理掉旧的错位字段（避免老代码或下游误读到嵌套的旧值）
    if (config.generationConfig?.thinkingConfig) {
      const cleaned = { ...config.generationConfig };
      delete cleaned.thinkingConfig;
      config.generationConfig = Object.keys(cleaned).length > 0 ? cleaned : undefined;
    }
  } else if (modelLower.includes('claude') || modelLower.includes('anthropic')) {
    // 2. Claude (Anthropic) 代理配置
    // 🐛 FIX: 之前依赖上面 `config.generationConfig = { ...config.generationConfig }`
    // 给 generationConfig 兜底，那行随 Gemini 改动被移除后，这里如果传进来的
    // generationConfig 是 undefined，下面 `config.generationConfig.thinking = ...`
    // 会抛 "Cannot set properties of undefined"。所以先确保它是个对象。
    config.generationConfig = { ...(config.generationConfig || {}) };
    const isHaiku = modelLower.includes('haiku');
    if (isHaiku || thinkingConfig.mode === 'off') {
      config.generationConfig.thinking = { type: 'disabled' };
    } else {
      // 现代 Claude 4.6+ / Sonnet 4.6/4.7+ 适配，彻底防范 400 报错
      const isAdaptiveModel = isAdaptiveThinkingClaude(modelLower) || (thinkingConfig.effort !== undefined && thinkingConfig.effort !== 'auto');
      if (isAdaptiveModel && thinkingConfig.budgetTokens === undefined) {
        const effort = effortToAnthropicEffort(thinkingConfig.effort) || 'high';
        applyAnthropicAdaptiveThinking(config.generationConfig, effort);
      } else {
        const budgetTokens = thinkingConfig.budgetTokens !== undefined
          ? thinkingConfig.budgetTokens
          : effortToAnthropicBudget(thinkingConfig.effort);
        config.generationConfig.thinking = {
          type: 'enabled',
          budget_tokens: budgetTokens
        };
      }
    }
  } else if (modelLower.includes('glm')) {
    // 3. 智谱 GLM 代理配置
    // 🐛 FIX: 同 Claude 路径，确保 generationConfig 是个对象再写字段。
    config.generationConfig = { ...(config.generationConfig || {}) };
    if (thinkingConfig.mode === 'off') {
      config.generationConfig.thinking = { type: 'disabled' };
    } else {
      config.generationConfig.thinking = {
        type: 'enabled',
        clear_thinking: false // 保留式思考
      };
    }
  } else if (modelLower.includes('o1') || modelLower.includes('o3') || modelLower.includes('gpt-')) {
    // 4. OpenAI 系列
    // 🐛 FIX: 同 Claude 路径，确保 generationConfig 是个对象再写字段。
    config.generationConfig = { ...(config.generationConfig || {}) };
    if (thinkingConfig.mode === 'off') {
      config.generationConfig.reasoning_effort = 'none'; // 🌟 强制关闭思考 (gpt-5.5 / o-series 官方标准 none 档位)
    } else {
      const effort = effortToOpenAIEffort(thinkingConfig.effort);
      if (effort) {
        config.generationConfig.reasoning_effort = effort;
      }
    }
  } else if (modelLower.includes('qwen')) {
    // 5. Qwen (阿里) 系列
    // Qwen 官方 DashScope OpenAI 兼容接口用 `enable_thinking` (boolean) 控制思考模式，
    // 通过 extra_body 传递（详见 https://help.aliyun.com/zh/model-studio/use-qwen3）。
    // 注意：Qwen3-Instruct-2507 仅支持非思考模式；Qwen3-Thinking-2507 仅支持思考模式；
    //   Qwen3.6 系列默认开启思考。客户端这里只负责按用户开关注入字段，
    //   不与上游模型默认值博弈——上游会根据自身能力做容错。
    // FIX: 之前完全没有 qwen 分支，所有 Qwen 模型的 /thinking 设置静默丢失。
    config.generationConfig = { ...(config.generationConfig || {}) };
    config.generationConfig.extra_body = {
      ...(config.generationConfig.extra_body || {}),
      enable_thinking: thinkingConfig.mode !== 'off',
    };
  }

  // 🐛 [thinking-debug] 出口处打印"实际写入 generationConfig 的思考字段"
  // 这是真正会随请求体发到 DeepV 后端的形态
  const gc = config.generationConfig || {};
  const injected: Record<string, unknown> = {};
  if (gc.thinkingConfig !== undefined) injected.thinkingConfig = gc.thinkingConfig; // Gemini
  if (gc.thinking !== undefined) injected.thinking = gc.thinking;                   // Claude / GLM
  if (gc.reasoning_effort !== undefined) injected.reasoning_effort = gc.reasoning_effort; // OpenAI
  // eslint-disable-next-line no-console
  console.log(
    `\x1b[35m[thinking-debug]\x1b[0m \u2192 injected to generationConfig: ${
      Object.keys(injected).length === 0 ? '(none, model not matched)' : JSON.stringify(injected)
    }`
  );

  return config;
}

/**
 * DeepV服务器适配器 - 精简版
 * 通过统一的聊天API调用所有AI模型，服务端智能处理模型选择和格式转换
 * 支持Claude和Gemini模型的统一接口
 */
export class OttoServerAdapter implements ContentGenerator {
  public userTier?: UserTierId;
  private authHandler: (() => Promise<void>) | null = null;
  private config?: Config;
  private gitHeaders: Record<string, string> | null = null;
  private gitHeadersResolved = false;

  /**
   * 内部员工域名白名单
   * 只有这些域名的用户才会在请求中附带 git 仓库信息
   */
  private static readonly INTERNAL_EMAIL_DOMAINS = [
    '@cmcm.com',
    '@orionstar.com',
    '@aicfcf.com',
  ];

  constructor(region: string, projectId: string, proxyServerUrl?: string, config?: Config) {
    // 保存 Config 引用用于模型回退
    this.config = config;

    // NOTE: region and projectId parameters are legacy, no longer used after switching to proxy-based architecture
    // 使用硬编码的代理服务器URL，用户无需配置
    const finalProxyUrl = proxyServerUrl || getActiveProxyServerUrl();
    proxyAuthManager.configure({ proxyServerUrl: finalProxyUrl });

    // 初始化认证处理器 - 直接抛出UnauthorizedError触发/auth对话框
    this.authHandler = async () => {
      console.log('🔄 [DeepV Server] Authentication required, opening auth dialog...');
      throw new UnauthorizedError('Authentication required - please re-authenticate');
    };

    // 只在调试模式下显示详细日志
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      console.log(`[DeepV Server] Initialized with proxy server: ${finalProxyUrl}`);
    }
  }

  /**
   * 判断当前用户是否为内部员工（基于邮箱域名）
   */
  private isInternalUser(): boolean {
    const userInfo = proxyAuthManager.getUserInfo();
    const email = userInfo?.email?.toLowerCase();
    if (!email) return false;
    return OttoServerAdapter.INTERNAL_EMAIL_DOMAINS.some(domain => email.endsWith(domain));
  }

  /**
   * 懒加载获取 git 仓库信息 headers。
   * 仅对内部员工生效，结果在 session 内缓存。
   */
  private getGitHeaders(): Record<string, string> {
    if (this.gitHeadersResolved) {
      return this.gitHeaders || {};
    }
    this.gitHeadersResolved = true;

    if (!this.isInternalUser()) {
      this.gitHeaders = null;
      return {};
    }

    const cwd = this.config?.getWorkingDir?.() || this.config?.getTargetDir?.() || process.cwd();
    const headers: Record<string, string> = {};

    const remotes = getGitRemotes(cwd);
    if (remotes) {
      // JSON格式: {"origin":"https://...","upstream":"https://..."}
      headers['X-Git-Remotes'] = JSON.stringify(remotes);

      const branch = getGitBranch(cwd);
      if (branch) {
        headers['X-Git-Branch'] = toSafeHeaderValue(branch);
      }

      // 协议 v1.4.2 新增
      const commitSha = getGitCommitSha(cwd);
      if (commitSha) {
        headers['X-Git-Commit'] = commitSha; // sha 只含 [0-9a-f]，无需过滤
      }

      const projectPath = getGitProjectPath(cwd);
      if (projectPath) {
        headers['X-Git-Project-Path'] = toSafeHeaderValue(projectPath);
      }
    } else {
      // 兜底：当前目录不是 git 仓库时，扫描下一级子目录中的 git 仓库
      const subInfos = getSubdirectoryGitInfos(cwd);
      if (subInfos.length > 0) {
        // 收集所有子目录的 remotes，按子目录名分组
        // 格式: { "project-a": {"origin":"https://..."}, "project-b": {"origin":"https://..."} }
        const allRemotes: Record<string, Record<string, string>> = {};
        const branches: Record<string, string> = {};
        for (const info of subInfos) {
          allRemotes[info.name] = info.remotes;
          if (info.branch) {
            branches[info.name] = info.branch;
          }
        }
        headers['X-Git-Remotes'] = JSON.stringify(allRemotes);
        if (Object.keys(branches).length > 0) {
          headers['X-Git-Branch'] = JSON.stringify(branches);
        }
      }
    }

    this.gitHeaders = Object.keys(headers).length > 0 ? headers : null;
    return this.gitHeaders || {};
  }

  /**
   * 设置飞书用户信息
   */
  setUserInfo(userInfo: any): void {
    proxyAuthManager.setUserInfo(userInfo);
    // 只在调试模式下显示详细日志
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      console.log(`[DeepV Server] User info configured: ${userInfo.name}`);
    }
  }

  /**
   * 检查飞书认证状态
   */
  async verifyFeishuAuth(): Promise<boolean> {
    try {
      const userInfo = proxyAuthManager.getUserInfo();
      if (userInfo) {
        // 只在调试模式下显示详细日志
        if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
          console.log(`[DeepV Server] User info found: ${userInfo.name} (${userInfo.email || userInfo.openId || 'N/A'})`);
        }
        return true;
      } else {
        console.warn(`[DeepV Server] No user info found, please login first`);
        return false;
      }
    } catch (error) {
      console.error(`[DeepV Server] Authentication check failed:`, error);
      return false;
    }
  }

  /**
   * 清理内容，移除空消息和无效部分，同时合并流式历史中的思维部分到主消息中
   * 针对 Claude、Kimi、GLM 等对消息格式要求严格的模型
   */
  private cleanContents(contents: any[]): any[] {
    if (!Array.isArray(contents)) return contents;

    const consolidated: any[] = [];
    let accumulatedReasoning: any[] = [];

    for (const content of contents) {
      // 深度拷贝消息，同时过滤掉无效的空文本/空白字符块，防止传给服务端后转换为大模型格式（如 Anthropic）时报错
      const clonedParts = content.parts
        ? content.parts.filter((p: any) => {
            if (p && p.text !== undefined) {
              return typeof p.text === 'string' && p.text.trim() !== '';
            }
            return p !== null && p !== undefined;
          })
        : [];

      const clonedContent = {
        role: content.role,
        parts: clonedParts
      };

      if (clonedContent.role === MESSAGE_ROLES.MODEL) {
        const parts = clonedContent.parts || [];

        // 分离思维部分与非思维部分（如文本、工具调用等）
        const reasoningParts = parts.filter((p: any) => p && p.reasoning !== undefined);
        const nonReasoningParts = parts.filter((p: any) => p && p.reasoning === undefined);

        // 如果包含思维链，则累积暂存
        if (reasoningParts.length > 0) {
          accumulatedReasoning.push(...reasoningParts);
        }

        // 如果含有非思维的实质部分（文本、工具调用等），则保留该消息，并合并已暂存的思维链
        if (nonReasoningParts.length > 0) {
          if (accumulatedReasoning.length > 0) {
            clonedContent.parts = [...accumulatedReasoning, ...nonReasoningParts];
            accumulatedReasoning = []; // 消费后清除暂存
          } else {
            clonedContent.parts = nonReasoningParts;
          }

          // 🔧 合并同一回合内连续的 model 消息
          // 当 reasoning + text + functionCall 被流式处理拆成多个独立 Content 时，
          // 需要将它们合并为单个 Content（包含 reasoning、text、functionCall）。
          // 否则 Server genaiAdapter 会将其转为多条 assistant 消息，
          // 导致 Kimi K2.6 等模型因 tool_call 消息缺少 reasoning_content 而报错。
          const lastConsolidated = consolidated[consolidated.length - 1];
          if (lastConsolidated && lastConsolidated.role === MESSAGE_ROLES.MODEL) {
            lastConsolidated.parts.push(...clonedContent.parts);
          } else {
            consolidated.push(clonedContent);
          }
        } else {
          // 如果是纯思维链消息（无任何实质正文/工具调用），且已经累积，则安全跳过此独立消息，避免发送连续的助手消息
          continue;
        }
      } else {
        // 遇到非 model 消息（user 或 tool），说明当前助手回合结束。清空暂存，防止跨回合污染
        accumulatedReasoning = [];
        consolidated.push(clonedContent);
      }
    }

    const cleaned = consolidated.filter(content => {
      // 1. 移除没有 parts 的消息
      if (!content.parts || content.parts.length === 0) return false;

      // 2. 检查 parts 是否有效
      const hasValidPart = content.parts.some((part: any) => {
        // 如果是文本，必须非空
        if (part.text !== undefined) return part.text.trim() !== '';
        // 其他类型（functionCall, functionResponse, reasoning, etc.）视为有效
        return true;
      });

      return hasValidPart;
    });

    // 🛡️ 协议安全网：删除"真孤儿 functionResponse"（找不到任何可配对 functionCall）
    // 修复用户实拍 easyrouter 400：
    //   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
    // 上下文压缩/历史截断可能切掉 functionCall 却保留其 functionResponse，
    // 该孤儿转 OpenAI 格式后变成无前驱 tool_calls 的 role:'tool' → 严格网关 400。
    // 此清理对 Gemini / Claude / OpenAI 三家均无害：合法配对全部保留，仅删真孤儿。
    const orphanCleaned = this.removeOrphanedToolResponses(cleaned);

    // 🔧 安全保障：确保清理后 contents 不以 model/assistant 结尾
    // 某些模型（如 AWS Bedrock Claude）不支持 assistant prefill，
    // 要求对话必须以 user 消息结尾。过滤空消息后末尾可能变成 model。
    if (orphanCleaned.length > 0 && orphanCleaned[orphanCleaned.length - 1].role === MESSAGE_ROLES.MODEL) {
      logger.warn('[cleanContents] Contents ends with model message after cleanup — appending user placeholder');
      orphanCleaned.push({
        role: MESSAGE_ROLES.USER,
        parts: [{ text: '[Conversation continues]' }],
      });
    }

    // 🆕 调试日志：输出整理后的历史结构，帮助诊断多轮对话中的思维块合并情况
    if (process.env.DEBUG || process.env.NODE_ENV === 'development' || true) { // 🌟 暂时强制开启以便在用户的终端中显示，极其利于排除故障
      console.log(`[cleanContents] 整理后的历史记录列表 (共 ${orphanCleaned.length} 条):`);
      orphanCleaned.forEach((c, idx) => {
        const partTypes = (c.parts || []).map((p: any) => {
          if (p.text !== undefined) return `text(${p.text.length})`;
          if (p.functionCall) return `functionCall(${p.functionCall.name})`;
          if (p.functionResponse) return `functionResponse(${p.functionResponse.name})`;
          if (p.reasoning) return `reasoning(${p.reasoning.length})`;
          return 'unknown';
        });
        console.log(`  [${idx}] role=${c.role} parts=[${partTypes.join(', ')}]`);
      });
    }

    return orphanCleaned;
  }

  /**
   * 🛡️ 删除"真孤儿 functionResponse"——在整个 contents 里找不到任何可配对
   * functionCall 的 functionResponse。
   *
   * 修复生产 bug（用户实拍 easyrouter 400）：
   *   "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
   *
   * 根因：上下文压缩/历史截断会把 functionCall 切掉、却保留其 functionResponse，
   * 形成孤儿。它被上游 sanitizeRequestContents 的"全局 name 兜底"误判存活，
   * 转 OpenAI 格式后变成无前驱 tool_calls 的 role:'tool' → 严格网关报 400。
   *
   * 配对算法（模拟服务端真实配对，以 fc 为单位按"配对槽消耗"避免误删）：
   *   1) 先扫描所有 functionCall，每个 fc 建一个配对槽 {id?, name, consumed:false}。
   *   2) 按出现顺序遍历每个 functionResponse，为其寻找一个未消耗的槽：
   *        - 优先匹配 id 相同的未消耗槽 → 命中则消耗
   *        - 否则匹配 name 相同的未消耗槽 → 命中则消耗
   *        - 都没有 → 真孤儿，删除
   *      （以 fc 为单位建槽，保证一个 fc 只配 1 个 fr，id 与 name 不会各放行一个。）
   *
   * 无害性保证（对 Gemini / Claude / OpenAI 三家均成立）：
   *   - 合法会话里 fr 数 ≤ 同名 fc 数，计数永远够 → 不删任何合法配对。
   *   - 并行同名 N 对：nameCount=N，N 个 fr 各消耗 1，全部保留 → 不误删。
   *   - 仅当 fr 数 > 可配对 fc 数（真出现孤儿）才删多出来的那些。
   *   - 孤儿 functionResponse 本就是三家协议的共同禁忌，删除只会让请求更合法。
   */
  private removeOrphanedToolResponses(contents: any[]): any[] {
    if (!Array.isArray(contents) || contents.length === 0) return contents;

    // 快速通道：没有任何 functionResponse 时直接返回，零开销、零改动
    const hasAnyFunctionResponse = contents.some(
      (c) => Array.isArray(c?.parts) && c.parts.some((p: any) => p?.functionResponse),
    );
    if (!hasAnyFunctionResponse) return contents;

    // 1) 扫描所有 functionCall，每个 fc 建一个"配对槽"（含 id?/name，初始未消耗）。
    //    以 fc 为单位建槽是关键：一个 fc 同时有 id 和 name 时只能配 1 个 fr，
    //    绝不能让 id 和 name 各放行一个 fr（否则一个 fc 被算成 2 份配对额度）。
    const slots: Array<{ id?: string; name?: string; consumed: boolean }> = [];
    for (const content of contents) {
      if (!Array.isArray(content?.parts)) continue;
      for (const part of content.parts) {
        const fc = part?.functionCall;
        if (!fc) continue;
        slots.push({ id: fc.id, name: fc.name, consumed: false });
      }
    }

    // 2) 遍历每条消息，为每个 functionResponse 寻找一个未消耗的配对槽
    let removedCount = 0;
    const result: any[] = [];
    for (const content of contents) {
      if (!Array.isArray(content?.parts)) {
        result.push(content);
        continue;
      }

      const keptParts = content.parts.filter((part: any) => {
        const fr = part?.functionResponse;
        if (!fr) return true; // 非 functionResponse 一律保留

        // 优先 id 精确配对：找一个未消耗、id 相同的槽
        if (fr.id) {
          const slot = slots.find((s) => !s.consumed && s.id === fr.id);
          if (slot) {
            slot.consumed = true;
            return true;
          }
        }
        // 回退 name 配对：找一个未消耗、name 相同的槽（覆盖 Gemini 无 id 及并行同名）
        if (fr.name) {
          const slot = slots.find((s) => !s.consumed && s.name === fr.name);
          if (slot) {
            slot.consumed = true;
            return true;
          }
        }
        // 真孤儿：没有任何可配对的 functionCall 槽
        removedCount++;
        logger.warn(
          `[removeOrphanedToolResponses] ❌ Removing orphaned functionResponse: ` +
          `${fr.name} (id: ${fr.id ?? 'n/a'}) — no matching functionCall found.`,
        );
        return false;
      });

      // 若该消息所有 part 都被删空，则整条丢弃；否则保留（可能含其他 part）
      if (keptParts.length > 0) {
        result.push(keptParts.length === content.parts.length ? content : { ...content, parts: keptParts });
      }
    }

    if (removedCount > 0) {
      logger.warn(
        `[removeOrphanedToolResponses] Removed ${removedCount} orphaned functionResponse(s) before sending to cloud.`,
      );
    }

    return result;
  }

  /**
   * 核心方法：统一的内容生成接口
   * 使用新的 /v1/chat/messages 统一端点，服务端智能处理所有模型差异
   */
  async generateContent(request: GenerateContentParameters, scene: SceneType): Promise<GenerateContentResponse> {
    try {
      // 1. 构建统一的GenAI格式请求
      const sceneModel = SceneManager.getModelForScene(scene);
      const userModel = this.config?.getModel();

      // 🆕 如果用户使用自定义模型，辅助场景（非主对话场景）应该也使用用户的自定义模型
      // 这样可以避免在使用自定义模型时仍然调用 DeepV API
      let modelToUse: string;
      if (userModel && isCustomModel(userModel)) {
        // 用户使用自定义模型时：
        // - 如果 request.model 也是自定义模型，使用 request.model
        // - 否则使用用户的自定义模型（忽略场景固定模型）
        if (request.model && isCustomModel(request.model)) {
          modelToUse = request.model;
        } else {
          modelToUse = userModel;
        }
        console.log(`[DeepV Server] User is using custom model, overriding scene model for ${scene}: ${modelToUse}`);
      } else {
        // 模型解析优先级：request.model > sceneModel > userModel > 'auto'
        // 这样固定值场景（如 'gemini-2.5-flash'）会优先，'auto' 场景会回退到用户模型
        modelToUse = request.model || sceneModel || userModel || 'auto';
      }

      // 检查是否为自定义模型
      if (isCustomModel(modelToUse) && this.config) {
        const customModelConfig = this.config.getCustomModelConfig(modelToUse);
        if (customModelConfig) {
          console.log(`[DeepV Server] Using custom model: ${customModelConfig.displayName}`);
          // 🆕 注入会话级/项目级 thinking 配置
          const thinkingOverride = this.config.getThinkingConfig();
          const resolvedConfig = {
            ...customModelConfig,
            ...(thinkingOverride && { thinking: thinkingOverride }),
          };
          return await callCustomModel(resolvedConfig, request, request.config?.abortSignal);
        } else {
          throw new Error(`Custom model configuration not found for: ${modelToUse}`);
        }
      }

      // 详细的模型决策日志 - 仅在调试模式下显示
      if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
        console.log(`[🎯 Model Resolution] Using model: ${modelToUse} for scene: ${scene}`);
      }

      // 🆕 注入走 GenAI 格式 (DeepV 服务端代理) 的思考模式适配
      const resolvedConfig = applyGenAIThinkingConfig(modelToUse, request.config || {}, this.config?.getThinkingConfig());

      const unifiedRequest = {
        model: modelToUse,
        contents: this.cleanContents(stripUIFieldsFromArray(request.contents)),
        config: {
          ...resolvedConfig,
          // 添加场景信息到headers，供服务端参考
          httpOptions: {
            ...resolvedConfig.httpOptions,
            headers: {
              ...resolvedConfig.httpOptions?.headers,
              'X-Scene-Type': scene,
              'X-Scene-Display': SceneManager.getSceneDisplayName(scene),
            }
          }
        }
      };

      logger.info(`[DeepV Server] Calling unified chat API with model: ${modelToUse}`);

      // 2. 统一API调用 - 服务端处理所有模型差异
      // scene 是 SceneType 枚举，转为字符串后做合法性守卫，防止 "undefined" 流入服务端
      const sceneValue = scene != null && String(scene) !== 'undefined' ? String(scene) : undefined;
      const response = await this.callUnifiedChatAPI('/v1/chat/messages', unifiedRequest, request.config?.abortSignal, sceneValue);

      // 3. 日志记录工具调用
      if (response.functionCalls && response.functionCalls.length > 0 && (process.env.DEBUG || process.env.NODE_ENV === 'development')) {
        console.log(`[DeepV Server] Model called ${response.functionCalls.length} tool(s): ${response.functionCalls.map(fc => fc.name).join(', ')}`);
      }

      console.log('[DeepV Server] Response received successfully', { model: modelToUse });
      return response;

    } catch (error) {
      return this.handleError(error);
    }
  }

  /**
   * 统一的API调用方法 - 使用新的统一端点
   * 🆕 使用指数退避重试策略处理 429 和 5xx 错误
   * @see https://cloud.google.com/storage/docs/retry-strategy#exponential-backoff
   */
  private async callUnifiedChatAPI(endpoint: string, requestBody: any, abortSignal?: AbortSignal, sceneType?: string): Promise<GenerateContentResponse> {
    // 使用指数退避包装实际的 API 调用
    return retryWithBackoff(
      () => this.executeUnifiedChatAPICall(endpoint, requestBody, abortSignal, sceneType),
      {
        // 使用标准退避配置，适合大多数场景
        // 对于大量工具调用场景，可以在调用处设置 aggressiveBackoff: true
        shouldRetry: (error: Error) => {
          // 🚫 DeepX配额错误(402) - 不重试，立即显示友好提示
          if (isDeepXQuotaError(error)) {
            return false;
          }
          // 🚫 用户取消 - 不重试
          if (error.message.includes('cancelled by user') || error.name === 'AbortError') {
            return false;
          }
          // 🚫 认证错误 - 不重试
          if (error.message.includes('401') || error instanceof UnauthorizedError) {
            return false;
          }
          // 🚫 区域封锁 - 不重试
          if (error.message.includes('451') || error.message.includes('REGION_BLOCKED')) {
            return false;
          }
          // ✅ 429 限流 - 重试
          if (error.message.includes('429')) {
            return true;
          }
          // ✅ 5xx 服务器错误 - 重试
          if (error.message.match(/5\d{2}/)) {
            return true;
          }
          // ✅ 传输中断/连接异常 - 重试
          const errorMessage = error.message.toLowerCase();
          const errorCode = (error as any)?.cause?.code || (error as any)?.code;
          if (
            errorMessage.includes('terminated') ||
            errorMessage.includes('socket hang up') ||
            errorMessage.includes('connection closed') ||
            errorMessage.includes('other side closed')
          ) {
            return true;
          }
          if (
            errorCode &&
            [
              'ECONNRESET',
              'ECONNABORTED',
              'ECONNREFUSED',
              'EPIPE',
              'ETIMEDOUT',
              'UND_ERR_SOCKET',
              'UND_ERR_CONNECT_TIMEOUT',
              'UND_ERR_HEADERS_TIMEOUT',
              'UND_ERR_BODY_TIMEOUT'
            ].includes(errorCode)
          ) {
            return true;
          }
          // ✅ 网络连接错误 - 重试
          if (error instanceof TypeError && error.message.includes('fetch failed')) {
            return true;
          }
          return false;
        },
      }
    );
  }

  /**
   * 执行实际的 API 调用（不含重试逻辑）
   * 被 callUnifiedChatAPI 通过 retryWithBackoff 包装调用
   */
  private async executeUnifiedChatAPICall(endpoint: string, requestBody: any, abortSignal?: AbortSignal, sceneType?: string): Promise<GenerateContentResponse> {
    const userHeaders = await proxyAuthManager.getUserHeaders(sceneType);
    const proxyUrl = `${proxyAuthManager.getProxyServerUrl()}${endpoint}`;

    const controller = new AbortController();
    let abortListener: (() => void) | null = null;

    if (abortSignal) {
      // 🚨 防止内存泄漏：检查传入的signal是否已被中止
      if (abortSignal.aborted) {
        controller.abort();
      } else {
        const handleAbort = () => {
          console.log('[DeepV Server] Request cancelled by user');
          controller.abort();
        };
        abortSignal.addEventListener('abort', handleAbort);
        abortListener = () => abortSignal.removeEventListener('abort', handleAbort);
      }
    }

    // 🚨 非流式请求的超时保护：两层防御
    // 第1层（连接层）：300秒内必须收到响应头
    //   - 保护 TCP 连接建立和首个响应头的接收
    //   - 防止服务端完全无响应的情况
    // 第2层（数据层）：响应头后，300秒内必须完成 response.json() 解析
    //   - 保护完整响应体的接收和 JSON 反序列化
    //   - 总请求时间 = 连接等待 + 数据接收 + 解析，均有保护
    const fetchTimeoutId = setTimeout(() => {
      console.warn('[DeepV Server] API fetch timeout - aborting connection layer after 300s. Try: check your network, or say "continue" to retry.');
      controller.abort();
    }, 300000);

    const startTime = Date.now();

    try {
      console.log('[DeepV Server] Making unified API call', {
        endpoint,
        url: proxyUrl,
        model: requestBody.model
      });

      // 🔍 [STOP-DEBUG][adapter] Outgoing tool manifest — non-stream path.
      // 用途：诊断"模型说要调 local_time 但工具调用却空了"这类问题。如果
      // 这里打印的工具名列表不含 local_time / goal_achieved，那就是
      // toolRegistry 那边出了问题；如果列表是齐的但 server 仍然没工具，
      // 那就是 server 端的过滤/转换 bug。详见 client.ts:~500 (toolRegistry.
      // getFunctionDeclarations())。
      try {
        const tools = (requestBody as any)?.config?.tools;
        const names = Array.isArray(tools)
          ? tools.flatMap((t: any) => (t?.functionDeclarations ?? []).map((d: any) => d?.name))
          : [];
        console.log(
          `[STOP-DEBUG][adapter] → ${endpoint} model=${requestBody.model} tools(${names.length})=[${names.join(', ')}]`,
        );
      } catch {
        // 日志不能障碍请求
      }

      // 落盘出站请求体（异步，不阻塞 fetch）。non-stream 路径也保留诊断价值。
      dumpOutboundRequest('unified', requestBody);

      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          ...this.getGitHeaders(),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      // 🚨 获取响应头后清理连接层超时，启用数据层超时
      // 响应头已收到说明连接正常，现在保护响应体接收和解析阶段
      clearTimeout(fetchTimeoutId);
      const dataTimeoutId = setTimeout(() => {
        console.warn('[DeepV Server] API data timeout - response.json() taking too long (>300s) in data layer. Try: check your network, say "continue" to retry, or try a different model.');
        controller.abort();
      }, 300000);

      if (!response.ok) {
        clearTimeout(dataTimeoutId);
        const errorText = await response.text();

        // 401错误特殊处理
        if (response.status === 401 && isOurAuthError(errorText)) {
          console.error('[DeepV Server] 401 Unauthorized - triggering auth dialog');
          if (this.authHandler) {
            await this.authHandler();
          }
          throw new UnauthorizedError('Authentication required - please re-authenticate');
        }

        // 451错误特殊处理 - 立即中断
        if (response.status === 451) {
          console.error('[DeepV Server] 451 Region Blocked - IMMEDIATE ABORT');
          // 立即中断当前请求
          controller.abort();
          // 抛出特殊异常立即中断事件循环
          throw new Error(`REGION_BLOCKED_451: ${errorText}`);
        }

        // 🆕 为 429/5xx 错误创建带状态码的错误对象，便于重试逻辑判断
        const apiError = new Error(`API request failed (${response.status}): ${errorText}`);
        (apiError as any).status = response.status;
        // 🆕 尝试解析 Retry-After 头，传递给重试逻辑
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          (apiError as any).response = {
            status: response.status,
            headers: { 'retry-after': retryAfter }
          };
        }
        throw apiError;
      }

      // 🚨 第三层保护：response.json() 解析也有独立的 300s 超时
      // 虽然前面有数据层超时保护，但这里再加一层确保 JSON 解析不会卡住
      const responseData = await this.withTimeout(
        response.json() as Promise<GenerateContentResponse>,
        300000,
        '[DeepV Server] API response parsing timeout after 300s - JSON.parse() or streaming took too long. Try: check your network, say "continue" to retry, or try a different model.'
      );
      clearTimeout(dataTimeoutId);

      // 确保响应对象有 functionCalls getter
      if (!responseData.functionCalls) {
        Object.defineProperty(responseData, 'functionCalls', {
          get: function() {
            if (this.candidates?.[0]?.content?.parts?.length === 0) {
              return undefined;
            }
            if (this.candidates && this.candidates.length > 1) {
              console.warn(
                'there are multiple candidates in the response, returning function calls from the first one.',
              );
            }
            const functionCalls = this.candidates?.[0]?.content?.parts
              ?.filter((part: any) => part.functionCall)
              .map((part: any) => part.functionCall)
              .filter((functionCall: any) => functionCall !== undefined);
            if (functionCalls?.length === 0) {
              return undefined;
            }
            return functionCalls;
          },
          enumerable: false,
          configurable: true
        });
      }

      const duration = Date.now() - startTime;
      console.log('[DeepV Server] API call completed', {
        endpoint,
        duration: `${duration}ms`,
        status: response.status
      });

      return responseData;

    } catch (error) {
      const duration = Date.now() - startTime;

      // 🚨 清理资源：移除abort监听器和所有超时定时器
      if (abortListener) {
        abortListener();
      }
      clearTimeout(fetchTimeoutId);

      // 用户取消请求的优雅处理
      if (error instanceof Error &&
          (error.message.includes('cancelled by user') || error.name === 'AbortError')) {
        console.log('⚠️  任务已取消');
        throw error;
      }

      // 超时错误处理
      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warn('[DeepV Server] Request timeout', {
          endpoint,
          duration: `${duration}ms`,
          reason: error.message
        });
      } else if (error instanceof Error && error.message.includes('abort')) {
        logger.warn('[DeepV Server] Request aborted', {
          endpoint,
          duration: `${duration}ms`,
          reason: error.message
        });
      } else {
        logger.error('[DeepV Server] API call failed', {
          endpoint,
          duration: `${duration}ms`,
          error: error instanceof Error ? error.message : error
        });
      }

      throw error;
    } finally {
      // 🚨 最终清理：确保资源一定被释放
      clearTimeout(fetchTimeoutId);
      if (abortListener) {
        abortListener();
      }
    }
  }



  /**
   * 统一错误处理方法
   */
  private handleError(error: unknown): never {
    // 🚨 特殊处理用户中断 - 优雅处理，不显示错误堆栈
    if (error instanceof Error &&
        (error.message.includes('cancelled by user') || error.name === 'AbortError')) {
      throw error;
    }

    // 🚨 特殊处理网络连接错误
    const isConnectionError = error instanceof TypeError &&
      (error.message.includes('fetch failed') ||
       error.message.includes('ECONNREFUSED') ||
       (error as any).cause?.code === 'ECONNREFUSED');

    if (isConnectionError) {
      console.error(`❌ 无法连接到服务器，请检查网络连接或服务器状态`);
    } else {
      console.error('[DeepV Server] Error in generateContent:', error);
    }

    // 🚨 特殊处理401错误 - 提供更友好的错误信息
    if (error instanceof Error && (error as any).isAuthError) {
      const friendlyError = new Error(
        `Authentication failed (401): ${error.message}\n\n` +
        `Please check your Feishu authentication token and try again.\n` +
        `If the problem persists, you may need to re-authenticate.`
      );
      (friendlyError as any).isAuthError = true;
      (friendlyError as any).statusCode = 401;
      throw friendlyError;
    }


    throw error;
  }

  async generateContentStream(request: GenerateContentParameters, scene: SceneType): Promise<AsyncGenerator<GenerateContentResponse>> {
    // 检查是否为自定义模型
    const sceneModel = SceneManager.getModelForScene(scene);
    const userModel = this.config?.getModel();

    // 🆕 如果用户使用自定义模型，辅助场景应该也使用用户的自定义模型
    let modelToUse: string;
    if (userModel && isCustomModel(userModel)) {
      // 用户使用自定义模型时：忽略场景固定模型，使用用户的自定义模型
      if (request.model && isCustomModel(request.model)) {
        modelToUse = request.model;
      } else {
        modelToUse = userModel;
      }
      console.log(`[DeepV Server] (Stream) User is using custom model, overriding scene model for ${scene}: ${modelToUse}`);
    } else {
      modelToUse = request.model || sceneModel || userModel || 'auto';
    }

    if (isCustomModel(modelToUse) && this.config) {
      const customModelConfig = this.config.getCustomModelConfig(modelToUse);
      if (customModelConfig) {
        console.log(`[DeepV Server] Custom model detected, using streaming mode`);
        // 🆕 注入会话级/项目级 thinking 配置
        const thinkingOverride = this.config.getThinkingConfig();
        const resolvedConfig = {
          ...customModelConfig,
          ...(thinkingOverride && { thinking: thinkingOverride }),
        };
        return callCustomModelStream(resolvedConfig, request, request.config?.abortSignal);
      }
    }

    // 🔍 Model-specific SSE streaming support check (not model selection)
    // This detects which API features are available for the requested model
    // Actual model selection is done by the server based on 'auto' requests
    // Uses broad pattern matching to automatically support new model versions
    //
    // 注：早期版本曾因 cloud-mode (DEEPV_CLOUD_MODE=true) 强制走非流式以避免
    // "消息被打断"，但该限制在远程协议加入 thoughtId 聚合 + Thought/Reasoning
    // chunk 转发后已不再需要。流式体验对 thinking mode 至关重要，恢复默认行为。
    if (supportsSSEStreaming(request.model)) {
      return this._generateContentStream(request, scene);
    } else {
      // 其他模型将非流式响应包装为流式格式
      return this._generateContent(request, scene);
    }
  }

  async _generateContent(request: GenerateContentParameters, scene: SceneType): Promise<AsyncGenerator<GenerateContentResponse>> {
    const response = await this.generateContent(request, scene);
    return (async function* () {
          yield response;
    })();
  }

  /**
   * 🆕 真正的流式内容生成
   * 支持Server-Sent Events (SSE)和ESC键中断
   */
  async _generateContentStream(request: GenerateContentParameters, scene: SceneType): Promise<AsyncGenerator<GenerateContentResponse>> {
    try {
      // 构建流式请求
      const sceneModel = SceneManager.getModelForScene(scene);
      const userModel = this.config?.getModel();

      // 🆕 如果用户使用自定义模型，辅助场景应该也使用用户的自定义模型
      let modelToUse: string;
      if (userModel && isCustomModel(userModel)) {
        // 用户使用自定义模型时：忽略场景固定模型，使用用户的自定义模型
        if (request.model && isCustomModel(request.model)) {
          modelToUse = request.model;
        } else {
          modelToUse = userModel;
        }
        console.log(`[DeepV Server] (_Stream) User is using custom model, overriding scene model for ${scene}: ${modelToUse}`);
      } else {
        // 模型解析优先级：request.model > sceneModel > userModel > 'auto'
        // 这样固定值场景（如 'gemini-2.5-flash'）会优先，'auto' 场景会回退到用户模型
        modelToUse = request.model || sceneModel || userModel || 'auto';
      }

      // 详细的模型决策日志 - 仅在调试模式下显示
      if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
        console.log(`[🎯 Model Resolution (Stream)] Using model: ${modelToUse} for scene: ${scene}`);
      }

      // 🆕 注入走 GenAI 格式 (DeepV 服务端代理) 的思考模式适配 (流式)
      const resolvedConfig = applyGenAIThinkingConfig(modelToUse, request.config || {}, this.config?.getThinkingConfig());

      const streamRequest = {
        model: modelToUse,
        contents: this.cleanContents(stripUIFieldsFromArray(request.contents)),
        config: {
          ...resolvedConfig,
          stream: true,  // 启用流式输出
          // 添加场景信息到headers
          httpOptions: {
            ...resolvedConfig.httpOptions,
            headers: {
              ...resolvedConfig.httpOptions?.headers,
              'X-Scene-Type': scene,
              'X-Scene-Display': SceneManager.getSceneDisplayName(scene),
            }
          }
        }
      };

      logger.info(`[DeepV Server] Starting stream with model: ${modelToUse}`);

      // 调用流式API（错误处理已在callStreamAPI中统一处理）
      // scene 是 SceneType 枚举，转为字符串后做合法性守卫，防止 "undefined" 流入服务端
      const sceneValue = scene != null && String(scene) !== 'undefined' ? String(scene) : undefined;
      const response = await this.callStreamAPI('/v1/chat/stream', streamRequest, request.config?.abortSignal, sceneValue);

      // 返回流式生成器
      return this.createStreamGenerator(response, request.config?.abortSignal);

    } catch (error) {
      logger.error('[DeepV Server] Stream request failed', { error });
      return this.handleStreamError(error);
    }
  }

  /**
   * 🆕 调用流式API
   * 使用指数退避重试策略处理初始连接的 429 和 5xx 错误
   * 注意：只对初始连接进行重试，一旦流开始就不再重试
   */
  private async callStreamAPI(endpoint: string, requestBody: any, abortSignal?: AbortSignal, sceneType?: string): Promise<Response> {
    // 使用指数退避包装实际的流式 API 调用
    return retryWithBackoff(
      () => this.executeStreamAPICall(endpoint, requestBody, abortSignal, sceneType),
      {
        shouldRetry: (error: Error) => {
          // 🚫 DeepX配额错误(402) - 不重试，立即显示友好提示
          if (isDeepXQuotaError(error)) {
            return false;
          }
          // 🚫 用户取消 - 不重试
          if (error.message.includes('cancelled by user') || error.name === 'AbortError') {
            return false;
          }
          // 🚫 认证错误 - 不重试
          if (error.message.includes('401') || error instanceof UnauthorizedError) {
            return false;
          }
          // 🚫 区域封锁 - 不重试
          if (error.message.includes('451') || error.message.includes('REGION_BLOCKED')) {
            return false;
          }
          // ✅ 429 限流 - 重试
          if (error.message.includes('429')) {
            return true;
          }
          // ✅ 5xx 服务器错误 - 重试
          if (error.message.match(/5\d{2}/)) {
            return true;
          }
          // ✅ 传输中断/连接异常 - 重试
          const errorMessage = error.message.toLowerCase();
          const errorCode = (error as any)?.cause?.code || (error as any)?.code;
          if (
            errorMessage.includes('terminated') ||
            errorMessage.includes('socket hang up') ||
            errorMessage.includes('connection closed') ||
            errorMessage.includes('other side closed')
          ) {
            return true;
          }
          if (
            errorCode &&
            [
              'ECONNRESET',
              'ECONNABORTED',
              'ECONNREFUSED',
              'EPIPE',
              'ETIMEDOUT',
              'UND_ERR_SOCKET',
              'UND_ERR_CONNECT_TIMEOUT',
              'UND_ERR_HEADERS_TIMEOUT',
              'UND_ERR_BODY_TIMEOUT'
            ].includes(errorCode)
          ) {
            return true;
          }
          // ✅ 网络连接错误 - 重试
          if (error instanceof TypeError && error.message.includes('fetch failed')) {
            return true;
          }
          return false;
        },
      }
    );
  }

  /**
   * 执行实际的流式 API 调用（不含重试逻辑）
   * 被 callStreamAPI 通过 retryWithBackoff 包装调用
   */
  private async executeStreamAPICall(endpoint: string, requestBody: any, abortSignal?: AbortSignal, sceneType?: string): Promise<Response> {
    const userHeaders = await proxyAuthManager.getUserHeaders(sceneType);
    const proxyUrl = `${proxyAuthManager.getProxyServerUrl()}${endpoint}`;

    // 🔍 调试：打印代理相关信息（流式调用）- 仅在调试模式下显示
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      console.log('🔍 [DeepV Debug Stream] Proxy environment variables:');
      console.log('  HTTP_PROXY:', process.env.HTTP_PROXY);
      console.log('  HTTPS_PROXY:', process.env.HTTPS_PROXY);
      console.log('  http_proxy:', process.env.http_proxy);
      console.log('  https_proxy:', process.env.https_proxy);
      console.log('  Target URL:', proxyUrl);

      // 🔍 检查 undici 全局调度器（流式）
      const globalDispatcher = getGlobalDispatcher();
      console.log('🔍 [DeepV Debug Stream] Global dispatcher:', globalDispatcher?.constructor?.name || 'undefined');
      if (globalDispatcher && 'uri' in globalDispatcher) {
        console.log('  Dispatcher URI:', (globalDispatcher as any).uri);
      }
    }

    const controller = new AbortController();
    let abortListener: (() => void) | null = null;

    if (abortSignal) {
      // 🚨 防止内存泄漏：检查传入的signal是否已被中止
      if (abortSignal.aborted) {
        controller.abort();
      } else {
        const handleAbort = () => {
          if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
            console.log('[DeepV Server] Stream request cancelled by user');
          }
          controller.abort();
        };
        abortSignal.addEventListener('abort', handleAbort);
        abortListener = () => abortSignal.removeEventListener('abort', handleAbort);
      }
    }

    // 注意：不使用全局超时定时器
    // 原因：
    // 1. 流式API本身没有明确的时间限制（可能会持续很长时间）
    // 2. 如果中途没有数据，createStreamGenerator 中的 120秒 read() 超时会生效
    // 3. 全局定时器易导致定时器泄漏（流完成后无法清理）
    // 4. 用户可以通过 abortSignal 随时取消请求

    const startTime = Date.now();

    try {
      console.log('[DeepV Server] Making stream API call', {
        endpoint,
        url: proxyUrl,
        model: requestBody.model
      });

      // 🔍 [STOP-DEBUG][adapter] Outgoing tool manifest — stream path.
      // 与 non-stream 路径同义，只是走的是 /v1/chat/stream。
      try {
        const tools = (requestBody as any)?.config?.tools;
        const names = Array.isArray(tools)
          ? tools.flatMap((t: any) => (t?.functionDeclarations ?? []).map((d: any) => d?.name))
          : [];
        console.log(
          `[STOP-DEBUG][adapter] → ${endpoint} (stream) model=${requestBody.model} tools(${names.length})=[${names.join(', ')}]`,
        );
      } catch {
        // 日志不能障碍请求
      }

      // 落盘出站请求体（异步，不阻塞 fetch）。
      // 用户报告问题时让他们把 ~/.deepv/last-requests/ 给我们做字节级对账。
      dumpOutboundRequest('stream', requestBody);

      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...userHeaders,
          ...this.getGitHeaders(),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();

        // 401错误特殊处理 - 与非流式API保持一致
        if (response.status === 401 && isOurAuthError(errorText)) {
          console.error('[DeepV Server] Stream 401 Unauthorized - triggering auth dialog');
          if (this.authHandler) {
            await this.authHandler();
          }
          throw new UnauthorizedError('Authentication required - please re-authenticate');
        }

        // 451错误特殊处理 - 立即中断
        if (response.status === 451) {
          console.error('[DeepV Server] Stream 451 Region Blocked - IMMEDIATE ABORT');
          // 立即中断当前请求
          controller.abort();
          // 抛出特殊异常立即中断事件循环
          throw new Error(`REGION_BLOCKED_451: ${errorText}`);
        }

        // 为 429/5xx 错误创建带状态码的错误对象，便于重试逻辑判断
        const apiError = new Error(`Stream API error (${response.status}): ${errorText}`);
        (apiError as any).status = response.status;
        throw apiError;
      }

      const duration = Date.now() - startTime;
      console.log('[DeepV Server] Stream API call initiated', {
        endpoint,
        duration: `${duration}ms`,
        status: response.status
      });

      return response;

    } catch (error) {
      const duration = Date.now() - startTime;

      // 🚨 清理资源：移除abort监听器
      if (abortListener) {
        abortListener();
      }

      // 用户取消请求的优雅处理
      if (error instanceof Error &&
          (error.message.includes('cancelled by user') || error.name === 'AbortError')) {
        console.log('⚠️  流式任务已取消');
        throw error;
      }

      // 超时错误处理
      if (error instanceof Error && error.message.includes('abort')) {
        logger.warn('[DeepV Server] Stream API aborted', {
          endpoint,
          duration: `${duration}ms`,
          reason: error.message
        });
      } else {
        logger.error('[DeepV Server] Stream API call failed', {
          endpoint,
          duration: `${duration}ms`,
          error: error instanceof Error ? error.message : error
        });
      }

      throw error;
    } finally {
      // 清理abort监听器
      if (abortListener) {
        abortListener();
      }
    }
  }

  /**
   * 🆕 创建流式生成器
   *
   * 超时保护策略（针对 SSE/流式响应）：
   * - 每次 read() 调用的等待时间不超过 300 秒
   * - 如果 300 秒内未收到任何数据块，自动中止（防止僵死连接）
   * - 只要数据块在 300 秒内持续到达，即使总耗时很长也不会超时
   * - 这支持长时间运行的推理模型（如 o1 系列，思考可能需要几分钟）
   * - 用户可以通过 abortSignal 随时取消请求
   *
   * 设计意图：防止单个数据块卡顿，但允许完整的流式响应任意长
   */
  private async *createStreamGenerator(response: Response, abortSignal?: AbortSignal): AsyncGenerator<GenerateContentResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No stream reader available');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytesRead = 0;
    let lastUsageMetadata: any = null;

    // 🛡️ 工具调用累积器：服务端常常把同一个 functionCall 拆成多个 SSE chunk
    // 推送（先 name、再分批 args、最后 finishReason）。如果客户端把每个 chunk
    // 立即 yield 给 Turn.run()，turn 会对每个 chunk 都执行
    // handlePendingFunctionCall —— 结果就是把同一个工具调用 push 成多个残缺
    // 的 ToolCallRequest（甚至出现 args 缺失或 name 缺失），最终
    // finishReason=FUNCTION_CALL 但 functionCalls=0 / 或重复调用。
    //
    // 修复：仅对含 functionCall 的 chunk 累积合并，等流结束（[DONE] 或 reader.done）
    // 才 yield 一次完整的合并 chunk。纯文本 chunk 仍然立即 yield，保留流式打字体感。
    //
    // 注：mergeStreamContent 之前是死代码（定义但从未调用）；此处启用它。
    let accumulatedToolChunk: any = null;

    // 🎯 关键保护机制：监听客户端取消信号
    // 当用户中断时，立即释放流读取器并停止消费数据
    const handleAbort = () => {
      console.log('[DeepV Server] Stream cancelled by user - releasing reader and stopping consumption');
      try {
        reader.cancel();  // 立即取消流读取
      } catch (e) {
        // 忽略cancel可能抛出的错误
      }
    };

    // 为 abortSignal 添加监听器，一旦用户取消就立即调用 handleAbort
    let abortListener: (() => void) | undefined;
    if (abortSignal && !abortSignal.aborted) {
      abortListener = handleAbort;
      abortSignal.addEventListener('abort', abortListener);
    }

    try {
      while (true) {
        // 检查是否被用户中止（二次检查 + 快速退出）
        if (abortSignal?.aborted) {
          console.log('[DeepV Server] Stream generation cancelled by user - exiting loop');

          // 📊 记录部分消费的tokens（如果有）
          if (lastUsageMetadata) {
            console.log('[DeepV Server] Partial token consumption recorded:', {
              inputTokens: lastUsageMetadata.promptTokenCount || 0,
              outputTokens: lastUsageMetadata.candidatesTokenCount || 0,
              totalTokens: lastUsageMetadata.totalTokenCount || 0,
              stoppedReason: 'user_cancelled',
              bytesReceived: totalBytesRead,
            });
          }
          break;
        }

        // ⏱️ 为每个 read() 添加 300 秒的空闲超时
        // 保护机制：如果 300 秒内没有收到任何数据，认为连接已断或服务无响应
        // 但流中每来一个数据块，计时器就重置（新的 read() 调用）
        let readResult;
        try {
          readResult = await this.withTimeout(
            reader.read(),
            300000,
            '[DeepV Server] Stream read timeout after 300s (no data received in this chunk)'
          );
        } catch (readError) {
          // 如果是 AbortError（由 reader.cancel() 引发），则优雅退出
          if (readError instanceof Error &&
              (readError.name === 'AbortError' || readError.message.includes('cancelled'))) {
            console.log('[DeepV Server] Stream read cancelled - exiting');
            break;
          }

          // 🆕 捕获 TCP 中断错误（如服务器重启导致的连接断开）
          if (readError instanceof TypeError) {
            const errorMessage = readError.message.toLowerCase();
            const errorCode = (readError as any)?.cause?.code || (readError as any)?.code;

            const isTCPInterrupt =
              errorMessage.includes('terminated') ||
              errorMessage.includes('socket hang up') ||
              errorMessage.includes('connection closed') ||
              errorMessage.includes('other side closed') ||
              (errorCode && [
                'ECONNRESET',
                'ECONNABORTED',
                'EPIPE',
                'ETIMEDOUT',
                'UND_ERR_SOCKET',
              ].includes(errorCode));

            if (isTCPInterrupt) {
              // 创建一个带标记的错误，便于上层识别和处理
              const streamInterruptError = new Error(
                `Stream interrupted: Connection was terminated mid-stream. ` +
                `This may be caused by server restart or network issues. ` +
                `Please retry your request. (Original: ${readError.message})`
              );
              (streamInterruptError as any).isStreamInterrupt = true;
              (streamInterruptError as any).isRetryable = true;
              (streamInterruptError as any).bytesReceived = totalBytesRead;
              console.warn(`⚠️  [DeepV Server] Stream connection interrupted after ${totalBytesRead} bytes. Cause: ${readError.message}`);
              throw streamInterruptError;
            }
          }

          // 其他错误继续抛出
          throw readError;
        }

        const { done, value } = readResult;
        if (done) {
          // 🛡️ 流自然结束：flush 累积的工具调用 chunk
          if (accumulatedToolChunk) {
            // 🔍 [STOP-DEBUG][adapter] 诊断日志 #3a：done flush
            const fcs = accumulatedToolChunk.candidates?.[0]?.content?.parts?.filter((p: any) => p.functionCall) ?? [];
            console.log(
              `[STOP-DEBUG][adapter] FLUSH on reader.done: functionCallCount=${fcs.length}, names=[${fcs.map((p: any) => p.functionCall?.name ?? '').join(',')}]`,
            );
            this.finalizeAccumulatedToolChunk(accumulatedToolChunk);
            yield accumulatedToolChunk;
            accumulatedToolChunk = null;
          } else {
            // 🔍 [STOP-DEBUG][adapter] 诊断日志：done 但累加器空
            console.log(
              '[STOP-DEBUG][adapter] reader.done with NO accumulator (no tool calls were accumulated)',
            );
          }
          break;
        }

        totalBytesRead += value.length;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              // 🛡️ 收到 [DONE]：flush 累积的工具调用 chunk
              if (accumulatedToolChunk) {
                // 🔍 [STOP-DEBUG][adapter] 诊断日志 #3b：[DONE] flush
                const fcs = accumulatedToolChunk.candidates?.[0]?.content?.parts?.filter((p: any) => p.functionCall) ?? [];
                console.log(
                  `[STOP-DEBUG][adapter] FLUSH on [DONE]: functionCallCount=${fcs.length}, names=[${fcs.map((p: any) => p.functionCall?.name ?? '').join(',')}]`,
                );
                this.finalizeAccumulatedToolChunk(accumulatedToolChunk);
                yield accumulatedToolChunk;
                accumulatedToolChunk = null;
              } else {
                // 🔍 [STOP-DEBUG][adapter] 诊断日志：[DONE] 但累加器空
                console.log(
                  '[STOP-DEBUG][adapter] [DONE] with NO accumulator (no tool calls were accumulated)',
                );
              }
              return; // 流结束
            }

            try {
              // 🆕 无条件先打 RAW SSE line（在 JSON.parse 之前），
              // 这样即便 chunk 被 SSE 边界切坏导致 parse 失败，也能看出
              // 客户端到底从网络上读到了什么字节。这是「服务端说下发了
              // 但客户端日志里没看到」类问题的关键诊断点。
              if (data.includes('"reasoning"') || data.includes('"thought"')) {
                console.log(
                  `[REASONING-TRACE][adapter] PRE-PARSE SSE line (${data.length}B contains reasoning/thought): ${data.length > 600 ? data.substring(0, 600) + '…[truncated]' : data}`,
                );
              }

              const chunk = JSON.parse(data);

              // 🔍 [STOP-DEBUG][adapter] 诊断日志 #1：原始服务器 chunk
              // 用途：定位 function_call 在哪一层丢失。如果服务器根本没发送
              // parts[i].functionCall（而是发了 tool_use / tool_call 之类的
              // 其它 schema），下面的 hasFunctionCall 判断就会 false，整个
              // 工具调用就在客户端被静默跳过。
              // 这条日志可以告诉我们 server 真正在发什么。仅打印前 800 字符
              // 防止巨型 chunk 把日志刷屏。
              try {
                const dump = JSON.stringify(chunk);
                console.log(
                  `[STOP-DEBUG][adapter] RAW chunk (${dump.length}B): ${dump.length > 800 ? dump.substring(0, 800) + '…[truncated]' : dump}`,
                );
                // 🆕 reasoning 专项 trace：判定网关是否真的下发了 reasoning 字段
                const partsForTrace = chunk?.candidates?.[0]?.content?.parts ?? [];
                for (let i = 0; i < partsForTrace.length; i++) {
                  const p = partsForTrace[i];
                  if (p && typeof p === 'object') {
                    const keys = Object.keys(p);
                    const hasReasoning = 'reasoning' in p;
                    const hasText = typeof p.text === 'string';
                    const hasThought = p.thought === true;
                    if (hasReasoning || hasThought) {
                      console.log(
                        `[REASONING-TRACE][adapter] chunk part[${i}] keys=[${keys.join(',')}] reasoning=${hasReasoning} thought=${hasThought} text=${hasText}`,
                      );
                    }
                  }
                }
              } catch {
                // 忽略 stringify 失败（含循环引用等极少数情况）
              }

              // 跳过连接确认消息
              if (chunk.type === 'connection_established') {
                continue;
              }

              // 处理错误
              if (chunk.error) {
                throw new Error(chunk.error);
              }

              // 📊 记录最新的使用数据以备客户端取消时记录
              if (chunk.usageMetadata) {
                lastUsageMetadata = chunk.usageMetadata;
              }

              // 🚀 立即转换 - 但是否立即 yield 取决于 chunk 是否含 functionCall
              const genaiResponse = this.convertStreamChunkToGenAI(chunk);
              if (!genaiResponse) {
                // 🔍 [STOP-DEBUG][adapter] 诊断日志：转换失败丢弃
                console.log(
                  '[STOP-DEBUG][adapter] convertStreamChunkToGenAI returned null; chunk skipped',
                );
                continue;
              }

              // 🛡️ 区分工具调用 chunk 与纯文本 chunk
              const parts = genaiResponse.candidates?.[0]?.content?.parts ?? [];
              const hasFunctionCall = parts.some((p: any) => p.functionCall);

              // 🔍 [STOP-DEBUG][adapter] 诊断日志 #2：累加器决策
              // 用途：判断 chunk 进入了三个分支中的哪一个：
              //   (A) hasFunctionCall=true → 累积合并
              //   (B) accumulator 已存在 → 把后续 finishReason/usage 合并进去
              //   (C) 纯文本 → 立即 yield
              // 如果服务器发了 functionCall 但 partsKeys 里看不到 'functionCall'
              // 字段（比如显示 ['toolUse'] / ['name','input']），那就是 schema
              // 不匹配——server 端没把 claude tool_use 翻译成 gemini functionCall。
              const partsKeys = parts.map((p: any) =>
                p && typeof p === 'object' ? Object.keys(p) : typeof p,
              );
              const finishReason = genaiResponse.candidates?.[0]?.finishReason;
              console.log(
                `[STOP-DEBUG][adapter] chunk decision: hasFunctionCall=${hasFunctionCall}, hasAccumulator=${!!accumulatedToolChunk}, finishReason=${finishReason || 'none'}, partsKeys=${JSON.stringify(partsKeys)}`,
              );

              if (hasFunctionCall) {
                // 含 functionCall 的 chunk —— 不立即 yield，先累积合并
                accumulatedToolChunk = this.mergeStreamContent(
                  accumulatedToolChunk,
                  genaiResponse,
                );
              } else if (accumulatedToolChunk) {
                // 已经在累积工具调用了：把后续 chunk（可能携带 finishReason
                // 或 usageMetadata）也合并进去，等流结束再统一发出。
                // 这样能避免 finishReason 提前到达 turn.ts 时 functionCalls
                // 还没合并完整的竞态。
                accumulatedToolChunk = this.mergeStreamContent(
                  accumulatedToolChunk,
                  genaiResponse,
                );
              } else {
                // 纯文本 / thought / reasoning chunk —— 立即 yield，保留流式
                yield genaiResponse;
              }

            } catch (parseError) {
              // 🆕 SSE chunk 解析失败 — 用 console.error 替代 logger.warn，
              // 让它一定进入 ConsolePatcher → /export-debug。同时打印完整
              // 出错的 data 字节内容（不要截断），便于排查 SSE 边界 / 转义问题。
              console.error(
                `[REASONING-TRACE][adapter] ⚠ SSE chunk parse FAILED: ${parseError instanceof Error ? parseError.message : parseError}`,
              );
              console.error(
                `[REASONING-TRACE][adapter] failed-data length=${data.length}, full content: ${data}`,
              );
              // 忽略解析错误，继续处理
            }
          }
        }
      }
    } finally {
      // 🧹 清理：移除 abort 监听器
      if (abortListener && abortSignal) {
        abortSignal.removeEventListener('abort', abortListener);
      }

      try {
        reader.releaseLock();
      } catch (e) {
        // 忽略release可能的错误
      }
    }
  }

  /**
   * 🆕 将流式块转换为GenAI格式
   */
  private convertStreamChunkToGenAI(chunk: any): GenerateContentResponse | null {
    if (!chunk.candidates || !Array.isArray(chunk.candidates) || chunk.candidates.length === 0) {
      return null;
    }

    // 确保响应对象有 functionCalls getter（复用现有逻辑）
    const response = {
      candidates: chunk.candidates,
      usageMetadata: chunk.usageMetadata
    } as GenerateContentResponse;

    // 🚀 预处理：补全缺失的 ID
    if (response.candidates?.[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.functionCall && !part.functionCall.id) {
          const generatedId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          console.log(`[DeepV Server] 补全缺失的工具 ID (Chunk): ${part.functionCall.name} -> ${generatedId}`);
          part.functionCall.id = generatedId;
        }
      }
    }

    if (!response.functionCalls) {
      Object.defineProperty(response, 'functionCalls', {
        get: function() {
          if (this.candidates?.[0]?.content?.parts?.length === 0) {
            return undefined;
          }
          if (this.candidates && this.candidates.length > 1) {
            console.warn(
              'there are multiple candidates in the response, returning function calls from the first one.',
            );
          }
          const functionCalls = this.candidates?.[0]?.content?.parts
            ?.filter((part: any) => part.functionCall)
            .map((part: any) => part.functionCall)
            .filter((functionCall: any) => functionCall !== undefined);
          if (functionCalls?.length === 0) {
            return undefined;
          }
          return functionCalls;
        },
        enumerable: false,
        configurable: true
      });
    }

    return response;
  }

  /**
   * 把累积器里残留的"字符串形式 args"归一化成对象。
   *
   * server 端流式分片可能把 args 作为 JSON 字符串增量推送（"{\"k\":", "\"v\"}"），
   * mergeStreamContent 仅做字符串拼接；但下游 SchemaValidator 期望 args 是
   * 对象，不归一会报 "params must be an object"。在 yield 累积器前调用此函数。
   *
   * 失败容忍：JSON.parse 抛错时保持原字符串不动，让下游能输出更准确的错误。
   */
  private finalizeAccumulatedToolChunk(chunk: any): void {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return;
    for (const p of parts) {
      const fc = p?.functionCall;
      if (!fc) continue;
      if (typeof fc.args === 'string') {
        const trimmed = fc.args.trim();
        if (trimmed.length === 0) {
          fc.args = {};
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            fc.args = parsed;
          }
        } catch (e) {
          console.warn(
            `[DeepV Server] Failed to parse accumulated functionCall.args as JSON for tool "${fc.name}". Keeping raw string for downstream error reporting. Raw: ${trimmed.substring(0, 200)}`,
          );
        }
      } else if (fc.args === undefined || fc.args === null) {
        fc.args = {};
      }
    }
  }

  /**
   * 合并流式 chunk 到累积器中。
   *
   * 用于把 SSE 工具调用流（一个 functionCall 被服务端拆成多个 chunk：
   * 先 name、再分批 args、最后 finishReason）重新拼回成一个完整的 chunk，
   * 然后由 createStreamGenerator 在流结束时一次性 yield 给上层。这样
   * Turn.run 看到的"含 functionCall 的 chunk"就一定是完整的、最终的，
   * 不会出现 turn.ts 对同一个工具调用 push 多个残缺 ToolCallRequest。
   *
   * 关键点：
   *   - 第一次合并（accumulated === null）做深拷贝，避免污染原始 chunk；
   *   - 遍历 newChunk 的所有 parts（不是只看 parts[0]），同 chunk 同时
   *     含 text + functionCall 的情况也能正确处理；
   *   - 文本 part 累积到 accumulator 末尾的同质 part 上，避免文本碎片；
   *   - functionCall part 按"id 判同"合并：accumulator 末尾若是同 id（或新
   *     分片无 id 视为续传）的 functionCall 则 in-place 合并；若双方 id 都
   *     存在且不同（并行 tool_call），作为新独立 part 推入，避免静默吞调用；
   *     accumulator 末尾不是 functionCall 时也作为新独立 part 推入；
   *   - args 的合并兼容字符串增量（流式 JSON 拼接）和对象增量（浅合并）；
   *   - usageMetadata 与 finishReason 始终用最新 chunk 的值覆盖累积器。
   */
  private mergeStreamContent(accumulated: any, newChunk: GenerateContentResponse): GenerateContentResponse {
    if (!accumulated) {
      // 🛡️ 深拷贝首个含 functionCall 的 chunk 作为累积器底座，避免后续
      // mutate 污染原始 chunk（原始 chunk 的 candidates 引用可能被其他
      // 路径读取，例如 chunks[] 历史持久化）。
      const cloned: any = {
        candidates: newChunk.candidates ? structuredClone(newChunk.candidates) : [],
        usageMetadata: newChunk.usageMetadata,
      };
      // 重新挂上 functionCalls getter（structuredClone 会丢掉 defineProperty 注入）
      Object.defineProperty(cloned, 'functionCalls', {
        get: function () {
          const parts = this.candidates?.[0]?.content?.parts;
          if (!parts || parts.length === 0) return undefined;
          const fcs = parts
            .filter((p: any) => p.functionCall)
            .map((p: any) => p.functionCall)
            .filter((fc: any) => fc !== undefined);
          return fcs.length === 0 ? undefined : fcs;
        },
        enumerable: false,
        configurable: true,
      });

      // 🚀 ID 补全：首个 chunk 里若有 functionCall 但缺 id，立即补全
      const firstParts = cloned.candidates?.[0]?.content?.parts || [];
      for (const p of firstParts) {
        if (p.functionCall && !p.functionCall.id) {
          const generatedId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          console.log(`[DeepV Server] 补全缺失的工具 ID (Merge init): ${p.functionCall.name} -> ${generatedId}`);
          p.functionCall.id = generatedId;
        }
      }

      return cloned as GenerateContentResponse;
    }

    const accumulatedParts: any[] = accumulated.candidates?.[0]?.content?.parts || [];
    const newParts: any[] = newChunk.candidates?.[0]?.content?.parts || [];

    // 🛡️ 遍历新 chunk 的每一个 part，按 part 类型分别合并
    for (const newPart of newParts) {
      if (newPart.text !== undefined) {
        // 文本累积：粘到 accumulator 末尾同质（纯 text、无 functionCall）part 上
        const lastAccPart = accumulatedParts[accumulatedParts.length - 1];
        if (lastAccPart && lastAccPart.text !== undefined && !lastAccPart.functionCall) {
          lastAccPart.text = (lastAccPart.text || '') + (newPart.text || '');
        } else {
          accumulatedParts.push({ ...newPart });
        }
        continue;
      }

      if (newPart.functionCall) {
        // functionCall 合并策略：
        //   - 若新 chunk 是"同一个调用"的增量分片（同 id，或新分片无 id 视为续传），
        //     则 in-place 合并进 accumulator 末尾的 functionCall；
        //   - 若新 chunk 是"另一个并行调用"（两端 id 都存在且不同），
        //     作为新的独立 part 推入，避免静默吞掉并行 tool_call。
        const lastAccPart = accumulatedParts[accumulatedParts.length - 1];
        if (lastAccPart && lastAccPart.functionCall) {
          const accFc = lastAccPart.functionCall;
          const newFc = newPart.functionCall;

          const isContinuation =
            !newFc.id || !accFc.id || newFc.id === accFc.id;

          if (isContinuation) {
            // 🛡️ name: trim 防止模型返回带空格的工具名
            if (newFc.name) accFc.name = String(newFc.name).trim();
            // id 通常在第一个分片就到，但若后到也覆盖
            if (newFc.id) accFc.id = newFc.id;

            // args 增量合并
            if (newFc.args !== undefined && newFc.args !== null) {
              if (typeof newFc.args === 'string' && typeof accFc.args === 'string') {
                accFc.args = (accFc.args || '') + newFc.args;
              } else if (typeof newFc.args === 'object') {
                accFc.args = {
                  ...(typeof accFc.args === 'object' && accFc.args ? accFc.args : {}),
                  ...newFc.args,
                };
              } else {
                accFc.args = newFc.args;
              }
            }
          } else {
            // 并行调用：作为新的独立 part 推入
            const partToPush: any = { ...newPart, functionCall: { ...newFc } };
            if (!partToPush.functionCall.id) {
              const generatedId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
              console.log(`[DeepV Server] 补全缺失的工具 ID (Merge parallel): ${partToPush.functionCall.name} -> ${generatedId}`);
              partToPush.functionCall.id = generatedId;
            }
            accumulatedParts.push(partToPush);
          }
        } else {
          // 新的独立 functionCall part
          const partToPush: any = { ...newPart, functionCall: { ...newPart.functionCall } };
          if (!partToPush.functionCall.id) {
            const generatedId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            console.log(`[DeepV Server] 补全缺失的工具 ID (Merge): ${partToPush.functionCall.name} -> ${generatedId}`);
            partToPush.functionCall.id = generatedId;
          }
          accumulatedParts.push(partToPush);
        }
        continue;
      }

      // 其他类型 part（thought / functionResponse 等）：直接 push（不合并）
      accumulatedParts.push({ ...newPart });
    }

    // 确保 candidates[0].content.parts 引用回写（万一 accumulator 没建立 parts）
    if (accumulated.candidates?.[0]?.content) {
      accumulated.candidates[0].content.parts = accumulatedParts;
    }

    // 更新使用统计（使用最新的）
    if (newChunk.usageMetadata) {
      accumulated.usageMetadata = newChunk.usageMetadata;
    }

    // 更新完成原因（始终以最新 chunk 为准）
    const newFinishReason = newChunk.candidates?.[0]?.finishReason;
    if (newFinishReason && accumulated.candidates?.[0]) {
      accumulated.candidates[0].finishReason = newFinishReason;
    }

    return accumulated;
  }

  /**
   * 🆕 构建统一请求格式（用于流式）
   */
  private buildUnifiedRequest(request: GenerateContentParameters, scene: SceneType): any {
    const sceneModel = SceneManager.getModelForScene(scene);
    const userModel = this.config?.getModel();

    // 🆕 如果用户使用自定义模型，忽略场景固定模型
    let modelToUse: string;
    if (userModel && isCustomModel(userModel)) {
      if (request.model && isCustomModel(request.model)) {
        modelToUse = request.model;
      } else {
        modelToUse = userModel;
      }
    } else {
      modelToUse = request.model || sceneModel || 'auto';
    }

    return {
      model: modelToUse,
      contents: request.contents,
      config: {
        ...request.config,
        httpOptions: {
          ...request.config?.httpOptions,
          headers: {
            ...request.config?.httpOptions?.headers,
            'X-Scene-Type': scene,
            'X-Scene-Display': SceneManager.getSceneDisplayName(scene),
          }
        }
      }
    };
  }

  /**
   * 🆕 处理流式错误 - 复用统一错误处理逻辑
   */
  private async *handleStreamError(error: unknown): AsyncGenerator<GenerateContentResponse> {
    this.handleError(error);
  }

  /**
   * Token计数 - 使用新的统一端点
   */
  async countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    try {
      // 🔧 自定义模型返回 0 token，不进行估算
      // 这样可以清楚地看到自定义模型不支持 token 计数
      const modelToUse = request.model || this.config?.getModel() || 'auto';
      if (isCustomModel(modelToUse)) {
        console.log('[DeepV Server] Custom model detected, token counting not supported');
        return { totalTokens: 0 };
      }

      // 构建统一的GenAI格式请求，包含 systemInstruction 和 tools（如果有）
      const unifiedRequest: {
        model: string;
        contents: typeof request.contents;
        config?: { systemInstruction?: unknown; tools?: unknown };
      } = {
        model: modelToUse,
        contents: request.contents
      };

      // 从 request.config 中提取 systemInstruction 和 tools
      if (request.config?.systemInstruction || request.config?.tools) {
        unifiedRequest.config = {};
        if (request.config.systemInstruction) {
          unifiedRequest.config.systemInstruction = request.config.systemInstruction;
        }
        if (request.config.tools) {
          unifiedRequest.config.tools = request.config.tools;
        }
      }

      // 调用统一Token计数API
      const response = await this.callUnifiedTokenCountAPI(unifiedRequest);

      // 发射实时token事件，立即更新UI显示
      realTimeTokenEventManager.emitRealTimeToken({
        inputTokens: response.totalTokens || 0,
        outputTokens: 0, // Token计数不生成输出
        totalTokens: response.totalTokens || 0,
        timestamp: Date.now(),
      });

      return response;

    } catch (error) {
      // 对于自定义模型，token count 失败是预期行为，使用 debug 级别
      const modelToUse = request.model || this.config?.getModel() || 'auto';
      if (isCustomModel(modelToUse)) {
        console.log('[DeepV Server] Token count not available for custom model, using fallback');
      } else {
        logger.error('[DeepV Server] Token count failed:', error);
      }

      // 回退到估算方法
      return this.estimateTokensAsFailback(request);
    }
  }

  /**
   * Token计数专用API调用
   */
  private async callUnifiedTokenCountAPI(requestBody: any): Promise<CountTokensResponse> {
    const userHeaders = await proxyAuthManager.getUserHeaders();
    const proxyUrl = `${proxyAuthManager.getProxyServerUrl()}/v1/chat/count-tokens`;

    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          // 注意：count-tokens 端点不发送 git header（协议 v1.4.2 §DoD）
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();

        // 401错误特殊处理
        if (response.status === 401 && isOurAuthError(errorText)) {
          console.error('[DeepV Server] Token count 401 Unauthorized');
          if (this.authHandler) {
            await this.authHandler();
          }
          throw new UnauthorizedError('Authentication required - please re-authenticate');
        }

        throw new Error(`Token count API failed (${response.status}): ${errorText}`);
      }

      const responseData = await response.json();

      console.log('[DeepV Server] Token count response', {
        totalTokens: responseData.totalTokens
      });

      return {
        totalTokens: responseData.totalTokens || 0
      };

    } catch (error) {
      logger.error('[DeepV Server] Token count API call failed:', error);
      throw error;
    }
  }

  /**
   * 回退的Token估算方法
   * 改进版：包含工具调用、响应，以及更准确的字符到token转换
   */
  private estimateTokensAsFailback(request: CountTokensParameters): CountTokensResponse {
    try {
      const contentsArray = Array.isArray(request.contents) ? request.contents : [{ role: MESSAGE_ROLES.USER, parts: [{ text: request.contents }] }];
      let totalChars = 0;
      let toolCallCount = 0;
      let toolResultCount = 0;
      let textParts = 0;

      for (const content of contentsArray) {
        if (typeof content === 'object' && content && 'parts' in content && Array.isArray(content.parts)) {
          for (const part of content.parts) {
            if (typeof part === 'object' && part && 'text' in part && typeof part.text === 'string') {
              totalChars += part.text.length;
              textParts++;
            } else if (typeof part === 'object' && part && 'functionCall' in part && (part as any).functionCall) {
              // 估算工具调用的token数
              const functionCall = (part as any).functionCall;
              const toolCallText = `[Tool: ${functionCall.name}]` +
                                  JSON.stringify(functionCall.args || {});
              totalChars += toolCallText.length;
              toolCallCount++;
           } else if (typeof part === 'object' && part && 'functionResponse' in part && (part as any).functionResponse) {
              // 估算工具响应的token数
              const functionResponse = (part as any).functionResponse;
              const output = functionResponse.response?.output || 'result';
              const toolResultText = `[Tool Result: ${output}]`;
              totalChars += toolResultText.length + 20; // 额外的结构开销
              toolResultCount++;
           }
          }
        } else if (typeof content === 'string') {
          totalChars += content.length;
          textParts++;
        }
      }

      // 改进的字符到token转换
      const contentStr = JSON.stringify(contentsArray);
      const hasChineseChars = /[\u4e00-\u9fff]/.test(contentStr);
      const hasCodeContent = /```|function|class|import|export|\{|\}|\[|\]/.test(contentStr);

      let charsPerToken = 4; // 默认英文比例
      if (hasChineseChars) {
        charsPerToken = 2; // 中文密度更高
      } else if (hasCodeContent) {
        charsPerToken = 3; // 代码token密度介于中间
      }

      const estimatedTokens = Math.ceil(totalChars / charsPerToken);

      return {
        totalTokens: estimatedTokens,
      };
    } catch (error) {
      console.error('[DeepV Server] Fallback estimation error:', error);
      return {
        totalTokens: 1000, // Default fallback
      };
    }
  }



  /**
   * Embedding: Claude doesn't support this
   */
  async embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    throw new Error('Claude models do not support embedding content');
  }

  /**
   * ⏱️ 为 Promise 添加超时保护的通用工具
   *
   * 超时策略汇总：
   * ┌─ 非流式请求 (generateContent)
   * │  ├─ 连接层：300s 等待响应头（TCP 建立 + 首响）
   * │  ├─ 数据层：300s 接收响应体（response.body）
   * │  └─ 解析层：300s 解析 JSON（response.json()）
   * │
   * └─ 流式请求 (_generateContentStream)
   *    └─ 读取层：每个 read() 调用 300s 超时
   *       （若数据块在 300s 内到达则重置，无整体限制）
   *       用途：防止单个数据块卡顿，支持长推理时间
   *
   * 实现：使用 Promise.race 竞速机制 + 显式清理
   * ⚠️  关键：必须清理超时定时器，否则每次调用都泄漏 300s 的 setTimeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      // 🔑 关键清理：如果 promise 先完成，必须清理 timeoutId
      // 否则会形成幽灵定时器，占用内存 300 秒，高并发下导致严重内存泄漏
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    });
  }
}
