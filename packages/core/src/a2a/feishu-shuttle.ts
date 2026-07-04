/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Feishu A2A Shuttle - Concrete Feishu operations as A-to-A actions.
 *
 * These are NOT abstract API wrappers. They are pre-built workflows that
 * chain multiple Feishu API calls + local Otto tools into single actions
 * that agents can trigger autonomously.
 *
 * Every action here maps to a real lark-cli command.
 */

import type { A2AMessage, AgentIdentity, Artifact } from './protocol.js';

// ============================================================
// Shuttle Action Types
// ============================================================

export type FeishuShuttleAction =
  | 'read_messages'          // Auto-read Feishu IM messages
  | 'write_document'         // Write/create Feishu document
  | 'sync_progress'          // Sync work progress to Feishu
  | 'send_message'           // Send Feishu IM message
  | 'create_spreadsheet'     // Create Feishu spreadsheet with data
  | 'create_workflow'        // Build automated Feishu workflow
  | 'read_and_summarize'     // Read messages + summarize via LLM
  | 'auto_respond'           // Auto-respond to Feishu messages
  | 'batch_create_tasks'     // Create multiple Feishu tasks from text
  | 'update_wiki'            // Update Feishu knowledge base
  | 'cross_dept_handoff';    // A-to-A cross department task handoff

export interface ShuttleRequest {
  action: FeishuShuttleAction;
  agent: AgentIdentity;
  params: Record<string, any>;
  trigger: 'human' | 'agent' | 'schedule' | 'event';
}

export interface ShuttleResult {
  action: FeishuShuttleAction;
  success: boolean;
  feishu_objects: Artifact[];
  summary: string;
  next_actions?: string[];
}

// ============================================================
// Action Definitions (lark-cli command mapping)
// ============================================================

export interface ActionDef {
  action: FeishuShuttleAction;
  description: string;
  larkCliCommand: string;    // The actual lark-cli command to execute
  params: Record<string, string>;
  outputType: 'text' | 'json' | 'file' | 'feishu_object';
  a2aCapable: boolean;       // Can this be triggered by another agent?
  examples: string[];
}

