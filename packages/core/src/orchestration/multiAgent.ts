/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Multi-Agent Collaboration — 多 Otto 协作网络。
 *
 * 当每个员工飞书里都有自己的 Otto 时，Otto 之间可以互相协作：
 * - 小王的 Otto 需要查老张的日历 → 直接问老张的 Otto
 * - 不需要人与人之间的协调，AI 之间自动完成
 *
 * 基于 CrewAI 的角色驱动模型设计，但适配 Otto 的飞书场景。
 */

import type { Config } from '../config/config.js';

/** 协作角色 */
export type CollaborationRole = 'initiator' | 'coordinator' | 'executor' | 'reviewer';

/** 飞书消息发送器接口（由 CLI 的 gateway 注入） */
export interface FeishuMessageSender {
  /** 给指定用户发单聊消息 */
  sendMessageToUser(openId: string, text: string): Promise<void>;
  /** 给指定群发消息 */
  sendMessageToChat(chatId: string, text: string): Promise<void>;
}

/** 协作请求 */
export interface CollaborationRequest {
  id: string;
  fromUserId: string;
  fromAgentId: string;
  fromUserName: string;
  toUserId: string;
  toAgentId: string;
  toUserName: string;
  role: CollaborationRole;
  task: string;
  context?: string;
  deadline?: string;
  priority: 'low' | 'medium' | 'high';
}

/** 协作响应 */
export interface CollaborationResponse {
  requestId: string;
  fromAgentId: string;
  accepted: boolean;
  result?: string;
  data?: Record<string, unknown>;
  message?: string;
  timestamp: string;
}

/** Agent 注册信息 */
export interface AgentRegistration {
  agentId: string;
  userId: string;
  userName: string;
  department: string;
  capabilities: string[]; // 该 Otto 能做什么
  endpoint?: string; // 可达的 HTTP/WS 端点
  status: 'online' | 'busy' | 'offline';
  lastSeen: string;
  /** 飞书 open_id（用于通过飞书消息发送协作请求） */
  feishuOpenId?: string;
  /** 飞书 chat_id（如果 Otto 在某个群里） */
  feishuChatId?: string;
}

/**
 * 多 Agent 协作管理器。
 *
 * 设计：
 * - 每个 Otto 实例注册自己的能力（能操作飞书日历/文档/任务等）
 * - 需要协作时，通过中央注册表找到目标 Otto
 * - 发送协作请求，目标 Otto 响应
 * - 全程通过飞书消息流可见（人在飞书里看到 AI 之间的对话）
 */
export class MultiAgentCollaboration {
  private agents = new Map<string, AgentRegistration>();
  private pendingRequests = new Map<string, CollaborationRequest>();
  private feishuSender: FeishuMessageSender | null = null;

  /** 注入飞书消息发送器（由 CLI gateway 初始化时注入） */
  setFeishuSender(sender: FeishuMessageSender): void {
    this.feishuSender = sender;
    console.log('[MultiAgent] Feishu message sender injected');
  }

  /**
   * 注册当前 Otto 实例。
   */
  register(reg: Omit<AgentRegistration, 'lastSeen' | 'status'>): void {
    const full: AgentRegistration = {
      ...reg,
      status: 'online',
      lastSeen: new Date().toISOString(),
    };
    this.agents.set(reg.agentId, full);
    console.log(`[MultiAgent] Registered: ${reg.userName} (${reg.agentId})`);
  }

