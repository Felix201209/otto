/**
 * Session Switcher Component
 * Session切换器UI组件
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useState, useRef, useEffect } from 'react';
import { Edit3, Trash2, Settings, Wrench, Plus, X, Download } from 'lucide-react';
import { SessionInfo } from '../../../src/types/sessionTypes';
import { SessionType, SESSION_UI_CONSTANTS } from '../../../src/constants/sessionConstants';
import { useTranslation } from '../hooks/useTranslation';
import './SessionSwitcher.css';

interface SessionSwitcherProps {
  /** 当前活跃的Session */
  currentSession: SessionInfo | null;

  /** 所有Session列表 */
  sessions: SessionInfo[];

  /** Session切换回调 */
  onSessionSwitch: (sessionId: string) => void;

  /** 创建新Session回调 */
  onCreateSession: (type: SessionType) => void;

  /** Session操作回调 */
  onSessionAction: (action: 'rename' | 'delete' | 'duplicate' | 'export', sessionId: string) => void;

  /** 🎯 Session顺序变更回调（用于拖拽排序） */
  onSessionsReorder?: (sessionIds: string[]) => void;

  /** 获取Session标题的函数 */
  getSessionTitle?: (sessionId: string) => string;

  /** 检查Session是否未使用过（没有聊天历史） */
  isSessionUnused?: (sessionId: string) => boolean;

  /** 是否禁用 */
  disabled?: boolean;

  /** 自定义样式 */
  className?: string;
}

/**
 * SessionSwitcher - Session横向标签切换组件
 *
 * 功能：
 * - 横向滑动的Session标签列表
 * - 点击标签直接切换Session
 * - "+"按钮创建新Session
 * - 使用第一条用户消息作为标题
 * - Session右键操作菜单
 */
