/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FeishuGateway,
  buildCardKitStreamingCard,
  buildCardKitFinalCard,
  renderFooterMarkdown,
  CARDKIT_STREAMING_ELEMENT_ID,
  CARDKIT_FOOTER_ELEMENT_ID,
  CARDKIT_LOADING_ELEMENT_ID,
} from './gateway.js';

// Mock logger
vi.mock('./logger.js', () => ({
  dlog: vi.fn(),
  dwarn: vi.fn(),
  derror: vi.fn(),
}));

// Mock @larksuiteoapi/node-sdk
const mockRegister = vi.fn();
vi.mock('@larksuiteoapi/node-sdk', () => ({
    WSClient: class {
      private options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
      start = vi.fn().mockImplementation(async () => {
        // Trigger onReady callback immediately to let connect() resolve
        if (this.options && typeof this.options.onReady === 'function') {
          this.options.onReady();
        }
      });
    },
    EventDispatcher: class {
      register = mockRegister;
    },
  }));

// Mock loadProcessedMessages and saveProcessedMessages to isolate tests from real disk.
// processedMessages is a Map<id, firstSeenTimestamp> (at-most-once dedup store).
vi.spyOn(FeishuGateway.prototype as unknown, 'loadProcessedMessages').mockImplementation(function(this: unknown) {
  this.processedMessages = new Map();
});
vi.spyOn(FeishuGateway.prototype as unknown, 'saveProcessedMessages').mockImplementation(() => {});

