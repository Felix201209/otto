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
import { Config, WebSearchProvider } from '../config/config.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { SceneType } from '../core/sceneManager.js';
import { t } from '../utils/simpleI18n.js';
import { isOttoQuotaError } from '../utils/quotaErrorDetection.js';
import { isCustomModel, generateCustomModelId } from '../types/customModel.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// 最大内容长度限制（10K字符），防止token爆炸
const MAX_CONTENT_LENGTH = 10000;

// bing/bocha 的 HTTP 搜索超时（15秒）；gemini grounding 保留原有 30 秒
const HTTP_SEARCH_TIMEOUT_MS = 15000;

// 国内可直连的 Bing 搜索页（免 key，默认 provider）
const BING_SEARCH_ENDPOINT = 'https://cn.bing.com/search';

// 博查 Web Search API（需 key，可选 provider）
const BOCHA_SEARCH_ENDPOINT = 'https://api.bochaai.com/v1/web-search';

// 不带常规桌面 UA 时 Bing 可能直接拒绝或返回验证页，这里固定一个主流桌面 UA
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

/** 统一的搜索结果条目（bing/bocha 两个 HTTP provider 共用） */
interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
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
 * 解码常见 HTML 实体。只处理搜索摘要里高频出现的几种，
 * 不追求完备（完备解码需要引依赖，违背零依赖原则）。
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 && n < 0x10ffff
        ? String.fromCodePoint(n)
        : _m;
    });
}

/** 去 HTML 标签 + 解实体 + 压空白，得到纯文本 */
function cleanHtmlText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析 Bing 搜索结果页 HTML。
 * 结构约定：每条结果是 <li class="b_algo">，内含 h2>a（标题+链接）
 * 与 .b_caption 下的 <p>（摘要）。用正则/字符串切块解析，不引 HTML 解析依赖。
 * 防御性：结构对不上时返回空数组，由调用方 fail-loud 报明确错误。
 */
export function parseBingResults(html: string): WebSearchResultItem[] {
  const items: WebSearchResultItem[] = [];

  // 找到每个结果块的起点，按起点切块（块间无嵌套 b_algo，切块足够安全）
  const blockStartRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/g;
  const starts: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockStartRegex.exec(html)) !== null) {
    starts.push(match.index);
  }

  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(
      starts[i],
      i + 1 < starts.length ? starts[i + 1] : undefined,
    );

    // 标题 + 链接：h2 内第一个 <a href="...">
    const titleMatch = block.match(
      /<h2[^>]*>[\s\S]*?<a[^>]*?href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!titleMatch) continue;

    const url = decodeHtmlEntities(titleMatch[1]).trim();
    const title = cleanHtmlText(titleMatch[2]);

    // 摘要：优先 .b_caption 下的 <p>，退化为块内第一个 <p>
    const captionMatch =
      block.match(
        /class="[^"]*\bb_caption\b[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/,
      ) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = captionMatch ? cleanHtmlText(captionMatch[1]) : '';

    // 只收真正的外链结果（广告/内部锚点等 href 非 http 的直接丢弃）
    if (title && /^https?:\/\//.test(url)) {
      items.push({ title, url, snippet });
    }
  }

  return items;
}

/**
 * A tool to perform web searches.
 *
 * Provider 分层（config.searchProvider 显式选择，默认 'bing'）：
 * - bing：抓取 cn.bing.com 搜索页并解析 HTML，免 key、国内开箱可用
 * - bocha：博查 Web Search API，需 searchApiKey（或环境变量 OTTO_BOCHA_API_KEY）
 * - gemini：原有 Google Search grounding（依赖 Gemini API，海外可用）
 */
export class WebSearchTool extends BaseTool<
  WebSearchToolParams,
  WebSearchToolResult
