/**
 * ToolCallList Component - 工具调用列表管理
 */

import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Circle, Disc, RotateCcw, CheckCircle, XCircle, AlertTriangle, Square, HelpCircle, Info, Check, X, Zap, ShieldAlert, Repeat, PlayCircle } from 'lucide-react';
import { ToolCall } from '../types';
import { useTranslation } from '../hooks/useTranslation';
import { TOOL_CALL_STATUS } from '../constants/toolConstants';
import { TodoDisplayRenderer } from './renderers/TodoDisplayRenderer';
import { SubAgentDisplayRenderer } from './renderers/SubAgentDisplayRenderer';
import { DiffRenderer } from './renderers/DiffRenderer';
import { BackgroundTaskOutputRenderer } from './renderers/BackgroundTaskOutputRenderer';
import { GoalAchievedDisplayRenderer } from './renderers/GoalAchievedDisplayRenderer';
import { GoalRejectedDisplayRenderer } from './renderers/GoalRejectedDisplayRenderer';
import { AskUserQuestionMessage } from './AskUserQuestionMessage';
import './renderers/Renderers.css';

// 结果类型检测函数
const getResultType = (result: any): string | null => {
  if (!result || typeof result === 'string') return null;

  const dataType = result?.data?.type || result?.type;

  // 检查特殊渲染类型
  if (dataType === 'todo_display') return 'todo_display';
  if (dataType === 'subagent_display' || dataType === 'subagent_update') return 'subagent_display';
  if (dataType === 'goal_achieved_display') return 'goal_achieved_display';
  if (dataType === 'goal_rejected_display') return 'goal_rejected_display';
  if (result?.fileDiff || result?.data?.fileDiff) return 'diff_display';
  if (result?.toolName === 'background_task_output' || result?.data?.toolName === 'background_task_output') return 'background_task_output';

  return null;
};

// 结果渲染函数 - 根据结果类型选择不同的渲染器
const renderResult = (result: any): React.ReactNode => {
  console.log('🎯 [renderResult] Processing result:', result);

  // 🔍 专门检查lint相关数据
  if (result && typeof result === 'object') {
    if (result.lintStatus || result.lintDiagnostics) {
      console.log('🔍 [LINT-CHECK] Found lint data in result:', {
        lintStatus: result.lintStatus,
        lintDiagnostics: result.lintDiagnostics
      });
    }

    if (result.data && (result.data.lintStatus || result.data.lintDiagnostics)) {
      console.log('🔍 [LINT-CHECK] Found lint data in result.data:', {
        lintStatus: result.data.lintStatus,
        lintDiagnostics: result.data.lintDiagnostics
      });
    }
  }

  // 字符串结果 - 先检查是否是特殊JSON格式
  if (typeof result === 'string') {
    console.log('🎯 [renderResult] String result');
    // 尝试parse字符串看是否是特殊格式
    if (result.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(result);

        // 🎯 SubAgent显示 - 支持两种格式
        if (parsed.type === 'subagent_update' && parsed.data?.type === 'subagent_display') {
          // 格式1: {"type":"subagent_update","data":{"type":"subagent_display",...}}
          console.log('🎯 [renderResult] SubAgent update detected in string');
          return <SubAgentDisplayRenderer data={parsed.data} />;
        } else if (parsed.type === 'subagent_display') {
          // 格式2: {"type":"subagent_display",...}
          console.log('🎯 [renderResult] SubAgent display detected in string');
          return <SubAgentDisplayRenderer data={parsed} />;
        }
      } catch (e) {
        // 不是JSON，继续按字符串处理
      }
    }
    return <pre>{result}</pre>;
  }

  // 检查 result.data.type 结构
  const dataType = result?.data?.type || result?.type;
  console.log('🎯 [renderResult] Detected type:', dataType);

  // TODO显示 - 检查两种可能的结构
  if (dataType === 'todo_display') {
    console.log('🎯 [renderResult] TODO display detected');
    const todoData = result.data || result;
    return <TodoDisplayRenderer data={todoData} />;
  }

  // SubAgent显示 - 检查两种可能的结构
  if (dataType === 'subagent_display' || dataType === 'subagent_update') {
    console.log('🎯 [renderResult] SubAgent display detected');
    let agentData = result;
    if (result.data) {
      agentData = dataType === 'subagent_update' ? result.data.data : result.data;
    }
    return <SubAgentDisplayRenderer data={agentData} />;
  }

  // 🎯 Goal achieved 完成卡片 - 见 GoalAchievedDisplayRenderer 的设计注释
  if (dataType === 'goal_achieved_display') {
    console.log('🎯 [renderResult] Goal achieved display detected');
    const goalData = result.data || result;
    return <GoalAchievedDisplayRenderer data={goalData} />;
  }

  // 🎯 Goal rejected 拒绝卡片
  if (dataType === 'goal_rejected_display') {
    console.log('🎯 [renderResult] Goal rejected display detected');
    const rejectData = result.data || result;
    return <GoalRejectedDisplayRenderer data={rejectData} />;
  }

  // Diff显示 - 检查两种可能的结构
  if (result?.fileDiff || result?.data?.fileDiff) {
    console.log('🎯 [renderResult] Diff display detected');
    const diffData = result.data || result;
    return <DiffRenderer data={diffData} simplified={false} />;
  }

  // 🎯 后台任务输出显示
  if (result?.toolName === 'background_task_output' || result?.data?.toolName === 'background_task_output') {
    console.log('🎯 [renderResult] Background task output detected');
    // 直接传递 result，渲染器内部会处理 data 字段
    return <BackgroundTaskOutputRenderer data={result} />;
  }

  // 其他对象结果 - 只显示data字段，使用横向滚动
  console.log('🎯 [renderResult] Fallback to JSON display');
  const dataToShow = result?.data || result;

  // 共用的内联样式，保留原有换行但不自动换行
  const noAutoWrapStyle = {
    whiteSpace: 'pre' as const, // 保留换行符，但不自动换行
    overflowX: 'auto' as const,
    overflowY: 'auto' as const,
    wordBreak: 'normal' as const,
    wordWrap: 'normal' as const,
    maxWidth: '100%'
  };

  // 如果是字符串，直接显示原始内容，不进行JSON序列化
  if (typeof dataToShow === 'string') {
    return <pre className="compact-json-result" style={noAutoWrapStyle}>{dataToShow}</pre>;
  }

  // 如果是对象，尝试智能显示
  if (typeof dataToShow === 'object' && dataToShow !== null) {
    // 如果对象有content字段，优先显示content
    if (dataToShow.content && typeof dataToShow.content === 'string') {
      return <pre className="compact-json-result" style={noAutoWrapStyle}>{dataToShow.content}</pre>;
    }
    // 如果对象有text字段，显示text
    if (dataToShow.text && typeof dataToShow.text === 'string') {
      return <pre className="compact-json-result" style={noAutoWrapStyle}>{dataToShow.text}</pre>;
    }
    // 如果对象有message字段，显示message
    if (dataToShow.message && typeof dataToShow.message === 'string') {
      return <pre className="compact-json-result" style={noAutoWrapStyle}>{dataToShow.message}</pre>;
    }
  }

  // 其他情况才使用JSON序列化
  return <pre className="compact-json-result" style={noAutoWrapStyle}>{JSON.stringify(dataToShow, null, 2)}</pre>;
};

