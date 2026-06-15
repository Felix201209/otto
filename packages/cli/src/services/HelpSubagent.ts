/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, SceneType } from 'otto-core';

// 扩展 globalThis 类型以支持 esbuild banner 注入的变量
declare global {
  var __dirname: string;
  var __filename: string;
}

/**
 * HelpSubagent - 智能帮助系统（无状态消息处理器）
 *
 * 这是一个独立的 AI 助手，用于回答 CLI 功能相关的问题。
 * - 使用固定的 Auto 模型（gemini-2.0-flash-thinking-exp-1219）
 * - 基于内置知识库回答问题
 * - 不污染主会话的上下文
 * - 无状态设计，每次调用独立处理
 */
export class HelpSubagent {
  private static knowledgeBase: string | null = null;

  /**
   * 加载知识库（单例模式，只加载一次）
   */
  private static loadKnowledgeBase(): string {
    if (HelpSubagent.knowledgeBase) {
      return HelpSubagent.knowledgeBase;
    }

    try {
      // 获取当前模块所在目录（打包后是 bundle/otto.js）
      // esbuild 的 banner 会设置 globalThis.__dirname 为 otto.js 所在目录
      const bundleDir = typeof globalThis.__dirname !== 'undefined'
        ? globalThis.__dirname
        : dirname(fileURLToPath(import.meta.url));

      // 尝试多个可能的路径
      const possiblePaths = [
        // 打包后：bundle/assets/help/cli-help-knowledge.md
        join(bundleDir, 'assets/help/cli-help-knowledge.md'),

        // 开发环境路径（从 packages/cli/src/services/ 到 packages/cli/src/assets/help/）
        join(dirname(fileURLToPath(import.meta.url)), '../assets/help/cli-help-knowledge.md'),
        join(dirname(fileURLToPath(import.meta.url)), '../../assets/help/cli-help-knowledge.md'),

        // npm 全局安装时的路径
        join(process.cwd(), 'assets/help/cli-help-knowledge.md'),
      ];

      for (const helpFilePath of possiblePaths) {
        if (readFileSync && helpFilePath) {
          try {
            const content = readFileSync(helpFilePath, 'utf-8');
            if (content && content.length > 100) {
              console.debug(`✅ Loaded help knowledge base from: ${helpFilePath}`);
              HelpSubagent.knowledgeBase = content;
              return content;
            }
          } catch {
            // 尝试下一个路径
            continue;
          }
        }
      }

      // 调试：输出所有尝试的路径
      console.error('❌ Failed to find knowledge base. Tried paths:');
      possiblePaths.forEach(p => console.error(`   - ${p}`));
      console.error(`   bundleDir (globalThis.__dirname): ${bundleDir}`);
      console.error(`   process.cwd(): ${process.cwd()}`);

      throw new Error('Knowledge base file not found in any expected location');
    } catch (error) {
      console.error('Failed to load help knowledge base:', error);
      const fallback = '# Help System\n\nKnowledge base not available. Please check installation.';
      HelpSubagent.knowledgeBase = fallback;
      return fallback;
    }
  }

  /**
   * 检测用户语言偏好
   */
  private static detectLanguage(): 'zh' | 'en' {
    // 简单检测：如果环境变量或系统语言是中文，使用中文
    const lang = process.env.LANG || process.env.LANGUAGE || '';
    return lang.includes('zh') || lang.includes('CN') ? 'zh' : 'en';
  }

  /**
   * 构建系统提示词
   */
  private static getSystemPrompt(): string {
    const knowledgeBase = HelpSubagent.loadKnowledgeBase();
    const lang = HelpSubagent.detectLanguage();

    if (lang === 'zh') {
      return `你是 Otto CLI 的智能帮助助手。

你的知识库包含了所有 CLI 命令和功能的详细信息。请根据以下知识库内容回答用户的问题：

${knowledgeBase}

回答要求：
1. **重要：始终使用用户提问时的语言来回答** - 如果用户用中文问，就用中文答；如果用英文问，就用英文答
2. 简洁明确，直接给出答案和示例
3. 如果用户问"如何做某事"，给出具体命令和步骤
4. 提及相关的命令或功能
5. 如果问题不在知识库范围内，礼貌地说明并建议查看在线文档
6. 使用 Markdown 格式使答案更易读

请直接回答用户的问题。`;
    } else {
      return `You are the intelligent help assistant for Otto CLI.

Your knowledge base contains detailed information about all CLI commands and features. Please answer user questions based on the following knowledge base:

${knowledgeBase}

Answer requirements:
1. **IMPORTANT: Always respond in the same language as the user's question** - If the user asks in Chinese, respond in Chinese; if in English, respond in English
2. Be concise and clear, provide direct answers with examples
3. If the user asks "how to do something", give specific commands and steps
4. Mention related commands or features
5. If the question is outside the knowledge base, politely explain and suggest checking online documentation
6. Use Markdown format to make answers more readable

Please answer the user's question directly.`;
    }
  }

  /**
   * 获取欢迎消息
   */
  static getWelcomeMessage(): string {
    const lang = HelpSubagent.detectLanguage();

    if (lang === 'zh') {
      return '💡 **Otto AI 智能帮助助手**\n\n我可以回答任何关于 CLI 功能和命令的问题！请问你需要什么帮助？\n\n_提示：按 Esc 键退出 • 此功能会消耗 token • 如只需查看命令列表，请使用 /help_';
    } else {
      return '💡 **Otto AI Help Assistant**\n\nI can answer any questions about CLI features and commands! What help do you need?\n\n_Tip: Press Esc to exit • Uses tokens • For command list, use /help instead_';
    }
  }

  /**
   * 处理用户问题并返回AI回答
   *
   * @param userQuestion 用户的问题
   * @param config Config 对象
   * @returns AI 的回答
   */
  static async answerQuestion(
    userQuestion: string,
    config: Config,
  ): Promise<string> {
    // 获取 Gemini Client
    const geminiClient = config.getGeminiClient();
    if (!geminiClient) {
      throw new Error('Gemini client not available');
    }

    // 构建完整的 prompt（包含系统提示和用户问题）
    const systemPrompt = HelpSubagent.getSystemPrompt();
    const fullPrompt = `${systemPrompt}\n\n用户问题：${userQuestion}`;

    // 使用 generateContent 方法
    const contentGenerator = geminiClient.getContentGenerator();

    // 使用 'auto' 模型（由服务端决定实际使用的模型）
    const response = await contentGenerator.generateContent(
      {
        model: 'auto', // 使用 auto，让服务端决定
        contents: [
          {
            role: 'user',
            parts: [{ text: fullPrompt }],
          },
        ],
        config: {
          maxOutputTokens: 2048,
        },
      },
      SceneType.SUB_AGENT // 使用 SUB_AGENT 场景
    );

    // 提取响应文本
    let responseText = '';
    if (response.text) {
      responseText = response.text;
    } else if (response.candidates && response.candidates[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;
      responseText = parts.map((p: any) => p.text || '').join('');
    }

    if (!responseText) {
      throw new Error('No response from model');
    }

    return responseText;
  }
}