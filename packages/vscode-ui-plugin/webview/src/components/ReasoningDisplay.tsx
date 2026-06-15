/**
 * Reasoning Display Component - 显示AI思考过程
 *
 * 参考 CLI 版本的 ReasoningDisplay 实现
 * 特性：
 * - 固定高度窗口（可折叠）
 * - 自动滚动显示最新内容
 * - 动画指示器（○ ● 交替）
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Brain } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';
import './ReasoningDisplay.css';

interface ReasoningDisplayProps {
  /** 思考过程文本内容 */
  reasoning: string;
  /** 是否正在思考（用于动画效果） */
  isActive?: boolean;
  /** 是否默认折叠 */
  defaultCollapsed?: boolean;
  /** 最大显示行数 */
  maxLines?: number;
}

export const ReasoningDisplay: React.FC<ReasoningDisplayProps> = ({
  reasoning,
  isActive = true,
  defaultCollapsed = false,
  maxLines = 8
}) => {
  const { t } = useTranslation();
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const [animationFrame, setAnimationFrame] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevIsActiveRef = useRef(isActive);

  // 🎯 思考结束时自动折叠：当 isActive 从 true 变为 false 时
  useEffect(() => {
    if (prevIsActiveRef.current && !isActive) {
      setIsCollapsed(true);
    }
    prevIsActiveRef.current = isActive;
  }, [isActive]);

  // 🎯 动画效果：交替显示 ○ 和 ●
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      setAnimationFrame(prev => (prev + 1) % 2);
    }, 500);

    return () => clearInterval(interval);
  }, [isActive]);

  // 🎯 自动滚动到底部
  useEffect(() => {
    if (contentRef.current && !isCollapsed) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [reasoning, isCollapsed]);

  // 🎯 计算是否需要显示折叠控制
  const lines = reasoning.split('\n');
  const lineCount = lines.length;
  const hasOverflow = lineCount > maxLines;

  // 🎯 动画指示器
  const indicator = isActive ? (animationFrame === 0 ? '○' : '●') : '●';

  if (!reasoning || reasoning.trim() === '') {
    return null;
  }

  return (
    <div className={`reasoning-display ${isCollapsed ? 'collapsed' : 'expanded'} ${isActive ? 'active' : 'completed'}`}>
      {/* 头部：标题和控制按钮 */}
      <div
        className="reasoning-header"
        onClick={() => setIsCollapsed(!isCollapsed)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsCollapsed(!isCollapsed);
          }
        }}
      >
        <div className="reasoning-title">
          <span className="reasoning-indicator">{indicator}</span>
          <Brain size={14} className="reasoning-icon" />
          <span className="reasoning-label">{t('reasoning.title')}</span>
        </div>
        <button
          className="reasoning-toggle"
          title={isCollapsed ? t('reasoning.expand') : t('reasoning.collapse')}
          aria-label={isCollapsed ? t('reasoning.expand') : t('reasoning.collapse')}
        >
          {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
      </div>

      {/* 内容区域 */}
      {!isCollapsed && (
        <div
          ref={contentRef}
          className="reasoning-content"
          style={{ maxHeight: `${maxLines * 1.5}em` }}
        >
          <pre className="reasoning-text">{reasoning}</pre>
          {hasOverflow && (
            <div className="reasoning-overflow-indicator">
              <span className="reasoning-line-count">
                {t('reasoning.lineCount', { count: lineCount })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 折叠状态下的预览 */}
      {isCollapsed && (
        <div className="reasoning-preview">
          <span className="reasoning-preview-text">
            {lines[lines.length - 1]?.substring(0, 80) || reasoning.substring(0, 80)}
            {(lines[lines.length - 1]?.length > 80 || reasoning.length > 80) && '...'}
          </span>
        </div>
      )}
    </div>
  );
};

export default ReasoningDisplay;