export const SessionSwitcher: React.FC<SessionSwitcherProps> = ({
  currentSession,
  sessions,
  onSessionSwitch,
  onCreateSession,
  onSessionAction,
  onSessionsReorder,
  getSessionTitle,
  isSessionUnused,
  disabled = false,
  className = ''
}) => {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

  // 🎯 拖拽状态管理
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // 关闭右键菜单的点击外部处理
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ESC键关闭菜单
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 鼠标滚轮支持 - 在hover状态下滚动tab
  useEffect(() => {
    const tabsElement = tabsContainerRef.current;
    if (!tabsElement) return;

    const handleWheel = (event: WheelEvent) => {
      // 只在有滚动条时处理（内容溢出）
      if (tabsElement.scrollWidth <= tabsElement.clientWidth) {
        return;
      }

      event.preventDefault();

      // 根据滚轮方向滚动
      const scrollAmount = 50; // 每次滚动的像素数
      const deltaX = event.deltaY > 0 ? scrollAmount : -scrollAmount;

      tabsElement.scrollLeft += deltaX;
    };

    // 使用passive: false以允许preventDefault
    tabsElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => tabsElement.removeEventListener('wheel', handleWheel);
  }, []);

  // 当前session变化时自动滚动到该session
  useEffect(() => {
    if (currentSession?.id) {
      console.log('🎯 [SCROLL] Current session changed, scrolling to:', currentSession.id);
      // 使用setTimeout确保DOM已更新
      setTimeout(() => {
        scrollToSession(currentSession.id);
      }, 150); // 增加延迟确保DOM完全更新
    }
  }, [currentSession?.id]);

  // 当sessions列表变化时（例如创建新session），如果有当前session就滚动到它
  useEffect(() => {
    if (currentSession?.id && sessions.length > 0) {
      // 检查新session是否存在于列表中
      const sessionExists = sessions.some(s => s.id === currentSession.id);
      console.log('🎯 [SCROLL] Sessions list changed, current session exists:', sessionExists, 'sessionId:', currentSession.id);
      if (sessionExists) {
        setTimeout(() => {
          scrollToSession(currentSession.id);
        }, 300); // 更长延迟确保新tab已完全渲染和排序
      }
    }
  }, [sessions.length, currentSession?.id, sessions]);

  /**
   * 处理Session切换
   */
  const handleSessionSelect = (sessionId: string) => {
    // 总是调用回调，即使是当前 session（用于关闭历史列表等）
    onSessionSwitch(sessionId);
  };

  /**
   * 滚动到指定的session标签
   */
  const scrollToSession = (sessionId: string) => {
    if (!tabsContainerRef.current) return;

    const sessionTab = tabsContainerRef.current.querySelector(`[data-session-id="${sessionId}"]`) as HTMLElement;
    if (!sessionTab) {
      console.log('Session tab not found:', sessionId);
      return;
    }

    const container = tabsContainerRef.current;
    const containerRect = container.getBoundingClientRect();
    const tabRect = sessionTab.getBoundingClientRect();

    // 计算需要滚动的距离
    const scrollLeft = container.scrollLeft;
    const tabLeft = tabRect.left - containerRect.left + scrollLeft;
    const tabRight = tabLeft + tabRect.width;
    const containerWidth = containerRect.width;

    //console.log('Scrolling to session:', sessionId, { tabLeft, scrollLeft, containerWidth });

    // 对于新创建的session（通常在第一个位置），直接滚动到开始
    const sessionIndex = sessions.findIndex(s => s.id === sessionId);
    if (sessionIndex === 0) {
      container.scrollTo({
        left: 0,
        behavior: 'smooth'
      });
      return;
    }

    // 如果tab在可视区域外，则滚动到它
    if (tabLeft < scrollLeft) {
      // tab在左边，滚动到tab的左边
      container.scrollTo({
        left: Math.max(0, tabLeft - 10), // 留一点边距，但不能小于0
        behavior: 'smooth'
      });
    } else if (tabRight > scrollLeft + containerWidth) {
      // tab在右边，滚动到tab的右边
      container.scrollTo({
        left: tabRight - containerWidth + 10, // 留一点边距
        behavior: 'smooth'
      });
    }
  };

  /**
   * 处理创建新Session
   * 🎯 直接创建新session，不做智能检查
   * 🎯 立即响应优化：UI立即反馈，后台操作异步进行
   */
  const handleCreateSession = () => {
    console.log('🆕 [+按钮] 创建新Session');
    console.log('🔍 [+按钮] 当前sessions数量:', sessions.length);

    // 🎯 立即滚动到开始位置，给用户即时反馈
    if (tabsContainerRef.current) {
      tabsContainerRef.current.scrollTo({
        left: 0,
        behavior: 'smooth'
      });
    }

    // 🎯 直接创建新session（底层会处理数量限制和踢出逻辑）
    setTimeout(() => {
      onCreateSession(SessionType.CHAT);
    }, 0);
  };

  /**
   * 处理右键菜单
   */
  const handleContextMenu = (event: React.MouseEvent, sessionId: string) => {
    event.preventDefault();
    event.stopPropagation();

    setContextMenu({
      sessionId,
      x: event.clientX,
      y: event.clientY
    });
  };

  /**
   * 处理Session操作
   */
  const handleSessionAction = (action: 'rename' | 'delete' | 'duplicate' | 'export', sessionId: string) => {
    onSessionAction(action, sessionId);
    setContextMenu(null);
  };

  /**
   * 处理关闭按钮点击（删除session）
   */
  const handleCloseSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // 阻止事件冒泡，避免触发tab切换

    // 如果只剩一个session，不允许删除
    if (sessions.length <= 1) {
      console.warn('Cannot delete the last session');
      return;
    }

    onSessionAction('delete', sessionId);
  };

  // 🎯 使用 ref 保存当前拖拽的 session ID，避免 dataTransfer 在某些浏览器中失效
  const draggedIdRef = useRef<string | null>(null);

  /**
   * 🎯 拖拽开始事件处理
   */
  const handleDragStart = (e: React.DragEvent<HTMLButtonElement>, sessionId: string) => {
    // 🎯 同时使用 dataTransfer 和 ref 保存拖拽 ID
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionId);
    draggedIdRef.current = sessionId;
    setDraggedSessionId(sessionId);

    // 🎯 设置拖拽图像（可选，提升视觉体验）
    if (e.currentTarget) {
      e.dataTransfer.setDragImage(e.currentTarget, 50, 16);
    }

    console.log('🎯 [DRAG-START] Session drag started:', sessionId);
  };

  /**
   * 🎯 拖拽悬停事件处理
   */
  const handleDragOver = (e: React.DragEvent<HTMLButtonElement>, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    // 🎯 只有当悬停的不是被拖拽的 session 时才更新状态
    if (draggedIdRef.current !== sessionId) {
      setDragOverSessionId(sessionId);
    }
  };

  /**
   * 🎯 拖拽离开事件处理
   */
  const handleDragLeave = (e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    // 🎯 检查是否真的离开了元素（防止子元素触发）
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!e.currentTarget.contains(relatedTarget)) {
      setDragOverSessionId(null);
    }
  };

  /**
   * 🎯 拖拽放置事件处理
   */
  const handleDrop = (e: React.DragEvent<HTMLButtonElement>, dropSessionId: string) => {
    e.preventDefault();
    e.stopPropagation();

    // 🎯 优先从 ref 获取拖拽 ID（更可靠），fallback 到 dataTransfer
    const draggedId = draggedIdRef.current || e.dataTransfer.getData('text/plain');

    console.log('🎯 [DROP] Drop event:', {
      draggedId: draggedId?.substring(0, 8) || 'null',
      dropSessionId: dropSessionId.substring(0, 8),
      hasCallback: !!onSessionsReorder,
      sessionsCount: sessions.length
    });

    if (!draggedId || draggedId === dropSessionId) {
      console.log('🎯 [DROP] Skipping - same session or no draggedId');
      setDraggedSessionId(null);
      setDragOverSessionId(null);
      draggedIdRef.current = null;
      return;
    }

    if (!onSessionsReorder) {
      console.warn('🎯 [DROP] No onSessionsReorder callback provided!');
      setDraggedSessionId(null);
      setDragOverSessionId(null);
      draggedIdRef.current = null;
      return;
    }

    // 计算新顺序
    const newSessions = [...sessions];
    const draggedIndex = newSessions.findIndex(s => s.id === draggedId);
    const dropIndex = newSessions.findIndex(s => s.id === dropSessionId);

    console.log('🎯 [DROP] Indices:', { draggedIndex, dropIndex });

    if (draggedIndex > -1 && dropIndex > -1) {
      const [draggedSession] = newSessions.splice(draggedIndex, 1);
      newSessions.splice(dropIndex, 0, draggedSession);

      console.log('🎯 [DROP] Session reordered:', {
        draggedId: draggedId.substring(0, 8),
        dropId: dropSessionId.substring(0, 8),
        newOrder: newSessions.map((s, i) => `${i}:${s.id.substring(0, 8)}`).join(' ')
      });

      // 调用父组件的重新排序回调
      onSessionsReorder(newSessions.map(s => s.id));
    } else {
      console.warn('🎯 [DROP] Invalid indices, skipping reorder');
    }

    setDraggedSessionId(null);
    setDragOverSessionId(null);
    draggedIdRef.current = null;
  };

  /**
   * 🎯 拖拽结束事件处理
   */
  const handleDragEnd = () => {
    console.log('🎯 [DRAG-END] Drag ended');
    setDraggedSessionId(null);
    setDragOverSessionId(null);
    draggedIdRef.current = null;
  };

  /**
   * 获取Session显示标题（使用第一条用户消息或默认名称）
   */
  const getSessionDisplayTitle = (session: SessionInfo) => {
    if (getSessionTitle) {
      return getSessionTitle(session.id);
    }
    return session.name;
  };

  // 无Session的情况下仅显示创建按钮
  if (sessions.length === 0) {
    return (
      <div className={`session-switcher session-switcher--empty ${className}`}>
        <button
          className="session-switcher__create-btn"
          onClick={handleCreateSession}
          disabled={disabled}
          title="Create New Session"
        >
          <Plus size={14} stroke="currentColor" />
        </button>
      </div>
    );
  }

  return (
    <div className={`session-switcher ${className}`} ref={containerRef}>
      {/* 固定的创建新Session按钮 - Pinned Header */}
      <div className="session-switcher__pinned-header">
        <button
          className="session-switcher__create-btn session-switcher__create-btn--pinned"
          onClick={handleCreateSession}
          disabled={disabled}
          title="Create New Session"
        >
          <Plus size={14} stroke="currentColor" />
        </button>
      </div>

      {/* 横向滑动的Session标签列表 */}
      <div className="session-switcher__tabs-container">
        <div className="session-switcher__tabs" ref={tabsContainerRef}>
          {sessions.map((session) => (
            <button
              key={session.id}
              data-session-id={session.id}
              draggable={!disabled}
              className={`session-switcher__tab ${
                session.id === currentSession?.id ? 'session-switcher__tab--active' : ''
              } ${isSessionUnused && isSessionUnused(session.id) ? 'session-switcher__tab--unused' : ''} ${
                draggedSessionId === session.id ? 'session-switcher__tab--dragging' : ''
              } ${
                dragOverSessionId === session.id ? 'session-switcher__tab--drag-over' : ''
              }`}
              onClick={() => handleSessionSelect(session.id)}
              onContextMenu={(e) => handleContextMenu(e, session.id)}
              onDragStart={(e) => handleDragStart(e, session.id)}
              onDragOver={(e) => handleDragOver(e, session.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, session.id)}
              onDragEnd={handleDragEnd}
              disabled={disabled}
              title={session.description || getSessionDisplayTitle(session)}
            >
              {/* 状态指示器 - 问号或圆点 */}
              {session.status === 'confirming' ? (
                <span
                  className="session-switcher__status-icon session-switcher__status-icon--confirming"
                  title="等待确认"
                >
                  ❓
                </span>
              ) : (
                <div
                  className={`session-switcher__status-dot session-switcher__status-dot--${session.status}`}
                  title={`Status: ${session.status}`}
                />
              )}

              <span className="session-switcher__tab-title">
                {getSessionDisplayTitle(session)}
              </span>

              {/* 关闭按钮 */}
              {sessions.length > 1 && (
                <button
                  className="session-switcher__tab-close"
                  onClick={(e) => handleCloseSession(e, session.id)}
                  title="关闭此会话"
                  disabled={false}
                >
                  <X size={12} stroke="currentColor" />
                </button>
              )}

              {/* 未使用session的视觉标识 */}
              {isSessionUnused && isSessionUnused(session.id) && (
                <span className="session-switcher__tab-indicator">•</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="session-switcher__context-menu"
          style={{
            left: contextMenu.x,
            top: contextMenu.y
          }}
        >
          <button
            className="session-switcher__context-item"
            onClick={() => handleSessionAction('rename', contextMenu.sessionId)}
          >
            <Edit3 size={12} stroke="currentColor" className="session-switcher__context-icon" />
            {t('session.rename', undefined, 'Rename')}
          </button>

          <button
            className="session-switcher__context-item"
            onClick={() => handleSessionAction('export', contextMenu.sessionId)}
          >
            <Download size={12} stroke="currentColor" className="session-switcher__context-icon" />
            {t('session.export', undefined, 'Export Chat')}
          </button>

          {sessions.length > 1 && (
            <button
              className="session-switcher__context-item session-switcher__context-item--danger"
              onClick={() => handleSessionAction('delete', contextMenu.sessionId)}
            >
              <Trash2 size={12} stroke="currentColor" className="session-switcher__context-icon" />
              {t('session.delete', undefined, 'Delete')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 获取Session类型图标
 */
function getSessionTypeIcon(type: SessionType): React.ReactNode {
  const iconProps = { size: 12, stroke: "currentColor" };
  switch (type) {
    case SessionType.CHAT:
      return <span>💬</span>;
    case SessionType.CODE_REVIEW:
      return <span>👀</span>;
    case SessionType.DEBUG:
      return <span>🐛</span>;
    case SessionType.DOCUMENTATION:
      return <span>📝</span>;
    case SessionType.REFACTORING:
      return <Wrench {...iconProps} />;
    case SessionType.CUSTOM:
      return <Settings {...iconProps} />;
    default:
      return <span>💬</span>;
  }
}

/**
 * 获取Session类型名称
 */
function getSessionTypeName(type: SessionType): string {
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
      return '自定义会话';
    default:
      return '聊天会话';
  }
}
