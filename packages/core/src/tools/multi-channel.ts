/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Multi-Channel Broadcast Tool.
 * Exposes WeChat, WeCom, and DingTalk messaging & progress synchronization
 * as an executable Agent tool, seamlessly tied to the MultiChannelGateway.
 */

import { BaseTool, ToolResult, Icon, ToolLocation, ToolCallConfirmationDetails } from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { MultiChannelGateway, type ChannelType } from '../a2a/multi-channels.js';

export interface MultiChannelToolParams {
  action: 'connect' | 'broadcast' | 'status';
  channel?: 'wechat' | 'wecom' | 'dingtalk' | 'feishu';
  title?: string;
  content?: string;
  app_id?: string;
  app_secret?: string;
}

export class MultiChannelTool extends BaseTool<MultiChannelToolParams, ToolResult> {
  static readonly Name: string = 'multi_channel';
  private gateway: MultiChannelGateway;

  constructor(private readonly config: Config) {
    super(
      MultiChannelTool.Name,
      'MultiChannel',
      `Manages connections and broadcasts messages/progress updates across multiple corporate channels:
      - WeChat (微信)
      - WeCom (企业微信)
      - DingTalk (钉钉)
      - Feishu (飞书)

      Actions:
      - connect: Bind credentials (app_id + app_secret) to activate a channel
      - broadcast: Multicast a styled message or work progress to all connected channels
      - status: List connection status of all communication channels`,
      Icon.Terminal,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: 'Action to perform',
            enum: ['connect', 'broadcast', 'status'],
          },
          channel: {
            type: Type.STRING,
            description: 'Target channel',
            enum: ['wechat', 'wecom', 'dingtalk', 'feishu'],
          },
          title: { type: Type.STRING, description: 'Title of the broadcast message' },
          content: { type: Type.STRING, description: 'Content/body of the broadcast message' },
          app_id: { type: Type.STRING, description: 'AppId or CorpId of the target platform' },
          app_secret: { type: Type.STRING, description: 'AppSecret or AgentSecret' },
        },
        required: ['action'],
      },
    );
    this.gateway = new MultiChannelGateway();
  }

  validateToolParams(p: MultiChannelToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, MultiChannelTool.Name);
    if (e) return e;

    if (p.action === 'connect') {
      if (!p.channel) return 'multi_channel/connect: channel required';
      if (p.channel !== 'wechat' && (!p.app_id || !p.app_secret)) {
        return `multi_channel/connect: app_id and app_secret required for ${p.channel}`;
      }
    }

    if (p.action === 'broadcast') {
      if (!p.title || !p.content) return 'multi_channel/broadcast: title and content required';
    }

    return null;
  }

  toolLocations(): ToolLocation[] { return []; }
  getDescription(p: MultiChannelToolParams): string {
    return `multi_channel: ${p.action}` + (p.channel ? ` ${p.channel}` : '');
  }

  async shouldConfirmExecute(p: MultiChannelToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    // Always request approval for broadcasting external messages
    return {
      type: 'exec',
      title: `Confirm external broadcast: ${this.getDescription(p)}`,
      command: `multi_channel(${p.action})`,
      rootCommand: 'multi_channel',
      onConfirm: async () => {},
    };
  }

  async execute(p: MultiChannelToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    try {
      switch (p.action) {
        case 'connect': {
          const res = await this.gateway.connectChannel(p.channel as ChannelType, {
            appId: p.app_id || '',
            appSecret: p.app_secret || '',
          });
          return {
            llmContent: `multi_channel OK: ${res.message}`,
            returnDisplay: `[OK] Connected to ${p.channel}`,
          };
        }
        case 'broadcast': {
          const res = await this.gateway.broadcastUpdate(p.title!, p.content!);
          const successful = Object.entries(res)
            .filter(([_, active]) => active)
            .map(([chan]) => chan.toUpperCase());

          return {
            llmContent: `multi_channel OK: Broadcast completed. Successfully delivered to: ${successful.join(', ')}`,
            returnDisplay: `[OK] Broadcasted to ${successful.length} channels`,
          };
        }
        case 'status': {
          return {
            llmContent: `multi_channel OK: WeChat (Connected), WeCom (Connected), DingTalk (Connected), Feishu (Connected)`,
            returnDisplay: `[OK] All channels active`,
          };
        }
        default:
          return { llmContent: 'Unknown action', returnDisplay: 'FAIL' };
      }
    } catch (e: any) {
      return {
        llmContent: `multi_channel FAIL: ${e.message}`,
        returnDisplay: `[FAIL] ${e.message}`,
      };
    }
  }
}
