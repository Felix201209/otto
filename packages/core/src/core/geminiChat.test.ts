/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Content,
  Models,
  GenerateContentConfig,
  Part,
  GenerateContentResponse,
} from '@google/genai';
import { GeminiChat } from './geminiChat.js';
import { Config } from '../config/config.js';
import { setSimulate429 } from '../utils/testUtils.js';
import { SceneType } from './sceneManager.js';

// Mocks
const mockModelsModule = {
  generateContent: vi.fn(),
  generateContentStream: vi.fn(),
  countTokens: vi.fn(),
  embedContent: vi.fn(),
  batchEmbedContents: vi.fn(),
} as unknown as Models;

describe('GeminiChat', () => {
  let chat: GeminiChat;
  let mockConfig: Config;
  const config: GenerateContentConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryLogPromptsEnabled: () => true,
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getContentGeneratorConfig: () => ({
        authType: 'oauth-personal',
        model: 'test-model',
      }),
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      setModel: vi.fn(),
      getQuotaErrorOccurred: vi.fn().mockReturnValue(false),
      setQuotaErrorOccurred: vi.fn(),
      flashFallbackHandler: undefined,
    } as unknown as Config;

    // Disable 429 simulation for tests
    setSimulate429(false);
    // Reset history for each test by creating a new instance
    chat = new GeminiChat(mockConfig, mockModelsModule, config, []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  describe('sendMessage', () => {
    it('should call generateContent with the correct parameters', async () => {
      const response = {
        candidates: [
          {
            content: {
              parts: [{ text: 'response' }],
              role: 'model',
            },
            finishReason: 'STOP',
            index: 0,
            safetyRatings: [],
          },
        ],
        text: () => 'response',
      } as unknown as GenerateContentResponse;
      vi.mocked(mockModelsModule.generateContent).mockResolvedValue(response);

      await chat.sendMessage({ message: 'hello' }, 'prompt-id-1', SceneType.CHAT_CONVERSATION);

      expect(mockModelsModule.generateContent).toHaveBeenCalledWith({
        model: 'gemini-pro',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        config: {},
      }, SceneType.CHAT_CONVERSATION);
    });
  });

  describe('sendMessageStream', () => {
    it('should call generateContentStream with the correct parameters', async () => {
      const response = (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'response' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
              safetyRatings: [],
            },
          ],
          text: () => 'response',
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockModelsModule.generateContentStream).mockResolvedValue(
        response,
      );

      await chat.sendMessageStream({ message: 'hello' }, 'prompt-id-1', SceneType.CHAT_CONVERSATION);

      expect(mockModelsModule.generateContentStream).toHaveBeenCalledWith({
        model: 'gemini-pro',
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        config: {},
      }, SceneType.CHAT_CONVERSATION);
    });

    it('should merge consecutive reasoning chunks and keep them in history', async () => {
      // 模拟服务器流式下发：3 个 reasoning chunk + 1 个最终 text chunk
      const response = (async function* () {
        yield {
          candidates: [{
            content: { role: 'model', parts: [{ reasoning: 'Let me ' }] },
            index: 0,
          }],
        } as unknown as GenerateContentResponse;
        yield {
          candidates: [{
            content: { role: 'model', parts: [{ reasoning: 'think about ' }] },
            index: 0,
          }],
        } as unknown as GenerateContentResponse;
        yield {
          candidates: [{
            content: { role: 'model', parts: [{ reasoning: 'this...' }] },
            index: 0,
          }],
        } as unknown as GenerateContentResponse;
        yield {
          candidates: [{
            content: { role: 'model', parts: [{ text: 'Final answer.' }] },
            finishReason: 'STOP',
            index: 0,
          }],
          text: () => 'Final answer.',
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockModelsModule.generateContentStream).mockResolvedValue(
        response,
      );

      const stream = await chat.sendMessageStream(
        { message: 'hello' },
        'prompt-id-2',
        SceneType.CHAT_CONVERSATION,
      );
      // 消费完整个流以触发 recordHistory
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) { /* drain */ }

      const history = chat.getHistory();
      // user + reasoning(合并后) + text，共 3 条
      expect(history.length).toBe(3);
      expect(history[0].role).toBe('user');
      expect(history[1].role).toBe('model');
      expect((history[1].parts?.[0] as any).reasoning).toBe(
        'Let me think about this...',
      );
      expect(history[2].role).toBe('model');
      expect(history[2].parts?.[0]?.text).toBe('Final answer.');
    });
  });

  describe('recordHistory', () => {
    const userInput: Content = {
      role: 'user',
      parts: [{ text: 'User input' }],
    };

    it('should add user input and a single model output to history', () => {
      const modelOutput: Content[] = [
        { role: 'model', parts: [{ text: 'Model output' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutput);
      const history = chat.getHistory();
      expect(history).toEqual([userInput, modelOutput[0]]);
    });

    it('should consolidate adjacent model outputs', () => {
      const modelOutputParts: Content[] = [
        { role: 'model', parts: [{ text: 'Model part 1' }] },
        { role: 'model', parts: [{ text: 'Model part 2' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputParts);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([{ text: 'Model part 1Model part 2' }]);
    });

    it('should handle a mix of user and model roles in outputContents (though unusual)', () => {
      const mixedOutput: Content[] = [
        { role: 'model', parts: [{ text: 'Model 1' }] },
        { role: 'user', parts: [{ text: 'Unexpected User' }] }, // This should be pushed as is
        { role: 'model', parts: [{ text: 'Model 2' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, mixedOutput);
      const history = chat.getHistory();
      expect(history.length).toBe(4); // user, model1, user_unexpected, model2
      expect(history[0]).toEqual(userInput);
      expect(history[1]).toEqual(mixedOutput[0]);
      expect(history[2]).toEqual(mixedOutput[1]);
      expect(history[3]).toEqual(mixedOutput[2]);
    });

    it('should consolidate multiple adjacent model outputs correctly', () => {
      const modelOutputParts: Content[] = [
        { role: 'model', parts: [{ text: 'M1' }] },
        { role: 'model', parts: [{ text: 'M2' }] },
        { role: 'model', parts: [{ text: 'M3' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputParts);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[1].parts).toEqual([{ text: 'M1M2M3' }]);
    });

    it('should not consolidate if roles are different between model outputs', () => {
      const modelOutputParts: Content[] = [
        { role: 'model', parts: [{ text: 'M1' }] },
        { role: 'user', parts: [{ text: 'Interjecting User' }] },
        { role: 'model', parts: [{ text: 'M2' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputParts);
      const history = chat.getHistory();
      expect(history.length).toBe(4); // user, M1, Interjecting User, M2
      expect(history[1].parts).toEqual([{ text: 'M1' }]);
      expect(history[3].parts).toEqual([{ text: 'M2' }]);
    });

    it('should merge with last history entry if it is also a model output', () => {
      // @ts-expect-error Accessing private property for test setup
      chat.history = [
        userInput,
        { role: 'model', parts: [{ text: 'Initial Model Output' }] },
      ]; // Prime the history

      const newModelOutput: Content[] = [
        { role: 'model', parts: [{ text: 'New Model Part 1' }] },
        { role: 'model', parts: [{ text: 'New Model Part 2' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, newModelOutput); // userInput here is for the *next* turn, but history is already primed

      // Reset and set up a more realistic scenario for merging with existing history
      chat = new GeminiChat(mockConfig, mockModelsModule, config, []);
      const firstUserInput: Content = {
        role: 'user',
        parts: [{ text: 'First user input' }],
      };
      const firstModelOutput: Content[] = [
        { role: 'model', parts: [{ text: 'First model response' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(firstUserInput, firstModelOutput);

      const secondUserInput: Content = {
        role: 'user',
        parts: [{ text: 'Second user input' }],
      };
      const secondModelOutput: Content[] = [
        { role: 'model', parts: [{ text: 'Second model response part 1' }] },
        { role: 'model', parts: [{ text: 'Second model response part 2' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(secondUserInput, secondModelOutput);

      const finalHistory = chat.getHistory();
      expect(finalHistory.length).toBe(4); // user1, model1, user2, model2(consolidated)
      expect(finalHistory[0]).toEqual(firstUserInput);
      expect(finalHistory[1]).toEqual(firstModelOutput[0]);
      expect(finalHistory[2]).toEqual(secondUserInput);
      expect(finalHistory[3].role).toBe('model');
      expect(finalHistory[3].parts).toEqual([
        { text: 'Second model response part 1Second model response part 2' },
      ]);
    });

    it('should correctly merge consolidated new output with existing model history', () => {
      // Setup: history ends with a model turn
      const initialUser: Content = {
        role: 'user',
        parts: [{ text: 'Initial user query' }],
      };
      const initialModel: Content = {
        role: 'model',
        parts: [{ text: 'Initial model answer.' }],
      };
      chat = new GeminiChat(mockConfig, mockModelsModule, config, [
        initialUser,
        initialModel,
      ]);

      // New interaction
      const currentUserInput: Content = {
        role: 'user',
        parts: [{ text: 'Follow-up question' }],
      };
      const newModelParts: Content[] = [
        { role: 'model', parts: [{ text: 'Part A of new answer.' }] },
        { role: 'model', parts: [{ text: 'Part B of new answer.' }] },
      ];

      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(currentUserInput, newModelParts);
      const history = chat.getHistory();

      // Expected: initialUser, initialModel, currentUserInput, consolidatedNewModelParts
      expect(history.length).toBe(4);
      expect(history[0]).toEqual(initialUser);
      expect(history[1]).toEqual(initialModel);
      expect(history[2]).toEqual(currentUserInput);
      expect(history[3].role).toBe('model');
      expect(history[3].parts).toEqual([
        { text: 'Part A of new answer.Part B of new answer.' },
      ]);
    });

    it('should handle empty modelOutput array', () => {
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, []);
      const history = chat.getHistory();
      // If modelOutput is empty, it might push a default empty model part depending on isFunctionResponse
      // Assuming isFunctionResponse(userInput) is false for this simple text input
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([]);
    });

    it('should handle aggregating modelOutput', () => {
      const modelOutputUndefinedParts: Content[] = [
        { role: 'model', parts: [{ text: 'First model part' }] },
        { role: 'model', parts: [{ text: 'Second model part' }] },
        { role: 'model', parts: undefined as unknown as Part[] }, // Test undefined parts
        { role: 'model', parts: [{ text: 'Third model part' }] },
        { role: 'model', parts: [] }, // Test empty parts array
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputUndefinedParts);
      const history = chat.getHistory();
      expect(history.length).toBe(5);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([
        { text: 'First model partSecond model part' },
      ]);
      expect(history[2].role).toBe('model');
      expect(history[2].parts).toBeUndefined();
      expect(history[3].role).toBe('model');
      expect(history[3].parts).toEqual([{ text: 'Third model part' }]);
      expect(history[4].role).toBe('model');
      expect(history[4].parts).toEqual([]);
    });

    it('should handle modelOutput with parts being undefined or empty (if they pass initial every check)', () => {
      const modelOutputUndefinedParts: Content[] = [
        { role: 'model', parts: [{ text: 'Text part' }] },
        { role: 'model', parts: undefined as unknown as Part[] }, // Test undefined parts
        { role: 'model', parts: [] }, // Test empty parts array
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputUndefinedParts);
      const history = chat.getHistory();
      expect(history.length).toBe(4); // userInput, model1 (text), model2 (undefined parts), model3 (empty parts)
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([{ text: 'Text part' }]);
      expect(history[2].role).toBe('model');
      expect(history[2].parts).toBeUndefined();
      expect(history[3].role).toBe('model');
      expect(history[3].parts).toEqual([]);
    });

    it('should correctly handle automaticFunctionCallingHistory', () => {
      const afcHistory: Content[] = [
        { role: 'user', parts: [{ text: 'AFC User' }] },
        { role: 'model', parts: [{ text: 'AFC Model' }] },
      ];
      const modelOutput: Content[] = [
        { role: 'model', parts: [{ text: 'Regular Model Output' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutput, afcHistory);
      const history = chat.getHistory();
      expect(history.length).toBe(3);
      expect(history[0]).toEqual(afcHistory[0]);
      expect(history[1]).toEqual(afcHistory[1]);
      expect(history[2]).toEqual(modelOutput[0]);
    });

    it('should add userInput if AFC history is present but empty', () => {
      const modelOutput: Content[] = [
        { role: 'model', parts: [{ text: 'Model Output' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutput, []); // Empty AFC history
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1]).toEqual(modelOutput[0]);
    });

    it('should skip "thought" content from modelOutput', () => {
      const modelOutputWithThought: Content[] = [
        { role: 'model', parts: [{ thought: true }, { text: 'Visible text' }] },
        { role: 'model', parts: [{ text: 'Another visible text' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputWithThought);
      const history = chat.getHistory();
      expect(history.length).toBe(2); // User input + consolidated model output
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      // The 'thought' part is skipped, 'Another visible text' becomes the first part.
      expect(history[1].parts).toEqual([{ text: 'Another visible text' }]);
    });

    it('should skip "thought" content even if it is the only content', () => {
      const modelOutputOnlyThought: Content[] = [
        { role: 'model', parts: [{ thought: true }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputOnlyThought);
      const history = chat.getHistory();
      expect(history.length).toBe(1); // User input + default empty model part
      expect(history[0]).toEqual(userInput);
    });

    it('should correctly consolidate text parts when a thought part is in between', () => {
      const modelOutputMixed: Content[] = [
        { role: 'model', parts: [{ text: 'Part 1.' }] },
        {
          role: 'model',
          parts: [{ thought: true }, { text: 'Should be skipped' }],
        },
        { role: 'model', parts: [{ text: 'Part 2.' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputMixed);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([{ text: 'Part 1.Part 2.' }]);
    });

    it('should handle multiple thought parts correctly', () => {
      const modelOutputMultipleThoughts: Content[] = [
        { role: 'model', parts: [{ thought: true }] },
        { role: 'model', parts: [{ text: 'Visible 1' }] },
        { role: 'model', parts: [{ thought: true }] },
        { role: 'model', parts: [{ text: 'Visible 2' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputMultipleThoughts);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([{ text: 'Visible 1Visible 2' }]);
    });

    it('should handle thought part at the end of outputContents', () => {
      const modelOutputThoughtAtEnd: Content[] = [
        { role: 'model', parts: [{ text: 'Visible text' }] },
        { role: 'model', parts: [{ thought: true }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputThoughtAtEnd);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toEqual([{ text: 'Visible text' }]);
    });

    it('should merge consecutive function calls into a single message', () => {
      const userInput: Content = {
        role: 'user',
        parts: [{ text: 'User input requiring multiple tools' }],
      };
      const modelOutputWithMultipleFunctionCalls: Content[] = [
        {
          role: 'model',
          parts: [{ functionCall: { id: 'call1', name: 'read_file', args: { path: '/file1.txt' } } }]
        },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'call2', name: 'read_file', args: { path: '/file2.txt' } } }]
        },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'call3', name: 'write_file', args: { path: '/output.txt' } } }]
        },
      ];

      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutputWithMultipleFunctionCalls);
      const history = chat.getHistory();

      // Should have user input + one consolidated model message with all function calls
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userInput);
      expect(history[1].role).toBe('model');
      expect(history[1].parts).toHaveLength(3);
      expect(history[1].parts?.[0]?.functionCall?.id).toBe('call1');
      expect(history[1].parts?.[1]?.functionCall?.id).toBe('call2');
      expect(history[1].parts?.[2]?.functionCall?.id).toBe('call3');
    });

    it('should keep reasoning content in history (not filter it out)', () => {
      const modelOutput: Content[] = [
        { role: 'model', parts: [{ reasoning: 'thinking step 1' } as Part] },
        { role: 'model', parts: [{ text: 'final answer' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutput);
      const history = chat.getHistory();
      expect(history.length).toBe(3);
      expect(history[0]).toEqual(userInput);
      expect((history[1].parts?.[0] as any).reasoning).toBe('thinking step 1');
      expect(history[2].parts?.[0]?.text).toBe('final answer');
    });

    it('should not merge reasoning content with subsequent text content', () => {
      // reasoning 与紧随其后的 text 必须保持为独立的两条 model content，
      // 否则 OpenAI/DeepSeek 协议下无法正确还原 reasoning_content 字段。
      const modelOutput: Content[] = [
        { role: 'model', parts: [{ reasoning: 'inner thought' } as Part] },
        { role: 'model', parts: [{ text: 'visible answer' }] },
      ];
      // @ts-expect-error Accessing private method for testing purposes
      chat.recordHistory(userInput, modelOutput);
      const history = chat.getHistory();
      expect(history.length).toBe(3);
      // 第二条仍是 reasoning，没有被合并到 text 里
      expect((history[1].parts?.[0] as any).reasoning).toBe('inner thought');
      expect(history[1].parts?.[0]?.text).toBeUndefined();
      // 第三条是纯 text
      expect(history[2].parts?.[0]?.text).toBe('visible answer');
    });
  });

  describe('addHistory', () => {
    it('should add a new content item to the history', () => {
      const newContent: Content = {
        role: 'user',
        parts: [{ text: 'A new message' }],
      };
      chat.addHistory(newContent);
      const history = chat.getHistory();
      expect(history.length).toBe(1);
      expect(history[0]).toEqual(newContent);
    });

    it('should add multiple items correctly', () => {
      const content1: Content = {
        role: 'user',
        parts: [{ text: 'Message 1' }],
      };
      const content2: Content = {
        role: 'model',
        parts: [{ text: 'Message 2' }],
      };
      chat.addHistory(content1);
      chat.addHistory(content2);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(content1);
      expect(history[1]).toEqual(content2);
    });
  });

  describe('fixRequestContents - merge adjacent same-role messages', () => {
    /**
     * 通过 setHistory + sendMessage 间接验证 fixRequestContents 的行为：
     * setHistory(historyEndingWithUserFR) → sendMessage(textQuery) →
     * sendMessage 内部会把 textQuery 作为新 user 消息 concat 到 history 后面，
     * 形成 [..., user(fr), user(text)] 的相邻 user 序列，
     * fixRequestContents 应当把它们合并成一条 user 消息。
     */
    function makeStubResponse(): GenerateContentResponse {
      return {
        candidates: [
          {
            content: { parts: [{ text: 'ok' }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
            safetyRatings: [],
          },
        ],
        text: () => 'ok',
      } as unknown as GenerateContentResponse;
    }

    it('合并 user(functionResponse) + user(text) 为一条 user', async () => {
      vi.mocked(mockModelsModule.generateContent).mockResolvedValue(makeStubResponse());

      // 历史以 model(fc) → user(fr) 收尾，模拟"流被中断、tool_result 已落但下一轮 model 还没来得及说话"
      chat.setHistory([
        { role: 'user', parts: [{ text: 'do something' }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'fn', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'fn', response: { output: 'done' } } }] },
      ]);

      // 客户端流恢复逻辑会再发一条 user(text)（即"continue"消息）
      await chat.sendMessage(
        { message: '[System] continue from where you left off' },
        'prompt-continue',
        SceneType.CHAT_CONVERSATION,
      );

      // 拿到实际传给 contentGenerator 的 contents
      const args = vi.mocked(mockModelsModule.generateContent).mock.calls[0][0] as {
        contents: Content[];
      };

      // user(fr) 和 user(text) 应被合并成一条 user，parts = [fr, text]
      const last = args.contents[args.contents.length - 1];
      expect(last.role).toBe('user');
      expect(last.parts).toHaveLength(2);
      expect(last.parts?.[0]?.functionResponse?.id).toBe('call_1');
      expect(last.parts?.[1]?.text).toBe('[System] continue from where you left off');

      // 合并后整体不应再出现 [user, user] 相邻
      for (let i = 1; i < args.contents.length; i++) {
        expect(args.contents[i].role).not.toBe(args.contents[i - 1].role);
      }
    });

    it('合并三条连续 user 消息（fr + text + text）', async () => {
      vi.mocked(mockModelsModule.generateContent).mockResolvedValue(makeStubResponse());

      chat.setHistory([
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ functionCall: { id: 'c2', name: 'fn', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'c2', name: 'fn', response: { output: 'r' } } }] },
        // 客户端额外注入的相邻 user 消息（极端情况，模拟连续中断）
        { role: 'user', parts: [{ text: 'first injected' }] },
      ]);

      await chat.sendMessage(
        { message: 'second injected' },
        'prompt-multi',
        SceneType.CHAT_CONVERSATION,
      );

      const args = vi.mocked(mockModelsModule.generateContent).mock.calls[0][0] as {
        contents: Content[];
      };
      const last = args.contents[args.contents.length - 1];
      expect(last.role).toBe('user');
      // 三条 user 合并：fr + 'first injected' + 'second injected' = 3 个 part
      expect(last.parts).toHaveLength(3);
      expect(last.parts?.[0]?.functionResponse?.id).toBe('c2');
      expect(last.parts?.[1]?.text).toBe('first injected');
      expect(last.parts?.[2]?.text).toBe('second injected');
    });

    it('保留中间不同 role 的消息不变（user → model → user 不合并）', async () => {
      vi.mocked(mockModelsModule.generateContent).mockResolvedValue(makeStubResponse());

      chat.setHistory([
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'reply' }] },
      ]);
      await chat.sendMessage(
        { message: 'second' },
        'prompt-noop',
        SceneType.CHAT_CONVERSATION,
      );

      const args = vi.mocked(mockModelsModule.generateContent).mock.calls[0][0] as {
        contents: Content[];
      };
      // 顺序应保持 user → model → user，不合并
      expect(args.contents.length).toBe(3);
      expect(args.contents[0].role).toBe('user');
      expect(args.contents[1].role).toBe('model');
      expect(args.contents[2].role).toBe('user');
      expect(args.contents[2].parts?.[0]?.text).toBe('second');
    });

    it('不影响原 history（仅修改请求时的副本）', async () => {
      vi.mocked(mockModelsModule.generateContent).mockResolvedValue(makeStubResponse());

      const original: Content[] = [
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ functionCall: { id: 'c3', name: 'fn', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'c3', name: 'fn', response: { output: 'r' } } }] },
      ];
      chat.setHistory(original);

      await chat.sendMessage(
        { message: 'continue' },
        'prompt-history-untouched',
        SceneType.CHAT_CONVERSATION,
      );

      // history 不应被合并影响（addHistory 在 sendMessage 内部会单独执行，
      // 但应保持 model + 单条 user(fr) 的原结构 + 新的 user(text) 独立追加）
      const finalHistory = chat.getHistory(/* curated */ true);
      // 结构上，最后一条 user(fr) 和后续追加的 user(text) 仍应在 history 里独立保存
      // （我们只在请求层合并，history 层保持原貌，留给后续逻辑做更精细处理）
      const userFrInHistory = finalHistory.find(
        (c) => c.role === 'user' && c.parts?.some((p) => p.functionResponse?.id === 'c3'),
      );
      expect(userFrInHistory).toBeDefined();
      // user(fr) 这条 history 项仍应只含 functionResponse，不应被合并
      expect(userFrInHistory?.parts?.length).toBe(1);
    });
  });
});

// ─── filterToolsByMessage (per-request workflow gate) ────────────────────────

describe('filterToolsByMessage (workflow gate)', () => {
  const workflowDecl = { name: 'workflow', description: 'workflow tool' };
  const otherDecl = { name: 'shell', description: 'shell tool' };
  const toolsWithWorkflow = [{ functionDeclarations: [workflowDecl, otherDecl] }];

  let chatWithTools: GeminiChat;
  let mockConfig: Config;

  function makeStreamResponse() {
    return (async function* () {
      yield {
        candidates: [{
          content: { parts: [{ text: 'ok' }], role: 'model' },
          finishReason: 'STOP',
          index: 0,
        }],
        text: () => 'ok',
      } as unknown as GenerateContentResponse;
    })();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryLogPromptsEnabled: () => false,
      getUsageStatisticsEnabled: () => false,
      getDebugMode: () => false,
      getContentGeneratorConfig: () => ({ authType: 'oauth-personal', model: 'test-model' }),
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      setModel: vi.fn(),
      getQuotaErrorOccurred: vi.fn().mockReturnValue(false),
      setQuotaErrorOccurred: vi.fn(),
      flashFallbackHandler: undefined,
    } as unknown as Config;
    chatWithTools = new GeminiChat(
      mockConfig,
      mockModelsModule,
      { tools: toolsWithWorkflow } as GenerateContentConfig,
      [],
    );
    vi.mocked(mockModelsModule.generateContentStream).mockResolvedValue(makeStreamResponse());
  });

  it('filters out workflow tool when message has no trigger word', async () => {
    await chatWithTools.sendMessageStream(
      { message: 'please help me refactor this large codebase' },
      'p1',
      SceneType.CHAT_CONVERSATION,
    );

    const callArg = vi.mocked(mockModelsModule.generateContentStream).mock.calls[0][0];
    const decls = (callArg.config?.tools as any[])?.[0]?.functionDeclarations ?? [];
    expect(decls.map((d: any) => d.name)).not.toContain('workflow');
    expect(decls.map((d: any) => d.name)).toContain('shell');
  });

  it('keeps workflow tool when message contains trigger word "workflow"', async () => {
    await chatWithTools.sendMessageStream(
      { message: 'workflow analyze all packages in parallel' },
      'p2',
      SceneType.CHAT_CONVERSATION,
    );

    const callArg = vi.mocked(mockModelsModule.generateContentStream).mock.calls[0][0];
    const decls = (callArg.config?.tools as any[])?.[0]?.functionDeclarations ?? [];
    expect(decls.map((d: any) => d.name)).toContain('workflow');
  });

  it('trigger word match is case-insensitive (WORKFLOW, Workflow)', async () => {
    for (const word of ['WORKFLOW', 'Workflow', 'WorkFlow']) {
      vi.mocked(mockModelsModule.generateContentStream).mockResolvedValue(makeStreamResponse());
      await chatWithTools.sendMessageStream(
        { message: `${word} do something` },
        'p3',
        SceneType.CHAT_CONVERSATION,
      );
      const callArg = vi.mocked(mockModelsModule.generateContentStream).mock.calls.at(-1)![0];
      const decls = (callArg.config?.tools as any[])?.[0]?.functionDeclarations ?? [];
      expect(decls.map((d: any) => d.name)).toContain('workflow');
    }
  });

  it('does not crash when tools is undefined', async () => {
    const chatNoTools = new GeminiChat(mockConfig, mockModelsModule, {}, []);
    vi.mocked(mockModelsModule.generateContentStream).mockResolvedValue(makeStreamResponse());
    await expect(
      chatNoTools.sendMessageStream({ message: 'hello' }, 'p4', SceneType.CHAT_CONVERSATION),
    ).resolves.toBeDefined();
  });

  it('/goal prompt (no workflow word) does not expose workflow tool', async () => {
    const goalPrompt = '你是一个长程任务执行助手。任务：重构整个代码库。请并行分析所有模块。';
    await chatWithTools.sendMessageStream(
      { message: goalPrompt },
      'p5',
      SceneType.CHAT_CONVERSATION,
    );

    const callArg = vi.mocked(mockModelsModule.generateContentStream).mock.calls[0][0];
    const decls = (callArg.config?.tools as any[])?.[0]?.functionDeclarations ?? [];
    expect(decls.map((d: any) => d.name)).not.toContain('workflow');
  });
});
