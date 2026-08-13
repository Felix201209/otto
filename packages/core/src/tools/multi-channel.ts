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
  agent_id?: string;
  target_users?: string;
  target_tags?: string;
  target_parties?: string;
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
          agent_id: { type: Type.STRING, description: 'WeCom AgentId or DingTalk robotCode' },
          target_users: { type: Type.STRING, description: 'Target user IDs' },
          target_tags: { type: Type.STRING, description: 'WeCom target tag IDs' },
          target_parties: { type: Type.STRING, description: 'WeCom target department IDs' },
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
            agentId: p.agent_id,
            targetUsers: p.target_users,
            targetTags: p.target_tags,
            targetParties: p.target_parties,
          });
          // 诚实：连接失败（含「未实现」）不许包装成 OK。
          if (!res.success) {
            return {
              llmContent: `multi_channel FAIL: ${res.message}`,
              returnDisplay: `[FAIL] ${p.channel}: ${res.message}`,
            };
          }
          return {
            llmContent: `multi_channel OK: ${res.message}`,
            returnDisplay: `[OK] Connected to ${p.channel}`,
          };
        }
        case 'broadcast': {
          const res = await this.gateway.broadcastUpdate(p.title!, p.content!);
          const delivered = Object.entries(res)
            .filter(([, ok]) => ok)
            .map(([chan]) => chan.toUpperCase());

          // 一个渠道都没真正送达 → 明确报「未发送」，不谎报已群发。
          if (delivered.length === 0) {
            const msg =
              '消息未发送：没有已配置且成功投递的企业微信/钉钉渠道；个人微信未接入，飞书请走独立飞书网关。' +
              '本工具不会假报送达。';
            return {
              llmContent: `multi_channel FAIL: ${msg}`,
              returnDisplay: `[FAIL] 未送达任何渠道`,
            };
          }

          return {
            llmContent: `multi_channel OK: 已送达以下渠道：${delivered.join(', ')}`,
            returnDisplay: `[OK] Broadcasted to ${delivered.length} channels`,
          };
        }
        case 'status': {
          // 诚实：如实反映每个渠道是否真的接通，不再硬编码「全部已连接」。
          const channels: ChannelType[] = ['wechat', 'wecom', 'dingtalk', 'feishu'];
          const lines = channels.map((c) => {
            if (c === 'feishu') {
              return 'Feishu (飞书): 未在本工具内接通，请走独立飞书网关 (otto feishu daemon)';
            }
            return this.gateway.isChannelReady(c)
              ? `${c}: Connected`
              : `${c}: 未接通（尚未实现）`;
          });
          return {
            llmContent: `multi_channel status:\n${lines.join('\n')}`,
            returnDisplay: `[INFO] 无渠道真实接通（微信/企微/钉钉未实现，飞书走独立网关）`,
          };
        }
        default:
          return { llmContent: 'Unknown action', returnDisplay: 'FAIL' };
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return {
        llmContent: `multi_channel FAIL: ${m}`,
        returnDisplay: `[FAIL] ${m}`,
      };
    }
  }
}