describe('FeishuGateway - Message Parsing', () => {
  let gateway: FeishuGateway;
  let messageCallback: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    messageCallback = null;

    mockRegister.mockImplementation((handlers: unknown) => {
      if (handlers['im.message.receive_v1']) {
        messageCallback = handlers['im.message.receive_v1'];
      }
    });
  });

  it('correctly parses plain text message', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_123',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello world' }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    // Trigger callback
    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toBe('hello world');
    expect(receivedMsg.messageType).toBe('text');
  });

  it('correctly parses file message', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_file_123',
          message_type: 'file',
          content: JSON.stringify({ file_key: 'file_v2_abc', file_name: 'test.pdf' }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    // Trigger callback
    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toBe('[文件消息: test.pdf]');
    expect(receivedMsg.messageType).toBe('file');
    expect(receivedMsg.pendingFiles).toEqual([
      { fileKey: 'file_v2_abc', fileName: 'test.pdf', placeholder: '[文件消息: test.pdf]' }
    ]);
  });

  it('correctly parses audio message', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_audio_123',
          message_type: 'audio',
          content: JSON.stringify({ file_key: 'file_v2_audio', duration: 12000 }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toBe('[音频消息: audio_om_audio_123.opus]');
    expect(receivedMsg.messageType).toBe('audio');
    expect(receivedMsg.pendingFiles).toEqual([
      { fileKey: 'file_v2_audio', fileName: 'audio_om_audio_123.opus', placeholder: '[音频消息: audio_om_audio_123.opus]' }
    ]);
  });

  it('correctly parses media message', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_media_123',
          message_type: 'media',
          content: JSON.stringify({ file_key: 'file_v2_video', duration: 34000 }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toBe('[视频消息: video_om_media_123.mp4]');
    expect(receivedMsg.messageType).toBe('media');
    expect(receivedMsg.pendingFiles).toEqual([
      { fileKey: 'file_v2_video', fileName: 'video_om_media_123.mp4', placeholder: '[视频消息: video_om_media_123.mp4]' }
    ]);
  });

  it('correctly parses post message (rich text) with title and paragraphs', async () => {
    await gateway.connect();
    expect(messageCallback).toBeTypeOf('function');

    const postContent = {
      zh_cn: {
        title: 'My Title',
        content: [
          [
            { tag: 'text', text: 'First line text. ' },
            { tag: 'a', text: 'Link Text', href: 'https://example.com' },
          ],
          [
            { tag: 'at', text: '@SomeUser' },
            { tag: 'text', text: ' Second line.' },
          ],
        ],
      },
    };

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_post_123',
          message_type: 'post',
          content: JSON.stringify(postContent),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    // Trigger callback
    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toContain('**My Title**');
    expect(receivedMsg.text).toContain('First line text.');
    expect(receivedMsg.text).toContain('[Link Text](https://example.com)');
    expect(receivedMsg.text).toContain('@SomeUser Second line.');
    expect(receivedMsg.messageType).toBe('post');
  });

  it('correctly parses post message with embedded images and defers download', async () => {
    await gateway.connect();

    // Mock downloadImageResource — should NOT be called (download now deferred)
    const downloadSpy = vi.spyOn(gateway, 'downloadImageResource')
      .mockResolvedValue('/tmp/mock-local-image.png');

    const postContent = {
      zh_cn: {
        title: '',
        content: [
          [
            { tag: 'text', text: 'Please analyze this ' },
            { tag: 'img', image_key: 'img_v2_123' },
          ],
        ],
      },
    };

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_post_img_123',
          message_type: 'post',
          content: JSON.stringify(postContent),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    // Image download is DEFERRED — not called in gateway anymore
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.text).toContain('Please analyze this');
    expect(receivedMsg.text).toContain('[图片_1]');
    // pendingImages should carry the image metadata for later download
    expect(receivedMsg.pendingImages).toBeDefined();
    expect(receivedMsg.pendingImages).toHaveLength(1);
    expect(receivedMsg.pendingImages[0].imageKey).toBe('img_v2_123');
    expect(receivedMsg.pendingImages[0].placeholder).toBe('[图片_1]');
  });

  it('correctly parses merge_forward message and extracts nested sub-messages', async () => {
    await gateway.connect();

    const mockFetchOk = (body: unknown) => ({
      ok: true,
      json: async () => body,
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/tenant_access_token')) {
        return mockFetchOk({
          tenant_access_token: 't-mock-token',
          expire: 7200,
        });
      }
      if (url.includes('/im/v1/messages/')) {
        // 飞书「获取指定消息内容」对 merge_forward 返回扁平化消息树：
        // 第一条是父消息（无 upper_message_id），其后子消息带 upper_message_id。
        return mockFetchOk({
          code: 0,
          msg: 'success',
          data: {
            items: [
              {
                message_id: 'om_merge_123',
                msg_type: 'merge_forward',
                body: { content: '{}' },
                create_time: '1615367850000',
                sender: { id: 'ou_root', id_type: 'open_id', sender_type: 'user' },
              },
              {
                message_id: 'om_sub_1',
                upper_message_id: 'om_merge_123',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: 'hello from sub1' }) },
                create_time: '1615367851000',
                sender: {
                  id: 'ou_user_1',
                  id_type: 'open_id',
                  sender_type: 'user',
                },
              },
              {
                message_id: 'om_sub_2',
                upper_message_id: 'om_merge_123',
                msg_type: 'file',
                body: { content: JSON.stringify({ file_key: 'file_sub_2', file_name: 'nested.zip' }) },
                create_time: '1615367852000',
                sender: {
                  id: 'ou_user_2',
                  id_type: 'open_id',
                  sender_type: 'user',
                },
              },
            ],
          },
        });
      }
      return mockFetchOk({ code: 0 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_merge_123',
          message_type: 'merge_forward',
          content: 'Merged and Forwarded Message',
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.messageType).toBe('merge_forward');
    expect(receivedMsg.text).toContain('[合并转发的消息记录]');
    expect(receivedMsg.text).toContain('ou_user_1');
    expect(receivedMsg.text).toContain('hello from sub1');
    expect(receivedMsg.text).toContain('ou_user_2');
    expect(receivedMsg.text).toContain('[文件消息: nested.zip]');
    expect(receivedMsg.pendingFiles).toBeDefined();
    expect(receivedMsg.pendingFiles).toHaveLength(1);
    expect(receivedMsg.pendingFiles[0].fileKey).toBe('file_sub_2');
    expect(receivedMsg.pendingFiles[0].fileName).toBe('nested.zip');
  });

  it('correctly generates unique placeholders for multiple rich-text images across sub-messages within merge_forward', async () => {
    await gateway.connect();

    const mockFetchOk = (body: unknown) => ({
      ok: true,
      json: async () => body,
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/tenant_access_token')) {
        return mockFetchOk({
          tenant_access_token: 't-mock-token',
          expire: 7200,
        });
      }
      if (url.includes('/im/v1/messages/')) {
        return mockFetchOk({
          code: 0,
          msg: 'success',
          data: {
            items: [
              {
                message_id: 'om_merge_125',
                msg_type: 'merge_forward',
                body: { content: '{}' },
                create_time: '1615367850000',
                sender: { id: 'ou_root', id_type: 'open_id', sender_type: 'user' },
              },
              {
                message_id: 'om_sub_post_1',
                upper_message_id: 'om_merge_125',
                msg_type: 'post',
                body: {
                  content: JSON.stringify({
                    zh_cn: {
                      title: 'First post',
                      content: [
                        [
                          { tag: 'text', text: 'Check first: ' },
                          { tag: 'img', image_key: 'img_key_1' },
                        ],
                      ],
                    },
                  }),
                },
                create_time: '1615367851000',
                sender: {
                  id: 'ou_user_1',
                  id_type: 'open_id',
                  sender_type: 'user',
                },
              },
              {
                message_id: 'om_sub_post_2',
                upper_message_id: 'om_merge_125',
                msg_type: 'post',
                body: {
                  content: JSON.stringify({
                    zh_cn: {
                      title: 'Second post',
                      content: [
                        [
                          { tag: 'text', text: 'Check second: ' },
                          { tag: 'img', image_key: 'img_key_2' },
                        ],
                      ],
                    },
                  }),
                },
                create_time: '1615367852000',
                sender: {
                  id: 'ou_user_2',
                  id_type: 'open_id',
                  sender_type: 'user',
                },
              },
            ],
          },
        });
      }
      return mockFetchOk({ code: 0 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_merge_125',
          message_type: 'merge_forward',
          content: 'Merged posts with images',
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.messageType).toBe('merge_forward');

    expect(receivedMsg.pendingImages).toBeDefined();
    expect(receivedMsg.pendingImages).toHaveLength(2);
    expect(receivedMsg.pendingImages[0].imageKey).toBe('img_key_1');
    expect(receivedMsg.pendingImages[0].placeholder).toBe('[图片_1]');
    expect(receivedMsg.pendingImages[1].imageKey).toBe('img_key_2');
    expect(receivedMsg.pendingImages[1].placeholder).toBe('[图片_2]');

    expect(receivedMsg.text).toContain('[图片_1]');
    expect(receivedMsg.text).toContain('[图片_2]');
  });

  it('correctly reports error when fetching merge_forward sub-messages fails', async () => {
    await gateway.connect();

    const mockFetchError = (body: unknown) => ({
      ok: true,
      json: async () => body,
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/tenant_access_token')) {
        return mockFetchError({
          tenant_access_token: 't-mock-token',
          expire: 7200,
        });
      }
      if (url.includes('/im/v1/messages/')) {
        return mockFetchError({
          code: 230002,
          msg: 'Bot has no permission to access the message',
        });
      }
      return mockFetchError({ code: 0 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_merge_error',
          message_type: 'merge_forward',
          content: 'Merged with error',
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: {
            open_id: 'ou_789',
          },
        },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.messageType).toBe('merge_forward');
    expect(receivedMsg.text).toContain('原因: 飞书接口返回错误 (code: 230002): Bot has no permission to access the message');
  });

  it('recursively expands nested merge_forward sub-messages using upper_message_id tree', async () => {
    await gateway.connect();

    const mockFetchOk = (body: unknown) => ({
      ok: true,
      json: async () => body,
    });

    // 扁平树：root -> (text A) 和 (nested merge_forward) -> (text B 挂在 nested 下)
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/tenant_access_token')) {
        return mockFetchOk({ tenant_access_token: 't-mock-token', expire: 7200 });
      }
      if (url.includes('/im/v1/messages/')) {
        return mockFetchOk({
          code: 0,
          msg: 'success',
          data: {
            items: [
              {
                message_id: 'om_root',
                msg_type: 'merge_forward',
                body: { content: '{}' },
                create_time: '1615367850000',
                sender: { id: 'ou_root', id_type: 'open_id', sender_type: 'user' },
              },
              {
                message_id: 'om_textA',
                upper_message_id: 'om_root',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: 'top level A' }) },
                create_time: '1615367851000',
                sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' },
              },
              {
                message_id: 'om_nested',
                upper_message_id: 'om_root',
                msg_type: 'merge_forward',
                body: { content: '{}' },
                create_time: '1615367852000',
                sender: { id: 'ou_nest', id_type: 'open_id', sender_type: 'user' },
              },
              {
                message_id: 'om_textB',
                upper_message_id: 'om_nested',
                msg_type: 'text',
                body: { content: JSON.stringify({ text: 'deep nested B' }) },
                create_time: '1615367853000',
                sender: { id: 'ou_b', id_type: 'open_id', sender_type: 'user' },
              },
            ],
          },
        });
      }
      return mockFetchOk({ code: 0 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_root',
          message_type: 'merge_forward',
          content: 'Nested merged',
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: { sender_id: { open_id: 'ou_789' } },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.messageType).toBe('merge_forward');
    // 顶层文本与深层嵌套文本都应被展开
    expect(receivedMsg.text).toContain('top level A');
    expect(receivedMsg.text).toContain('deep nested B');
    // 深层文本应有更深的缩进（嵌套渲染）
    const lines = receivedMsg.text.split('\n');
    const deepLine = lines.find((l: string) => l.includes('deep nested B'));
    expect(deepLine.startsWith('  ')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // interactive（卡片）消息解析
  // -------------------------------------------------------------------------
  it('parses an interactive card: extracts header title and body text, tagged as card', () => {
    const cardContent = JSON.stringify({
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: '部署通知' } },
      elements: [
        { tag: 'markdown', content: '服务 **order-api** 已发布到生产环境' },
        { tag: 'hr' },
        { tag: 'div', text: { tag: 'lark_md', content: '版本: v2.3.1' } },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_1',
      'interactive',
      cardContent,
      [],
      [],
    );

    // 标注来源为卡片
    expect(text).toContain('[卡片]');
    // 标题
    expect(text).toContain('部署通知');
    // 各 element 的正文文本
    expect(text).toContain('服务 **order-api** 已发布到生产环境');
    expect(text).toContain('版本: v2.3.1');
  });

  it('recursively extracts text from nested card structures (column_set / div.fields)', () => {
    const cardContent = JSON.stringify({
      header: { title: { tag: 'plain_text', content: '工单 #1024' } },
      elements: [
        {
          tag: 'div',
          fields: [
            { is_short: true, text: { tag: 'lark_md', content: '**状态**: 处理中' } },
            { is_short: true, text: { tag: 'lark_md', content: '**负责人**: 张三' } },
          ],
        },
        {
          tag: 'column_set',
          columns: [
            {
              tag: 'column',
              elements: [{ tag: 'markdown', content: '优先级: 高' }],
            },
            {
              tag: 'column',
              elements: [{ tag: 'markdown', content: '截止: 2026-06-10' }],
            },
          ],
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '来自监控系统' }] },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_2',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('工单 #1024');
    expect(text).toContain('**状态**: 处理中');
    expect(text).toContain('**负责人**: 张三');
    expect(text).toContain('优先级: 高');
    expect(text).toContain('截止: 2026-06-10');
    expect(text).toContain('来自监控系统');
  });

  it('handles interactive card with the new schema (card.body.elements) and i18n header', () => {
    // 部分 bot 使用 card 2.0：外层包一层 card，标题在 i18n 结构里
    const cardContent = JSON.stringify({
      type: 'template',
      data: {
        card: {
          header: { title: { tag: 'plain_text', content: 'Alert' } },
          body: {
            elements: [{ tag: 'markdown', content: 'CPU usage exceeded 90%' }],
          },
        },
      },
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_3',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('[卡片]');
    expect(text).toContain('Alert');
    expect(text).toContain('CPU usage exceeded 90%');
  });

  it('falls back gracefully when interactive content is not valid JSON', () => {
    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_bad',
      'interactive',
      'not-a-json',
      [],
      [],
    );
    // 不抛异常，至少标注为卡片消息
    expect(text).toContain('[卡片');
  });

  it('renders a card table component as a markdown table preserving row/column alignment', () => {
    const cardContent = JSON.stringify({
      header: { title: { tag: 'plain_text', content: '考勤日报' } },
      elements: [
        {
          tag: 'table',
          columns: [
            { name: 'dept', display_name: '部门', data_type: 'text' },
            { name: 'today', display_name: '今天', data_type: 'text' },
            { name: 'last', display_name: '上个工作日', data_type: 'text' },
          ],
          rows: [
            { dept: 'AI Native生产力中心', today: '14/20', last: '18/20' },
            { dept: '平台研发部', today: '9/10', last: '10/10' },
          ],
        },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_table',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('[卡片]');
    expect(text).toContain('考勤日报');
    // markdown 表头与分隔线
    expect(text).toContain('| 部门 | 今天 | 上个工作日 |');
    expect(text).toContain('| --- | --- | --- |');
    // 行数据保持列对应
    expect(text).toContain('| AI Native生产力中心 | 14/20 | 18/20 |');
    expect(text).toContain('| 平台研发部 | 9/10 | 10/10 |');
  });

  it('formats non-string table cell values (options / persons / number / date)', () => {
    const cardContent = JSON.stringify({
      elements: [
        {
          tag: 'table',
          columns: [
            { name: 'name', display_name: '客户', data_type: 'text' },
            { name: 'scale', display_name: '规模', data_type: 'options' },
            { name: 'arr', display_name: 'ARR', data_type: 'number' },
            { name: 'poc', display_name: '跟进人', data_type: 'persons' },
          ],
          rows: [
            {
              name: '飞书科技',
              scale: [{ text: 'S2', color: 'blue' }],
              arr: 168,
              poc: ['ou_abc', 'ou_def'],
            },
          ],
        },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_table2',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('| 客户 | 规模 | ARR | 跟进人 |');
    // options 取 text，number 原样，persons 数组合并
    expect(text).toContain('飞书科技');
    expect(text).toContain('S2');
    expect(text).toContain('168');
  });

  it('extracts text from markdown-type table cells with nested property.elements structure', () => {
    // 飞书 table 单元格 data_type 为 markdown 时，值是嵌套对象而非简单字符串：
    //   { tag: "markdown", property: { elements: [{ tag: "plain_text", property: { content: "2.24亿" } }] } }
    const cardContent = JSON.stringify({
      elements: [
        {
          tag: 'table',
          columns: [
            { name: 'name', display_name: '姓名', data_type: 'text' },
            { name: 'tokens', display_name: 'Token消耗', data_type: 'markdown' },
            { name: 'total_cost', display_name: '总费用', data_type: 'text' },
          ],
          rows: [
            {
              name: '黄威健',
              tokens: {
                id: '_5',
                tag: 'markdown',
                property: {
                  elements: [
                    {
                      id: '0_1__5_0',
                      tag: 'plain_text',
                      property: { content: '2.24亿', textAlign: 'left' },
                    },
                  ],
                  markdownElements: [],
                  originTag: 'markdown',
                  textAlign: 'left',
                },
              },
              total_cost: '$18.54',
            },
            {
              name: '魏辉',
              tokens: {
                id: '_6',
                tag: 'markdown',
                property: {
                  elements: [
                    {
                      id: '1_1__6_0',
                      tag: 'plain_text',
                      property: { content: '7487.78万', textAlign: 'left' },
                    },
                  ],
                  markdownElements: [],
                  originTag: 'markdown',
                  textAlign: 'left',
                },
              },
              total_cost: '$6.66',
            },
          ],
        },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_table_markdown',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('| 姓名 | Token消耗 | 总费用 |');
    expect(text).toContain('| 黄威健 | 2.24亿 | $18.54 |');
    expect(text).toContain('| 魏辉 | 7487.78万 | $6.66 |');
  });

  it('falls back to column display names when a table has no rows', () => {
    const cardContent = JSON.stringify({
      elements: [
        {
          tag: 'table',
          columns: [
            { name: 'a', display_name: '列A', data_type: 'text' },
            { name: 'b', display_name: '列B', data_type: 'text' },
          ],
          rows: [],
        },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_table3',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('| 列A | 列B |');
  });

  // -------------------------------------------------------------------------
  // 真实落盘格式：飞书「获取消息内容」接口对转发的 interactive 卡片返回
  // {title, elements:[[...]], user_dsl} 结构。其中 user_dsl 是卡片的完整 DSL，
  // 对 card 2.0 卡片（schema:"2.0"）尤其关键——此时 content.elements 简化视图
  // 只会返回 [<img>, "请升级至最新版本客户端，以查看内容"] 占位，真实内容只在 user_dsl。
  // -------------------------------------------------------------------------
  it('parses card 2.0 (schema 2.0) from user_dsl when content.elements is only an upgrade placeholder', () => {
    const userDsl = JSON.stringify({
      schema: '2.0',
      config: {},
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '2026年第22周代码贡献排行榜' },
        subtitle: { tag: 'plain_text', content: '共 45 条提交（仅部门成员）' },
      },
      body: {
        direction: 'vertical',
        elements: [
          {
            tag: 'table',
            columns: [
              { name: 'name', display_name: '开发者', data_type: 'text' },
              { name: 'additions', display_name: '增行', data_type: 'text' },
              { name: 'commits', display_name: '提交', data_type: 'text' },
            ],
            rows: [
              { name: '🥇 凉水', additions: '3万', commits: '32' },
              { name: '🥈 孔海峰', additions: '1万', commits: '5' },
              { name: '🥉 黄威健', additions: '674', commits: '8' },
            ],
          },
        ],
      },
    });
    // content 顶层是飞书简化视图：elements 只有图片占位 + 升级提示
    const cardContent = JSON.stringify({
      title: null,
      elements: [[{ tag: 'img' }, { tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
      user_dsl: userDsl,
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_v2_table',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('[卡片]');
    // 标题与副标题来自 user_dsl.header
    expect(text).toContain('2026年第22周代码贡献排行榜');
    expect(text).toContain('共 45 条提交（仅部门成员）');
    // user_dsl.body 里的 table 被重建为 markdown 表格
    expect(text).toContain('| 开发者 | 增行 | 提交 |');
    expect(text).toContain('| --- | --- | --- |');
    expect(text).toContain('| 🥇 凉水 | 3万 | 32 |');
    expect(text).toContain('| 🥉 黄威健 | 674 | 8 |');
    // 绝不应出现降级占位文本
    expect(text).not.toContain('请升级至最新版本客户端');
  });

  it('parses card 1.0 from user_dsl (header + nested column_set/markdown) ignoring the simplified elements view', () => {
    const userDsl = JSON.stringify({
      config: {},
      header: { template: 'green', title: { tag: 'plain_text', content: 'Otto' } },
      elements: [
        { tag: 'markdown', content: 'Otto v1.1.6 发布', text_align: 'left' },
        { tag: 'hr' },
        { tag: 'markdown', content: '✨ 新功能：支持飞书「合并转发」消息解析' },
      ],
    });
    const cardContent = JSON.stringify({
      title: 'Otto',
      elements: [[{ tag: 'text', text: 'Otto v1.1.6 发布' }]],
      user_dsl: userDsl,
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_v1_dsl',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('[卡片]');
    expect(text).toContain('Otto');
    expect(text).toContain('Otto v1.1.6 发布');
    expect(text).toContain('✨ 新功能：支持飞书「合并转发」消息解析');
  });

  it('renders the 2D content.elements view as a table when user_dsl is absent', () => {
    // 没有 user_dsl 时，回退到 content.elements 二维数组（行→单元格）
    const cardContent = JSON.stringify({
      title: null,
      elements: [
        [{ tag: 'text', text: '您的团队考勤日报' }],
        [{ tag: 'hr' }],
        [
          { tag: 'text', text: '部门' },
          { tag: 'text', text: '今天' },
          { tag: 'text', text: '上个工作日' },
        ],
        [
          { tag: 'text', text: 'AI Native生产力中心' },
          { tag: 'text', text: '14/20' },
          { tag: 'text', text: '18/20' },
        ],
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_2d_fallback',
      'interactive',
      cardContent,
      [],
      [],
    );

    expect(text).toContain('[卡片]');
    expect(text).toContain('您的团队考勤日报');
    // 数据行各单元格都应保留
    expect(text).toContain('AI Native生产力中心');
    expect(text).toContain('14/20');
    expect(text).toContain('18/20');
  });

  it('strips lark_md <font> color tags but keeps inner text and markdown bold', () => {
    const cardContent = JSON.stringify({
      header: { title: { tag: 'plain_text', content: '考勤日报' } },
      elements: [
        {
          tag: 'markdown',
          content: "**<font color='orange-400'>今天</font>**<font color='orange-400'>10:30</font>",
        },
        { tag: 'markdown', content: "<font color='orange-400'>14/20</font>" },
      ],
    });

    const text = (gateway as unknown).parseSingleMessageContent(
      'om_card_font',
      'interactive',
      cardContent,
      [],
      [],
    );

    // <font ...> 与 </font> 标签应被清除
    expect(text).not.toContain('<font');
    expect(text).not.toContain('</font>');
    expect(text).not.toContain('color=');
    // 内部文字保留
    expect(text).toContain('今天');
    expect(text).toContain('10:30');
    expect(text).toContain('14/20');
    // 合法的 markdown 加粗符号保留
    expect(text).toContain('**今天**');
  });

  it('expands an interactive card forwarded inside a merge_forward message', async () => {
    await gateway.connect();

    const mockFetchOk = (body: unknown) => ({ ok: true, json: async () => body });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/tenant_access_token')) {
        return mockFetchOk({ tenant_access_token: 't-mock-token', expire: 7200 });
      }
      if (url.includes('/im/v1/messages/')) {
        return mockFetchOk({
          code: 0,
          msg: 'success',
          data: {
            items: [
              {
                message_id: 'om_root_card',
                msg_type: 'merge_forward',
                body: { content: '{}' },
                create_time: '1615367850000',
                sender: { id: 'ou_root', id_type: 'open_id', sender_type: 'user' },
              },
              {
                message_id: 'om_sub_card',
                upper_message_id: 'om_root_card',
                msg_type: 'interactive',
                body: {
                  content: JSON.stringify({
                    header: { title: { tag: 'plain_text', content: '审批请求' } },
                    elements: [{ tag: 'markdown', content: '请假 2 天，请审批' }],
                  }),
                },
                create_time: '1615367851000',
                sender: { id: 'ou_bot_1', id_type: 'open_id', sender_type: 'app' },
              },
            ],
          },
        });
      }
      return mockFetchOk({ code: 0 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_root_card',
          message_type: 'merge_forward',
          content: 'Forwarded card',
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: { sender_id: { open_id: 'ou_789' } },
      },
    };

    let receivedMsg: unknown = null;
    gateway.onMessage = async (msg) => {
      receivedMsg = msg;
      return null;
    };

    await messageCallback(mockEvent);

    expect(receivedMsg).not.toBeNull();
    expect(receivedMsg.messageType).toBe('merge_forward');
    expect(receivedMsg.text).toContain('[卡片]');
    expect(receivedMsg.text).toContain('审批请求');
    expect(receivedMsg.text).toContain('请假 2 天，请审批');
  });
});

// ---------------------------------------------------------------------------
// FeishuGateway - Message Deduplication Suite
// ---------------------------------------------------------------------------

describe('FeishuGateway - Message Deduplication', () => {
  let gateway: FeishuGateway;
  let messageCallback: unknown;

  beforeEach(async () => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    messageCallback = null;

    // Clear high-risk dedup cache to prevent cross-test pollution from disk
    (gateway as unknown).highRiskHashes.clear();

    mockRegister.mockImplementation((handlers: unknown) => {
      if (handlers['im.message.receive_v1']) {
        messageCallback = handlers['im.message.receive_v1'];
      }
    });

    const mockFetchOk = (body: unknown) => ({
      ok: true,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers(),
    });

    const fetchMock = vi.fn().mockResolvedValue(mockFetchOk({
      tenant_access_token: 'mock-tenant-token',
      expire: 7200,
      code: 0,
      data: { reaction_id: 'mock-reaction-id' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await gateway.connect();
  });

  it('deduplicates concurrent in-flight messages and handles success/failure lifecycle', async () => {
    let callCount = 0;
    let finishMessagePromise: (() => void) | null = null;
    const shouldFail = false;

    gateway.onMessage = async (_msg) => {
      callCount++;
      return new Promise((resolve, reject) => {
        finishMessagePromise = () => {
          if (shouldFail) {
            reject(new Error('simulated error'));
          } else {
            resolve('reply');
          }
        };
      });
    };

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_test_dedup_123',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: { open_id: 'ou_789' },
        },
      },
    };

    // 1. Send first message (starts processing and blocks waiting for finishMessagePromise)
    const firstCallPromise = messageCallback(mockEvent);

    // Give it a microtask tick to ensure the handler is invoked and in-flight is registered
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(callCount).toBe(1);
    expect((gateway as unknown).inFlightMessages.has('om_test_dedup_123')).toBe(true);

    // 2. Send second message with same message_id (retry) while first is in-flight
    const secondCallResult = await messageCallback(mockEvent);
    // Since it's in-flight, it should be skipped immediately and return { code: 0 } without incrementing callCount
    expect(secondCallResult).toEqual({ code: 0 });
    expect(callCount).toBe(1);

    // 3. Let the first call finish successfully
    finishMessagePromise!();
    await firstCallPromise;

    // After success, it should be removed from in-flight and added to processedMessages
    expect((gateway as unknown).inFlightMessages.has('om_test_dedup_123')).toBe(false);
    expect((gateway as unknown).processedMessages.has('om_test_dedup_123')).toBe(true);

    // 4. Send third message with same message_id (should be skipped as duplicate)
    const thirdCallResult = await messageCallback(mockEvent);
    expect(thirdCallResult).toEqual({ code: 0 });
    expect(callCount).toBe(1);
  });

  it('records the message at receipt (at-most-once), so a failed turn is NOT re-run on redelivery', async () => {
    // at-most-once 语义：消息在"受理时"就落盘，处理失败也不会因飞书重推而重跑。
    // 这正是修复"上午处理完、下午被重推、agent 又跑一遍"的关键。
    let callCount = 0;
    let finishMessagePromise: (() => void) | null = null;

    gateway.onMessage = async (_msg) => {
      callCount++;
      return new Promise((resolve, reject) => {
        finishMessagePromise = () => {
          reject(new Error('simulated error'));
        };
      });
    };

    const mockEvent = {
      event: {
        message: {
          message_id: 'om_test_failure_123',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello' }),
          chat_id: 'oc_456',
          chat_type: 'p2p',
        },
        sender: {
          sender_id: { open_id: 'ou_789' },
        },
      },
    };

    // 1. Send message (starts processing). It is persisted to processedMessages
    //    IMMEDIATELY on receipt — before onMessage even resolves.
    const callPromise = messageCallback(mockEvent);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(callCount).toBe(1);
    expect((gateway as unknown).inFlightMessages.has('om_test_failure_123')).toBe(true);
    expect((gateway as unknown).processedMessages.has('om_test_failure_123')).toBe(true);

    // 2. Let it fail.
    finishMessagePromise!();
    await callPromise;

    // After failure: removed from in-flight, but STILL recorded as processed
    // (at-most-once) so a blind Feishu redelivery won't re-run it.
    expect((gateway as unknown).inFlightMessages.has('om_test_failure_123')).toBe(false);
    expect((gateway as unknown).processedMessages.has('om_test_failure_123')).toBe(true);

    // 3. A redelivery of the same message_id must be skipped (NOT reprocessed).
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'success';
    };
    (gateway as unknown).recentContents.clear(); // 绕过 5s 内容去重，单独验证 messageId 去重
    const redeliverResult = await messageCallback(mockEvent);
    expect(redeliverResult).toEqual({ code: 0 });
    expect(callCount).toBe(1); // unchanged — the redelivery was deduped
  });

  it('persists message ids at receipt and survives a simulated restart via load/save', () => {
    // 受理即落盘 + 重启后仍生效：用真实的 record/save/load（绕过本文件顶部的 mock）
    // 验证一条 id 写盘后，新实例 load 时仍认得它。
    const store = new Map<string, number>();
    const g = gateway as unknown;
    // 临时还原真实实现（顶部 mock 会把 save/load 变成 no-op）。
    const realSave = function (this: unknown) {
      store.clear();
      for (const [k, v] of this.processedMessages) store.set(k, v);
    };
    const realLoad = function (this: unknown) {
      this.processedMessages = new Map(store);
    };
    const origSave = g.saveProcessedMessages;
    const origLoad = g.loadProcessedMessages;
    g.saveProcessedMessages = realSave;
    try {
      g.processedMessages = new Map();
      g.recordProcessedMessage('om_persist_1');
      expect(store.has('om_persist_1')).toBe(true);

      // Simulate restart: wipe in-memory, then load from the persisted store.
      g.processedMessages = new Map();
      g.loadProcessedMessages = realLoad;
      g.loadProcessedMessages();
      expect(g.processedMessages.has('om_persist_1')).toBe(true);
    } finally {
      g.saveProcessedMessages = origSave;
      g.loadProcessedMessages = origLoad;
    }
  });

  it('deduplicates high-risk messages (restart/update) via content hash within 3-hour window', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    const restartEvent = {
      event: {
        message: {
          message_id: 'om_hr_001',
          message_type: 'text',
          content: JSON.stringify({ text: '/feishu restart' }),
          chat_id: 'oc_restart_chat',
          chat_type: 'group',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };

    // 1. First /feishu restart should be processed
    await messageCallback(restartEvent);
    expect(callCount).toBe(1);

    // 2. Same content, different messageId (simulating Feishu redelivery) should be dropped
    const redeliverEvent = {
      event: {
        message: {
          message_id: 'om_hr_002', // different ID — bypasses messageId dedup
          message_type: 'text',
          content: JSON.stringify({ text: '/feishu restart' }),
          chat_id: 'oc_restart_chat',
          chat_type: 'group',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };
    (gateway as unknown).recentContents.clear(); // bypass short-window content dedup
    const result = await messageCallback(redeliverEvent);
    expect(result).toEqual({ code: 0 });
    expect(callCount).toBe(1); // still 1, deduplicated

    // Verify that a warning message was sent back to the chat about the dropped duplicate
    const allFetchCalls = (globalThis as unknown).fetch?.mock?.calls || [];
    const sentMessages = allFetchCalls
      .filter((call: unknown[]) => {
        const url = call[0];
        return typeof url === 'string' && url.includes('/im/v1/messages');
      })
      .map((call: unknown[]) => {
        try {
          const body = JSON.parse(call[1]?.body || '{}');
          return JSON.parse(body?.content || '{}').text || '';
        } catch { return ''; }
      });
    const warningMsg = sentMessages.find((t: string) => t.includes('疑似重复') && t.includes('已丢弃'));
    expect(warningMsg).toBeTruthy();
  });

  it('allows different high-risk messages from the same chat', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    // First message: /feishu restart
    const event1 = {
      event: {
        message: {
          message_id: 'om_diff_001',
          message_type: 'text',
          content: JSON.stringify({ text: '/feishu restart' }),
          chat_id: 'oc_diff_chat',
          chat_type: 'group',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };
    await messageCallback(event1);
    expect(callCount).toBe(1);

    // Second message: self_update (different content, should NOT be deduplicated)
    const event2 = {
      event: {
        message: {
          message_id: 'om_diff_002',
          message_type: 'text',
          content: JSON.stringify({ text: '请帮我 self_update 更新到最新版' }),
          chat_id: 'oc_diff_chat',
          chat_type: 'group',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };
    (gateway as unknown).recentContents.clear();
    await messageCallback(event2);
    expect(callCount).toBe(2);
  });

  it('does not deduplicate normal (non-high-risk) messages', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    const normalEvent = {
      event: {
        message: {
          message_id: 'om_normal_001',
          message_type: 'text',
          content: JSON.stringify({ text: '帮我写个 hello world' }),
          chat_id: 'oc_normal_chat',
          chat_type: 'group',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };

    // Even with a different messageId but same content, normal messages are only
    // caught by the 5-second content dedup, not the high-risk hash dedup.
    await messageCallback(normalEvent);
    expect(callCount).toBe(1);

    const normalEvent2 = {
      event: {
        message: {
          message_id: 'om_normal_002',
          message_type: 'text',
          content: JSON.stringify({ text: '帮我写个 hello world' }),
          chat_id: 'oc_normal_chat',
          chat_type: 'group',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };
    (gateway as unknown).recentContents.clear(); // bypass short-window dedup
    await messageCallback(normalEvent2);
    // high-risk dedup does NOT apply to normal messages, so this goes through
    expect(callCount).toBe(2);
  });

  it('filters stale messages created before the WS connection was established', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    const now = Date.now();

    // Simulate a message that was created 60 seconds before the connection was established
    const staleEvent = {
      header: {
        create_time: String(now - 60000), // 60s before connection
      },
      event: {
        message: {
          message_id: 'om_stale_001',
          message_type: 'text',
          content: JSON.stringify({ text: 'old message from before reconnect' }),
          chat_id: 'oc_stale_chat',
          chat_type: 'p2p',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };

    const result = await messageCallback(staleEvent);
    expect(result).toEqual({ code: 0 });
    expect(callCount).toBe(0); // stale message should be dropped
  });

  it('allows fresh messages created after the WS connection was established', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    const now = Date.now();

    // Simulate a message created after the connection was established
    const freshEvent = {
      header: {
        create_time: String(now + 1000), // 1s after connection
      },
      event: {
        message: {
          message_id: 'om_fresh_001',
          message_type: 'text',
          content: JSON.stringify({ text: 'fresh message after reconnect' }),
          chat_id: 'oc_fresh_chat',
          chat_type: 'p2p',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };

    await messageCallback(freshEvent);
    expect(callCount).toBe(1); // fresh message should be processed
  });

  it('allows messages without header.create_time (no timestamp = pass through)', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    // No header.create_time — backward compatible, should not be filtered
    const noTimestampEvent = {
      event: {
        message: {
          message_id: 'om_no_ts_001',
          message_type: 'text',
          content: JSON.stringify({ text: 'message without timestamp' }),
          chat_id: 'oc_no_ts_chat',
          chat_type: 'p2p',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };

    await messageCallback(noTimestampEvent);
    expect(callCount).toBe(1);
  });

  it('respects STALE_CLOCK_SKEW_MS tolerance for near-boundary messages', async () => {
    let callCount = 0;
    gateway.onMessage = async (_msg) => {
      callCount++;
      return 'ok';
    };

    const now = Date.now();

    // Message created 3 seconds before connection (within 5s clock skew tolerance)
    const borderlineEvent = {
      header: {
        create_time: String(now - 3000), // 3s before, within 5s skew
      },
      event: {
        message: {
          message_id: 'om_borderline_001',
          message_type: 'text',
          content: JSON.stringify({ text: 'borderline message' }),
          chat_id: 'oc_borderline_chat',
          chat_type: 'p2p',
        },
        sender: { sender_id: { open_id: 'ou_001' } },
      },
    };

    await messageCallback(borderlineEvent);
    // Within clock skew tolerance, should NOT be filtered
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CardKit 2.0 streaming card builders & footer rendering
// ---------------------------------------------------------------------------

describe('CardKit 2.0 builders', () => {
  it('buildCardKitStreamingCard produces schema 2.0 with streaming_mode and required element ids', () => {
    const card = buildCardKitStreamingCard('initial body', 'initial footer');
    expect(card.schema).toBe('2.0');
    expect(card.config.streaming_mode).toBe(true);
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const ids = elements.map((e) => e.element_id);
    expect(ids).toContain(CARDKIT_STREAMING_ELEMENT_ID);
    expect(ids).toContain(CARDKIT_FOOTER_ELEMENT_ID);
    expect(ids).toContain(CARDKIT_LOADING_ELEMENT_ID);
    const main = elements.find((e) => e.element_id === CARDKIT_STREAMING_ELEMENT_ID);
    expect(main?.tag).toBe('markdown');
    expect(main?.content).toBe('initial body');
    // loading 图标必须有 custom_icon 配置（飞书客户端据此渲染加载动画）
    const loading = elements.find((e) => e.element_id === CARDKIT_LOADING_ELEMENT_ID);
    expect(loading?.icon?.tag).toBe('custom_icon');
    expect(loading?.icon?.img_key).toBeTruthy();
  });

  it('buildCardKitFinalCard does NOT include loading_icon (terminal state)', () => {
    const card = buildCardKitFinalCard('done', { status: '已完成' });
    const elements = card.body.elements as Array<Record<string, unknown>>;
    const ids = elements.map((e) => e.element_id);
    // 终态卡片不应该带 loading 图标，飞书客户端会自动停止加载动画
    expect(ids).not.toContain(CARDKIT_LOADING_ELEMENT_ID);
  });

  it('buildCardKitStreamingCard uses placeholder content when given empty strings', () => {
    const card = buildCardKitStreamingCard();
    const elements = card.body.elements as Array<Record<string, unknown>>;
    // 飞书 markdown 元素 content 不能完全为空，必须用占位字符
    for (const el of elements) {
      expect(typeof el.content).toBe('string');
      expect(el.content.length).toBeGreaterThan(0);
    }
  });

  it('buildCardKitFinalCard closes streaming_mode and includes summary', () => {
    const card = buildCardKitFinalCard('## Done\n\nbody', { status: '已完成', elapsedMs: 1234 });
    expect(card.schema).toBe('2.0');
    expect(card.config.streaming_mode).toBe(false);
    expect(card.config.summary?.content).toBeTruthy();
    const elements = card.body.elements as Array<Record<string, unknown>>;
    expect(elements.find((e) => e.element_id === CARDKIT_STREAMING_ELEMENT_ID)?.content).toContain('Done');
    expect(elements.find((e) => e.element_id === CARDKIT_FOOTER_ELEMENT_ID)?.content).toContain('已完成');
  });

  it('renderFooterMarkdown formats status/elapsed/tokens/context with separators', () => {
    const text = renderFooterMarkdown({
      status: '已完成',
      elapsedMs: 65000,
      model: 'claude-opus-4-7',
      tokens: { input: 12345, output: 6789 },
      contextPercentage: 42.7,
    });
    expect(text).toContain('已完成');
    expect(text).toContain('1m 5s'); // 65s
    expect(text).toContain('claude-opus-4-7');
    expect(text).toContain('↑12,345');
    expect(text).toContain('↓6,789');
    expect(text).toContain('上下文剩余 57%'); // 100 - 42.7 = 57.3 -> 57%
    expect(text).toContain('·'); // separator
  });

  it('renderFooterMarkdown highlights error status in red', () => {
    const text = renderFooterMarkdown({ status: 'Error: timeout' });
    expect(text).toContain("color='red'");
  });

  it('renderFooterMarkdown returns empty string when no metrics provided', () => {
    expect(renderFooterMarkdown({})).toBe('');
  });
});

// ---------------------------------------------------------------------------
// CardKit 2.0 streaming flow (mocked fetch)
// ---------------------------------------------------------------------------

describe('FeishuGateway.sendStreamingCardWithFooter (CardKit 2.0)', () => {
  let gateway: FeishuGateway;
  // 简化的 fetch mock 工厂
  const mockFetchOk = (body: unknown) => ({
    ok: true,
    json: async () => body,
  } as unknown as Response);

  beforeEach(() => {
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    // 跳过真正的 token 申请
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
    // 启用 CardKit 2.0 feature flag（默认禁用 → 短路到 legacy；
    // 这组测试是验证 v2 流程契约本身，需显式开启）
    process.env['OTTO_FEISHU_CARDKIT_V2'] = '1';
  });

  afterEach(() => {
    delete process.env['OTTO_FEISHU_CARDKIT_V2'];
  });

  it('happy path: create card → send IM message → push content → push footer → finalize', async () => {
    const fetchMock = vi.fn();
    // 1) cardkit.card.create
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { card_id: 'cardkit_001' } }));
    // 2) im.message.create or reply (since replyToMessageId is provided, prefer reply)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_msg_001' } }));
    // 3) push content (streamCardKitElement)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    // 4) push footer (streamCardKitElement)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    // 5) close streaming_mode (settings)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    // 6) card.update (final)
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter(
      'oc_chat_001',
      'hello world',
      { status: '思考中' },
      'om_origin_001',
    );

    expect(handle.cardId).toBe('cardkit_001');
    expect(handle.messageId).toBe('om_msg_001');

    // 验证 cardkit.card.create 调用
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(String(createUrl)).toContain('/open-apis/cardkit/v1/cards');
    expect(createInit?.method).toBe('POST');
    const createBody = JSON.parse(createInit?.body as string);
    expect(createBody.type).toBe('card_json');
    const createCard = JSON.parse(createBody.data);
    expect(createCard.schema).toBe('2.0');
    expect(createCard.config.streaming_mode).toBe(true);

    // 验证 im.message reply 调用
    const [imUrl, imInit] = fetchMock.mock.calls[1];
    expect(String(imUrl)).toContain('/open-apis/im/v1/messages/om_origin_001/reply');
    const imBody = JSON.parse(imInit?.body as string);
    expect(imBody.msg_type).toBe('interactive');
    const imContent = JSON.parse(imBody.content);
    expect(imContent.type).toBe('card');
    expect(imContent.data.card_id).toBe('cardkit_001');

    // pushContent
    const pushOk = await handle.pushContent('hello world updated');
    expect(pushOk).toBe(true);
    const [pushUrl, pushInit] = fetchMock.mock.calls[2];
    expect(String(pushUrl)).toContain(`/cardkit/v1/cards/cardkit_001/elements/${CARDKIT_STREAMING_ELEMENT_ID}/content`);
    expect(pushInit?.method).toBe('PUT');
    const pushBody = JSON.parse(pushInit?.body as string);
    expect(pushBody.content).toBe('hello world updated');
    expect(typeof pushBody.sequence).toBe('number');
    expect(pushBody.sequence).toBeGreaterThanOrEqual(2);

    // pushFooter
    const footerOk = await handle.pushFooter({ status: '已完成', elapsedMs: 1500 });
    expect(footerOk).toBe(true);
    const [footerUrl, footerInit] = fetchMock.mock.calls[3];
    expect(String(footerUrl)).toContain(`/elements/${CARDKIT_FOOTER_ELEMENT_ID}/content`);
    const footerBody = JSON.parse(footerInit?.body as string);
    expect(footerBody.content).toContain('已完成');

    // finalize → settings + update
    const finalizeOk = await handle.finalize('final answer', { status: '已完成', elapsedMs: 2000 });
    expect(finalizeOk).toBe(true);

    const [settingsUrl, settingsInit] = fetchMock.mock.calls[4];
    expect(String(settingsUrl)).toContain('/cardkit/v1/cards/cardkit_001/settings');
    expect(settingsInit?.method).toBe('PATCH');
    const settingsBody = JSON.parse(settingsInit?.body as string);
    expect(JSON.parse(settingsBody.settings).streaming_mode).toBe(false);

    const [updateUrl, updateInit] = fetchMock.mock.calls[5];
    expect(String(updateUrl)).toContain('/cardkit/v1/cards/cardkit_001');
    expect(updateInit?.method).toBe('PUT');
    const updateBody = JSON.parse(updateInit?.body as string);
    const finalCard = JSON.parse(updateBody.card.data);
    expect(finalCard.config.streaming_mode).toBe(false);
  });

  it('returns no-op handle when card.create fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockFetchOk({ code: 230099, msg: 'create failed' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter('oc_chat_001', 'hi');
    expect(handle.cardId).toBeNull();
    expect(handle.messageId).toBeNull();
    expect(await handle.pushContent('x')).toBe(false);
    expect(await handle.finalize('done')).toBe(false);
  });

  it('pushContent skips RPC when content is unchanged', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { card_id: 'cardkit_dedup' } }));
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_dedup' } }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter('oc_chat_x', 'same');
    // 推同样的内容不应该再发请求
    const ok = await handle.pushContent('same');
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 只 create + send，没有 stream
  });

  it('pushContent treats rate-limit (230020) as soft fail without throwing', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { card_id: 'cardkit_rl' } }));
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_rl' } }));
    fetchMock.mockResolvedValueOnce(mockFetchOk({ code: 230020, msg: 'rate limited' }));
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter('oc_chat_y', 'a');
    const ok = await handle.pushContent('b');
    expect(ok).toBe(false); // 速率限制返回 false 但不抛异常
  });
});

// ---------------------------------------------------------------------------
// CardKit 2.0 feature flag（短路）
//   生产环境 CardKit 2.0 不稳，默认 (无环境变量) sendStreamingCardWithFooter
//   必须立即返回 noop handle，不发起任何 cardkit.card.create 请求，
//   让调用方走 sendCard legacy 兜底。
// ---------------------------------------------------------------------------

describe('FeishuGateway.sendStreamingCardWithFooter - feature flag short-circuit', () => {
  let gateway: FeishuGateway;

  beforeEach(() => {
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
    delete process.env['OTTO_FEISHU_CARDKIT_V2'];
  });

  afterEach(() => {
    delete process.env['OTTO_FEISHU_CARDKIT_V2'];
    vi.unstubAllGlobals();
  });

  it('returns a noop handle without calling cardkit.card.create when flag is off', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter(
      'oc_chat_off',
      'hello',
    );

    expect(handle.messageId).toBeNull();
    expect(handle.cardId).toBeNull();
    // 关键断言：fetch 一次都不应被调用（短路必须发生在 createCardKitCard 之前）
    expect(fetchMock).not.toHaveBeenCalled();

    // noop pushContent / pushFooter / finalize 都返回 false（不再触发任何 RPC）
    expect(await handle.pushContent('updated')).toBe(false);
    expect(await handle.pushFooter({ status: 'done' } as unknown)).toBe(false);
    expect(await handle.finalize('end')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proceeds with cardkit.card.create when flag is explicitly enabled', async () => {
    process.env['OTTO_FEISHU_CARDKIT_V2'] = '1';
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 0, data: { card_id: 'cardkit_flag_on' } }),
    } as unknown as Response);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: 0, data: { message_id: 'om_flag_on' } }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const handle = await gateway.sendStreamingCardWithFooter(
      'oc_chat_on',
      'hello',
    );

    expect(handle.cardId).toBe('cardkit_flag_on');
    expect(handle.messageId).toBe('om_flag_on');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('FeishuGateway - image download saves with real extension', () => {
  let gateway: FeishuGateway;
  let tmpDir: string;

  // 各类图片的字节头样本（足够触发 magic number 探测）
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const mockImageResponse = (bytes: Uint8Array, contentType: string | null) =>
    ({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? contentType : null,
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }) as unknown as Response;

  beforeEach(async () => {
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    tmpDir = path.join(os.tmpdir(), `feishu-img-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    const fs = await import('node:fs');
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('downloadImageToDir saves JPEG bytes with .jpg (not .png) via magic number', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(JPEG, 'image/png')));
    const localPath = await gateway.downloadImageToDir('om_1', 'img_key_1', tmpDir);
    expect(localPath).toBeTruthy();
    expect(localPath!.endsWith('.jpg')).toBe(true);
  });

  it('downloadImageToDir saves GIF bytes with .gif', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(GIF, null)));
    const localPath = await gateway.downloadImageToDir('om_2', 'img_key_2', tmpDir);
    expect(localPath!.endsWith('.gif')).toBe(true);
  });

  it('downloadImageToDir keeps .png for real PNG bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(PNG, 'image/png')));
    const localPath = await gateway.downloadImageToDir('om_3', 'img_key_3', tmpDir);
    expect(localPath!.endsWith('.png')).toBe(true);
  });

  it('downloadImageResource saves JPEG bytes with .jpg in temp dir', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(JPEG, null)));
    const localPath = await gateway.downloadImageResource('om_4', 'img_key_4');
    expect(localPath).toBeTruthy();
    expect(localPath!.endsWith('.jpg')).toBe(true);
    const fs = await import('node:fs');
    try {
      fs.rmSync(localPath!, { force: true });
    } catch {
      /* ignore */
    }
  });

  it('downloadFileToDir saves files with safe file names and handles duplicate names correctly', async () => {
    const fileBytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockImageResponse(fileBytes, 'application/pdf')));

    // 1. 正常保存，过滤非法字符
    const localPath1 = await gateway.downloadFileToDir('om_file_1', 'file_key_1', 'my-test-file*?!.pdf', tmpDir);
    expect(localPath1).toBeTruthy();
    const fs = await import('node:fs');
    const path = await import('node:path');
    expect(path.basename(localPath1!)).toBe('my-test-file___.pdf');
    expect(fs.readFileSync(localPath1!)).toEqual(Buffer.from(fileBytes));

    // 2. 模拟重名时自动递增
    const localPath2 = await gateway.downloadFileToDir('om_file_2', 'file_key_2', 'my-test-file*?!.pdf', tmpDir);
    expect(localPath2).toBeTruthy();
    expect(path.basename(localPath2!)).toBe('my-test-file____1.pdf');
    expect(fs.readFileSync(localPath2!)).toEqual(Buffer.from(fileBytes));
  });
});

// ---------------------------------------------------------------------------
// Card callbacks over WS long-connection: form card + card.action.trigger
// ---------------------------------------------------------------------------

describe('FeishuGateway - askQuestionsViaForm (interactive form card)', () => {
  let gateway: FeishuGateway;
  let cardActionHandler: unknown;

  const mockFetchOk = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');

    cardActionHandler = null;
    mockRegister.mockImplementation((handlers: unknown) => {
      if (handlers['card.action.trigger']) {
        cardActionHandler = handlers['card.action.trigger'];
      }
    });
  });

  it('connect() registers a card.action.trigger handler (WS supports card callbacks)', async () => {
    await gateway.connect();
    expect(cardActionHandler).toBeTypeOf('function');
  });

  it('builds a schema 2.0 form card with select_static + input + submit button', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_1' } }));
    vi.stubGlobal('fetch', fetchMock);

    // 不等待提交，先验证发出的卡片结构。给极短超时让它尽快 resolve。
    const promise = gateway.askQuestionsViaForm(
      'oc_chat_1',
      [
        {
          question: 'Pick a framework',
          header: 'Framework',
          options: [
            { label: 'React', description: 'UI lib' },
            { label: 'Vue' },
          ],
        },
      ],
      50, // 50ms 超时
    );

    // 等卡片真正发出（sendRawInteractiveCard 是异步的）
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // 验证发出的卡片 JSON
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/open-apis/im/v1/messages');
    const body = JSON.parse(init?.body as string);
    expect(body.msg_type).toBe('interactive');
    const card = JSON.parse(body.content);
    expect(card.schema).toBe('2.0');

    const form = card.body.elements[0];
    expect(form.tag).toBe('form');
    const tags = form.elements.map((e: unknown) => e.tag);
    expect(tags).toContain('select_static');
    expect(tags).toContain('input');
    expect(tags).toContain('button');

    const select = form.elements.find((e: unknown) => e.tag === 'select_static');
    expect(select.name).toBe('q0');
    // options = 2 候选 + 1 "其他"
    expect(select.options).toHaveLength(3);
    expect(select.options[0].value).toBe('opt_0');
    expect(select.options[2].value).toBe('__other__');

    const submit = form.elements.find((e: unknown) => e.tag === 'button');
    expect(submit.form_action_type).toBe('submit');
    expect(submit.name).toBe('submit_btn');

    // 让超时触发，避免悬挂
    const result = await promise;
    expect(result.ok).toBe(true);
    // 超时 → 答案为空
    expect(result.answers!['Pick a framework']).toBe('');
  });

  it('resolves selected option label from form_value', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_2' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_2',
      [
        {
          question: 'Pick a framework',
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
      ],
      5000,
    );

    // 等卡片发出后，模拟用户提交（选第二项 Vue = opt_1）
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_2' },
        operator: { open_id: 'ou_user_1' },
        action: {
          tag: 'button',
          value: { action: 'submit_answers' },
          form_value: { q0: 'opt_1', q0_other: '' },
        },
      },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.answers!['Pick a framework']).toBe('Vue');
  });

  it('resolves custom "other" text when user picks the fill-in option', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_3' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_3',
      [{ question: 'Your choice?', options: [{ label: 'A' }, { label: 'B' }] }],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_3' },
        action: {
          form_value: { q0: '__other__', q0_other: 'My custom answer' },
        },
      },
    });

    const result = await promise;
    expect(result.answers!['Your choice?']).toBe('My custom answer');
  });

  it('builds a card with tag:multi_select_static when multiSelect is true and parses multiple choices', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_multi' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_multi',
      [
        {
          question: 'Select multiple technologies',
          options: [{ label: 'Node.js' }, { label: 'Python' }, { label: 'Go' }],
          multiSelect: true,
        },
      ],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Verify card generation
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    const card = JSON.parse(body.content);
    const form = card.body.elements[0];
    const multiSelectStatic = form.elements.find((e: unknown) => e.tag === 'multi_select_static');

    expect(multiSelectStatic).toBeDefined();
    expect(multiSelectStatic.options).toHaveLength(4); // 3 options + 1 "other"

    // Simulate submission with multiple selections: Node.js (opt_0) and Go (opt_2) + custom filling (other)
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_multi' },
        action: {
          form_value: { q0: ['opt_0', 'opt_2', '__other__'], q0_other: 'Rust' },
        },
      },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.answers!['Select multiple technologies']).toBe('Node.js, Go, Rust');
  });

  it('resolves answers from unwrapped trigger payload (no event wrapper)', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_unwrapped' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_unwrapped',
      [
        {
          question: 'Pick a framework',
          options: [{ label: 'React' }, { label: 'Vue' }],
        },
      ],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await cardActionHandler({
      schema: '2.0',
      operator: { open_id: 'ou_user_1' },
      action: {
        tag: 'button',
        form_value: { q0: 'opt_1', q0_other: '' },
      },
      host: 'im_message',
      context: {
        open_message_id: 'om_form_unwrapped',
        open_chat_id: 'oc_chat_unwrapped',
      },
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.answers!['Pick a framework']).toBe('Vue');
  });

  it('returns ok:false when card send fails (caller should fallback to text)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 99991663, msg: 'send failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await gateway.askQuestionsViaForm(
      'oc_chat_4',
      [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }],
      5000,
    );
    expect(result.ok).toBe(false);
    expect(result.answers).toBeUndefined();
  });

  it('renders the "other ideas" button as a schema 2.0 callback button OUTSIDE the form (never tag:action)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_other' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_other',
      [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      50,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    const card = JSON.parse(body.content);
    expect(card.schema).toBe('2.0');

    // 🚫 schema 2.0 严禁出现 tag:'action' 容器——它是 1.0 写法，会让整卡校验失败
    const allTags = card.body.elements.map((e: unknown) => e.tag);
    expect(allTags).not.toContain('action');

    // ✅ 第二个元素应是直接位于 body.elements 的 callback 按钮（在 form 之外）
    expect(card.body.elements[0].tag).toBe('form');
    const otherBtn = card.body.elements[1];
    expect(otherBtn.tag).toBe('button');
    expect(otherBtn.behaviors).toBeDefined();
    expect(otherBtn.behaviors[0].type).toBe('callback');
    expect(otherBtn.behaviors[0].value.choice).toBe('other_ideas');

    await promise; // 让超时收尾，避免悬挂
  });

  it('returns { ok:true, otherIdeas:true } when user clicks the "other ideas" callback button', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_form_oi' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askQuestionsViaForm(
      'oc_chat_oi',
      [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // 模拟用户点击「我有其他想法」：value 为对象 { choice: 'other_ideas' }
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_form_oi' },
        operator: { open_id: 'ou_user_1' },
        action: {
          tag: 'button',
          value: { choice: 'other_ideas' },
        },
      },
    });

    const result = (await promise) as unknown;
    expect(result.ok).toBe(true);
    expect(result.otherIdeas).toBe(true);
    // 走 otherIdeas 分支时不应附带 answers
    expect(result.answers).toBeUndefined();
  });
});

describe('FeishuGateway - waitForCardAction (button card with real callback)', () => {
  let gateway: FeishuGateway;
  let cardActionHandler: unknown;

  const mockFetchOk = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
    cardActionHandler = null;
    mockRegister.mockImplementation((handlers: unknown) => {
      if (handlers['card.action.trigger']) {
        cardActionHandler = handlers['card.action.trigger'];
      }
    });
  });

  it('sends a button card and resolves with the clicked value', async () => {
    await gateway.connect();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_btn_1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.waitForCardAction(
      'oc_chat_1',
      'Choose',
      'body',
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      '__timeout__',
      5000,
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // 用户点击 "yes" 按钮，value 是 { choice: 'yes' }
    await cardActionHandler({
      event: {
        context: { open_message_id: 'om_btn_1' },
        action: { tag: 'button', value: { choice: 'yes' } },
      },
    });

    const choice = await promise;
    expect(choice).toBe('yes');
  });

  it('falls back to text-choice mode when card send fails', async () => {
    await gateway.connect();
    // sendCard 失败 → waitForTextChoice → sendMarkdown 成功
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 99991663, msg: 'fail' })) // sendCard direct fail
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { message_id: 'om_txt_1' } })); // sendMarkdown
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.waitForCardAction(
      'oc_chat_2',
      'Choose',
      'body',
      [{ label: 'Yes', value: 'yes' }],
      '__timeout__',
      50, // 短超时，触发文本模式超时返回默认值
    );

    const choice = await promise;
    expect(choice).toBe('__timeout__');
    // 第二次 fetch 应是 markdown 文本消息（文本兜底）
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// getChatName — 解析群名（无权限/失败时 fallback 到 null）
// ---------------------------------------------------------------------------

describe('FeishuGateway - getChatName', () => {
  let gateway: FeishuGateway;

  const mockFetchOk = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
  });

  it('returns the chat name on success and calls the correct endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: '我的项目协作群' } }));
    vi.stubGlobal('fetch', fetchMock);

    const name = await gateway.getChatName('oc_abc123');
    expect(name).toBe('我的项目协作群');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/open-apis/im/v1/chats/oc_abc123');
    expect(init?.method ?? 'GET').toBe('GET');
    expect((init?.headers as unknown)?.Authorization).toBe('Bearer mock-token');
  });

  it('caches the resolved name and does not re-request on second call', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: 'Cached Group' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await gateway.getChatName('oc_cache');
    const second = await gateway.getChatName('oc_cache');
    expect(first).toBe('Cached Group');
    expect(second).toBe('Cached Group');
    // 仅请求一次（第二次命中缓存）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the API responds with a non-zero error code (e.g. no permission)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 99991672, msg: 'no permission' }));
    vi.stubGlobal('fetch', fetchMock);

    const name = await gateway.getChatName('oc_noperm');
    expect(name).toBeNull();
  });

  it('returns null when the chat name is empty (p2p chats have no name)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: '' } }));
    vi.stubGlobal('fetch', fetchMock);

    const name = await gateway.getChatName('oc_p2p');
    expect(name).toBeNull();
  });

  it('returns null and does not throw when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const name = await gateway.getChatName('oc_neterr');
    expect(name).toBeNull();
  });

  it('returns null for empty chatId without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const name = await gateway.getChatName('');
    expect(name).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not cache failures, allowing a later retry to succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 99991672, msg: 'no permission' }))
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: 'Now Visible' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await gateway.getChatName('oc_retry');
    const second = await gateway.getChatName('oc_retry');
    expect(first).toBeNull();
    expect(second).toBe('Now Visible');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getChatMode — 精确判断会话类型（p2p 单聊 / group 群聊），用于 Dashboard 友好展示
// ---------------------------------------------------------------------------

describe('FeishuGateway - getChatMode', () => {
  let gateway: FeishuGateway;

  const mockFetchOk = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
  });

  it('returns "p2p" for a bot direct-message chat', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: '', chat_mode: 'p2p' } }));
    vi.stubGlobal('fetch', fetchMock);

    const mode = await gateway.getChatMode('oc_p2p_dm');
    expect(mode).toBe('p2p');
  });

  it('returns "group" for a normal group chat', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: '协作群', chat_mode: 'group' } }));
    vi.stubGlobal('fetch', fetchMock);

    const mode = await gateway.getChatMode('oc_group');
    expect(mode).toBe('group');
  });

  it('caches the chat mode after getChatName resolves (no second request)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: 'G', chat_mode: 'group' } }));
    vi.stubGlobal('fetch', fetchMock);

    // 第一次走 getChatName 触发请求，顺带缓存 chat_mode
    await gateway.getChatName('oc_combo');
    // getChatMode 应命中缓存，不再发请求
    const mode = await gateway.getChatMode('oc_combo');
    expect(mode).toBe('group');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the API responds with a non-zero error code (no permission)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 99991672, msg: 'no permission' }));
    vi.stubGlobal('fetch', fetchMock);

    const mode = await gateway.getChatMode('oc_noperm');
    expect(mode).toBeNull();
  });

  it('returns null (does not throw) when fetch rejects', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const mode = await gateway.getChatMode('oc_neterr');
    expect(mode).toBeNull();
  });

  it('returns null for empty chatId without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const mode = await gateway.getChatMode('');
    expect(mode).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still resolves p2p mode even when name is empty (p2p chats have no name)', async () => {
    // 关键回归：p2p 单聊 name 为空，但 chat_mode 仍须可被识别为 p2p。
    // 这保证我们不会把 p2p 和"无名群/无权限群"混为一谈。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockFetchOk({ code: 0, data: { name: '', chat_mode: 'p2p' } }));
    vi.stubGlobal('fetch', fetchMock);

    const name = await gateway.getChatName('oc_p2p_noname');
    const mode = await gateway.getChatMode('oc_p2p_noname');
    expect(name).toBeNull(); // 无群名，fallback
    expect(mode).toBe('p2p'); // 但类型精确可知
    expect(fetchMock).toHaveBeenCalledTimes(1); // 共用一次请求
  });
});

// ---------------------------------------------------------------------------
// Goal-driven mode form card structure (regression for Feishu code=230099)
// ---------------------------------------------------------------------------

describe('FeishuGateway - askGoalFormViaCard (goal contract form card)', () => {
  let gateway: FeishuGateway;

  const mockFetchOk = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new FeishuGateway('mock-app-id', 'mock-app-secret');
    vi.spyOn(gateway, 'getTenantToken').mockResolvedValue('mock-token');
  });

  // 飞书 select_static 组件【不支持】label 属性。早期版本误给 intensity 下拉
  // 加了 label，导致整卡 JSON 校验失败（code=230099 "unknown property:
  // label, path: ... select_static"），表单根本发不出去 → 用户看到
  // "目标表单发送失败"。此用例锁死该回归。
  it('does NOT put a `label` property on any select_static (Feishu rejects it)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_goal_1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askGoalFormViaCard('oc_goal_chat', 50);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/open-apis/im/v1/messages');
    const card = JSON.parse(JSON.parse(init?.body as string).content);
    expect(card.schema).toBe('2.0');

    const form = card.body.elements.find((e: unknown) => e.tag === 'form');
    expect(form).toBeTruthy();

    const selects = form.elements.filter(
      (e: unknown) => e.tag === 'select_static' || e.tag === 'multi_select_static',
    );
    expect(selects.length).toBeGreaterThan(0);
    for (const sel of selects) {
      expect(sel).not.toHaveProperty('label');
    }

    await promise; // 让超时 resolve，避免悬挂
  });

  it('builds a complete goal form: task/criteria/forbidden/hours inputs + intensity select + submit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 0, data: { message_id: 'om_goal_2' } }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = gateway.askGoalFormViaCard('oc_goal_chat', 50);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [, init] = fetchMock.mock.calls[0];
    const card = JSON.parse(JSON.parse(init?.body as string).content);
    const form = card.body.elements.find((e: unknown) => e.tag === 'form');

    const inputNames = form.elements
      .filter((e: unknown) => e.tag === 'input')
      .map((e: unknown) => e.name);
    expect(inputNames).toEqual(
      expect.arrayContaining(['task', 'criteria', 'forbidden', 'hours']),
    );

    const select = form.elements.find((e: unknown) => e.tag === 'select_static');
    expect(select.name).toBe('intensity');
    expect(select.options.map((o: unknown) => o.value)).toEqual([
      'steady',
      'standard',
      'intense',
    ]);

    const submit = form.elements.find((e: unknown) => e.tag === 'button');
    expect(submit.form_action_type).toBe('submit');
    expect(submit.name).toBe('submit_btn');

    await promise;
  });

  it('returns ok:false (non-timeout) when card send fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchOk({ code: 230099, msg: 'parse card json err' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await gateway.askGoalFormViaCard('oc_goal_chat', 50);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBeFalsy();
  });
});
