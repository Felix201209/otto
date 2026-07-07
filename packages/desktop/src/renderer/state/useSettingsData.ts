/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置/诊断面板的状态管理（P0）。与 useOttoStore（会话/聊天）解耦成独立 hook，
 * 因为这块数据（settings/mcp/context/stats/doctor/todos）与消息流无关，
 * 混进主 reducer 会让 App 的聊天路径多绕一层不相关状态更新。
 *
 * 协议帧对应关系（packages/server/src/protocol.ts）：
 *   get_settings -> settings
 *   set_setting  -> settings（成功后广播）/ error
 *   mcp_list     -> mcp_servers
 *   mcp_add/mcp_remove -> mcp_servers（成功后广播）/ error
 *   get_context_breakdown -> context_breakdown
 *   get_stats    -> stats_snapshot
 *   run_doctor   -> doctor_report
 *   get_todos    -> todos_list
 *
 * Todo 列表额外做「主动订阅」：todo_write 工具执行后 server 目前不会主动推
 * todos_list（P0 范围内未加新的广播时机，避免过度扩协议），面板改为在打开时
 * 拉一次 + 会话状态变为 idle 时（一轮结束）自动刷新一次，足够覆盖「任务列表
 * 面板」的核心场景，且不需要 server 新增广播逻辑。
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import * as transport from '../transport.js';
import type {
  SettingsSnapshot,
  McpServerInfo,
  ContextBreakdown,
  StatsSnapshot,
  DoctorReportInfo,
  TodoItemInfo,
  MemoryFileInfo,
  SkillSummary,
  ToolSummary,
  WorkflowSummary,
  ExtensionSummary,
  IdeConnectionStatusValue,
  ServerToClient,
} from 'otto-server';

export interface SettingsDataState {
  settings: SettingsSnapshot | null;
  mcpServers: McpServerInfo[];
  contextBreakdown: ContextBreakdown | null;
  stats: StatsSnapshot | null;
  doctorReport: DoctorReportInfo | null;
  doctorRunning: boolean;
  todos: TodoItemInfo[];
  memoryFiles: MemoryFileInfo[];
  skills: SkillSummary[];
  tools: ToolSummary[];
  compressRunning: boolean;
  compressMessage: string | null;
  /** 最近一次导出结果提示（成功给保存路径，取消/失败给说明）；null = 未导出过。 */
  exportMessage: string | null;
  workflows: WorkflowSummary[];
  extensions: ExtensionSummary[];
  ideStatus: { status: IdeConnectionStatusValue; details?: string } | null;
  lastError: string | null;
}

const initialState: SettingsDataState = {
  settings: null,
  mcpServers: [],
  contextBreakdown: null,
  stats: null,
  doctorReport: null,
  doctorRunning: false,
  todos: [],
  memoryFiles: [],
  skills: [],
  tools: [],
  compressRunning: false,
  compressMessage: null,
  exportMessage: null,
  workflows: [],
  extensions: [],
  ideStatus: null,
  lastError: null,
};

type Action =
  | { kind: 'frame'; frame: ServerToClient }
  | { kind: 'doctor_running' }
  | { kind: 'compress_running' }
  | { kind: 'export_message'; message: string | null }
  | { kind: 'clear_error' };

