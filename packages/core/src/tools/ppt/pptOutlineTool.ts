/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { BaseTool, Icon, ToolResult, ToolLocation } from '../tools.js';
import { Type } from '@google/genai';
import { Config } from '../../config/config.js';
import { PPTOutlineManager } from './pptOutlineManager.js';

export type PptOutlineAction = 'init' | 'update' | 'view' | 'clear';

export interface PptOutlineToolParams {
  /** 操作类型 */
  action: PptOutlineAction;
  /** PPT主题 */
  topic?: string;
  /** 预计页数 */
  page_count?: number;
  /** 大纲内容 */
  outline?: string;
}

/**
 * PPT大纲管理工具
 * 支持初始化、更新、查看、清除操作
 */
export class PptOutlineTool extends BaseTool<PptOutlineToolParams, ToolResult> {
  static readonly Name = 'ppt_outline';

  constructor(_config: Config) {
    super(
      PptOutlineTool.Name,
      'PPT大纲管理',
      `管理PPT大纲内容。支持以下操作：
- init: 初始化PPT编辑模式，开始创建新PPT
- update: 更新大纲内容（主题、页数、大纲文本）
- view: 查看当前大纲状态
- clear: 清除当前大纲并退出PPT模式

在用户与AI交互过程中，通过此工具不断迭代优化大纲内容。
outline 可用于保存故事板；若用户明确优先速度，快速兜底内容应使用逐页 Markdown，每页用 <!-- layout: cover|statement|split|timeline|quote|list|section|visual --> 指定版式，并使用独占一行的 --- 分隔。
高审美任务必须先加载 ppt-creator 并走自定义 HTML/CSS/SVG 画布；ppt_generate 只用于用户明确接受模板化快速兜底时。`,
      Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: '操作类型: init(初始化), update(更新), view(查看), clear(清除)',
            enum: ['init', 'update', 'view', 'clear'],
          },
          topic: {
            type: Type.STRING,
            description: 'PPT主题标题',
          },
          page_count: {
            type: Type.NUMBER,
            description: '预计PPT页数（1-100）',
          },
          outline: {
            type: Type.STRING,
            description: '故事板或快速兜底用的逐页 Markdown；高审美任务应按 ppt-creator 生成自定义视觉画布',
          },
        },
        required: ['action'],
      },
      true, // isOutputMarkdown
      true, // forceMarkdown
    );
  }

  validateToolParams(params: PptOutlineToolParams): string | null {
    const validActions: PptOutlineAction[] = ['init', 'update', 'view', 'clear'];
    if (!validActions.includes(params.action)) {
      return `无效的action: ${params.action}，必须是 ${validActions.join(', ')} 之一`;
    }

    if (params.page_count !== undefined) {
      if (!Number.isInteger(params.page_count) || params.page_count < 1 || params.page_count > 100) {
        return 'page_count 必须是 1-100 之间的整数';
      }
    }

    return null;
  }

  getDescription(params: PptOutlineToolParams): string {
    const actionDesc: Record<PptOutlineAction, string> = {
      init: '初始化PPT大纲模式',
      update: '更新PPT大纲',
      view: '查看当前PPT大纲',
      clear: '清除并退出PPT模式',
    };
    return actionDesc[params.action] || 'PPT大纲操作';
  }

  toolLocations(_params: PptOutlineToolParams): ToolLocation[] {
    return [];
  }

  async execute(params: PptOutlineToolParams, _signal: AbortSignal): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `❌ 参数错误: ${validationError}`,
        returnDisplay: `❌ ${validationError}`,
      };
    }

    const manager = PPTOutlineManager.getInstance();

    switch (params.action) {
      case 'init': {
        // 初始化PPT模式
        manager.init(params.topic);

        // 如果提供了其他参数，也一并更新
        if (params.page_count !== undefined || params.outline !== undefined) {
          manager.update({
            pageCount: params.page_count,
            outline: params.outline,
          });
        }

        const preview = manager.formatPreview();
        const fullOutput = `✅ PPT编辑模式已激活

${preview}

💡 提示：
- 使用 ppt_outline action=update 来迭代修改大纲
- 使用 ppt_outline action=view 来查看当前大纲
- 每页之间使用独占一行的 --- 分隔
- 高审美任务加载 ppt-creator 并走自定义视觉画布
- 只有用户明确优先速度时，才使用 ppt_generate 快速兜底`;

        return {
          llmContent: fullOutput,
          returnDisplay: fullOutput,
        };
      }

      case 'update': {
        if (!manager.isActive()) {
          const errorOutput = `❌ PPT模式未激活

请先使用 ppt_outline action=init 初始化PPT编辑模式。

示例：
\`\`\`
ppt_outline(action="init", topic="我的PPT主题")
\`\`\``;
          return {
            llmContent: errorOutput,
            returnDisplay: errorOutput,
          };
        }

        try {
          manager.update({
            topic: params.topic,
            pageCount: params.page_count,
            outline: params.outline,
          });

          const updateOutput = `✏️ 大纲已更新

${manager.formatPreview()}`;

          return {
            llmContent: updateOutput,
            returnDisplay: updateOutput,
          };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            llmContent: `❌ 更新失败: ${errorMsg}`,
            returnDisplay: `❌ 更新失败: ${errorMsg}`,
          };
        }
      }

      case 'view': {
        const preview = manager.formatPreview();

        return {
          llmContent: preview,
          returnDisplay: preview,
        };
      }

      case 'clear': {
        const wasActive = manager.isActive();
        const topic = manager.getState().topic;
        manager.clear();

        const clearOutput = wasActive
          ? `✅ PPT模式已退出，大纲已清除

之前的主题: ${topic || '(未设置)'}`
          : '✅ PPT模式本来就未激活';

        return {
          llmContent: clearOutput,
          returnDisplay: clearOutput,
        };
      }

      default:
        return {
          llmContent: `❌ 未知操作: ${params.action}`,
          returnDisplay: '❌ 未知操作',
        };
    }
  }
}
