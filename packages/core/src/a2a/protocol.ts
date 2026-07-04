/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto A-to-A Protocol - Agent-to-Agent communication via Feishu.
 *
 * Phase 3 of Otto's evolution: multiple Otto instances communicate
 * through Feishu's architecture (IM/Task/Approval as transport layer).
 *
 * Design principles:
 * 1. Feishu is the transport layer (zero extra infrastructure)
 * 2. Every A-to-A message is a Feishu Task (auditable, assignable, trackable)
 * 3. Results come back via Feishu IM (visible to humans)
 * 4. Auth is enterprise-scoped (HMAC-SHA256 signed)
 */

import * as crypto from 'crypto';

// ============================================================
// Protocol Types
// ============================================================

export const A2A_PROTOCOL_VERSION = '1.0';

export type MessageType =
  | 'task_request'      // A asks B to do something
  | 'task_result'       // B returns result to A
  | 'task_reject'       // B rejects the task
  | 'status_query'      // A asks B for status
  | 'status_response'   // B responds with status
  | 'knowledge_sync';   // A pushes knowledge to B

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface Artifact {
  type: 'feishu_doc' | 'feishu_sheet' | 'feishu_base' | 'file' | 'text';
  token?: string;       // Feishu object token
  path?: string;        // Local file path
  content?: string;     // Inline text content
}

export interface A2AMessage {
  protocol: 'otto-a2a/1.0';
  id: string;            // Unique message ID
  from: AgentIdentity;
  to: AgentIdentity;
  type: MessageType;
  priority: Priority;
  payload: TaskPayload | ResultPayload | SyncPayload;
  auth: AuthBlock;
  created_at: string;
  expires_at?: string;
}

export interface AgentIdentity {
  agent_id: string;      // e.g. "otto-realestate-wangjing"
  department: string;    // e.g. "real_estate"
  enterprise: string;    // e.g. "huasheng"
}

export interface TaskPayload {
  task_type: string;     // e.g. "contract_review"
  context: string;       // Natural language description
  artifacts?: Artifact[];
  deadline?: string;     // ISO 8601
  callback: {
    on_complete?: string; // Feishu IM chat_id or task_id
    on_reject?: string;
  };
}

export interface ResultPayload {
  original_task_id: string;
  status: 'success' | 'partial' | 'failed';
  result_text: string;
  artifacts?: Artifact[];
  duration_min?: number;
  tokens_used?: number;
}

export interface SyncPayload {
  knowledge_category: string;
  knowledge_items: Array<{
    content: string;
    confidence: number;
  }>;
}

export interface AuthBlock {
  enterprise_id: string;
  signature: string;     // HMAC-SHA256
  timestamp: number;
}

// ============================================================
// Message Factory
// ============================================================

export class A2AMessageBuilder {
  private enterprise: string;
  private secret: string;
  private agentId: string;
  private department: string;

  constructor(enterprise: string, secret: string, agentId: string, department: string) {
    this.enterprise = enterprise;
    this.secret = secret;
    this.agentId = agentId;
    this.department = department;
  }

  private sign(payload: string, timestamp: number): string {
    return crypto.createHmac('sha256', this.secret)
      .update(`${this.enterprise}.${timestamp}.${payload}`)
      .digest('hex');
  }

  private genId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  buildTaskRequest(
    toAgent: AgentIdentity,
    taskType: string,
    context: string,
    options?: {
      artifacts?: Artifact[];
      priority?: Priority;
      deadline?: string;
      onComplete?: string;
      onReject?: string;
    }
  ): A2AMessage {
    const payload: TaskPayload = {
      task_type: taskType,
      context,
      artifacts: options?.artifacts,
      deadline: options?.deadline,
      callback: {
        on_complete: options?.onComplete,
        on_reject: options?.onReject,
      },
    };
    const payloadStr = JSON.stringify(payload);
    const timestamp = Date.now();

    return {
      protocol: `otto-a2a/${A2A_PROTOCOL_VERSION}`,
      id: this.genId(),
      from: { agent_id: this.agentId, department: this.department, enterprise: this.enterprise },
      to: toAgent,
      type: 'task_request',
      priority: options?.priority || 'normal',
      payload,
      auth: {
        enterprise_id: this.enterprise,
        signature: this.sign(payloadStr, timestamp),
        timestamp,
      },
      created_at: new Date().toISOString(),
      expires_at: options?.deadline,
    };
  }

