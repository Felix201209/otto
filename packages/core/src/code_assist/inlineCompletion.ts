/**
 * @license
 * Copyright 2025 Easy Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { proxyAuthManager } from '../core/proxyAuth.js';
import { getActiveProxyServerUrl } from '../config/proxyConfig.js';
import { getSessionId } from '../utils/session.js';
import { getGitBranch, getGitCommitSha, getGitProjectPath, getGitRemotes } from '../utils/gitUtils.js';

/**
 * 过滤 HTTP header 值中的非 Latin-1 字符（如中文分支名）。
 * HTTP/1.1 header 值只允许 Latin-1 字符集（\x00-\xFF）。
 */
function toSafeHeaderValue(value: string): string {
  return value.replace(/[^\x00-\xFF]/g, '');
}

/**
 * FIM 补全专用模型 - 固定使用 Codestral 2
 * 🔒 不允许用户更换模型
 */
const FIM_MODEL = 'codestral-2';

/**
 * FIM 补全默认配置
 */
const FIM_DEFAULT_CONFIG = {
  maxOutputTokens: 128,
  temperature: 0.2,
};

/**
 * 行内代码补全请求参数
 */
export interface InlineCompletionRequest {
  /** 文件路径 */
  filePath: string;
  /** 当前光标位置 */
  position: {
    line: number;
    character: number;
  };
  /** 光标前的代码 */
  prefix: string;
  /** 光标后的代码 */
  suffix: string;
  /** 编程语言 */
  language: string;
  /** 最大补全长度（token 数） */
  maxLength?: number;
}

/**
 * 行内代码补全响应
 */
export interface InlineCompletionResponse {
  /** 补全文本 */
  text: string;
  /** 补全范围（可选，用于替换已有文本） */
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * Codestral FIM API 请求格式
 */
interface CodestralFIMRequest {
  model: 'codestral-2';
  prompt: string;
  suffix?: string;
  config?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

/**
 * Codestral FIM API 响应格式
 */
interface CodestralFIMResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
      role: 'model';
    };
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
    index: number;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    creditsUsage?: number;
  };
  modelVersion?: string;
}

/**
 * 行内代码补全服务
 *
 * 🆕 使用 Codestral 2 FIM 专用模型
 *
 * 相比旧的 Gemini 实现：
 * - 直接传 prompt + suffix，无需构造复杂的对话格式
 * - 响应直接返回代码片段，无需清理 markdown
 * - 专为代码补全优化，+30% 接受率
 */
export class InlineCompletionService {
  // 补全缓存（避免重复请求）
  private cache = new Map<string, InlineCompletionResponse>();
  private readonly MAX_CACHE_SIZE = 100;
  /** 项目工作目录，用于采集 git 信息。VSCode 插件模式下应传入打开的项目路径 */
  private readonly workingDir: string;

  constructor(workingDir?: string) {
    this.workingDir = workingDir ?? process.cwd();
    // 🆕 不再需要 Config 和 ContentGenerator
    // Codestral FIM 使用独立的 API 调用
  }

  /**
   * 获取当前使用的模型
   * 🔒 固定返回 codestral-2，不允许更换
   */
  getCurrentModel(): string {
    return FIM_MODEL;
  }