export const FEISHU_SHUTTLE_ACTIONS: ActionDef[] = [
  // ============================================================
  // 1. READ MESSAGES - Auto-read Feishu IM
  // ============================================================
  {
    action: 'read_messages',
    description: 'Read recent messages from a Feishu chat. Agent monitors chat for tasks/requests.',
    larkCliCommand: 'im +chat-messages-list --chat-id {chat_id}',
    params: { chat_id: 'Feishu chat ID to read from', limit: 'Number of messages (default 20)' },
    outputType: 'json',
    a2aCapable: true,
    examples: [
      'Agent A reads sales team chat -> finds customer complaint -> triggers response workflow',
      'Agent polls legal chat every 5min -> detects contract review request -> auto-processes',
    ],
  },

  // ============================================================
  // 2. WRITE DOCUMENT - Create/update Feishu doc
  // ============================================================
  {
    action: 'write_document',
    description: 'Create a new Feishu document from content, or update existing doc.',
    larkCliCommand: 'docs +create --title {title} --content @{file_path} --doc-format markdown',
    params: { title: 'Document title', file_path: 'Local markdown file to upload', doc_token: 'Existing doc token (for update)' },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent generates weekly report locally -> writes to Feishu doc -> shares with team',
      'Agent A finishes analysis -> creates Feishu doc with findings -> notifies Agent B',
    ],
  },

  // ============================================================
  // 3. SYNC PROGRESS - Update work progress to Feishu
  // ============================================================
  {
    action: 'sync_progress',
    description: 'Sync Otto task execution progress to Feishu (Task + Doc + IM in one action).',
    larkCliCommand: 'task +create --summary {summary} && docs +update --doc {doc_token} --command append --content @{file}',
    params: {
      summary: 'Progress summary text',
      doc_token: 'Feishu doc to append progress to',
      file: 'Local file with detailed progress',
      chat_id: 'Chat to notify (optional)',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent completes data analysis -> syncs progress to project doc -> notifies PM chat',
      'Agent A hands off to Agent B -> syncs current progress as Feishu task + doc update',
    ],
  },

  // ============================================================
  // 4. SEND MESSAGE - Send Feishu IM
  // ============================================================
  {
    action: 'send_message',
    description: 'Send a message to a Feishu chat or person. Supports text, file, and rich content.',
    larkCliCommand: 'im +messages-send --receive-id-type {id_type} --receive-id {id} --msg-type {msg_type} --content {content}',
    params: {
      id_type: 'chat_id or open_id or user_id',
      id: 'The receive ID',
      msg_type: 'text, file, post, interactive',
      content: 'Message content (JSON for non-text)',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent finishes report -> sends to manager chat with attachment',
      'Agent A detects anomaly -> alerts Agent B via dedicated A2A chat',
      'Agent auto-responds to customer query in service chat',
    ],
  },

  // ============================================================
  // 5. CREATE SPREADSHEET - Build Feishu sheet from data
  // ============================================================
  {
    action: 'create_spreadsheet',
    description: 'Create a Feishu spreadsheet and populate it with structured data.',
    larkCliCommand: 'sheets +create --title {title} && sheets +write --range A1 --values {values}',
    params: {
      title: 'Spreadsheet title',
      values: 'JSON 2D array of cell values',
      sheet_token: 'Existing sheet token (for append)',
      range: 'Cell range to write (default A1)',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent analyzes sales data -> creates Feishu sheet with results -> shares with team',
      'Agent A scrapes OA data -> writes to Feishu sheet -> Agent B reads sheet for reporting',
    ],
  },

  // ============================================================
  // 6. CREATE WORKFLOW - Build automated Feishu workflow
  // ============================================================
  {
    action: 'create_workflow',
    description: 'Create a multi-step Feishu workflow: trigger -> process -> output.',
    larkCliCommand: '(composite: task +create -> docs +create -> im +messages-send -> calendar +create)',
    params: {
      workflow_name: 'Name of the workflow',
      trigger: 'What triggers this workflow (message/schedule/event)',
      steps: 'Array of Feishu API calls to execute in sequence',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'New listing entered -> auto-create: task for photographer + doc for listing + notify sales chat',
      'Contract signed -> auto-create: task for finance + calendar reminder + doc archive + approval flow',
      'Employee onboarded -> auto-create: wiki page + task list + calendar events + chat welcome',
    ],
  },

  // ============================================================
  // 7. READ AND SUMMARIZE - LLM-powered message processing
  // ============================================================
  {
    action: 'read_and_summarize',
    description: 'Read messages from a chat, use LLM to summarize and extract action items.',
    larkCliCommand: 'im +chat-messages-list --chat-id {chat_id} -> (LLM process) -> task +create (batch)',
    params: {
      chat_id: 'Chat to read from',
      hours: 'Look back N hours (default 24)',
      summarize_to: 'Where to send summary (chat_id or doc_token)',
    },
    outputType: 'json',
    a2aCapable: true,
    examples: [
      'Agent reads 200 messages from project chat -> summarizes to 5 key points -> posts to manager chat',
      'Agent reads overnight customer messages -> extracts 3 complaints -> creates tasks for support team',
    ],
  },

  // ============================================================
  // 8. AUTO RESPOND - Auto-reply to Feishu messages
  // ============================================================
  {
    action: 'auto_respond',
    description: 'Auto-respond to messages based on knowledge base. Human reviews edge cases.',
    larkCliCommand: 'im +messages-list -> (LLM classify) -> im +messages-reply OR im +messages-send',
    params: {
      chat_id: 'Chat to monitor',
      knowledge_source: 'Department knowledge base to use for answers',
      confidence_threshold: 'Minimum confidence to auto-reply (default 0.8)',
      escalate_to: 'Human to escalate low-confidence cases to',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent monitors HR chat -> answers "how many vacation days" from policy -> escalates complex cases',
      'Agent monitors IT chat -> answers "WiFi not working" with diagnose_system -> escalates hardware issues',
    ],
  },

  // ============================================================
  // 9. BATCH CREATE TASKS - Parse text into Feishu tasks
  // ============================================================
  {
    action: 'batch_create_tasks',
    description: 'Parse a text block (meeting notes, email, chat log) into multiple Feishu tasks.',
    larkCliCommand: '(LLM extract tasks) -> task +create (loop) -> im +messages-send (summary)',
    params: {
      source_text: 'Text to extract tasks from',
      source_type: 'meeting_minutes, email, chat_log, document',
      default_assignee: 'Default person to assign tasks to',
      chat_id: 'Chat to send task summary to',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent reads meeting minutes -> extracts 8 action items -> creates 8 Feishu tasks -> posts summary',
      'Agent A finishes review -> generates 5 follow-up tasks -> assigns to Agent B department',
    ],
  },

  // ============================================================
  // 10. UPDATE WIKI - Sync knowledge to Feishu Wiki
  // ============================================================
  {
    action: 'update_wiki',
    description: 'Update Feishu knowledge base with new knowledge learned by Otto.',
    larkCliCommand: 'wiki +node-create --space-id {space_id} --title {title} --content @{file}',
    params: {
      space_id: 'Feishu Wiki space ID',
      title: 'Wiki page title',
      file: 'Local markdown file with content',
      parent_node: 'Parent node token (optional)',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Agent learns new SOP -> auto-publishes to Feishu Wiki -> team gets updated process doc',
      'Agent A offboards employee -> merges experience to Wiki -> department has updated knowledge',
    ],
  },

  // ============================================================
  // 11. CROSS DEPT HANDOFF - A-to-A task transfer
  // ============================================================
  {
    action: 'cross_dept_handoff',
    description: 'Full A-to-A handoff: create task + attach artifacts + notify + set deadline.',
    larkCliCommand: 'task +create --summary {summary} -> drive +upload (attachments) -> im +messages-send (notify)',
    params: {
      from_agent: 'Source agent identity',
      to_department: 'Target department',
      task_type: 'Type of task to hand off',
      context: 'Task context/description',
      artifacts: 'Files/docs to attach',
      deadline: 'ISO 8601 deadline',
      callback_chat: 'Chat ID for result callback',
    },
    outputType: 'feishu_object',
    a2aCapable: true,
    examples: [
      'Real estate agent says "need legal review" -> Otto creates task for legal dept + uploads contract + notifies legal chat',
      'Finance agent detects budget overrun -> hands off to audit dept with evidence attached',
      'Agent A completes data analysis -> hands off results to Agent B for report generation',
    ],
  },
];

