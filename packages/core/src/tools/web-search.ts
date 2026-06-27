/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GroundingMetadata } from '@google/genai';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';

import { getErrorMessage } from '../utils/errors.js';
import { Config } from '../config/config.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { SceneType } from '../core/sceneManager.js';
import { t } from '../utils/simpleI18n.js';
import { proxyAuthManager } from '../core/proxyAuth.js';
import { isOttoQuotaError } from '../utils/quotaErrorDetection.js';
import { isCustomModel, generateCustomModelId } from '../types/customModel.js';

// 最大内容长度限制（10K字符），防止token爆炸
const MAX_CONTENT_LENGTH = 10000;

interface GroundingChunkWeb {
  uri?: string;
  title?: string;
}

interface GroundingChunkItem {
  web?: GroundingChunkWeb;
  // Other properties might exist if needed in the future
}

interface GroundingSupportSegment {
  startIndex: number;
  endIndex: number;
  text?: string; // text is optional as per the example
}

interface GroundingSupportItem {
  segment?: GroundingSupportSegment;
  groundingChunkIndices?: number[];
  confidenceScores?: number[]; // Optional as per example
}

/**
 * Parameters for the WebSearchTool.
 */
export interface WebSearchToolParams {
  /**
   * The search query.
   */

  query: string;
}

/**
 * Extends ToolResult to include sources for web search.
 */
export interface WebSearchToolResult extends ToolResult {
  sources?: GroundingMetadata extends { groundingChunks: GroundingChunkItem[] }
    ? GroundingMetadata['groundingChunks']
    : GroundingChunkItem[];
}

/**
 * A tool to perform web searches via the Gemini API.
 */