  /**
   * 生成行内代码补全
   *
   * 🆕 使用 Codestral FIM API
   */
  async generateCompletion(
    request: InlineCompletionRequest,
    signal?: AbortSignal
  ): Promise<InlineCompletionResponse | null> {
    const fileName = request.filePath.split(/[\\/]/).pop() || 'unknown';
    const startTime = Date.now();

    console.log(`[Core:FIM] 🚀 generateCompletion started`, JSON.stringify({
      file: fileName,
      position: `${request.position.line}:${request.position.character}`,
      language: request.language,
      prefixLen: request.prefix.length,
      suffixLen: request.suffix.length,
      model: FIM_MODEL,
    }));

    try {
      // 检查缓存
      const cacheKey = this.getCacheKey(request);
      if (this.cache.has(cacheKey)) {
        console.log(`[Core:FIM] ✅ Internal cache HIT`, JSON.stringify({
          file: fileName,
          duration: `${Date.now() - startTime}ms`,
        }));
        return this.cache.get(cacheKey)!;
      }

      // 检查是否被取消
      if (signal?.aborted) {
        console.log(`[Core:FIM] ⏭️ Request already aborted before API call`, { file: fileName });
        return null;
      }

      // 🆕 构建 Codestral FIM 请求
      const fimRequest: CodestralFIMRequest = {
        model: FIM_MODEL,
        prompt: request.prefix,
        suffix: request.suffix,
        config: {
          maxOutputTokens: request.maxLength || FIM_DEFAULT_CONFIG.maxOutputTokens,
          temperature: FIM_DEFAULT_CONFIG.temperature,
        },
      };

      console.log(`[Core:FIM] 📡 Calling Codestral FIM API...`, JSON.stringify({
        file: fileName,
        model: FIM_MODEL,
        promptLen: fimRequest.prompt.length,
        suffixLen: fimRequest.suffix?.length || 0,
      }));

      const apiStartTime = Date.now();

      // 🆕 直接调用 FIM API
      const response = await this.callFIMAPI(fimRequest, signal);

      const apiDuration = Date.now() - apiStartTime;
      console.log(`[Core:FIM] 📡 API response received`, JSON.stringify({
        file: fileName,
        apiDuration: `${apiDuration}ms`,
        hasResponse: !!response,
        hasCandidates: !!response?.candidates?.length,
      }));

      if (signal?.aborted) {
        console.log(`[Core:FIM] ⏭️ Request aborted after API response`, { file: fileName });
        return null;
      }

      // 🆕 直接提取补全文本（FIM 响应无需清理 markdown）
      const completionText = this.extractFIMCompletionText(response);

      if (!completionText) {
        console.log(`[Core:FIM] ⚠️ No completion text in response`, JSON.stringify({
          file: fileName,
          duration: `${Date.now() - startTime}ms`,
          responseStructure: response ? {
            hasCandidates: !!response.candidates,
            candidateCount: response.candidates?.length || 0,
          } : 'null response',
        }));
        return null;
      }

      const result: InlineCompletionResponse = {
        text: completionText,
      };

      // 缓存结果
      this.addToCache(cacheKey, result);

      console.log(`[Core:FIM] ✅ Completion generated successfully`, JSON.stringify({
        file: fileName,
        totalDuration: `${Date.now() - startTime}ms`,
        apiDuration: `${apiDuration}ms`,
        resultLen: completionText.length,
        resultPreview: completionText.slice(0, 60).replace(/\n/g, '\\n') + (completionText.length > 60 ? '...' : ''),
        cacheSize: this.cache.size,
        model: FIM_MODEL,
      }));

      return result;
    } catch (error) {
      console.error(`[Core:FIM] ❌ Error generating completion:`, JSON.stringify({
        file: fileName,
        duration: `${Date.now() - startTime}ms`,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : undefined,
      }));
      return null;
    }
  }