> {
  static readonly Name: string = 'web_search';

  constructor(private readonly config: Config) {
    super(
      WebSearchTool.Name,
      'Web Search',
      'Performs a web search and returns a numbered list of results (title, URL, snippet). Works in mainland China out of the box: the default provider fetches Bing China search results without any API key. The provider is configurable via settings (bing / bocha / gemini). Useful for finding information on the internet based on a query.',
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

    // 与 web-fetch 相同的代理接入方式：配置了 proxy 时挂 undici 全局
    // dispatcher，让 bing/bocha 的 fetch 请求也走用户配置的代理。
    const proxy =
      typeof config.getProxy === 'function' ? config.getProxy() : undefined;
    if (proxy) {
      setGlobalDispatcher(new ProxyAgent(proxy as string));
    }
  }

  /**
   * Validates the parameters for the WebSearchTool.
   * 注意：必须命名为 validateToolParams（覆写 BaseTool），execute 调的就是它；
   * 旧版写成 validateParams 导致校验从未生效（空 query 会真发请求）。
   * @param params The parameters to validate
   * @returns An error message string if validation fails, null if valid
   */
  validateToolParams(params: WebSearchToolParams): string | null {
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

  /** 读取 provider 配置（默认 bing；对不完整的 mock config 保持防御性） */
  private getProvider(): WebSearchProvider {
    if (typeof this.config.getSearchProvider === 'function') {
      return this.config.getSearchProvider();
    }
    return 'bing';
  }

  /**
   * 把结构化结果条目格式化为编号列表，填充 llmContent / returnDisplay / sources。
   * bing / bocha 两个 HTTP provider 共用。
   */
  private formatResults(
    provider: WebSearchProvider,
    query: string,
    items: WebSearchResultItem[],
  ): WebSearchToolResult {
    const lines = items.map((item, index) => {
      const parts = [`${index + 1}. ${item.title}`, `   ${item.url}`];
      if (item.snippet) {
        parts.push(`   ${item.snippet}`);
      }
      return parts.join('\n');
    });

    let content = `Web search results for "${query}" (provider: ${provider}):\n\n${lines.join('\n\n')}`;

    // 截断过长内容，防止token爆炸
    let isTruncated = false;
    if (content.length > MAX_CONTENT_LENGTH) {
      content =
        content.substring(0, MAX_CONTENT_LENGTH) +
        `\n\n[Note: Content truncated to ${MAX_CONTENT_LENGTH} characters to prevent context overflow]`;
      isTruncated = true;
    }

    return {
      llmContent: content,
      returnDisplay: t('websearch.results.returned', {
        query,
        truncated: isTruncated ? t('websearch.results.truncated') : '',
      }),
      sources: items.map((item) => ({
        web: { uri: item.url, title: item.title },
      })),
    };
  }

  /** 统一的错误返回（fail-loud：错误说清原因与下一步，不静默回空） */
  private errorResult(message: string): WebSearchToolResult {
    console.error(`[WebSearchTool] ${message}`);
    return {
      llmContent: `Error: ${message}`,
      returnDisplay: t('websearch.error.performing'),
    };
  }

  /**
   * 带 15 秒超时的 fetch。外部 signal 与超时 signal 任一触发都会中止。
   * 返回 Response；超时/取消/网络错误以异常抛出，由 provider 分支翻译成明确文案。
   */
  private async fetchWithSearchTimeout(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(),
      HTTP_SEARCH_TIMEOUT_MS,
    );
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.any([signal, timeoutController.signal]),
      });
    } catch (error) {
      // 超时中止与外部取消区分开，给出可行动的错误信息
      if (timeoutController.signal.aborted && !signal.aborted) {
        throw new Error(
          `Search request timed out after ${HTTP_SEARCH_TIMEOUT_MS / 1000}s`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * bing provider（默认）：抓取 cn.bing.com 搜索页解析 HTML。
   * 免 key、国内可直连；页面结构变化时 fail-loud 返回明确错误。
   */
  private async executeBingSearch(
    params: WebSearchToolParams,
    signal: AbortSignal,
  ): Promise<WebSearchToolResult> {
    const url = `${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent(params.query)}&count=10`;

    let html: string;
    try {
      const response = await this.fetchWithSearchTimeout(
        url,
        {
          headers: {
            'User-Agent': DESKTOP_USER_AGENT,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        },
        signal,
      );
      if (!response.ok) {
        return this.errorResult(
          `Bing search failed with HTTP ${response.status} ${response.statusText} for query "${params.query}". Bing may be rate-limiting or blocking the request; retry later or switch searchProvider to 'bocha' or 'gemini'.`,
        );
      }
      html = await response.text();
    } catch (error) {
      return this.errorResult(
        `Bing search request failed for query "${params.query}": ${getErrorMessage(error)}`,
      );
    }

    // 防御性解析：结构对不上必须 fail-loud，绝不静默返回空结果
    if (!html.includes('b_algo')) {
      return this.errorResult(
        `Bing returned a page without any recognizable result blocks for query "${params.query}". The page structure may have changed, or Bing served a CAPTCHA/redirect page. Try again later or switch searchProvider to 'bocha' or 'gemini'.`,
      );
    }

    const items = parseBingResults(html);
    if (items.length === 0) {
      return this.errorResult(
        `Bing result blocks were found but none could be parsed for query "${params.query}". The result page structure likely changed; the Bing HTML parser needs updating. Switch searchProvider to 'bocha' or 'gemini' as a workaround.`,
      );
    }

    return this.formatResults('bing', params.query, items);
  }

  /**
   * bocha provider（可选）：博查 Web Search API。
   * 严格按显式配置走：选了 bocha 却没配 key 时 fail-loud，不自动降级。
   */
  private async executeBochaSearch(
    params: WebSearchToolParams,
    signal: AbortSignal,
  ): Promise<WebSearchToolResult> {
    const apiKey =
      typeof this.config.getSearchApiKey === 'function'
        ? this.config.getSearchApiKey()
        : undefined;
    if (!apiKey) {
      return this.errorResult(
        `searchProvider is set to 'bocha' but no API key is configured. Set 'searchApiKey' in settings.json or export the OTTO_BOCHA_API_KEY environment variable, or switch searchProvider back to 'bing' (no key required).`,
      );
    }

    let data: unknown;
    try {
      const response = await this.fetchWithSearchTimeout(
        BOCHA_SEARCH_ENDPOINT,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: params.query,
            count: 10,
            summary: true,
          }),
        },
        signal,
      );
      if (!response.ok) {
        const bodyExcerpt = (await response.text().catch(() => '')).slice(0, 200);
        return this.errorResult(
          `Bocha search failed with HTTP ${response.status} ${response.statusText} for query "${params.query}". ${bodyExcerpt}`,
        );
      }
      data = await response.json();
    } catch (error) {
      return this.errorResult(
        `Bocha search request failed for query "${params.query}": ${getErrorMessage(error)}`,
      );
    }

    // 结果结构：data.webPages.value[]，字段 name/url/snippet/summary
    const values = (
      data as {
        data?: { webPages?: { value?: Array<Record<string, unknown>> } };
      }
    )?.data?.webPages?.value;

    if (!Array.isArray(values)) {
      return this.errorResult(
        `Bocha returned an unexpected response shape for query "${params.query}" (missing data.webPages.value). The API contract may have changed.`,
      );
    }

    const items: WebSearchResultItem[] = values
      .map((v) => ({
        title: typeof v.name === 'string' ? v.name : '',
        url: typeof v.url === 'string' ? v.url : '',
        // summary: true 时 summary 字段比 snippet 更完整，优先用
        snippet:
          typeof v.summary === 'string' && v.summary
            ? v.summary
            : typeof v.snippet === 'string'
              ? v.snippet
              : '',
      }))
      .filter((v) => v.title && v.url);

    if (items.length === 0) {
      return {
        llmContent: `No search results or information found for query: "${params.query}"`,
        returnDisplay: 'No information found.',
      };
    }

    return this.formatResults('bocha', params.query, items);
  }

  /**
   * gemini provider（保留原有逻辑）：Gemini API googleSearch grounding。
   * 依赖 Otto 账号 / Gemini 访问，海外用户可用。
   */
  private async executeGeminiSearch(
    params: WebSearchToolParams,
    signal: AbortSignal,
  ): Promise<WebSearchToolResult> {
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
          llmContent: `This tool (${WebSearchTool.Name}) is configured with searchProvider 'gemini', but no custom Gemini Flash model (e.g., gemini-2.5-flash) was found in your custom models list to execute this tool. Please configure a custom Gemini Flash model, or switch searchProvider to 'bing' (no key required).`,
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
            `Web search with the 'gemini' provider requires a Otto account. ` +
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
            `Web search with the 'gemini' provider requires available credits in your account. ` +
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

    // 严格按显式配置分发（默认 bing）：配了 bocha 没 key 也不自动降级，fail-loud
    const provider = this.getProvider();
    switch (provider) {
      case 'bocha':
        return this.executeBochaSearch(params, signal);
      case 'gemini':
        return this.executeGeminiSearch(params, signal);
      case 'bing':
      default:
        return this.executeBingSearch(params, signal);
    }
  }
}
