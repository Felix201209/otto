/**
 * Session Manager Dialog Component
 * Session管理对话框组件
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useState, useEffect, useCallback } from 'react';
import { SessionInfo } from '../../../src/types/sessionTypes';
import { SessionType } from '../../../src/constants/sessionConstants';
import { useTranslation } from '../hooks/useTranslation';
import './SessionManagerDialog.css';

interface SessionManagerDialogProps {
  /** 是否显示对话框 */
  isOpen: boolean;

  /** 关闭对话框回调 */
  onClose: () => void;

  /** 所有Session列表 */
  sessions: SessionInfo[];

  /** 当前活跃Session */
  currentSessionId: string | null;

  /** Session操作回调 */
  onSessionAction: (action: SessionAction, sessionId?: string, data?: any) => void;
}

interface SessionAction {
  type: 'create' | 'rename' | 'delete' | 'duplicate' | 'export' | 'import' | 'clear';
}

interface RenameState {
  sessionId: string | null;
  newName: string;
  isEditing: boolean;
}

/**
 * SessionManagerDialog - Session管理对话框
 *
 * 功能：
 * - 显示所有Session列表
 * - 重命名、删除、复制Session
 * - 导入导出Session数据
 * - 清空Session内容
 */
export const SessionManagerDialog: React.FC<SessionManagerDialogProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  onSessionAction
}) => {
  const { t } = useTranslation();
  const [renameState, setRenameState] = useState<RenameState>({
    sessionId: null,
    newName: '',
    isEditing: false
  });
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set());

  /**
   * 确认重命名
   */
  const handleConfirmRename = useCallback(() => {
    if (!renameState.sessionId || !renameState.newName.trim()) {
      return;
    }

    onSessionAction({ type: 'rename' }, renameState.sessionId, renameState.newName.trim());
    setRenameState({ sessionId: null, newName: '', isEditing: false });
  }, [renameState, onSessionAction]);

  /**
   * 取消重命名
   */
  const handleCancelRename = useCallback(() => {
    setRenameState({ sessionId: null, newName: '', isEditing: false });
  }, []);

  // 重置状态当对话框关闭时
  useEffect(() => {
    if (!isOpen) {
      setRenameState({ sessionId: null, newName: '', isEditing: false });
      setDeleteConfirmId(null);
      setSelectedSessions(new Set());
    }
  }, [isOpen]);

  /**
   * 处理键盘事件
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation(); // 防止事件冒泡到其他对话框
        if (renameState.isEditing) {
          handleCancelRename();
        } else if (deleteConfirmId) {
          setDeleteConfirmId(null);
        } else {
          onClose();
        }
      } else if (event.key === 'Enter' && renameState.isEditing) {
        handleConfirmRename();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, renameState, deleteConfirmId, onClose, handleCancelRename, handleConfirmRename]);

  /**
   * 开始重命名Session
   */
  const handleStartRename = (sessionId: string, currentName: string) => {
    setRenameState({
      sessionId,
      newName: currentName,
      isEditing: true
    });
  };

  /**
   * 处理删除Session
   */
  const handleDeleteSession = (sessionId: string) => {
    onSessionAction({ type: 'delete' }, sessionId);
    setDeleteConfirmId(null);
  };

  /**
   * 处理复制Session
   */
  const handleDuplicateSession = (sessionId: string) => {
    onSessionAction({ type: 'duplicate' }, sessionId);
  };

  /**
   * 处理清空Session
   */
  const handleClearSession = (sessionId: string) => {
    onSessionAction({ type: 'clear' }, sessionId);
  };

  /**
   * 创建新Session
   */
  const handleCreateSession = (type: SessionType) => {
    onSessionAction({ type: 'create' }, undefined, { sessionType: type });
  };

  /**
   * 导出选中的Session
   */
  const handleExportSessions = () => {
    const sessionIds = selectedSessions.size > 0 ? Array.from(selectedSessions) : undefined;
    onSessionAction({ type: 'export' }, undefined, { sessionIds });
  };

  /**
   * 导入Session
   */
  const handleImportSessions = () => {
    onSessionAction({ type: 'import' });
  };

  /**
   * 切换Session选择状态
   */
  const toggleSessionSelection = (sessionId: string) => {
    const newSelected = new Set(selectedSessions);
    if (newSelected.has(sessionId)) {
      newSelected.delete(sessionId);
    } else {
      newSelected.add(sessionId);
    }
    setSelectedSessions(newSelected);
  };

  /**
   * 全选/取消全选
   */
  const toggleSelectAll = () => {
    if (selectedSessions.size === sessions.length) {
      setSelectedSessions(new Set());
    } else {
      setSelectedSessions(new Set(sessions.map(s => s.id)));
    }
  };

  /**
   * 格式化最后活跃时间
   */
  const formatLastActivity = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60 * 1000) {
      return '刚刚';
    } else if (diff < 60 * 60 * 1000) {
      return `${Math.floor(diff / (60 * 1000))} 分钟前`;
    } else if (diff < 24 * 60 * 60 * 1000) {
      return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
    } else {
      return new Date(timestamp).toLocaleDateString('zh-CN');
    }
  };

  /**
   * 获取Session类型显示名称
   */
  const getSessionTypeName = (type: SessionType) => {
    switch (type) {
      case SessionType.CHAT:
        return '聊天会话';
      case SessionType.CODE_REVIEW:
        return '代码审查';
      case SessionType.DEBUG:
        return '调试助手';
      case SessionType.DOCUMENTATION:
        return '文档生成';
      case SessionType.REFACTORING:
        return '重构建议';
      case SessionType.CUSTOM:
        return '自定义';
      default:
        return '未知';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="session-dialog-overlay" onClick={onClose}>
      <div className="session-dialog" onClick={(e) => e.stopPropagation()}>
        {/* 对话框头部 */}
        <div className="session-dialog__header">
          <h2 className="session-dialog__title">
            {t('session.manageTitle')}
          </h2>
          <button
            className="session-dialog__close"
            onClick={onClose}
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* 对话框内容 */}
        <div className="session-dialog__content">
          {/* 工具栏 */}
          <div className="session-dialog__toolbar">
            <div className="session-dialog__toolbar-left">
              <button
                className="session-dialog__btn session-dialog__btn--primary"
                onClick={() => handleCreateSession(SessionType.CHAT)}
              >
                ➕ 新建会话
              </button>

              <button
                className="session-dialog__btn"
                onClick={handleImportSessions}
              >
                📥 导入
              </button>

              <button
                className="session-dialog__btn"
                onClick={handleExportSessions}
                disabled={sessions.length === 0}
              >
                📤 导出{selectedSessions.size > 0 ? ` (${selectedSessions.size})` : ''}
              </button>
            </div>

            <div className="session-dialog__toolbar-right">
              <button
                className="session-dialog__btn session-dialog__btn--small"
                onClick={toggleSelectAll}
                disabled={sessions.length === 0}
              >
                {selectedSessions.size === sessions.length ? '取消全选' : '全选'}
              </button>
            </div>
          </div>

          {/* Session列表 */}
          <div className="session-dialog__list">
            {sessions.length === 0 ? (
              <div className="session-dialog__empty">
                <div className="session-dialog__empty-icon">💬</div>
                <div className="session-dialog__empty-text">
                  暂无会话
                </div>
                <button
                  className="session-dialog__btn session-dialog__btn--primary"
                  onClick={() => handleCreateSession(SessionType.CHAT)}
                >
                  创建第一个会话
                </button>
              </div>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={`session-dialog__item ${
                    session.id === currentSessionId ? 'session-dialog__item--active' : ''
                  }`}
                >
                  {/* 选择框 */}
                  <input
                    type="checkbox"
                    className="session-dialog__checkbox"
                    checked={selectedSessions.has(session.id)}
                    onChange={() => toggleSessionSelection(session.id)}
                  />

                  {/* Session信息 */}
                  <div className="session-dialog__item-info">
                    <div className="session-dialog__item-header">
                      <span className="session-dialog__item-icon">
                        {session.icon || '💬'}
                      </span>

                      {renameState.isEditing && renameState.sessionId === session.id ? (
                        <input
                          type="text"
                          className="session-dialog__rename-input"
                          value={renameState.newName}
                          onChange={(e) => setRenameState(prev => ({ ...prev, newName: e.target.value }))}
                          onBlur={handleConfirmRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleConfirmRename();
                            if (e.key === 'Escape') handleCancelRename();
                          }}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="session-dialog__item-name"
                          onDoubleClick={() => handleStartRename(session.id, session.name)}
                        >
                          {session.name}
                        </span>
                      )}

                      {session.id === currentSessionId && (
                        <span className="session-dialog__item-current">当前</span>
                      )}
                    </div>

                    <div className="session-dialog__item-meta">
                      <span className="session-dialog__item-type">
                        {getSessionTypeName(session.type)}
                      </span>
                      <span className="session-dialog__item-messages">
                        {session.messageCount} 消息
                      </span>
                      <span className="session-dialog__item-activity">
                        {formatLastActivity(session.lastActivity)}
                      </span>
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="session-dialog__item-actions">
                    <button
                      className="session-dialog__action-btn"
                      onClick={() => handleStartRename(session.id, session.name)}
                      title="重命名"
                    >
                      ✏️
                    </button>

                    <button
                      className="session-dialog__action-btn"
                      onClick={() => handleDuplicateSession(session.id)}
                      title="复制"
                    >
                      📄
                    </button>

                    {session.messageCount > 0 && (
                      <button
                        className="session-dialog__action-btn"
                        onClick={() => handleClearSession(session.id)}
                        title="清空"
                      >
                        🧹
                      </button>
                    )}

                    {sessions.length > 1 && (
                      <button
                        className="session-dialog__action-btn session-dialog__action-btn--danger"
                        onClick={() => setDeleteConfirmId(session.id)}
                        title="删除"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 对话框底部 */}
        <div className="session-dialog__footer">
          <div className="session-dialog__stats">
            总计 {sessions.length} 个会话，
            {sessions.reduce((sum, s) => sum + s.messageCount, 0)} 条消息
          </div>

          <button
            className="session-dialog__btn"
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        {/* 删除确认对话框 */}
        {deleteConfirmId && (
          <div className="session-dialog__confirm-overlay">
            <div className="session-dialog__confirm">
              <h3 className="session-dialog__confirm-title">确认删除</h3>
              <p className="session-dialog__confirm-message">
                确定要删除会话 "{sessions.find(s => s.id === deleteConfirmId)?.name}" 吗？
                <br />
                <strong>此操作不可撤销！</strong>
              </p>
              <div className="session-dialog__confirm-actions">
                <button
                  className="session-dialog__btn session-dialog__btn--danger"
                  onClick={() => handleDeleteSession(deleteConfirmId)}
                >
                  确认删除
                </button>
                <button
                  className="session-dialog__btn"
                  onClick={() => setDeleteConfirmId(null)}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
