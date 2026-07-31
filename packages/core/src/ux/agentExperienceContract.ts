/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

export type AgentActivityState =
  | 'idle'
  | 'thinking'
  | 'using_tool'
  | 'waiting_for_user'
  | 'running_subagents'
  | 'completed'
  | 'failed';

export interface ToolAvailabilityInput {
  surface: 'main-agent' | 'sub-agent';
  toolName: string;
  registered: boolean;
  lazyRegistered?: boolean;
  intentionallyHidden?: boolean;
}

export interface ToolAvailabilityMessage {
  visible: boolean;
  label: string;
  detail: string;
}

export function describeToolAvailability(input: ToolAvailabilityInput): ToolAvailabilityMessage {
  if (input.intentionallyHidden) {
    return {
      visible: false,
      label: 'Not shown in this mode',
      detail:
        input.surface === 'sub-agent'
          ? 'This tool is intentionally omitted from the lightweight sub-agent profile.'
          : 'This tool is hidden by the current product configuration.',
    };
  }

  if (!input.registered) {
    return {
      visible: false,
      label: 'Unavailable',
      detail: 'This tool is not registered in the current session.',
    };
  }

  return {
    visible: true,
    label: 'Ready',
    detail: input.lazyRegistered
      ? 'Loaded during session setup so the user can invoke it without a first-use delay.'
      : 'Available immediately in the current session.',
  };
}

export function summarizeAgentActivity(state: AgentActivityState, activeSubAgents: number = 0): string {
  switch (state) {
    case 'idle':
      return 'Ready';
    case 'thinking':
      return 'Thinking';
    case 'using_tool':
      return 'Using a tool';
    default:
      return 'Unknown';
    case 'waiting_for_user':
      return 'Needs your input';
    case 'running_subagents':
      return activeSubAgents > 0
        ? `Working with ${activeSubAgents} sub-agent${activeSubAgents === 1 ? '' : 's'}`
        : 'Working with sub-agents';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Needs attention';
  }
}

export function shouldShowUnreadDot(params: {
  source: 'user' | 'agent' | 'system' | 'external';
  sessionFocused: boolean;
  requiresUserAction?: boolean;
}): boolean {
  if (params.sessionFocused) return false;
  if (params.requiresUserAction) return true;
  return params.source === 'agent' || params.source === 'external';
}
