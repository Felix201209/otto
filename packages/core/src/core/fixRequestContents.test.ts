/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Content } from '../types/extendedContent.js';
import { GeminiChat } from './geminiChat.js';
import { Config } from '../config/config.js';
import { ContentGenerator } from './contentGenerator.js';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { logger } from '../utils/enhancedLogger.js';

// Mock dependencies
vi.mock('../config/config.js');
vi.mock('./contentGenerator.js');

describe('GeminiChat.fixRequestContents', () => {
  let geminiChat: GeminiChat;
  let mockConfig: Config;
  let mockContentGenerator: ContentGenerator;
  // 详细日志（如"补全/调整/孤立检测"）走 logger.debug；
  // 致命级别（孤立移除/末尾占位等）走 console.warn。
  // 这里两个 spy 各盯一头，断言时可以精确取舍。
  let loggerDebugSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // 创建完整的 mock Config 对象
    mockConfig = {
      getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({ authType: 'oauth' }),
      getProjectRoot: vi.fn().mockReturnValue('/mock/path'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      flashFallbackHandler: undefined,
      getQuotaErrorOccurred: vi.fn().mockReturnValue(false),
      setModel: vi.fn()
    } as any;

    mockContentGenerator = {} as ContentGenerator;
    geminiChat = new GeminiChat(mockConfig, mockContentGenerator);

    // 业务在 e36df4fc 之后把详细日志切到了 logger.debug，老的 spyOn(console, 'log') 永远收不到。
    loggerDebugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerDebugSpy?.mockRestore();
    consoleWarnSpy?.mockRestore();
  });

  // 使用反射访问私有方法进行测试
  const callFixRequestContents = (requestContents: Content[]): Content[] => {
    return (geminiChat as any).fixRequestContents(requestContents);
  };

  describe('单个 Function Call 场景', () => {
    it('应该为没有 response 的 function call 补全 user cancel（补全的 user 与原 user 会被合并）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { text: '我来搜索一下' },
            { functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }
          ]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ text: '等等，不用搜索了' }]
        }
      ];

      const result = callFixRequestContents(input);

      // 业务行为：补全的 user(cancel) 与紧跟的 user(text) 在最后阶段会被合并成一条 user。
      // 这是 e36df4fc 的合并相邻同 role 消息逻辑——避免上游协议看到连续两条 user 时把 tool_result 当成被截断。
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(input[0]);
      expect(result[1].role).toBe(MESSAGE_ROLES.USER);
      expect(result[1].parts).toEqual([
        {
          functionResponse: {
            name: 'search',
            id: 'abc123',
            response: { result: 'user cancel' }
          }
        },
        { text: '等等，不用搜索了' }
      ]);
    });

    it('有正确 response 的 function call 不应该被补全', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      expect(result).toHaveLength(2);
      expect(result).toEqual(input);
    });

    it('ID 不匹配的 response 应该被认为是未匹配（cancel 补全后与原 response 合并）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'xyz789', response: { result: '晴天' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      // 业务行为：
      //   - call(abc123) 没有匹配响应 → 补 user(cancel id=abc123)
      //   - 原 response(xyz789) 名字仍是 'search'，final 清理阶段用“id或name任一匹配” 保留了它
          //     （这不是 bug：是为了容忍部分模型丢失 ID、或 ID 变形返回的场景）
      //   - 两条 user 被合并为一条，parts=[cancel(abc123), original(xyz789)]
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(input[0]);
      expect(result[1].role).toBe(MESSAGE_ROLES.USER);
      expect(result[1].parts).toEqual([
        {
          functionResponse: {
            name: 'search',
            id: 'abc123',
            response: { result: 'user cancel' }
          }
        },
        { functionResponse: { name: 'search', id: 'xyz789', response: { result: '晴天' } } }
      ]);
    });

    it('name 不匹配的 response 应该被认为是未匹配（cancel 补全后与原 response 合并）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'calculate', id: 'abc123', response: { result: '42' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      // 业务行为：
      //   - call(search/abc123) 没匹配响应 → 补 user(cancel name=search id=abc123)
      //   - 原 response(calculate/abc123) 使用 ID abc123，final 清理阶段“id或name”任一匹配 → 保留
      //   - 两条 user 合并。这表明：模糊匹配是“宽进严出”，
      //     只要 ID 同、哪怕 name 不同，上游依然可能看到“你调的 search，却返回了 calculate 的结果”，
      //     但这是历史实现选择的容错。
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(input[0]);
      expect(result[1].role).toBe(MESSAGE_ROLES.USER);
      expect(result[1].parts).toEqual([
        {
          functionResponse: {
            name: 'search',
            id: 'abc123',
            response: { result: 'user cancel' }
          }
        },
        { functionResponse: { name: 'calculate', id: 'abc123', response: { result: '42' } } }
      ]);
    });
  });

  describe('多个 Function Call 场景', () => {
    it('应该为所有未匹配的 function call 补全 response（多条 cancel + 文本会合并到同一条 user）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } },
            { functionCall: { name: 'calculate', id: 'def456', args: { expression: '2+2' } } }
          ]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ text: '不需要这些功能' }]
        }
      ];

      const result = callFixRequestContents(input);

      // 行为：补全两条 cancel + 原 text，三个 part 合并到一条 user
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(input[0]);
      expect(result[1].role).toBe(MESSAGE_ROLES.USER);
      expect(result[1].parts).toEqual([
        {
          functionResponse: {
            name: 'search',
            id: 'abc123',
            response: { result: 'user cancel' }
          }
        },
        {
          functionResponse: {
            name: 'calculate',
            id: 'def456',
            response: { result: 'user cancel' }
          }
        },
        { text: '不需要这些功能' }
      ]);
    });

    it('应该只为部分未匹配的 function call 补全 response（最终合并并且 function-response 在前）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } },
            { functionCall: { name: 'calculate', id: 'def456', args: { expression: '2+2' } } }
          ]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } },
            { text: '搜索结果不错，但不需要计算' }
          ]
        }
      ];

      const result = callFixRequestContents(input);

      // 业务行为：
      //   - calculate 补全 cancel
      //   - 原 user 已被混合内容顺序调整：[search FR, text]
      //   - 两条 user 合并为一条：[calculate-cancel, search FR, text]
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(input[0]);
      expect(result[1].role).toBe(MESSAGE_ROLES.USER);
      expect(result[1].parts).toEqual([
        {
          functionResponse: {
            name: 'calculate',
            id: 'def456',
            response: { result: 'user cancel' }
          }
        },
        { functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } },
        { text: '搜索结果不错，但不需要计算' }
      ]);
    });

    it('所有 function call 都有匹配的 response 时不应该补全', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } },
            { functionCall: { name: 'calculate', id: 'def456', args: { expression: '2+2' } } }
          ]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } },
            { functionResponse: { name: 'calculate', id: 'def456', response: { result: '4' } } }
          ]
        }
      ];

      const result = callFixRequestContents(input);

      expect(result).toHaveLength(2);
      expect(result).toEqual(input);
    });
  });

  describe('混合内容顺序调整', () => {
    it('应该将 function-response 移到 text 前面', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { text: '搜索结果：' },
            { functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } },
            { text: '很好的天气！' }
          ]
        }
      ];

      const result = callFixRequestContents(input);

      expect(result).toHaveLength(2);
      expect(result[1].parts).toEqual([
        { functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } },
        { text: '搜索结果：' },
        { text: '很好的天气！' }
      ]);
    });

    it('只有 text 或只有 function-response 时不应该调整顺序', () => {
      const input1: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ text: '只有文本' }]
        }
      ];

      const input2: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } }]
        }
      ];

      const result1 = callFixRequestContents(input1);
      const result2 = callFixRequestContents(input2);

      // input1：补全 user-cancel + 原 user(text) 合并 → length=2，但合并后 parts=[FR cancel, text]
      expect(result1).toHaveLength(2);
      expect(result1[1].role).toBe(MESSAGE_ROLES.USER);
      expect(result1[1].parts).toEqual([
        {
          functionResponse: {
            name: 'search',
            id: 'abc123',
            response: { result: 'user cancel' }
          }
        },
        { text: '只有文本' }
      ]);

      // input2：完全匹配，原样返回
      expect(result2).toHaveLength(2);
      expect(result2[1].parts).toEqual(input2[1].parts);
    });
  });

  describe('边界情况', () => {
    it('空数组应该返回空数组', () => {
      const result = callFixRequestContents([]);
      expect(result).toEqual([]);
    });

    it('没有 function call 的内容应该保持不变', () => {
      // 注意：业务的"安全保障"逻辑会在 contents 以 model 结尾时追加一条 user placeholder
      // （防止 assistant-prefill error）。这里使用以 user 结尾的输入，验证非 function call 场景下
      // 既不会被错误修改也不会触发 placeholder 注入。
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '你好' }] },
        { role: MESSAGE_ROLES.MODEL, parts: [{ text: '你好！有什么可以帮你的吗？' }] },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '继续' }] }
      ];

      const result = callFixRequestContents(input);
      expect(result).toEqual(input);
    });

    it('contents 以 model 消息结尾时应该追加 user placeholder（防止 assistant-prefill error）', () => {
      // 业务安全保障：某些模型（如 AWS Bedrock 上的 Claude）不支持 assistant prefill，
      // 要求对话必须以 user 消息结尾。此处验证该保障逻辑生效。
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '你好' }] },
        { role: MESSAGE_ROLES.MODEL, parts: [{ text: '你好！有什么可以帮你的吗？' }] }
      ];

      const result = callFixRequestContents(input);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(input[0]);
      expect(result[1]).toEqual(input[1]);
      expect(result[2].role).toBe(MESSAGE_ROLES.USER);
      expect(result[2].parts).toEqual([{ text: '[Conversation continues]' }]);
    });

    it('function call 在最后一条消息时应该补全', () => {
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '搜索天气' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      expect(result).toHaveLength(3);
      expect(result[2]).toEqual({
        role: MESSAGE_ROLES.USER,
        parts: [{
          functionResponse: {
            name: 'search',
            id: 'abc123',
            response: { result: 'user cancel' }
          }
        }]
      });
    });

    it('没有 ID 的 function call 和 response 应该能够匹配', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', response: { result: '晴天' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      expect(result).toHaveLength(2);
      expect(result).toEqual(input);
    });

    it('一个有 ID 一个没有 ID 应该被认为是匹配的（模糊匹配，兼容性支持）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', response: { result: '晴天' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      // 现在应该匹配成功，不再补全多余的 cancel
      expect(result).toHaveLength(2);
      expect(result).toEqual(input);
    });
  });

  describe('复杂场景', () => {
    it('多轮对话中的 function call 修复', () => {
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '搜索天气' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: '1', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: '1', response: { result: '晴天' } } }]
        },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [
            { text: '天气很好！还需要其他信息吗？' },
            { functionCall: { name: 'calculate', id: '2', args: { expression: '2+2' } } }
          ]
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '不需要计算' }] }
      ];

      const result = callFixRequestContents(input);

      // 6 → 5：补全的 user(cancel calc/2) 与原 user(text "不需要计算") 合并
      expect(result).toHaveLength(5);
      // 末尾合并后的 user 同时包含 cancel 和原 text
      expect(result[4].role).toBe(MESSAGE_ROLES.USER);
      expect(result[4].parts).toEqual([
        {
          functionResponse: {
            name: 'calculate',
            id: '2',
            response: { result: 'user cancel' }
          }
        },
        { text: '不需要计算' }
      ]);
      // 前 4 条结构保持
      expect(result[0]).toEqual(input[0]);
      expect(result[1]).toEqual(input[1]);
      expect(result[2]).toEqual(input[2]);
      expect(result[3]).toEqual(input[3]);
    });
  });

  describe('多余 functionResponse 检测', () => {
    it('应该检测并记录多余的 functionResponse（ID 不匹配）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'correct_id', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'search', id: 'wrong_id', response: { result: '晴天' } } },
            { text: '这是用户输入' }
          ]
        }
      ];

      callFixRequestContents(input);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 检测到第2条消息中有 1 个孤立的 function response:'),
        expect.arrayContaining([
          expect.objectContaining({ name: 'search', id: 'wrong_id' })
        ])
      );
    });

    it('应该检测并记录多余的 functionResponse（name 不匹配）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'calculate', id: 'abc123', response: { result: '42' } } }
          ]
        }
      ];

      callFixRequestContents(input);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 检测到第2条消息中有 1 个孤立的 function response:'),
        expect.arrayContaining([
          expect.objectContaining({ name: 'calculate', id: 'abc123' })
        ])
      );
    });

    it('应该检测并记录多个多余的 functionResponse', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'valid_id', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'search', id: 'valid_id', response: { result: '晴天' } } }, // 匹配的
            { functionResponse: { name: 'search', id: 'invalid_id1', response: { result: '多云' } } }, // 多余的
            { functionResponse: { name: 'calculate', id: 'invalid_id2', response: { result: '42' } } }, // 多余的
            { text: '用户文本' }
          ]
        }
      ];

      callFixRequestContents(input);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 检测到第2条消息中有 2 个孤立的 function response:'),
        expect.arrayContaining([
          expect.objectContaining({ name: 'search', id: 'invalid_id1' }),
          expect.objectContaining({ name: 'calculate', id: 'invalid_id2' })
        ])
      );
    });

    it('有匹配的 functionResponse 时不应该报告多余的', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } }]
        }
      ];

      callFixRequestContents(input);

      // 确保没有 "检测到孤立" 的 debug 日志（合规对话不应该惊动开发者）
      expect(loggerDebugSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 检测到'),
        expect.anything(),
      );
    });

    it('没有 functionCall 的情况下所有 functionResponse 都应该被认为是多余的', () => {
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '只是普通对话' }] },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { functionResponse: { name: 'search', id: 'orphan_id', response: { result: '孤立响应' } } },
            { text: '用户消息' }
          ]
        }
      ];

      callFixRequestContents(input);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 检测到第2条消息中有 1 个孤立的 function response:'),
        expect.arrayContaining([
          expect.objectContaining({ name: 'search', id: 'orphan_id' })
        ])
      );
    });
  });

  describe('Function Response 仲裁逻辑 (Priority)', () => {
    it('当同时存在 "user cancel" 和真实结果时，应该保留真实结果', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'id1', args: {} } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'id1', response: { result: 'user cancel' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'id1', response: { result: '这是延迟到达的真实结果' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      // 验证结果中只保留了真实结果，且去掉了 "user cancel"
      const allResponses = result.flatMap(c => c.parts || []).filter(p => p.functionResponse);
      expect(allResponses).toHaveLength(1);
      expect((allResponses[0].functionResponse!.response as any).result).toBe('这是延迟到达的真实结果');
    });

    it('即便 "user cancel" 在真实结果后面，也应该保留真实结果（虽然通常不会发生）', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'id1', args: {} } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'id1', response: { result: '真实结果在前' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'search', id: 'id1', response: { result: 'user cancel' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      const allResponses = result.flatMap(c => c.parts || []).filter(p => p.functionResponse);
      expect(allResponses).toHaveLength(1);
      expect((allResponses[0].functionResponse!.response as any).result).toBe('真实结果在前');
    });

    it('Claude 场景：当 Call 没有 ID，但 Response 有 ID 时，应该正确仲裁并保留真实结果', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'glob', args: { pattern: '**/*' } } }] // 无 ID (Claude 风格)
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'glob', response: { result: 'user cancel' } } }] // 补全的无 ID cancel
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'glob', id: 'glob-123', response: { output: 'files...' } } }] // 真实的带 ID 结果
        }
      ];

      const result = callFixRequestContents(input);

      // 验证：
      // 1. 并没有因为 Call 缺少 ID 就补全多余的 cancel（因为第三个 Part 的真实结果已经匹配了它）
      // 2. 即使第二个 Part 插入了，仲裁逻辑也应该把它移除，保留带 ID 的 Part 3
      // 3. 🎯 关键：Part 3 的 ID 应该被回滚/对齐为 undefined，以匹配 Call 的 ID
      const allResponses = result.flatMap(c => c.parts || []).filter(p => p.functionResponse);
      expect(allResponses).toHaveLength(1);
      expect(allResponses[0].functionResponse!.id).toBeUndefined(); // ID 应该被对齐为 undefined
      expect((allResponses[0].functionResponse!.response as any).output).toBe('files...');
    });

    it('🆕 关键修复：cancel 和真实结果在不同 user 消息中时，应该只保留真实结果，不再补全 cancel', () => {
      // 这是实际发生的场景：cancel 插入到消息1，真实结果在消息2
      // 修复前：去重阶段保留真实结果，但补全阶段发现下一条消息没有响应，又插入 cancel
      // 修复后：补全阶段检查 bestResponses 发现真实结果在后续消息中，跳过补全
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'todo_write', id: 'functions.todo_write:3' } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'todo_write', id: 'functions.todo_write:3', response: { result: 'user cancel' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [{ functionResponse: { name: 'todo_write', id: 'functions.todo_write:3', response: { output: 'Todo List Updated Successfully\n\n' } } }]
        }
      ];

      const result = callFixRequestContents(input);

      // 应该只保留真实结果，没有 cancel
      const allResponses = result.flatMap(c => c.parts || []).filter(p => p.functionResponse);
      expect(allResponses).toHaveLength(1);
      expect((allResponses[0].functionResponse!.response as any).output).toBe('Todo List Updated Successfully\n\n');
    });
  });

  describe('日志测试', () => {
    it('补全 function call 时应该记录日志', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        { role: MESSAGE_ROLES.USER, parts: [{ text: '不需要' }] }
      ];

      callFixRequestContents(input);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 为第1条消息补全了 1 个未匹配的 function call')
      );
    });

    it('调整内容顺序时应该记录日志', () => {
      const input: Content[] = [
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'abc123', args: { query: '天气' } } }]
        },
        {
          role: MESSAGE_ROLES.USER,
          parts: [
            { text: '结果：' },
            { functionResponse: { name: 'search', id: 'abc123', response: { result: '晴天' } } }
          ]
        }
      ];

      callFixRequestContents(input);

      expect(loggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[fixRequestContents] 调整了第2条消息的内容顺序，function-response 在前')
      );
    });
  });

  // ─────────── 回归测试：末尾 user placeholder 安全保障 ───────────
  describe('末尾安全保障 (assistant-prefill 防护)', () => {
    it('contents 以 user 消息结尾时不应追加 placeholder', () => {
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '你好' }] },
      ];
      const result = callFixRequestContents(input);
      // 只有一条 user 消息，不应被改动
      expect(result).toHaveLength(1);
      expect(result[result.length - 1].role).toBe(MESSAGE_ROLES.USER);
      const lastText = (result[result.length - 1].parts?.[0] as any).text;
      expect(lastText).not.toBe('[Conversation continues]');
    });

    it('空数组不应被追加 placeholder', () => {
      const result = callFixRequestContents([]);
      expect(result).toEqual([]);
    });

    it('contents 以 model 消息结尾且只有 functionCall 时（被 fix 后）不应额外追加 placeholder', () => {
      // 业务行为：当 model 末尾是 functionCall 时，会先补 user-cancel functionResponse；
      // 这种补全已经把末尾变成了 user，因此不需要再追加 [Conversation continues] placeholder。
      const input: Content[] = [
        { role: MESSAGE_ROLES.USER, parts: [{ text: '搜天气' }] },
        {
          role: MESSAGE_ROLES.MODEL,
          parts: [{ functionCall: { name: 'search', id: 'xyz', args: { q: '天气' } } }]
        }
      ];
      const result = callFixRequestContents(input);
      // 末尾应是 user 消息（functionResponse 补全），且不是 [Conversation continues] 占位符
      expect(result[result.length - 1].role).toBe(MESSAGE_ROLES.USER);
      const lastPart = result[result.length - 1].parts?.[0] as any;
      expect(lastPart.functionResponse).toBeDefined();
      // 确认没有 [Conversation continues] 文本被追加在末尾
      const allText = result.flatMap(c => c.parts || [])
        .map((p: any) => p.text)
        .filter(Boolean);
      expect(allText).not.toContain('[Conversation continues]');
    });
  });
});