// 单个工具调用项组件
const ToolCallItem: React.FC<{
  toolCall: ToolCall;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onConfirm: (
    confirmed: boolean,
    userInput?: string,
    outcome?: string,
    extra?: {
      answers?: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
      feedback?: string;
    }
  ) => void;
  onMoveToBackground?: (toolCallId: string) => void;
  isInPlanMode?: boolean;
}> = ({ toolCall, isExpanded, onToggleExpand, onConfirm, onMoveToBackground, isInPlanMode = false }) => {
  const { t } = useTranslation();
  const [userInput, setUserInput] = useState('');
  const liveOutputRef = useRef<HTMLDivElement>(null);
  const [permissionMode, setPermissionMode] = useState<'once' | 'always_type' | 'always_project'>('once');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 🎯 直接在渲染时计算，不依赖useState和useEffect
  const hasConfirmation = toolCall.status === TOOL_CALL_STATUS.WAITING_FOR_CONFIRMATION;

  // 🎯 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isDropdownOpen]);

  // 🎯 检测是否为todo结果且工具已执行完成
  const isTodoResultCompleted = () => {
    const result = toolCall.result as any;
    const dataType = result?.data?.type || result?.type;
    return dataType === 'todo_display' && toolCall.status === TOOL_CALL_STATUS.SUCCESS;
  };

  // 🎯 自动滚动到实时输出底部
  useEffect(() => {
    if (liveOutputRef.current && toolCall.liveOutput) {
      liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
    }
  }, [toolCall.liveOutput]);

  // 🎯 确认选择处理函数
  const handleConfirmationChoice = (choice: string) => {
    let confirmed = true;
    let outcome: string | undefined;

    switch (choice) {
      case 'once':
        outcome = 'proceed_once';
        break;
      case 'always_type':
        outcome = 'proceed_always';
        break;
      case 'always_project':  // 🎯 关键选项
        outcome = 'proceed_always_project';
        break;
      case 'cancel':
        confirmed = false;
        outcome = 'cancel';
        break;
      default:
        confirmed = false;
        outcome = 'cancel';
    }

    // 🎯 扩展onConfirm调用以传递outcome
    onConfirm(confirmed, userInput.trim() || undefined, outcome);
  };

  // 🎯 获取工具执行结果摘要
  const getToolResultSummary = (): React.ReactNode | null => {
    if (toolCall.status !== TOOL_CALL_STATUS.SUCCESS || !toolCall.result) return null;

    const { toolName, result, parameters } = toolCall;
    const data = result.data || result;

    try {
      // 1. read_file / read_many_files
      if (toolName === 'read_file' || toolName === 'read_many_files') {
        const fileName = parameters.file_path || parameters.absolute_path || 'file';
        const shortName = fileName.split(/[/\\]/).pop();

        if (typeof data === 'string') {
          // 🎯 优先匹配摘要格式 1: "(59 lines)"
          const summaryMatch1 = data.match(/\((\d+)\s+lines\)/i);
          if (summaryMatch1) {
            return `Read ${shortName}, ${summaryMatch1[1]} lines`;
          }

          // 🎯 优先匹配摘要格式 2: "read lines: 1-40"
          const summaryMatch2 = data.match(/read\s+lines:\s*(\d+-\d+)/i);
          if (summaryMatch2) {
            return `Read ${shortName}, lines ${summaryMatch2[1]}`;
          }

          // 可能是多文件合并的字符串
          const fileCount = (data.match(/--- .*? ---/g) || []).length;
          if (fileCount > 1) return `Read ${fileCount} files`;

          // ❌ 移除不可靠的兜底行数计算
          // const lineCount = data.split('\n').length;
          // return `Read ${shortName}, ${lineCount} lines`;

          // 如果无法解析，返回 null，不显示摘要
          return null;
        } else if (data && data.content) {
          const lineCount = data.content.split('\n').length;
          return `Read ${shortName}, ${lineCount} lines`;
        }
      }

      // 2. list_directory / ls
      if (toolName === 'list_directory' || toolName === 'ls') {
        if (Array.isArray(data)) {
          return `Listed ${data.length} items`;
        } else if (typeof data === 'string') {
          // 🎯 优先匹配摘要格式: "Listed 13 item(s)."
          const summaryMatch = data.match(/Listed\s+(\d+)\s+item/i);
          if (summaryMatch) {
            return `Listed ${summaryMatch[1]} items`;
          }

          // 🎯 处理错误情况
          if (data.startsWith('Error:') || data.includes('Failed to')) {
            return data.split('\n')[0]; // 只显示第一行错误信息
          }

          // ❌ 移除不可靠的兜底行数计算
          // const count = data.trim().split('\n').length;
          // return `Listed ${count} items`;

          return null;
        } else if (data && data.files) {
          return `Listed ${data.files.length} items`;
        }
      }

      // 3. search_file_content / grep
      if (toolName === 'search_file_content' || toolName === 'grep') {
        const pattern = parameters.pattern || parameters.regex || '';
        if (Array.isArray(data)) {
          return `Found ${data.length} matches for "${pattern}"`;
        } else if (typeof data === 'string') {
          // 🎯 优先匹配摘要格式: "Found 20 matches (showing first 10)" 或 "Found 8 matches"
          const summaryMatch = data.match(/Found\s+(\d+)\s+matches/i);
          if (summaryMatch) {
            return `Found ${summaryMatch[1]} matches for "${pattern}"`;
          }

          // 🎯 处理未找到的情况
          if (data.includes('No matches found')) {
            return `No matches found for "${pattern}"`;
          }

          // ❌ 移除不可靠的兜底行数计算
          // const count = data.trim().split('\n').length;
          // return `Found ${count} matches for "${pattern}"`;

          return null;
        }
      }

      // 4. run_shell_command
      if (toolName === 'run_shell_command') {
        if (data.exit_code !== undefined) {
          return `Exit code: ${data.exit_code}`;
        }
      }

      // 5. glob
      if (toolName === 'glob') {
        const pattern = parameters.pattern || '';
        if (Array.isArray(data)) {
          return `Found ${data.length} files for "${pattern}"`;
        } else if (typeof data === 'string') {
          // 🎯 优先匹配摘要格式: "Found 50 matching file(s)"
          const summaryMatch = data.match(/Found\s+(\d+)\s+matching\s+file/i);
          if (summaryMatch) {
            return `Found ${summaryMatch[1]} files for "${pattern}"`;
          }

          // 🎯 处理未找到的情况
          if (data.includes('No files found')) {
            return `No files found for "${pattern}"`;
          }

          return null;
        }
      }

      // 6. replace / edit
      if (toolName === 'replace' || toolName === 'edit') {
        const fileName = parameters.file_path || 'file';
        const shortName = fileName.split(/[/\\]/).pop();

        // 尝试从 diff 中获取增删行数
        if (data && data.fileDiff) {
          // 简单的 diff 解析逻辑 (或者后端直接提供 stats)
          // 这里假设 fileDiff 是标准的 diff 字符串
          const added = (data.fileDiff.match(/^\+/gm) || []).length;
          const removed = (data.fileDiff.match(/^-/gm) || []).length;
          // 减去 header 的 +++ / ---
          const realAdded = Math.max(0, added - 1);
          const realRemoved = Math.max(0, removed - 1);

          return (
            <span>
              Edited {shortName}
              <span style={{ color: 'var(--vscode-gitDecoration-addedResourceForeground)', marginLeft: '6px' }}>+{realAdded}</span>
              <span style={{ color: 'var(--vscode-gitDecoration-deletedResourceForeground)', marginLeft: '6px' }}>-{realRemoved}</span>
            </span>
          );
        }

        // 如果没有 diff，尝试通过 old_string / new_string 计算
        if (parameters.old_string && parameters.new_string) {
          const oldLines = parameters.old_string.split('\n').length;
          const newLines = parameters.new_string.split('\n').length;
          const diff = newLines - oldLines;
          const sign = diff >= 0 ? '+' : '';
          const color = diff > 0 ? 'var(--vscode-gitDecoration-addedResourceForeground)' : (diff < 0 ? 'var(--vscode-gitDecoration-deletedResourceForeground)' : 'inherit');

          return (
            <span>
              Edited {shortName}
              <span style={{ color, marginLeft: '6px' }}>(lines: {sign}{diff})</span>
            </span>
          );
        }

        return `Edited ${shortName}`;
      }

    } catch (e) {
      console.error('Error generating summary:', e);
    }

    return null;
  };

  // 获取工具描述 - 优先使用动态描述，回退到参数格式化
  const getToolDescription = (): React.ReactNode => {
    // 🎯 如果有结果摘要，优先显示摘要
    const summary = getToolResultSummary();
    if (summary) {
      return summary;
    }

    // 🎯 优先使用工具的动态描述（不手动截断，让CSS处理）
    if (toolCall.description) {
      return toolCall.description;
    }

    // 🎯 回退到参数格式化（兼容旧版本）
    const entries = Object.entries(toolCall.parameters);
    if (entries.length === 0) return t('tools.noParameters', {}, 'No parameters');

    const paramStrings = entries.slice(0, 2).map(([key, value]) => {
      const strValue = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}="${strValue}"`;
    });

    const moreCount = Math.max(0, entries.length - 2);
    const result = paramStrings.join(' ');
    return moreCount > 0 ? `${result} +${moreCount} ${t('tools.more', {}, 'more')}` : result;
  };

  // 🎯 渲染确认预览内容
  const renderConfirmationPreview = (): React.ReactNode => {
    const { toolName, parameters, confirmationDetails } = toolCall;

    // 1. 如果是 Shell 命令类
    if (toolName === 'run_shell_command' || toolName === 'bash' || toolName === 'terminal') {
      return (
        <div className="confirmation-preview-item">
          <div className="preview-label">{t('tools.previewCommand', {}, 'Command to run:')}</div>
          <pre className="preview-code command">$ {confirmationDetails?.command || parameters.command || ''}</pre>
        </div>
      );
    }

    // 2. 如果是写入文件
    if (toolName === 'write_file') {
      const fileName = confirmationDetails?.fileName || parameters.file_path || 'file';
      // 🎯 优先使用 confirmationDetails 中的 fileDiff
      const fileDiff = confirmationDetails?.fileDiff;
      if (fileDiff) {
        return (
          <div className="confirmation-diff-preview">
            <DiffRenderer
              data={{
                fileDiff,
                fileName: confirmationDetails?.fileName || fileName,
                originalContent: confirmationDetails?.originalContent,
                newContent: confirmationDetails?.newContent
              }}
              simplified={false}
            />
          </div>
        );
      }
      // 回退显示
      const content = confirmationDetails?.newContent || parameters.content || '';
      return (
        <div className="confirmation-preview-item">
          <div className="preview-label">Writing to: <span className="file-path">{fileName}</span></div>
          <pre className="preview-code content">
            {content.length > 300 ? `${content.substring(0, 300)}...` : content}
          </pre>
        </div>
      );
    }

    // 3. 如果是编辑/替换文件 - 使用 DiffRenderer 显示 diff
    if (toolName === 'replace' || toolName === 'edit') {
      // 🔍 DEBUG: 详细记录 confirmationDetails 内容
      const safeStringify = (obj: any) => {
        try {
          return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'function') return '[Function]';
            return value;
          }, 2)?.substring(0, 500) || 'null';
        } catch (e) {
          return `[Error: ${e}]`;
        }
      };
      console.log('🔍 [ConfirmationPreview] Edit/Replace tool detected:', {
        toolName,
        hasConfirmationDetails: !!confirmationDetails,
        confirmationDetailsKeys: confirmationDetails ? Object.keys(confirmationDetails) : [],
        confirmationDetailsType: confirmationDetails?.type,
        hasFileDiff: !!confirmationDetails?.fileDiff,
        hasFileName: !!confirmationDetails?.fileName,
        fileDiffLength: confirmationDetails?.fileDiff?.length,
        confirmationDetails: safeStringify(confirmationDetails)
      });

      // 🎯 优先从 confirmationDetails 获取 diff 信息
      const fileDiff = confirmationDetails?.fileDiff;
      const fileName = confirmationDetails?.fileName || parameters.file_path || 'file';

      if (fileDiff) {
        console.log('✅ [ConfirmationPreview] Using DiffRenderer with fileDiff');
        return (
          <div className="confirmation-diff-preview">
            <DiffRenderer
              data={{
                fileDiff,
                fileName,
                originalContent: confirmationDetails?.originalContent,
                newContent: confirmationDetails?.newContent
              }}
              simplified={false}
            />
          </div>
        );
      }

      // 回退显示（当没有 fileDiff 时）
      console.warn('⚠️ [ConfirmationPreview] No fileDiff found, falling back to simple display');
      return (
        <div className="confirmation-preview-item">
          <div className="preview-label" style={{ fontSize: '0.85em', opacity: 0.8 }}>
            Modifying: <span className="file-path" style={{ fontSize: '1.15em', opacity: 1 }}>{fileName}</span>
          </div>
        </div>
      );
    }

    // 4. 🎯 删除文件确认 - 显示文件内容预览
    if (toolName === 'delete_file' || confirmationDetails?.type === 'delete') {
      const fileName = confirmationDetails?.fileName || parameters.file_path || 'file';
      const fileContent = confirmationDetails?.fileContent || '';
      const fileSize = confirmationDetails?.fileSize;
      const reason = confirmationDetails?.reason;

      return (
        <div className="confirmation-preview-item">
          <div className="preview-label" style={{ color: 'var(--vscode-gitDecoration-deletedResourceForeground)' }}>
            🗑️ Deleting: <span className="file-path">{fileName}</span>
          </div>
          {fileSize !== undefined && (
            <div className="preview-meta" style={{ fontSize: '0.85em', opacity: 0.7 }}>
              Size: {(fileSize / 1024).toFixed(1)} KB
            </div>
          )}
          {reason && (
            <div className="preview-meta" style={{ fontSize: '0.85em', opacity: 0.8 }}>
              Reason: {reason}
            </div>
          )}
          {fileContent && (
            <pre className="preview-code content" style={{ maxHeight: '150px', overflow: 'auto' }}>
              {fileContent.length > 500 ? `${fileContent.substring(0, 500)}...` : fileContent}
            </pre>
          )}
        </div>
      );
    }

    // 5. 其他工具：显示过滤并截断后的参数
    const filteredParams: Record<string, any> = {};
    Object.entries(parameters).forEach(([key, value]) => {
      // 过滤掉已知的超长无意义预览字段
      if (['old_string', 'new_string', 'content', 'explanation'].includes(key)) {
        filteredParams[key] = '(content omitted from preview)';
        return;
      }

      if (typeof value === 'string' && value.length > 150) {
        filteredParams[key] = value.substring(0, 150) + '...';
      } else {
        filteredParams[key] = value;
      }
    });

    return (
      <div className="confirmation-preview-item">
        <div className="preview-label">{t('tools.parameters', {}, 'Parameters:')}</div>
        <pre className="preview-code json">{JSON.stringify(filteredParams, null, 2)}</pre>
      </div>
    );
  };

  const hasMultipleParams = Object.keys(toolCall.parameters).length > 2;

  // 🎯 检查是否是特殊渲染结果（用于样式定制）
  const resultType = getResultType(toolCall.result);
  const isSpecialResult = resultType !== null;

  // 🎯 如果是已完成的todo结果，在流式历史中隐藏它（因为现在有了全局悬挂的Todo面板）
  if (isTodoResultCompleted()) {
    return null;
  }

  // 🎯 获取当前模式的显示文本
  const getModeLabel = (mode: string) => {
    switch (mode) {
      case 'once': return t('tools.executeOnce', {}, 'Ask Every Time');
      case 'always_type': return t('tools.alwaysAllowType', {}, 'Always Allow Type');
      case 'always_project': return t('tools.enableYolo', {}, 'Run Everything');
      default: return t('tools.executeOnce', {}, 'Ask Every Time');
    }
  };

  return (
    <div
      className="tool-call-item"
    >
      {/* 主要工具信息行 - 单行显示 */}
      <div
        className="tool-main-line"
        onClick={onToggleExpand}
        style={{ cursor: 'pointer' }}
      >
        <div className="tool-info">
          {getStatusIcon(toolCall.status)}
          <span className="tool-name">{toolCall.displayName}</span>
          <span className="tool-description">{getToolDescription()}</span>
        </div>

        <div className="tool-controls">
          <button
            className="expand-btn"
            onClick={(e) => {
              e.stopPropagation(); // 防止冒泡触发外层的 onClick
              onToggleExpand();
            }}
            title={isExpanded ? t('tools.collapseDetails', {}, 'Collapse details') : t('tools.expandDetails', {}, 'Expand details')}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>
      </div>

      {/* 🎯 Batch 工具：显示子工具调用列表 */}
      {toolCall.batchSubTools && toolCall.batchSubTools.length > 0 && (
        <div className="batch-sub-tools">
          {toolCall.batchSubTools.map((subTool, index) => (
            <div key={index} className="batch-sub-tool-item">
              <span className="batch-connector">
                {index === toolCall.batchSubTools!.length - 1 ? '└' : '├'}
              </span>
              <span className="batch-sub-tool-name">{subTool.displayName}</span>
              {subTool.summary && (
                <span className="batch-sub-tool-summary">{subTool.summary}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 🎯 AskUserQuestion：独立的问答对话 UI，不走通用确认栏 */}
      {hasConfirmation && toolCall.confirmationDetails?.type === 'question' && (
        <AskUserQuestionMessage
          confirmationDetails={toolCall.confirmationDetails}
          isInPlanMode={isInPlanMode}
          onConfirm={(payload) => {
            onConfirm(
              payload.confirmed,
              undefined,
              payload.outcome,
              {
                ...(payload.answers && { answers: payload.answers }),
                ...(payload.annotations && { annotations: payload.annotations }),
                ...(payload.feedback && { feedback: payload.feedback }),
              }
            );
          }}
        />
      )}

      {/* 确认提示 - 现代设计 (其他工具类型) */}
      {hasConfirmation && toolCall.confirmationDetails?.type !== 'question' && (
        <div className="tool-confirmation-modern">
          {/* 预览区域 - 智能渲染 */}
          <div className="confirmation-preview">
            {renderConfirmationPreview()}
          </div>

          {/* 底部操作栏 */}
          <div className="confirmation-footer-modern">
            {/* 左侧：模式选择下拉菜单 */}
            <div className="mode-selector" ref={dropdownRef}>
              <button
                className="mode-dropdown-trigger"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                title={t('tools.executeOnceTooltip', {}, 'Select execution mode')}
              >
                <span>{getModeLabel(permissionMode)}</span>
                <ChevronDown size={12} />
              </button>

              {isDropdownOpen && (
                <div className="mode-dropdown-menu">
                  <div
                    className={`mode-option ${permissionMode === 'once' ? 'selected' : ''}`}
                    onClick={() => { setPermissionMode('once'); setIsDropdownOpen(false); }}
                  >
                    <Check size={12} className="option-check" />
                    <span>{t('tools.executeOnce', {}, 'Ask Every Time')}</span>
                  </div>
                  <div
                    className={`mode-option ${permissionMode === 'always_type' ? 'selected' : ''}`}
                    onClick={() => { setPermissionMode('always_type'); setIsDropdownOpen(false); }}
                  >
                    <Check size={12} className="option-check" />
                    <span>{t('tools.alwaysAllowType', {}, 'Always Allow Type')}</span>
                  </div>
                  <div
                    className={`mode-option warning ${permissionMode === 'always_project' ? 'selected' : ''}`}
                    onClick={() => { setPermissionMode('always_project'); setIsDropdownOpen(false); }}
                  >
                    <Check size={12} className="option-check" />
                    <span>{t('tools.enableYolo', {}, 'Run Everything')}</span>
                  </div>
                </div>
              )}
            </div>

            {/* 右侧：操作按钮 */}
            <div className="action-buttons">
              <button
                className="action-btn cancel"
                onClick={() => handleConfirmationChoice('cancel')}
              >
                {t('tools.skip', {}, 'Skip')}
              </button>
              <button
                className="action-btn run"
                onClick={() => handleConfirmationChoice(permissionMode)}
              >
                {t('tools.run', {}, 'Run')}
                <RotateCcw size={12} style={{ marginLeft: 4 }} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🎯 后台运行状态提示 - 参考 CLI 实现 */}
      {toolCall.status === TOOL_CALL_STATUS.BACKGROUND_RUNNING && (
        <div className="tool-background-running-hint">
          <span className="background-hint-text">
            {t('backgroundTasks.runningInBackground', {}, '↓ Running in background')}
          </span>
        </div>
      )}

      {/* 🎯 实时输出区域 - 只在工具执行中且有实时输出时显示 */}
      {toolCall.status === TOOL_CALL_STATUS.EXECUTING && toolCall.liveOutput && (
        <div className="tool-live-output">
          <div className="live-output-header">
            <span className="live-output-label">
              {toolCall.status === TOOL_CALL_STATUS.EXECUTING ? t('tools.status.executing', {}, '🔄 Executing...') : t('tools.output', {}, '📄 Output')}
            </span>
            {/* 🎯 转到后台按钮 - 仅对 shell 命令类工具显示 */}
            {onMoveToBackground && (toolCall.toolName === 'run_shell_command' || toolCall.toolName === 'bash' || toolCall.toolName === 'terminal') && (
              <button
                className="move-to-background-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveToBackground(toolCall.id);
                }}
                title={t('backgroundTasks.moveToBackground', {}, 'Move to background')}
              >
                <PlayCircle size={12} />
                <span>{t('backgroundTasks.moveToBackground', {}, 'Move to background')}</span>
              </button>
            )}
          </div>
          <div className="live-output-content" ref={liveOutputRef}>
            {(() => {
              if (!toolCall.liveOutput) {
                return <div className="live-output-placeholder">{t('tools.waitingForOutput', {}, 'Waiting for output...')}</div>;
              }

              const output = toolCall.liveOutput.trim();
              // 🎯 检查是否是 SubAgent 实时更新 JSON
              if (output.startsWith('{') && output.includes('"subagent_')) {
                try {
                  const parsed = JSON.parse(output);
                  if (parsed.type === 'subagent_update' && parsed.data?.type === 'subagent_display') {
                    return <SubAgentDisplayRenderer data={parsed.data} />;
                  } else if (parsed.type === 'subagent_display') {
                    return <SubAgentDisplayRenderer data={parsed} />;
                  }
                } catch (e) {
                  // 解析失败，回退到普通文本显示
                }
              }

              return <pre className="live-output-text">{toolCall.liveOutput}</pre>;
            })()}
          </div>
        </div>
      )}

      {/* 展开的详情：参数 + 结果（均限制高度并可滚动） */}
      {isExpanded && (() => {
        const resultType = getResultType(toolCall.result);
        const isSpecialResult = resultType !== null;

        // 特殊结果类型：只显示结果，不显示参数
        if (isSpecialResult) {
          return (
            <div className="tool-expanded-params">
              <div className="params-json compact-result">
                {toolCall.result ? (
                  renderResult(toolCall.result)
                ) : (
                  toolCall.status === TOOL_CALL_STATUS.CANCELED ? (
                    <div>{t('tools.status.canceled', {}, 'Cancelled')}</div>
                  ) : toolCall.status === TOOL_CALL_STATUS.ERROR ? (
                    <div>{t('tools.status.failed', {}, 'Failed')}</div>
                  ) : (
                    <div>{t('tools.working', {}, 'Working...')}</div>
                  )
                )}
              </div>
            </div>
          );
        }

        // 普通结果：只显示结果的data字段
        return (
          <div className="tool-expanded-params">
            {/* 只显示结果区域 */}
            <div className="params-json compact-result">

              {toolCall.result ? (
                renderResult(toolCall.result)
              ) : (
                toolCall.status === TOOL_CALL_STATUS.CANCELED ? (
                  <div>{t('tools.status.canceled', {}, 'Cancelled')}</div>
                ) : toolCall.status === TOOL_CALL_STATUS.ERROR ? (
                  <div>{t('tools.status.failed', {}, 'Failed')}</div>
                ) : (
                  <div>{t('tools.working', {}, 'Working...')}</div>
                )
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// 状态图标组件 - 参考CLI实现
const getStatusIcon = (status: string) => {
  const iconProps = { size: 8, className: "status-icon" };
  const dotStyle = { fontSize: '10px', lineHeight: '1' };

  switch (status) {
    case TOOL_CALL_STATUS.SCHEDULED:
      return <span className="status-icon pending" style={dotStyle}>●</span>;
    case TOOL_CALL_STATUS.EXECUTING:
      // 🎯 闪烁的橙黄色实心小圆点
      return <span className="status-icon executing flashing" style={dotStyle}>●</span>;
    case TOOL_CALL_STATUS.BACKGROUND_RUNNING:
      // 🎯 黄色三角形 - 后台运行中（参考 CLI 的 ▸）
      return <span className="status-icon background-running" style={dotStyle}>▸</span>;
    case TOOL_CALL_STATUS.SUCCESS:
      // 🎯 绿色实心小圆点
      return <span className="status-icon success" style={dotStyle}>●</span>;
    case TOOL_CALL_STATUS.ERROR:
      // 🎯 红色实心小圆点
      return <span className="status-icon error" style={dotStyle}>●</span>;
    case TOOL_CALL_STATUS.WAITING_FOR_CONFIRMATION:
      return <AlertTriangle {...iconProps} className="status-icon confirming" />;
    case TOOL_CALL_STATUS.CANCELED:
      // 🎯 灰色实心小圆点 - 停止/取消状态
      return <span className="status-icon cancelled" style={dotStyle}>●</span>;
    default:
      return <HelpCircle {...iconProps} className="status-icon unknown" />;
  }
};

interface ToolCallListProps {
  toolCalls: ToolCall[];
  onConfirm?: (
    toolCallId: string,
    confirmed: boolean,
    userInput?: string,
    outcome?: string,
    extra?: {
      answers?: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
      feedback?: string;
    }
  ) => void;
  showCompact?: boolean;
  onMoveToBackground?: (toolCallId: string) => void;
  /** True when the current session is in plan mode (enables "Skip interview" footer). */
  isInPlanMode?: boolean;
}

export const ToolCallList: React.FC<ToolCallListProps> = ({ toolCalls, onConfirm, showCompact = false, onMoveToBackground, isInPlanMode = false }) => {
  // 🎯 初始化时，下列工具调用默认展开：
  //   - background_task_output：实时输出，折叠会让用户看不到正在跑的命令
  //   - goal_achieved：模型刚刚正式宣告 /goal 完成，reason 字段是用户最关心
  //     的"为什么完成"审计依据；默认折叠会埋掉这个里程碑事件
  const getDefaultExpandedTools = () => {
    const expanded = new Set<string>();
    toolCalls?.forEach(tc => {
      if (tc.toolName === 'background_task_output') {
        expanded.add(tc.id);
      }
      if (tc.toolName === 'goal_achieved') {
        expanded.add(tc.id);
      }
    });
    return expanded;
  };

  const [expandedTools, setExpandedTools] = useState<Set<string>>(getDefaultExpandedTools);

  // 🎯 当有新的 background_task_output 工具时，自动展开
  React.useEffect(() => {
    if (!toolCalls) return;
    const bgTools = toolCalls.filter(tc => tc.toolName === 'background_task_output');
    if (bgTools.length > 0) {
      setExpandedTools(prev => {
        const newSet = new Set(prev);
        bgTools.forEach(tc => newSet.add(tc.id));
        return newSet;
      });
    }
  }, [toolCalls]);

  // 🎯 当有新的 goal_achieved 工具到达时，自动展开。
  //   getDefaultExpandedTools 只在 mount 时跑一次；如果用户在会话中途
  //   触发 goal_achieved，那次工具调用 id 不在初始集合里，必须靠这条
  //   useEffect 加进去。和上面 background_task_output 的处理对称。
  React.useEffect(() => {
    if (!toolCalls) return;
    const goalTools = toolCalls.filter(tc => tc.toolName === 'goal_achieved');
    if (goalTools.length > 0) {
      setExpandedTools(prev => {
        const newSet = new Set(prev);
        goalTools.forEach(tc => newSet.add(tc.id));
        return newSet;
      });
    }
  }, [toolCalls]);

  if (!toolCalls || toolCalls.length === 0) {
    console.log('🔨 [ToolCallList] No tool calls to render');
    return null;
  }

  const toggleExpand = (toolId: string) => {
    setExpandedTools(prev => {
      const newSet = new Set(prev);
      if (newSet.has(toolId)) {
        newSet.delete(toolId);
      } else {
        newSet.add(toolId);
      }
      return newSet;
    });
  };

  const handleConfirm = (toolCallId: string) => (
    confirmed: boolean,
    userInput?: string,
    outcome?: string,
    extra?: {
      answers?: Record<string, string>;
      annotations?: Record<string, { preview?: string; notes?: string }>;
      feedback?: string;
    }
  ) => {
    onConfirm?.(toolCallId, confirmed, userInput, outcome, extra);
  };

  return (
    <div className="tool-call-list">
      {toolCalls.map((toolCall) => {
        const resultType = getResultType(toolCall.result);
        const isSpecialResult = resultType !== null;

        return (
          <ToolCallItem
            key={toolCall.id}
            toolCall={toolCall}
            isExpanded={expandedTools.has(toolCall.id)}
            onToggleExpand={() => toggleExpand(toolCall.id)}
            onConfirm={handleConfirm(toolCall.id)}
            onMoveToBackground={onMoveToBackground}
            isInPlanMode={isInPlanMode}
          />
        );
      })}
    </div>
  );
};