  buildTaskResult(
    toAgent: AgentIdentity,
    originalTaskId: string,
    status: 'success' | 'partial' | 'failed',
    resultText: string,
    options?: { artifacts?: Artifact[]; durationMin?: number; tokensUsed?: number }
  ): A2AMessage {
    const payload: ResultPayload = {
      original_task_id: originalTaskId,
      status,
      result_text: resultText,
      artifacts: options?.artifacts,
      duration_min: options?.durationMin,
      tokens_used: options?.tokensUsed,
    };
    const payloadStr = JSON.stringify(payload);
    const timestamp = Date.now();

    return {
      protocol: `otto-a2a/${A2A_PROTOCOL_VERSION}`,
      id: this.genId(),
      from: { agent_id: this.agentId, department: this.department, enterprise: this.enterprise },
      to: toAgent,
      type: 'task_result',
      priority: 'normal',
      payload,
      auth: {
        enterprise_id: this.enterprise,
        signature: this.sign(payloadStr, timestamp),
        timestamp,
      },
      created_at: new Date().toISOString(),
    };
  }

  buildKnowledgeSync(
    toAgent: AgentIdentity,
    category: string,
    items: Array<{ content: string; confidence: number }>
  ): A2AMessage {
    const payload: SyncPayload = { knowledge_category: category, knowledge_items: items };
    const payloadStr = JSON.stringify(payload);
    const timestamp = Date.now();

    return {
      protocol: `otto-a2a/${A2A_PROTOCOL_VERSION}`,
      id: this.genId(),
      from: { agent_id: this.agentId, department: this.department, enterprise: this.enterprise },
      to: toAgent,
      type: 'knowledge_sync',
      priority: 'low',
      payload,
      auth: {
        enterprise_id: this.enterprise,
        signature: this.sign(payloadStr, timestamp),
        timestamp,
      },
      created_at: new Date().toISOString(),
    };
  }
}

// ============================================================
// Feishu Transport Layer
// ============================================================

/**
 * Feishu as A-to-A transport:
 * - task_request -> create Feishu Task (assigned to target department)
 * - task_result  -> reply in Feishu IM (to original requester's chat)
 * - knowledge_sync -> update Feishu Wiki node
 *
 * Why Feishu as transport:
 * 1. Enterprise already uses Feishu (zero extra infra)
 * 2. Feishu has auth/audit built-in
 * 3. Tasks are naturally trackable
 * 4. Messages are visible to humans (transparency)
 */

export interface FeishuTransportConfig {
  // Feishu app credentials (already configured via lark-cli)
  agentId: string;
  // Chat ID for A-to-A communication (dedicated group or bot)
  a2aChatId: string;
  // Department -> Agent mapping
  departmentAgents: Record<string, AgentIdentity>;
}

export class FeishuA2ATransport {
  private config: FeishuTransportConfig;

  constructor(config: FeishuTransportConfig) {
    this.config = config;
  }

  /**
   * Send A-to-A message via Feishu.
   * task_request -> Feishu Task API
   * task_result -> Feishu IM reply
   * knowledge_sync -> Feishu Wiki update
   */
  async send(msg: A2AMessage): Promise<{ feishu_id: string; status: string }> {
    switch (msg.type) {
      case 'task_request':
        return this.sendAsTask(msg);
      case 'task_result':
        return this.sendAsIM(msg);
      case 'knowledge_sync':
        return this.sendAsWiki(msg);
      default:
        return this.sendAsIM(msg);
    }
  }

  /**
   * Poll Feishu for incoming A-to-A messages.
   * Checks: new tasks assigned to this agent, new IM messages in A-to-A chat.
   */
  async poll(): Promise<A2AMessage[]> {
    // In production, this would call lark-cli:
    //   lark-cli task +get-my-tasks  (find tasks from other agents)
    //   lark-cli im +chat-messages-list --chat-id <a2a_chat_id>
    // Then parse task descriptions / message bodies as A2A messages.
    //
    // For now, return empty array (to be wired in Phase 2).
    return [];
  }

  private async sendAsTask(msg: A2AMessage): Promise<{ feishu_id: string; status: string }> {
    // Production: lark-cli task +create --summary "A2A: <task_type>" --description <JSON>
    // The task description contains the full A2AMessage JSON.
    // Target agent polls its task list and finds A2A messages.
    const summary = `A2A: ${(msg.payload as TaskPayload).task_type}`;
    const description = JSON.stringify(msg);
    // Placeholder: actual lark-cli call in Phase 2
    return { feishu_id: `task_${Date.now()}`, status: 'created' };
  }