export class WebSearchTool extends BaseTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name: string = 'google_web_search';

  constructor(private readonly config: Config) {
    super(
      WebSearchTool.Name,
      'Web Search',
      'Performs a web search using Google Search (via the Gemini API) and returns the results. This tool is useful for finding information on the internet based on a query.',
      Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The search query to find information on the web.',
          },
        },
        required: ['query'],
      },
    );
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  validateParams(params: WebSearchToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params, WebSearchTool.Name);
    if (errors) {
      return errors;
    }

    if (!params.query || params.query.trim() === '') {
      return "The 'query' parameter cannot be empty.";
    }
    return null;
  }

  getDescription(params: WebSearchToolParams): string {
    return `Searching the web for: "${params.query}"`;
  }

  /**
   * 检测错误是否为 401 未授权错误
   */
  private is401Error(error: unknown): boolean {
    // 检查 error.status
    if (error && typeof error === 'object' && 'status' in error) {
      if ((error as { status: number }).status === 401) {
        return true;
      }
    }

    // 检查 error.response.status
    if (error && typeof error === 'object' && 'response' in error) {
      const response = (error as { response?: { status?: number } }).response;
      if (response && response.status === 401) {
        return true;
      }
    }

    // 检查错误消息
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (message.includes('401') || message.includes('unauthorized') || message.includes('authentication')) {
        return true;
      }
    }

    return false;
  }

  async execute(
    params: WebSearchToolParams,
    signal: AbortSignal,
  ): Promise<WebSearchToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    // Check if using a custom model
    const currentModel = typeof this.config.getModel === 'function' ? this.config.getModel() : undefined;
    const isUsingCustomModel = currentModel ? isCustomModel(currentModel) : false;
    let resolvedModel: string | undefined = undefined;

    if (isUsingCustomModel && typeof this.config.getCustomModels === 'function') {
      const customModels = this.config.getCustomModels() || [];
      const geminiFlashModel = customModels.find(m => {
        if (m.enabled === false) return false;
        const modelIdLower = (m.modelId || '').toLowerCase();
        const displayNameLower = (m.displayName || '').toLowerCase();
        return (modelIdLower.includes('gemini') && modelIdLower.includes('flash')) ||
               (displayNameLower.includes('gemini') && displayNameLower.includes('flash'));
      });

      if (!geminiFlashModel) {
        return {
          llmContent: `This tool (${WebSearchTool.Name}) is currently unavailable because you are using custom models, but no custom Gemini Flash model (e.g., gemini-2.5-flash) was found in your custom models list to execute this tool. Please configure a custom Gemini Flash model to use this feature.`,
          returnDisplay: `Tool unavailable: Gemini Flash required`
        };
      }
      resolvedModel = generateCustomModelId(geminiFlashModel);
    }

    const geminiClient = this.config.getOttoClient();

    // 🚨 创建超时保护：web search最多30秒
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[WebSearchTool] Web search timeout for query "${params.query}" - aborting after 30s`);
      controller.abort();
    }, 30000);

    try {
      console.log(`[WebSearchTool] Using temporary chat for web search with full API monitoring`);
      // 创建临时Chat获得完整的API日志、Token统计、错误处理等功能
      const temporaryChat = await geminiClient.createTemporaryChat(
        SceneType.WEB_SEARCH,
        resolvedModel, // 使用场景推荐的模型 or 自定义 Gemini Flash 模型
        { type: 'sub', agentId: 'WebSearch' }
      );

      // 设置Google搜索工具
      temporaryChat.setTools([{ googleSearch: {} }]);

      // 🚨 创建组合的abort signal：外部signal或超时signal中任一触发都会中止
      const combinedSignal = AbortSignal.any([signal, controller.signal]);

      const response = await temporaryChat.sendMessage(
        {
          message: params.query,
          config: {
            abortSignal: combinedSignal
          }
        },
        `websearch-${Date.now()}`,
        SceneType.WEB_SEARCH
      );

      const responseText = getResponseText(response);
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const sources = groundingMetadata?.groundingChunks as
        | GroundingChunkItem[]
        | undefined;
      const groundingSupports = groundingMetadata?.groundingSupports as
        | GroundingSupportItem[]
        | undefined;

      if (!responseText || !responseText.trim()) {
        return {
          llmContent: `No search results or information found for query: "${params.query}"`,
          returnDisplay: 'No information found.',
        };
      }

      let modifiedResponseText = responseText;
      const sourceListFormatted: string[] = [];

      if (sources && sources.length > 0) {
        sources.forEach((source: GroundingChunkItem, index: number) => {
          const title = source.web?.title || 'Untitled';
          const uri = source.web?.uri || 'No URI';
          sourceListFormatted.push(`[${index + 1}] ${title} (${uri})`);
        });

        if (groundingSupports && groundingSupports.length > 0) {
          const insertions: Array<{ index: number; marker: string }> = [];
          groundingSupports.forEach((support: GroundingSupportItem) => {
            if (support.segment && support.groundingChunkIndices) {
              const citationMarker = support.groundingChunkIndices
                .map((chunkIndex: number) => `[${chunkIndex + 1}]`)
                .join('');
              insertions.push({
                index: support.segment.endIndex,
                marker: citationMarker,
              });
            }
          });

          // Sort insertions by index in descending order to avoid shifting subsequent indices
          insertions.sort((a, b) => b.index - a.index);

          const responseChars = modifiedResponseText.split(''); // Use new variable
          insertions.forEach((insertion) => {
            // Fixed arrow function syntax
            responseChars.splice(insertion.index, 0, insertion.marker);
          });
          modifiedResponseText = responseChars.join(''); // Assign back to modifiedResponseText
        }

        if (sourceListFormatted.length > 0) {
          modifiedResponseText +=
            '\n\nSources:\n' + sourceListFormatted.join('\n'); // Fixed string concatenation
        }
      }

      // 截断过长内容，防止token爆炸
      let finalContent = modifiedResponseText;
      let isTruncated = false;
      if (modifiedResponseText.length > MAX_CONTENT_LENGTH) {
        finalContent = modifiedResponseText.substring(0, MAX_CONTENT_LENGTH);
        isTruncated = true;
      }

      const truncationNotice = isTruncated
        ? `\n\n[Note: Content truncated from ${modifiedResponseText.length} to ${MAX_CONTENT_LENGTH} characters to prevent context overflow]`
        : '';

      return {
        llmContent: `Web search results for "${params.query}":\n\n${finalContent}${truncationNotice}`,
        returnDisplay: t('websearch.results.returned', {
          query: params.query,
          truncated: isTruncated ? t('websearch.results.truncated') : '',
        }),
        sources,
      };
    } catch (error: unknown) {
      // 检测是否使用自定义模型（用户可能未登录 Otto）
      const currentModel = this.config.getModel();
      const isUsingCustomModel = isCustomModel(currentModel);

      // 检测未登录错误（401）
      const is401Error = this.is401Error(error);
      if (is401Error) {
        const notLoggedInMessage = isUsingCustomModel
          ? `This tool (${WebSearchTool.Name}) is currently unavailable because you are not logged in to Otto. ` +
            `Web search requires a Otto account. ` +
            `Do NOT retry this tool until the user logs in. ` +
            `You can continue to assist the user using other tools and your own knowledge.`
          : `This tool (${WebSearchTool.Name}) is currently unavailable due to authentication failure. ` +
            `Please ask the user to re-login using the /auth command. ` +
            `Do NOT retry this tool until authentication is restored.`;

        console.warn(`[WebSearchTool] Authentication error (401) detected for query "${params.query}"`);
        return {
          llmContent: notLoggedInMessage,
          returnDisplay: t('websearch.error.not.logged.in') || 'Not logged in',
        };
      }

      // 检测积分不足错误（402 配额错误）
      if (isOttoQuotaError(error)) {
        const quotaExceededMessage = isUsingCustomModel
          ? `This tool (${WebSearchTool.Name}) is currently unavailable because your Otto account has insufficient credits. ` +
            `Web search requires available credits in your account. ` +
            `Do NOT retry this tool until the user's credit balance is restored. ` +
            `You can continue to assist the user using other tools and your own knowledge.`
          : `This tool (${WebSearchTool.Name}) is currently unavailable due to insufficient credits in your Otto account. ` +
            `Please ask the user to check their account balance or upgrade their plan. ` +
            `Do NOT retry this tool until credits are available.`;

        console.warn(`[WebSearchTool] Quota exceeded error detected for query "${params.query}"`);
        return {
          llmContent: quotaExceededMessage,
          returnDisplay: t('websearch.error.quota.exceeded') || 'Insufficient credits',
        };
      }

      // 其他错误
      const errorMessage = `Error during web search for query "${params.query}": ${getErrorMessage(error)}`;
      console.error(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: t('websearch.error.performing'),
      };
    } finally {
      // 🚨 最终清理：确保超时定时器一定被清除
      clearTimeout(timeoutId);
      controller.abort(); // 清理超时controller
    }
  }
}