  /**
   * 🆕 调用 Codestral FIM API
   */
  private async callFIMAPI(
    request: CodestralFIMRequest,
    signal?: AbortSignal
  ): Promise<CodestralFIMResponse> {
    const userHeaders = await proxyAuthManager.getUserHeaders();
    const proxyUrl = `${getActiveProxyServerUrl()}/v1/chat/messages`;

    const controller = new AbortController();
    let abortListener: (() => void) | null = null;

    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        const handleAbort = () => {
          console.log('[Core:FIM] Request cancelled by user');
          controller.abort();
        };
        signal.addEventListener('abort', handleAbort);
        abortListener = () => signal.removeEventListener('abort', handleAbort);
      }
    }

    // FIM 请求超时保护：30 秒（补全应该很快）
    const timeoutId = setTimeout(() => {
      console.warn('[Core:FIM] FIM request timeout after 30s');
      controller.abort();
    }, 30000);

    try {
      // 🔍 调试：打印实际发送的请求体
      const requestBody = JSON.stringify(request);
      console.log(`[Core:FIM] 📤 Request body:`, requestBody);

      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...userHeaders,
          // 协议 v1.4.2 新增 header
          'X-DVCode-Scene': 'inline_complete',
          'X-Session-ID': getSessionId(),
          ...getInlineGitHeaders(this.workingDir),
        },
        body: requestBody,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[Core:FIM] 📥 Error response:`, errorText);
        throw new Error(`FIM API error (${response.status}): ${errorText}`);
      }

      const responseData = await response.json() as CodestralFIMResponse;
      console.log(`[Core:FIM] 📥 Success response:`, JSON.stringify(responseData).slice(0, 500));
      return responseData;

    } catch (error) {
      clearTimeout(timeoutId);

      if (abortListener) {
        abortListener();
      }

      // 用户取消请求的优雅处理
      if (error instanceof Error &&
          (error.message.includes('cancelled by user') || error.name === 'AbortError')) {
        throw error;
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (abortListener) {
        abortListener();
      }
    }
  }

  /**
   * 🆕 从 FIM 响应中提取补全文本
   * Codestral FIM 直接返回代码，无需清理 markdown
   */
  private extractFIMCompletionText(response: CodestralFIMResponse): string | null {
    try {
      const candidate = response.candidates?.[0];
      if (!candidate) {
        return null;
      }

      const content = candidate.content;
      if (!content?.parts || content.parts.length === 0) {
        return null;
      }

      // 直接拼接所有文本部分
      let text = '';
      for (const part of content.parts) {
        if (part.text) {
          text += part.text;
        }
      }

      // FIM 响应直接返回代码，通常无需清理
      // 但保险起见仍检查是否有意外的 markdown 标记
      if (text.startsWith('```') && text.endsWith('```')) {
        text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
      }

      return text.trim() || null;
    } catch (error) {
      console.error('[Core:FIM] Error extracting completion text:', error);
      return null;
    }
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(request: InlineCompletionRequest): string {
    const { prefix, suffix, language } = request;
    // 使用最后 200 个字符的 prefix 和前 100 个字符的 suffix
    const prefixKey = prefix.slice(-200);
    const suffixKey = suffix.slice(0, 100);
    return `${language}:${prefixKey}|||${suffixKey}`;
  }

  /**
   * 添加到缓存
   */
  private addToCache(key: string, value: InlineCompletionResponse): void {
    // 如果缓存满了，删除最旧的条目
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * inline_complete 链路专用 git header 采集。
 * 仅对内部员工（@cmcm.com / @orionstar.com / @aicfcf.com）发送，与主链路白名单一致。
 * 静默处理所有异常，git 信息缺失不影响补全功能。
 */
const INTERNAL_EMAIL_DOMAINS = ['@cmcm.com', '@orionstar.com', '@aicfcf.com'];

function getInlineGitHeaders(cwd: string): Record<string, string> {
  try {
    const email = proxyAuthManager.getUserInfo()?.email?.toLowerCase() ?? '';
    const isInternal = INTERNAL_EMAIL_DOMAINS.some((d) => email.endsWith(d));
    if (!isInternal) return {};

    const headers: Record<string, string> = {};

    const remotes = getGitRemotes(cwd);
    if (remotes) {
      headers['X-Git-Remotes'] = JSON.stringify(remotes);
    }

    const branch = getGitBranch(cwd);
    if (branch) headers['X-Git-Branch'] = toSafeHeaderValue(branch);

    const commitSha = getGitCommitSha(cwd);
    if (commitSha) headers['X-Git-Commit'] = commitSha; // sha 只含 [0-9a-f]，无需过滤

    const projectPath = getGitProjectPath(cwd);
    if (projectPath) headers['X-Git-Project-Path'] = toSafeHeaderValue(projectPath);

    return headers;
  } catch {
    return {};
  }
}