  private async sendAsIM(msg: A2AMessage): Promise<{ feishu_id: string; status: string }> {
    // Production: lark-cli im +messages-send --receive-id-type chat_id --receive-id <a2aChatId>
    const content = JSON.stringify(msg);
    // Placeholder: actual lark-cli call in Phase 2
    return { feishu_id: `im_${Date.now()}`, status: 'sent' };
  }

  private async sendAsWiki(msg: A2AMessage): Promise<{ feishu_id: string; status: string }> {
    // Production: lark-cli docs +update or wiki +node-update
    const content = JSON.stringify(msg);
    // Placeholder: actual lark-cli call in Phase 2
    return { feishu_id: `wiki_${Date.now()}`, status: 'updated' };
  }
}

// ============================================================
// A-to-A Router (per-agent message processing)
// ============================================================

export interface A2AHandler {
  taskType: string;
  handler: (msg: A2AMessage) => Promise<A2AMessage>; // returns result message
}

export class A2ARouter {
  private handlers: Map<string, A2AHandler> = new Map();
  private transport: FeishuA2ATransport;
  private identity: AgentIdentity;

  constructor(identity: AgentIdentity, transport: FeishuA2ATransport) {
    this.identity = identity;
    this.transport = transport;
  }

  /**
   * Register a handler for a specific task type.
   * When another agent sends a task_request with this task_type,
   * the handler is called.
   */
  registerHandler(taskType: string, handler: (msg: A2AMessage) => Promise<A2AMessage>): void {
    this.handlers.set(taskType, { taskType, handler });
  }