function reducer(state: SettingsDataState, action: Action): SettingsDataState {
  switch (action.kind) {
    case 'doctor_running':
      return { ...state, doctorRunning: true };
    case 'compress_running':
      return { ...state, compressRunning: true, compressMessage: null };
    case 'export_message':
      return { ...state, exportMessage: action.message };
    case 'clear_error':
      return state.lastError === null ? state : { ...state, lastError: null };
    case 'frame': {
      const frame = action.frame;
      switch (frame.type) {
        case 'settings':
          return { ...state, settings: frame.payload };
        case 'mcp_servers':
          return { ...state, mcpServers: frame.payload.servers };
        case 'context_breakdown':
          return { ...state, contextBreakdown: frame.payload };
        case 'stats_snapshot':
          return { ...state, stats: frame.payload };
        case 'doctor_report':
          return { ...state, doctorReport: frame.payload, doctorRunning: false };
        case 'todos_list':
          return { ...state, todos: frame.payload.todos };
        case 'memory_snapshot':
          return { ...state, memoryFiles: frame.payload.files };
        case 'skills_list':
          return { ...state, skills: frame.payload.skills };
        case 'tools_list':
          return { ...state, tools: frame.payload.tools };
        case 'compress_result':
          return {
            ...state,
            compressRunning: false,
            compressMessage: frame.payload.message,
          };
        case 'export_result':
          // 落盘副作用（saveTextFile）在 hook 的帧订阅里处理；这里仅穿透 state 无变化。
          return state;
        case 'workflows_list':
          return { ...state, workflows: frame.payload.workflows };
        case 'extensions_list':
          return { ...state, extensions: frame.payload.extensions };
        case 'ide_status':
          return { ...state, ideStatus: frame.payload };
        case 'error':
          // 仅拦截本面板相关的错误码，避免抢主聊天 toast 的错误展示。
          if (
            frame.payload.code === 'set_setting_failed' ||
            frame.payload.code === 'mcp_add_failed' ||
            frame.payload.code === 'mcp_remove_failed' ||
            frame.payload.code === 'doctor_failed' ||
            frame.payload.code === 'get_memory_failed' ||
            frame.payload.code === 'add_memory_failed' ||
            frame.payload.code === 'get_skills_failed' ||
            frame.payload.code === 'get_tools_failed' ||
            frame.payload.code === 'compress_failed'
          ) {
            return {
              ...state,
              lastError: frame.payload.message,
              doctorRunning:
                frame.payload.code === 'doctor_failed' ? false : state.doctorRunning,
              compressRunning:
                frame.payload.code === 'compress_failed' ? false : state.compressRunning,
            };
          }
          return state;
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

export interface SettingsDataActions {
  refreshSettings(): void;
  setSetting(key: 'agentStyle' | 'healthyUse' | 'preferredLanguage', value: string | boolean): void;
  refreshMcpServers(): void;
  addMcpServer(payload: {
    name: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;
    timeout?: number;
    trust?: boolean;
    description?: string;
  }): void;
  removeMcpServer(name: string): void;
  refreshContextBreakdown(sessionId: string): void;
  refreshStats(): void;
  runDoctor(): void;
  refreshTodos(): void;
  refreshMemory(): void;
  addMemory(fact: string): void;
  refreshSkills(): void;
  refreshTools(sessionId: string): void;
  compressContext(sessionId: string): void;
  exportConversation(sessionId: string): void;
  clearExportMessage(): void;
  refreshWorkflows(): void;
  refreshExtensions(): void;
  refreshIdeStatus(): void;
  clearError(): void;
}

export interface UseSettingsData {
  state: SettingsDataState;
  actions: SettingsDataActions;
}

export function useSettingsData(): UseSettingsData {
  const [state, dispatch] = useReducer(reducer, initialState);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const unsub = transport.onFrame((frame) => {
      if (!mountedRef.current) return;
      dispatch({ kind: 'frame', frame });
      // 导出结果的落盘是纯 UI 副作用（原生保存对话框），不适合塞进 reducer；
      // 在这里拦截并异步触发，完成后回填一句人类可读的提示。
      if (frame.type === 'export_result') {
        const { suggestedFileName, markdown } = frame.payload;
        void window.otto
          .saveTextFile(suggestedFileName, markdown)
          .then((savedPath) => {
            if (!mountedRef.current) return;
            dispatch({
              kind: 'export_message',
              message: savedPath ? `已导出到：${savedPath}` : '已取消导出。',
            });
          })
          .catch((e: unknown) => {
            if (!mountedRef.current) return;
            const message = e instanceof Error ? e.message : String(e);
            dispatch({ kind: 'export_message', message: `导出失败：${message}` });
          });
      }
    });
    return () => {
      mountedRef.current = false;
      unsub();
    };
  }, []);

  const refreshSettings = useCallback(() => {
    transport.send({ type: 'get_settings', payload: {} });
  }, []);

  const setSetting = useCallback(
    (key: 'agentStyle' | 'healthyUse' | 'preferredLanguage', value: string | boolean) => {
      transport.send({ type: 'set_setting', payload: { key, value } });
    },
    [],
  );

  const refreshMcpServers = useCallback(() => {
    transport.send({ type: 'mcp_list', payload: {} });
  }, []);

  const addMcpServer = useCallback<SettingsDataActions['addMcpServer']>((payload) => {
    transport.send({ type: 'mcp_add', payload });
  }, []);

  const removeMcpServer = useCallback((name: string) => {
    transport.send({ type: 'mcp_remove', payload: { name } });
  }, []);

  const refreshContextBreakdown = useCallback((sessionId: string) => {
    if (!sessionId) return;
    transport.send({ type: 'get_context_breakdown', payload: { sessionId } });
  }, []);

  const refreshStats = useCallback(() => {
    transport.send({ type: 'get_stats', payload: {} });
  }, []);

  const runDoctor = useCallback(() => {
    dispatch({ kind: 'doctor_running' });
    transport.send({ type: 'run_doctor', payload: {} });
  }, []);

  const refreshTodos = useCallback(() => {
    transport.send({ type: 'get_todos', payload: {} });
  }, []);

  const refreshMemory = useCallback(() => {
    transport.send({ type: 'get_memory', payload: {} });
  }, []);

  const addMemory = useCallback((fact: string) => {
    transport.send({ type: 'add_memory', payload: { fact } });
  }, []);

  const refreshSkills = useCallback(() => {
    transport.send({ type: 'get_skills', payload: {} });
  }, []);

  const refreshTools = useCallback((sessionId: string) => {
    if (!sessionId) return;
    transport.send({ type: 'get_tools', payload: { sessionId } });
  }, []);

  const compressContext = useCallback((sessionId: string) => {
    if (!sessionId) return;
    dispatch({ kind: 'compress_running' });
    transport.send({ type: 'compress_context', payload: { sessionId } });
  }, []);

  const exportConversation = useCallback((sessionId: string) => {
    if (!sessionId) return;
    transport.send({ type: 'export_conversation', payload: { sessionId } });
  }, []);

  const clearExportMessage = useCallback(() => {
    dispatch({ kind: 'export_message', message: null });
  }, []);

  const refreshWorkflows = useCallback(() => {
    transport.send({ type: 'get_workflows', payload: {} });
  }, []);

  const refreshExtensions = useCallback(() => {
    transport.send({ type: 'get_extensions', payload: {} });
  }, []);

  const refreshIdeStatus = useCallback(() => {
    transport.send({ type: 'get_ide_status', payload: {} });
  }, []);

  const clearError = useCallback(() => {
    dispatch({ kind: 'clear_error' });
  }, []);

  return {
    state,
    actions: {
      refreshSettings,
      setSetting,
      refreshMcpServers,
      addMcpServer,
      removeMcpServer,
      refreshContextBreakdown,
      refreshStats,
      runDoctor,
      refreshTodos,
      refreshMemory,
      addMemory,
      refreshSkills,
      refreshTools,
      compressContext,
      exportConversation,
      clearExportMessage,
      refreshWorkflows,
      refreshExtensions,
      refreshIdeStatus,
      clearError,
    },
  };
}
