/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * web_search 工具单测：全部 mock fetch，不联外网。
 * 覆盖：bing HTML fixture 解析、结构不认识时 fail-loud、
 * bocha JSON 解析、bocha 无 key fail-loud、15s 超时。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSearchTool, parseBingResults } from './web-search.js';
import { Config } from '../config/config.js';

/** 构造只带 web_search 所需方法的 mock config */
function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    getProxy: vi.fn().mockReturnValue(undefined),
    getSearchProvider: vi.fn().mockReturnValue('bing'),
    getSearchApiKey: vi.fn().mockReturnValue(undefined),
    getModel: vi.fn().mockReturnValue('gemini-2.5-pro'),
    ...overrides,
  } as unknown as Config;
}

/** 仿真实 Bing 结果页的最小 HTML fixture（两条结果 + 干扰节点） */
const BING_HTML_FIXTURE = `
<!DOCTYPE html><html><head><title>q - 搜索</title></head><body>
<ol id="b_results">
<li class="b_ad"><h2><a href="https://ads.example.com">广告不该被解析</a></h2></li>
<li class="b_algo">
  <h2><a target="_blank" href="https://example.com/first?x=1&amp;y=2">First &amp; Best Result</a></h2>
  <div class="b_caption"><p>Snippet A about <strong>otto</strong> search.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://example.org/second">Second Result</a></h2>
  <div class="b_caption"><p>第二条摘要，包含中文。</p></div>
</li>
</ol>
</body></html>`;

describe('parseBingResults', () => {
  it('解析 b_algo 条目的标题/链接/摘要，并解码实体、跳过非结果块', () => {
    const items = parseBingResults(BING_HTML_FIXTURE);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'First & Best Result',
      url: 'https://example.com/first?x=1&y=2',
      snippet: 'Snippet A about otto search.',
    });
    expect(items[1].title).toBe('Second Result');
    expect(items[1].snippet).toBe('第二条摘要，包含中文。');
  });

  it('无 b_algo 块时返回空数组（由调用方 fail-loud）', () => {
    expect(parseBingResults('<html><body>captcha page</body></html>')).toEqual([]);
  });
});

