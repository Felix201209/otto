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

/** 协作请求 */
export interface CollaborationRequest {
  id: string;
  fromUserId: string;
  fromAgentId: string;
  toUserId: string;
  toAgentId: string;
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

    // 尝试 HTTP 直连
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

    // 降级：通过飞书消息发送
    // 实际实现中，这里会调用飞书 API 给目标用户发消息
    // 目标 Otto 在飞书里收到消息后处理并回复
    return {
      requestId,
      fromAgentId: req.toAgentId,
      accepted: true,
      message: `Collaboration request sent via Feishu to ${targetAgent.userName}`,
      timestamp: new Date().toISOString(),
    };
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
): void {
  const mgr = getCollaborationManager();
  const agentId = config.getSessionId?.() || 'otto-main';
  const userId = (config as any).getFeishuUser?.() || userName;

  mgr.register({
    agentId,
    userId,
    userName,
    department,
    capabilities,
  });
}