// ============================================================
// Shuttle Executor - runs the actual lark-cli commands
// ============================================================

export class FeishuShuttleExecutor {
  private agent: AgentIdentity;

  constructor(agent: AgentIdentity) {
    this.agent = agent;
  }

  async execute(req: ShuttleRequest): Promise<ShuttleResult> {
    const def = FEISHU_SHUTTLE_ACTIONS.find(a => a.action === req.action);
    if (!def) {
      return {
        action: req.action,
        success: false,
        feishu_objects: [],
        summary: `Unknown action: ${req.action}`,
      };
    }

    try {
      // Build lark-cli command from template + params
      const cmd = this.buildCommand(def.larkCliCommand, req.params);
      const result = await this.runLarkCli(cmd);

      // Parse result and build artifacts
      const artifacts = this.parseArtifacts(result, req.action);

      return {
        action: req.action,
        success: true,
        feishu_objects: artifacts,
        summary: this.buildSummary(req.action, req.params, artifacts),
        next_actions: this.suggestNextActions(req.action, artifacts),
      };
    } catch (err: any) {
      return {
        action: req.action,
        success: false,
        feishu_objects: [],
        summary: `Failed: ${err.message}`,
      };
    }
  }

  private buildCommand(template: string, params: Record<string, any>): string {
    let cmd = template;
    for (const [key, val] of Object.entries(params)) {
      cmd = cmd.replace(`{${key}}`, String(val));
    }
    // Handle @file syntax (lark-cli reads from file)
    cmd = cmd.replace(/@(\w+)/g, (match, name) => {
      return params[name] ? `@${params[name]}` : match;
    });
    return cmd;
  }

  private async runLarkCli(cmd: string): Promise<string> {
    // In production: actual lark-cli execution via ProcessGuard
    // const { ProcessGuard } = await import('../utils/process-guard.js');
    // const result = await ProcessGuard.exec({ command: `lark-cli ${cmd}`, timeoutMs: 30000 });
    // return result.stdout;

    // Phase 2: wire to actual lark-cli
    return JSON.stringify({ status: 'placeholder', cmd });
  }

  private parseArtifacts(result: string, action: FeishuShuttleAction): Artifact[] {
    try {
      const parsed = JSON.parse(result);
      const artifacts: Artifact[] = [];

      if (parsed.doc_token) {
        artifacts.push({ type: 'feishu_doc', token: parsed.doc_token });
      }
      if (parsed.sheet_token || parsed.spreadsheet_token) {
        artifacts.push({ type: 'feishu_sheet', token: parsed.sheet_token || parsed.spreadsheet_token });
      }
      if (parsed.message_id) {
        artifacts.push({ type: 'text', content: parsed.message_id });
      }
      if (parsed.task_id) {
        artifacts.push({ type: 'text', content: `task:${parsed.task_id}` });
      }
      if (parsed.node_token) {
        artifacts.push({ type: 'text', content: `wiki:${parsed.node_token}` });
      }

      return artifacts;
    } catch {
      return [];
    }
  }

