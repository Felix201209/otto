import { Type } from '@google/genai';
import { BaseTool, Icon, ToolCallConfirmationDetails, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';

export interface FeishuProjectCollabParams {
  action: 'plan' | 'base_plan' | 'progress_sync' | 'reminder_plan' | 'create_base' | 'sync_progress' | 'schedule_reminders' | 'archive_acceptance';
  project_name: string;
  project_goal?: string;
  chat_id?: string;
  base_token?: string;
  table_id?: string;
  spreadsheet_token?: string;
  acceptance_content?: string;
  collaborators?: Array<{ name: string; role: string; responsibility: string }>;
  acceptance_nodes?: Array<{ name: string; due: string; standard: string; owner?: string; reminderMinutesBefore?: number }>;
  progress_owner?: string;
  progress_content?: string;
  progress_percent?: number;
}

const json = (value: unknown) => JSON.stringify(value ?? [], null, 2);

export class FeishuProjectCollabTool extends BaseTool<FeishuProjectCollabParams, ToolResult> {
  static readonly Name = 'feishu_project_collab';

  constructor(_config: Config) {
    super(
      FeishuProjectCollabTool.Name,
      'FeishuProjectCollab',
      'Plans Feishu project collaboration: project purpose, responsibilities, acceptance standards, milestones, progress sync, reminders, and Base/Sheet automation commands.',
      Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: ['plan', 'base_plan', 'progress_sync', 'reminder_plan', 'create_base', 'sync_progress', 'schedule_reminders', 'archive_acceptance'] },
          project_name: { type: Type.STRING },
          project_goal: { type: Type.STRING },
          chat_id: { type: Type.STRING },
          base_token: { type: Type.STRING },
          table_id: { type: Type.STRING },
          spreadsheet_token: { type: Type.STRING },
          acceptance_content: { type: Type.STRING },
          collaborators: { type: Type.ARRAY, items: { type: Type.OBJECT } },
          acceptance_nodes: { type: Type.ARRAY, items: { type: Type.OBJECT } },
          progress_owner: { type: Type.STRING },
          progress_content: { type: Type.STRING },
          progress_percent: { type: Type.NUMBER },
        },
        required: ['action', 'project_name'],
      },
    );
  }

  validateToolParams(params: FeishuProjectCollabParams): string | null {
    const error = SchemaValidator.validate(this.schema.parameters!, params, FeishuProjectCollabTool.Name);
    if (error) return error;
    if ((params.action === 'progress_sync' || params.action === 'sync_progress') && !params.progress_content) return 'progress sync requires progress_content';
    return null;
  }

  getDescription(params: FeishuProjectCollabParams): string {
    return 'Prepare Feishu collaboration plan for ' + params.project_name;
  }

  shouldConfirmExecute(_params: FeishuProjectCollabParams, _signal: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    return Promise.resolve(false);
  }

  async execute(params: FeishuProjectCollabParams): Promise<ToolResult> {
    const validation = this.validateToolParams(params);
    if (validation) return { llmContent: 'feishu_project_collab FAIL: ' + validation, returnDisplay: validation };
    const text = this.render(params);
    return { llmContent: text, returnDisplay: text };
  }

  private render(params: FeishuProjectCollabParams): string {
    if (params.action === 'create_base') return this.createBasePlan(params);
    if (params.action === 'sync_progress') return this.progress(params);
    if (params.action === 'schedule_reminders') return this.reminders(params);
    if (params.action === 'archive_acceptance') return this.archiveAcceptance(params);
    if (params.action === 'base_plan') return this.basePlan(params);
    if (params.action === 'progress_sync') return this.progress(params);
    if (params.action === 'reminder_plan') return this.reminders(params);
    return this.plan(params);
  }

  private plan(params: FeishuProjectCollabParams): string {
    return [
      '# Feishu Project Collaboration Plan', '',
      '## Project', '- Name: ' + params.project_name, '- Goal: ' + (params.project_goal || 'TBD'), '',
      '## Tables', '1. Project Charter: purpose, scope, owner, success criteria.', '2. Responsibility Matrix: collaborator, role, responsibility, expected output.', '3. Acceptance Milestones: node, due date, standard, owner, reminder time.', '4. Progress Log: owner, update, percent, blocker, next step, updated time.', '5. Risk Register: risk, impact, owner, mitigation, status.', '',
      '## Collaborators', json(params.collaborators), '',
      '## Acceptance nodes', json(params.acceptance_nodes), '',
      '## Automation', '- Create Feishu Base or Sheet at project start.', '- Append one row for every progress update.', '- Remind owners before each acceptance node.', '- Archive accepted output into Otto Project Memory.',
    ].join('\n');
  }

  private basePlan(params: FeishuProjectCollabParams): string {
    return ['# Feishu Base Automation Plan', '', 'lark-cli plan:', '1. base +base-create --name "' + params.project_name + ' Project Collaboration"', '2. Create tables: Project Charter, Responsibility Matrix, Acceptance Milestones, Progress Log, Risk Register.', '3. base +record-batch-create for goals, collaborators, milestones, progress.', '4. im +messages-send to notify the project chat.', '', 'Collaborators:', json(params.collaborators), '', 'Acceptance nodes:', json(params.acceptance_nodes)].join('\n');
  }

  private progress(params: FeishuProjectCollabParams): string {
    return ['# Progress Sync Plan', '', '- Project: ' + params.project_name, '- Owner: ' + (params.progress_owner || 'unknown'), '- Progress: ' + (params.progress_percent ?? 0) + '%', '- Update: ' + params.progress_content, '', 'Feishu actions:', '- Append Progress Log row.', '- Notify project chat when chat_id exists.', '- Update Risk Register if blocker appears.', '- Save important decisions into Otto Project Memory.'].join('\n');
  }

  private reminders(params: FeishuProjectCollabParams): string {
    const reminders = (params.acceptance_nodes || []).map((node) => ({ node: node.name, owner: node.owner || 'TBD', due: node.due, reminderMinutesBefore: node.reminderMinutesBefore ?? 1440, message: 'Acceptance node upcoming: ' + node.name + '. Standard: ' + node.standard }));
    return ['# Acceptance Reminder Plan', '', json(reminders), '', 'Feishu actions:', '- calendar +create for acceptance reminders, or scheduled project bot messages.', '- Mention owner before due date.', '- Ask owner to submit acceptance evidence and update milestone status.'].join('\n');
  }

  private createBasePlan(params: FeishuProjectCollabParams): string {
    return ['# Executable Base Creation', '', 'lark-cli base +base-create --name ' + JSON.stringify(params.project_name + ' Project Collaboration'), 'After base is created, create tables: Project Charter, Responsibility Matrix, Acceptance Milestones, Progress Log, Risk Register.', 'Then run base +record-batch-create for project goal, collaborators, and milestones.'].join('\n');
  }

  private archiveAcceptance(params: FeishuProjectCollabParams): string {
    const target = params.base_token ? 'base ' + params.base_token : 'sheet ' + (params.spreadsheet_token || '<spreadsheet_token>');
    return ['# Executable Acceptance Archive', '', 'Target: ' + target, 'Content: ' + (params.acceptance_content || params.progress_content || 'Acceptance output archived.'), 'Next: append archive row and promote accepted output into Otto Project Memory.'].join('\n');
  }

}