  /**
   * Main loop: poll for messages, dispatch to handlers, send results.
   */
  async run(intervalMs = 5000): Promise<void> {
    while (true) {
      try {
        const messages = await this.transport.poll();
        for (const msg of messages) {
          if (msg.type === 'task_request') {
            const payload = msg.payload as TaskPayload;
            const handlerEntry = this.handlers.get(payload.task_type);

            if (handlerEntry) {
              console.log(`[A2A] Processing: ${payload.task_type} from ${msg.from.agent_id}`);
              const result = await handlerEntry.handler(msg);
              await this.transport.send(result);
              console.log(`[A2A] Result sent to ${msg.from.agent_id}`);
            } else {
              // No handler: reject
              const reject = this.buildReject(msg, `No handler for task_type: ${payload.task_type}`);
              await this.transport.send(reject);
            }
          }
        }
      } catch (err) {
        console.error('[A2A] Router error:', err);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }

  /**
   * Send a task request to another agent.
   */
  async requestTask(
    toAgent: AgentIdentity,
    taskType: string,
    context: string,
    options?: { artifacts?: Artifact[]; deadline?: string; priority?: Priority }
  ): Promise<string> {
    const builder = new A2AMessageBuilder(
      this.identity.enterprise,
      process.env.OTTO_A2A_SECRET || 'default-secret',
      this.identity.agent_id,
      this.identity.department
    );
    const msg = builder.buildTaskRequest(toAgent, taskType, context, options);
    await this.transport.send(msg);
    return msg.id;
  }

  private buildReject(original: A2AMessage, reason: string): A2AMessage {
    const builder = new A2AMessageBuilder(
      this.identity.enterprise,
      process.env.OTTO_A2A_SECRET || 'default-secret',
      this.identity.agent_id,
      this.identity.department
    );
    return builder.buildTaskResult(original.from, original.id, 'failed', reason);
  }
}

// ============================================================
// Feishu Shuttle Chains (pre-built cross-system workflows)
// ============================================================

/**
 * Pre-built Otto shuttle chains that traverse Feishu + local + browser.
 * These are composite workflows, not single tool calls.
 */

export interface ShuttleChain {
  name: string;
  description: string;
  steps: ShuttleStep[];
}

export interface ShuttleStep {
  tool: string;           // web_automation | analyze_data | generate_document | lark-cli | desktop_automation
  action: string;         // navigate | query | report | im+messages-send | ...
  description: string;
  feishu_api?: string;    // If step uses Feishu API
  local_tool?: string;    // If step uses local Otto tool
}

export const SHUTTLE_CHAINS: ShuttleChain[] = [
  {
    name: 'data_ingest_to_feishu',
    description: 'Scrape data from OA website -> write to Feishu Base -> notify via Feishu IM -> create follow-up task',
    steps: [
      { tool: 'web_automation', action: 'navigate+scrape', description: 'Login to OA, navigate to report page, scrape table data', local_tool: 'web_automation' },
      { tool: 'lark-cli', action: 'base+record-batch-create', description: 'Write scraped data to Feishu Bitable', feishu_api: 'base/record-batch-create' },
      { tool: 'lark-cli', action: 'im+messages-send', description: 'Send notification to department chat with summary', feishu_api: 'im/messages-send' },
      { tool: 'lark-cli', action: 'task+create', description: 'Create follow-up task assigned to manager', feishu_api: 'task/create' },
    ],
  },
  {
    name: 'report_generate_and_share',
    description: 'Read Feishu Sheet -> analyze locally -> generate PDF report -> upload to Feishu Drive -> share in chat',
    steps: [
      { tool: 'lark-cli', action: 'sheets+read', description: 'Read sales data from Feishu Sheet', feishu_api: 'sheets/read' },
      { tool: 'analyze_data', action: 'query+chart', description: 'Analyze data, generate chart (bar/line/pie)', local_tool: 'analyze_data' },
      { tool: 'generate_document', action: 'report+pdf', description: 'Generate PDF report with chart embedded', local_tool: 'generate_document' },
      { tool: 'lark-cli', action: 'drive+upload', description: 'Upload PDF to Feishu Drive', feishu_api: 'drive/upload' },
      { tool: 'lark-cli', action: 'im+messages-send', description: 'Share file link in department chat', feishu_api: 'im/messages-send' },
    ],
  },
  {
    name: 'cross_dept_approval',
    description: 'Generate contract locally -> upload to Feishu Drive -> start Feishu Approval -> auto-send on approval',
    steps: [
      { tool: 'generate_document', action: 'contract+pdf', description: 'Generate contract PDF from template', local_tool: 'generate_document' },
      { tool: 'lark-cli', action: 'drive+upload', description: 'Upload contract to Feishu Drive', feishu_api: 'drive/upload' },
      { tool: 'lark-cli', action: 'approval+create', description: 'Start Feishu Approval flow for legal review', feishu_api: 'approval/create' },
      { tool: 'lark-cli', action: 'im+messages-send', description: 'Notify legal department chat', feishu_api: 'im/messages-send' },
    ],
  },
  {
    name: 'meeting_to_action',
    description: 'Fetch Feishu Meeting minutes -> extract action items -> create tasks -> update doc -> notify chat',
    steps: [
      { tool: 'lark-cli', action: 'minutes+search+download', description: 'Download meeting minutes/transcript', feishu_api: 'minutes/download' },
      { tool: 'analyze_data', action: 'extract+tasks', description: 'Extract action items from transcript via LLM', local_tool: 'analyze_data' },
      { tool: 'lark-cli', action: 'task+create', description: 'Create Feishu tasks for each action item', feishu_api: 'task/create' },
      { tool: 'lark-cli', action: 'docs+update', description: 'Update meeting notes document with action items', feishu_api: 'docs/update' },
      { tool: 'lark-cli', action: 'im+messages-send', description: 'Send summary + task list to meeting chat', feishu_api: 'im/messages-send' },
    ],
  },
  {
    name: 'auto_offboard_feishu',
    description: 'Otto offboard -> disable Feishu account -> reassign tasks -> transfer doc permissions -> remove from chats',
    steps: [
      { tool: 'memory_manager', action: 'offboard', description: 'Otto offboard: merge experience to department knowledge', local_tool: 'memory_manager' },
      { tool: 'lark-cli', action: 'contact+update', description: 'Disable Feishu contact account', feishu_api: 'contact/update' },
      { tool: 'lark-cli', action: 'task+list+reassign', description: 'Find open tasks and reassign to backup person', feishu_api: 'task/list' },
      { tool: 'lark-cli', action: 'docs+permissions', description: 'Transfer document ownership to department head', feishu_api: 'docs/permissions' },
      { tool: 'lark-cli', action: 'calendar+cancel', description: 'Cancel future calendar events', feishu_api: 'calendar/cancel' },
      { tool: 'lark-cli', action: 'im+chat-remove', description: 'Remove from department chats', feishu_api: 'im/chat-remove-member' },
    ],
  },
];
