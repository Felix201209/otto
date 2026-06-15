/**
 * SubAgentDisplayRenderer Component - Web版
 * 用于在VSCode插件中显示SubAgent执行状态
 */

import React from 'react';
import './Renderers.css';
import { useTranslation } from '../../hooks/useTranslation';

interface ToolCall {
  id?: string;
  callId?: string; // 🎯 兼容 callId
  name?: string;
  toolName?: string; // 🎯 兼容 toolName
  displayName?: string;
  status: string;
  description?: string;
  parameters?: Record<string, any>; // 🎯 添加参数支持
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface SubAgentStats {
  totalToolCalls: number;
  tokenUsage?: TokenUsage;
}

interface SubAgentDisplay {
  type: 'subagent_display';
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'Success' | 'Error'; // 🎯 兼容大写
  startTime: number;
  endTime?: number;
  taskDescription?: string;
  description?: string;
  currentTurn?: number;
  maxTurns?: number;
  toolCalls?: ToolCall[];
  stats: SubAgentStats;
  error?: string;
}

interface SubAgentDisplayRendererProps {
  data: SubAgentDisplay;
}

/**
 * 获取状态信息
 */
const getStatusInfo = (status: string) => {
  const s = status.toLowerCase();
  switch (s) {
    case 'starting':
    case 'running':
      return { icon: '●', color: 'var(--vscode-charts-blue)' };
    case 'completed':
    case 'success': // 🎯 兼容 success
      return { icon: '✓', color: 'var(--vscode-charts-green)' };
    case 'failed':
    case 'error': // 🎯 兼容 error
      return { icon: '✗', color: 'var(--vscode-charts-red)' };
    case 'cancelled':
      return { icon: '■', color: 'var(--vscode-charts-yellow)' };
    default:
      return { icon: '●', color: 'var(--vscode-foreground)' };
  }
};

/**
 * 获取工具状态图标
 */
const getToolStatusIcon = (status: string): string => {
  const s = status.toLowerCase();
  switch (s) {
    case 'pending':
    case 'scheduled':
      return '●'; // 🎯 统一使用实心圆
    case 'executing':
    case 'running':
      return '●'; // 🎯 统一使用实心圆
    case 'subagent_running':
      return '●';
    case 'success':
      return '●'; // 🎯 统一使用实心圆
    case 'error':
    case 'failed':
      return '●'; // 🎯 统一使用实心圆
    case 'canceled':
    case 'cancelled':
      return '●'; // 🎯 统一使用实心圆
    case 'confirming':
    case 'awaiting_approval':
      return '?';
    default:
      return '●'; // 🎯 默认显示实心圆
  }
};

/**
 * 格式化执行时间
 */
const formatDuration = (durationMs?: number): string => {
  if (!durationMs) return '';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

/**
 * 格式化Token使用量
 */
const formatTokenUsage = (tokenUsage?: TokenUsage): string => {
  if (!tokenUsage || tokenUsage.totalTokens === 0) {
    return '0';
  }

  const { totalTokens } = tokenUsage;
  if (totalTokens >= 1000) {
    return `${(totalTokens / 1000).toFixed(1)}k`;
  }
  return totalTokens.toString();
};

/**
 * 格式化工具描述
 */
const formatToolDescription = (toolCall: ToolCall): string => {
  const desc = toolCall.description || '';
  const toolName = toolCall.toolName || toolCall.name || '';

  let result = '';

  // 🎯 处理 sequentialthinking 的 JSON 描述
  if (toolName === 'sequentialthinking' && desc.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(desc);
      result = parsed.thought || desc;
    } catch (e) {
      result = desc;
    }
  } else {
    // 🎯 兜底：从参数中提取
    const params = toolCall.parameters || {};
    result = desc || params.command || params.file_path || params.path || params.pattern || '';
  }

  if (!result) return '';

  return result;
};

/**
 * 获取工具状态颜色
 */
const getToolStatusColor = (status: string): string => {
  const s = status.toLowerCase();
  switch (s) {
    case 'pending':
    case 'scheduled':
      return 'var(--vscode-charts-blue)';
    case 'executing':
    case 'running':
      return 'var(--vscode-charts-orange)';
    case 'success':
    case 'completed':
      return 'var(--vscode-charts-green)';
    case 'error':
    case 'failed':
      return 'var(--vscode-charts-red)';
    case 'canceled':
    case 'cancelled':
      return 'var(--vscode-descriptionForeground)';
    default:
      return 'var(--vscode-charts-blue)';
  }
};

export const SubAgentDisplayRenderer: React.FC<SubAgentDisplayRendererProps> = ({ data }) => {
  const { t } = useTranslation();
  const statusInfo = getStatusInfo(data.status);

  console.log('🎯 [SubAgentDisplayRenderer] Rendering SubAgent data:', data);

  // 🎯 渲染任务信息头
  const renderTaskHeader = () => {
    const isRunning = data.status === 'starting' || data.status === 'running';

    return (
      <div className="subagent-task-header">
        <div className="subagent-task-title-row">
          <span className="subagent-status-icon" style={{ color: statusInfo.color }}>
            {statusInfo.icon}
          </span>
          <span className="subagent-task-brief">{data.description || '代码分析'}</span>
          {isRunning && data.maxTurns !== undefined && (
            <span className="subagent-task-progress">
              Turn {data.currentTurn ?? 0}/{data.maxTurns}
            </span>
          )}
        </div>

        {data.taskDescription && (
          <div className="subagent-task-description">
            {data.taskDescription}
          </div>
        )}
      </div>
    );
  };

  // 渲染执行中的工具列表
  const renderRunningToolsList = () => {
    if (!data.toolCalls || data.toolCalls.length === 0) return null;

    return (
      <div className="subagent-running-tools">
        {data.toolCalls.map((toolCall, index) => {
          const isLast = index === data.toolCalls!.length - 1;
          const connector = isLast ? '└' : '├';

          const toolDesc = formatToolDescription(toolCall);

          return (
            <div key={toolCall.id || toolCall.callId} className="subagent-tool-item">
              <span className="subagent-connector">{connector}─</span>
              <span className="subagent-tool-icon" style={{ color: getToolStatusColor(toolCall.status) }}>
                {getToolStatusIcon(toolCall.status)}
              </span>
              <span className="subagent-tool-name">
                {toolCall.displayName || toolCall.toolName || toolCall.name}
              </span>
              {toolDesc && (
                <span className="subagent-tool-desc">
                  {toolDesc}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // 渲染完成状态的统计信息
  const renderCompletedStats = () => {
    const totalDuration = data.endTime ? data.endTime - data.startTime : 0;
    const formattedDuration = formatDuration(totalDuration);

    return (
      <div className="subagent-stats">
        <div className="subagent-stat-item">
          <span className="subagent-connector">├─</span>
          <span className="subagent-stat-label">{t('subagent.toolCalls')}</span>
          <span className="subagent-stat-value">{t('subagent.toolCallsCount', { count: data.stats.totalToolCalls })}</span>
        </div>

        <div className="subagent-stat-item">
          <span className="subagent-connector">├─</span>
          <span className="subagent-stat-label">{t('subagent.executionTime')}</span>
          <span className="subagent-stat-value">{formattedDuration || '< 1ms'}</span>
        </div>

        <div className="subagent-stat-item">
          <span className="subagent-connector">├─</span>
          <span className="subagent-stat-label">{t('subagent.tokenConsumption')}</span>
          <span className="subagent-stat-value">{formatTokenUsage(data.stats.tokenUsage)}</span>
        </div>

        <div className="subagent-stat-item">
          <span className="subagent-connector">└─</span>
          <span className="subagent-stat-label">{t('subagent.turns')}</span>
          <span className="subagent-stat-value">{data.currentTurn ?? '-'}/{data.maxTurns ?? '-'}</span>
        </div>

        {/* 错误信息 */}
        {data.status === 'failed' && data.error && (
          <div className="subagent-error">
            <span className="subagent-error-icon">⚠️</span>
            <span className="subagent-error-text">{data.error}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="subagent-display-container">
      {/* 🎯 任务头 */}
      {renderTaskHeader()}

      {/* 渲染内容 */}
      {(data.status === 'starting' || data.status === 'running')
        ? renderRunningToolsList()
        : renderCompletedStats()}

      {/* 当前状态提示（仅在执行中显示） */}
      {data.status === 'running' && data.toolCalls && data.toolCalls.length > 0 && (
        <div className="subagent-running-hint">
          <span className="subagent-spinner">⠏</span>
          <span className="subagent-running-text">{t('subagent.running')}</span>
        </div>
      )}
    </div>
  );
};