  /**
   * 更新 Agent 状态。
   */
  updateStatus(agentId: string, status: AgentRegistration['status']): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.lastSeen = new Date().toISOString();
    }
  }

  /**
   * 查找能执行某项任务的 Agent。
   */
  findCapableAgents(capability: string): AgentRegistration[] {
    return Array.from(this.agents.values()).filter(
      a => a.capabilities.includes(capability) && a.status !== 'offline'
    );
  }

  /**
   * 发起协作请求。
   *
   * 实际通信路径：
   * 1. 如果目标 Otto 有 HTTP 端点 → 直接 HTTP 调用
   * 2. 如果没有 → 通过飞书消息发送（目标 Otto 在飞书里收到并处理）
   */
  async requestCollaboration(
    req: Omit<CollaborationRequest, 'id'>,
  ): Promise<CollaborationResponse> {
    const requestId = `collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fullReq: CollaborationRequest = { ...req, id: requestId };
    this.pendingRequests.set(requestId, fullReq);

    const targetAgent = this.agents.get(req.toAgentId);

    if (!targetAgent) {
      return {
        requestId,
        fromAgentId: req.toAgentId,
        accepted: false,
        message: `Agent ${req.toAgentId} not found`,
        timestamp: new Date().toISOString(),
      };
    }

    // 1. 尝试 HTTP 直连（最低延迟）
    if (targetAgent.endpoint) {
      try {
        const response = await fetch(`${targetAgent.endpoint}/collab`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fullReq),
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          const result = await response.json();
          this.pendingRequests.delete(requestId);
          return result as CollaborationResponse;
        }
      } catch (error) {
        console.warn(`[MultiAgent] HTTP failed, falling back to Feishu: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 2. 通过飞书消息发送协作请求
    if (this.feishuSender && targetAgent.feishuOpenId) {
      const msgText = this.formatCollabRequestForFeishu(fullReq);
      try {
        await this.feishuSender.sendMessageToUser(targetAgent.feishuOpenId, msgText);
        return {
          requestId,
          fromAgentId: req.toAgentId,
          accepted: true,
          message: `协作请求已通过飞书发送给 ${targetAgent.userName}：${req.task}`,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        console.warn(`[MultiAgent] Feishu send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 3. 通过群聊发送（如果有 chatId）
    if (this.feishuSender && targetAgent.feishuChatId) {
      const msgText = this.formatCollabRequestForFeishu(fullReq);
      try {
        await this.feishuSender.sendMessageToChat(targetAgent.feishuChatId, msgText);
        return {
          requestId,
          fromAgentId: req.toAgentId,
          accepted: true,
          message: `协作请求已通过飞书群发送给 ${targetAgent.userName}：${req.task}`,
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        console.warn(`[MultiAgent] Feishu group send failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 4. 所有通道都不可用
    return {
      requestId,
      fromAgentId: req.toAgentId,
      accepted: false,
      message: `无法联系 ${targetAgent.userName} 的 Otto（无 HTTP 端点、无飞书 openId）`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 将协作请求格式化为飞书消息文本。
   */
  private formatCollabRequestForFeishu(req: CollaborationRequest): string {
    const lines: string[] = [];
    lines.push(`[Otto 协作请求]`);
    lines.push(`来自：${req.fromUserName} 的 Otto`);
    lines.push(`任务：${req.task}`);
    if (req.context) {
      lines.push(`背景：${req.context}`);
    }
    if (req.deadline) {
      lines.push(`截止：${req.deadline}`);
    }
    lines.push(`优先级：${req.priority}`);
    lines.push(`请求ID：${req.id}`);
    lines.push('');
    lines.push(`请回复 "协作接受 ${req.id}" 或 "协作拒绝 ${req.id}" 来处理此请求。`);
    return lines.join('\n');
  }

  /**
   * 解析飞书消息，判断是否是协作请求的回复。
   * 如果是，返回请求 ID 和是否接受。
   */
  parseCollabReply(messageText: string): { requestId: string; accepted: boolean } | null {
    const text = messageText.trim();
    const acceptMatch = text.match(/^协作接受\s+(\S+)/i);
    if (acceptMatch) {
      return { requestId: acceptMatch[1], accepted: true };
    }
    const rejectMatch = text.match(/^协作拒绝\s+(\S+)/i);
    if (rejectMatch) {
      return { requestId: rejectMatch[1], accepted: false };
    }
    // 也支持英文
    const acceptEn = text.match(/^collab accept\s+(\S+)/i);
    if (acceptEn) {
      return { requestId: acceptEn[1], accepted: true };
    }
    const rejectEn = text.match(/^collab reject\s+(\S+)/i);
    if (rejectEn) {
      return { requestId: rejectEn[1], accepted: false };
    }
    return null;
  }

  /**
   * 判断飞书消息是否是 Otto 协作请求（而非普通对话）。
   */
  isCollabRequest(messageText: string): boolean {
    return messageText.trim().startsWith('[Otto 协作请求]');
  }

  /**
   * 处理收到的协作请求（作为目标 Otto）。
   */
  async handleCollaborationRequest(
    req: CollaborationRequest,
    config: Config,
  ): Promise<CollaborationResponse> {
    // 根据请求类型执行对应操作
    // 例如："查老张下周日历" → 调用 calendar +agenda

    try {
      // 这里委托给 Otto 的工具系统执行
      // 实际实现中会调用 lark-cli 的对应能力
      const result = `[Collaboration] Received request from ${req.fromAgentId}: ${req.task}`;

      return {
        requestId: req.id,
        fromAgentId: req.toAgentId,
        accepted: true,
        result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        requestId: req.id,
        fromAgentId: req.toAgentId,
        accepted: false,
        message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * 获取所有在线 Agent。
   */
  getOnlineAgents(): AgentRegistration[] {
    return Array.from(this.agents.values()).filter(a => a.status === 'online');
  }

  /**
   * 清理超时的待处理请求（5分钟超时）。
   */
  cleanupStaleRequests(): void {
    const now = Date.now();
    for (const [id, req] of this.pendingRequests) {
      const reqTime = parseInt(id.split('_')[1] || '0');
      if (now - reqTime > 5 * 60 * 1000) {
        this.pendingRequests.delete(id);
      }
    }
  }
}

/**
 * 全局单例协作管理器。
 */
let globalCollab: MultiAgentCollaboration | null = null;

export function getCollaborationManager(): MultiAgentCollaboration {
  if (!globalCollab) {
    globalCollab = new MultiAgentCollaboration();
  }
  return globalCollab;
}

/**
 * 初始化当前 Otto 的协作注册。
 */
export function initCollaboration(
  config: Config,
  userName: string,
  department: string,
  capabilities: string[] = ['calendar', 'docs', 'tasks', 'email'],
  feishuOpenId?: string,
  feishuChatId?: string,
): void {
  const mgr = getCollaborationManager();
  const agentId = (config as any).getSessionId?.() || 'otto-main';
  const userId = (config as any).getFeishuUser?.() || userName;

  mgr.register({
    agentId,
    userId,
    userName,
    department,
    capabilities,
    feishuOpenId,
    feishuChatId,
  });
}
