/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Multi-Channel Gateway.
 *
 * 诚实边界（重要）：
 *   除飞书外的渠道（微信 / 企业微信 / 钉钉）**尚未真正接通**——本文件不含任何
 *   真实的鉴权、Webhook 注册或消息投递逻辑。因此这些渠道的 connect/broadcast
 *   一律返回「未实现 / 未送达」，绝不谎报成功。
 *
 *   飞书本身也不在本网关内直接发送：真正的飞书收发走独立的飞书网关 / daemon
 *   （见 cli 的 feishuDaemon）。本文件对飞书同样不声称「已群发」。
 *
 *   之所以保留这层壳，是为了在真正接入前，给调用方（Agent / 工具）一个统一的
 *   入口，并让它们拿到「没发出去」的真话，而不是假的「已送达」。
 */

export type ChannelType = 'wechat' | 'wecom' | 'dingtalk' | 'feishu';

/** 尚未真正实现收发的渠道；对它们的 connect/broadcast 一律 fail-loud。 */
const UNIMPLEMENTED_CHANNELS: readonly ChannelType[] = [
  'wechat',
  'wecom',
  'dingtalk',
];

const CHANNEL_LABEL: Record<ChannelType, string> = {
  wechat: '微信',
  wecom: '企业微信',
  dingtalk: '钉钉',
  feishu: '飞书',
};

export interface ChannelMessage {
  id: string;
  channel: ChannelType;
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
}

export interface ChannelCredentials {
  appId: string;
  appSecret: string;
  token?: string;
  encodingAesKey?: string;
  agentId?: string; // WeCom specific
}

export class MultiChannelGateway {
  /**
   * 判断某渠道当前是否有真实收发能力。
   * 目前恒为 false（含飞书——飞书走独立网关，不在本文件内发送）。
   * 真接入某渠道后，在此返回其真实连接状态即可。
   */
  isChannelReady(channel: ChannelType): boolean {
    void channel;
    return false;
  }

  /**
   * 尝试连接一个渠道。
   *
   * 诚实实现：微信 / 企业微信 / 钉钉尚无真实鉴权逻辑，一律返回 success:false，
   * message 明说未实现；飞书不在本网关内直连，引导走飞书网关。
   */
  async connectChannel(
    channel: ChannelType,
    _creds: ChannelCredentials,
  ): Promise<{ success: boolean; message: string }> {
    const label = CHANNEL_LABEL[channel] ?? channel;

    if (channel === 'feishu') {
      return {
        success: false,
        message:
          '飞书不在 multi_channel 网关内直连：请通过独立的飞书网关 / daemon（otto feishu daemon start）接入，本工具不代为连接。',
      };
    }

    if (UNIMPLEMENTED_CHANNELS.includes(channel)) {
      return {
        success: false,
        message: `${label}（${channel}）渠道尚未实现：暂无真实鉴权与消息通道，拒绝谎报已连接。待接入后此处才会返回成功。`,
      };
    }

    return { success: false, message: `不支持的渠道：${channel}` };
  }

  /**
   * 广播消息 / 进度更新。
   *
   * 诚实实现：没有任何渠道具备真实投递能力，故所有渠道一律返回 false（未送达）。
   * 调用方据此可如实告知「消息没有发出去」，绝不假报送达。
   */
  async broadcastUpdate(
    title: string,
    _body: string,
    _fileUrl?: string,
  ): Promise<Record<ChannelType, boolean>> {
    void title;
    // 每个渠道都未真正实现投递 → 一律 false。
    return {
      feishu: false,
      wecom: false,
      dingtalk: false,
      wechat: false,
    };
  }
}