describe('WebSearchTool', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('工具名已改为 web_search', () => {
    expect(WebSearchTool.Name).toBe('web_search');
  });

  it('参数校验：空 query 拒绝', async () => {
    const tool = new WebSearchTool(makeConfig());
    const result = await tool.execute({ query: '   ' }, new AbortController().signal);
    expect(String(result.llmContent)).toContain('Invalid parameters');
  });

  describe('bing provider（默认）', () => {
    it('解析 HTML fixture 并输出编号列表', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(BING_HTML_FIXTURE, { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const tool = new WebSearchTool(makeConfig());
      const result = await tool.execute(
        { query: 'otto 搜索' },
        new AbortController().signal,
      );

      // 请求打到 cn.bing.com 且带桌面 UA
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toContain('https://cn.bing.com/search?q=');
      expect(url).toContain(encodeURIComponent('otto 搜索'));
      expect(url).toContain('count=10');
      expect(
        (init.headers as Record<string, string>)['User-Agent'],
      ).toContain('Mozilla/5.0');

      const content = String(result.llmContent);
      expect(content).toContain('provider: bing');
      expect(content).toContain('1. First & Best Result');
      expect(content).toContain('https://example.com/first?x=1&y=2');
      expect(content).toContain('Snippet A about otto search.');
      expect(content).toContain('2. Second Result');
      expect(result.sources).toHaveLength(2);
      expect(result.sources?.[0]?.web?.uri).toBe(
        'https://example.com/first?x=1&y=2',
      );
    });

    it('页面结构不认识时 fail-loud 返回明确错误，而不是静默空结果', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('<html><body>captcha</body></html>', { status: 200 }),
        ),
      );
      const tool = new WebSearchTool(makeConfig());
      const result = await tool.execute(
        { query: 'anything' },
        new AbortController().signal,
      );
      const content = String(result.llmContent);
      expect(content).toContain('Error');
      expect(content).toContain('structure');
    });

    it('HTTP 非 200 时 fail-loud 报状态码', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('nope', { status: 429, statusText: 'Too Many Requests' })),
      );
      const tool = new WebSearchTool(makeConfig());
      const result = await tool.execute(
        { query: 'x' },
        new AbortController().signal,
      );
      expect(String(result.llmContent)).toContain('429');
    });

    it('15 秒无响应则超时并报明确错误', async () => {
      vi.useFakeTimers();
      // fetch 永不 resolve，只在 signal 中止时 reject（仿真实 fetch 行为）
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted', 'AbortError')),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const tool = new WebSearchTool(makeConfig());
      const pending = tool.execute(
        { query: 'slow' },
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(15001);
      const result = await pending;
      expect(String(result.llmContent)).toContain('timed out after 15s');
    });
  });

  describe('bocha provider', () => {
    it('解析 data.webPages.value[]，summary 优先于 snippet', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              webPages: {
                value: [
                  {
                    name: 'Bocha First',
                    url: 'https://a.example.com',
                    snippet: 'short snippet',
                    summary: 'long summary text',
                  },
                  {
                    name: 'Bocha Second',
                    url: 'https://b.example.com',
                    snippet: 'only snippet',
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      const tool = new WebSearchTool(
        makeConfig({
          getSearchProvider: vi.fn().mockReturnValue('bocha'),
          getSearchApiKey: vi.fn().mockReturnValue('test-key'),
        }),
      );
      const result = await tool.execute(
        { query: 'bocha query' },
        new AbortController().signal,
      );

      // 请求形状：POST + Bearer + JSON body
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.bochaai.com/v1/web-search');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key');
      expect(headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({
        query: 'bocha query',
        count: 10,
        summary: true,
      });

      const content = String(result.llmContent);
      expect(content).toContain('provider: bocha');
      expect(content).toContain('1. Bocha First');
      expect(content).toContain('long summary text'); // summary 优先
      expect(content).not.toContain('short snippet');
      expect(content).toContain('2. Bocha Second');
      expect(content).toContain('only snippet');
    });

    it('没配 key 时 fail-loud，且不发任何请求', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const tool = new WebSearchTool(
        makeConfig({
          getSearchProvider: vi.fn().mockReturnValue('bocha'),
          getSearchApiKey: vi.fn().mockReturnValue(undefined),
        }),
      );
      const result = await tool.execute(
        { query: 'x' },
        new AbortController().signal,
      );
      const content = String(result.llmContent);
      expect(content).toContain('Error');
      expect(content).toContain('OTTO_BOCHA_API_KEY');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('响应结构不对时 fail-loud', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ code: 200, data: {} }), { status: 200 }),
        ),
      );
      const tool = new WebSearchTool(
        makeConfig({
          getSearchProvider: vi.fn().mockReturnValue('bocha'),
          getSearchApiKey: vi.fn().mockReturnValue('k'),
        }),
      );
      const result = await tool.execute(
        { query: 'x' },
        new AbortController().signal,
      );
      expect(String(result.llmContent)).toContain('unexpected response shape');
    });
  });

  describe('gemini provider（保留的 grounding 分支）', () => {
    it('走 createTemporaryChat + googleSearch grounding', async () => {
      const setTools = vi.fn();
      const sendMessage = vi.fn().mockResolvedValue({
        candidates: [
          {
            content: { parts: [{ text: 'grounded answer' }], role: 'model' },
            index: 0,
          },
        ],
      });
      const tool = new WebSearchTool(
        makeConfig({
          getSearchProvider: vi.fn().mockReturnValue('gemini'),
          getOttoClient: () => ({
            createTemporaryChat: vi
              .fn()
              .mockResolvedValue({ setTools, sendMessage }),
          }),
        }),
      );
      const result = await tool.execute(
        { query: 'gemini query' },
        new AbortController().signal,
      );
      expect(setTools).toHaveBeenCalledWith([{ googleSearch: {} }]);
      expect(String(result.llmContent)).toContain('grounded answer');
    });
  });
});