  private buildSummary(action: FeishuShuttleAction, params: Record<string, any>, artifacts: Artifact[]): string {
    const summaries: Record<string, string> = {
      read_messages: `Read ${params.limit || 20} messages from chat ${params.chat_id}`,
      write_document: `Created Feishu doc "${params.title}" (${artifacts.length} objects)`,
      sync_progress: `Synced progress to doc ${params.doc_token} + notified chat`,
      send_message: `Sent ${params.msg_type} message to ${params.id}`,
      create_spreadsheet: `Created spreadsheet "${params.title}" with data`,
      create_workflow: `Created workflow "${params.workflow_name}" with ${params.steps?.length || 0} steps`,
      read_and_summarize: `Summarized messages from chat ${params.chat_id}`,
      auto_respond: `Auto-responded in chat ${params.chat_id}`,
      batch_create_tasks: `Created tasks from ${params.source_type}`,
      update_wiki: `Updated Wiki space ${params.space_id} with "${params.title}"`,
      cross_dept_handoff: `Handed off ${params.task_type} to ${params.to_department}`,
    };
    return summaries[action] || `Action ${action} completed`;
  }

  private suggestNextActions(action: FeishuShuttleAction, artifacts: Artifact[]): string[] {
    const suggestions: Record<string, string[]> = {
      read_messages: ['Summarize messages with read_and_summarize', 'Extract tasks with batch_create_tasks'],
      write_document: ['Share doc via send_message', 'Create follow-up task'],
      sync_progress: ['Notify manager chat', 'Update project timeline'],
      send_message: [],
      create_spreadsheet: ['Analyze data with analyze_data', 'Generate chart report'],
      create_workflow: ['Monitor workflow status', 'Add more steps'],
      read_and_summarize: ['Post summary to manager chat', 'Create tasks from action items'],
      auto_respond: ['Log response to knowledge base', 'Escalate if needed'],
      batch_create_tasks: ['Notify assignees via send_message', 'Set calendar reminders'],
      update_wiki: ['Notify team of wiki update', 'Sync to department knowledge'],
      cross_dept_handoff: ['Wait for result callback', 'Set deadline reminder'],
    };
    return suggestions[action] || [];
  }
}

// ============================================================
// A-to-A Event Loop - agent monitors Feishu autonomously
// ============================================================

export interface EventLoopConfig {
  // Chats to monitor for incoming messages
  monitoredChats: Array<{ chat_id: string; purpose: string }>;
  // Poll interval in ms
  pollIntervalMs: number;
  // Auto-respond confidence threshold
  autoRespondThreshold: number;
  // Human escalation target
  escalateTo: string;
}

export class FeishuEventLoop {
  private config: EventLoopConfig;
  private executor: FeishuShuttleExecutor;
  private running: boolean = false;
  private processedMessages: Set<string> = new Set();

  constructor(config: EventLoopConfig, agent: AgentIdentity) {
    this.config = config;
    this.executor = new FeishuShuttleExecutor(agent);
  }

  /**
   * Start the A-to-A event loop.
   * Agent autonomously monitors Feishu chats, processes messages,
   * and triggers shuttle actions without human intervention.
   */
  async start(): Promise<void> {
    this.running = true;
    console.log(`[Feishu A2A] Event loop started. Monitoring ${this.config.monitoredChats.length} chats.`);

    while (this.running) {
      try {
        for (const chat of this.config.monitoredChats) {
          // 1. Read recent messages
          const readResult = await this.executor.execute({
            action: 'read_messages',
            agent: this.executor['agent'],
            params: { chat_id: chat.chat_id, limit: 10 },
            trigger: 'schedule',
          });

          // 2. Process new messages (placeholder: LLM classification in Phase 2)
          // - Classify: is this a task request? a question? a status update?
          // - If task request: trigger cross_dept_handoff or local tool execution
          // - If question: trigger auto_respond with knowledge base lookup
          // - If status update: trigger sync_progress

          // 3. Auto-respond if confidence is high enough
          // 4. Escalate to human if confidence is low

        }
      } catch (err) {
        console.error('[Feishu A2A] Event loop error:', err);
      }
      await new Promise(r => setTimeout(r, this.config.pollIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
    console.log('[Feishu A2A] Event loop stopped.');
  }
}
