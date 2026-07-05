/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「智能体」画廊浮层。展示 8 个企业专家卡片（PPT 创作 / 会议纪要 / 公文撰写 …），
 * 点击某张卡片即启动该专家（onLaunch）：由上层起一段新会话并注入专家开场消息。
 *
 * 交互复刻 AllConversations 浮层规范：半透明遮罩 + 居中卡片，点遮罩 / 点关闭 / Esc 关闭。
 * 打开即把焦点落到第一张卡片，方便键盘用户直接回车启动。数据来自纯静态目录 agents/experts。
 */

import React, { useEffect, useRef } from 'react';
import type { Expert } from '../agents/experts.js';
import { EXPERTS } from '../agents/experts.js';
import { IconClose, IconAgent } from './icons.js';

interface AgentGalleryProps {
  onLaunch: (expert: Expert) => void;
  onClose: () => void;
}

export function AgentGallery({
  onLaunch,
  onClose,
}: AgentGalleryProps): React.JSX.Element {
  const firstCardRef = useRef<HTMLButtonElement>(null);

  // 打开即聚焦第一张卡片（键盘可直接 Enter 启动）。
  useEffect(() => {
    firstCardRef.current?.focus();
  }, []);

  // Esc 关闭（挂在浮层根上，捕获冒泡上来的按键）。
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="otto-agents-overlay" onClick={onClose} onKeyDown={onKeyDown}>
      <div
        className="otto-agents"
        role="dialog"
        aria-label="智能体 · 企业专家"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="otto-agents__head">
          <IconAgent size={18} className="otto-agents__headicon" />
          <div className="otto-agents__headtext">
            <div className="otto-agents__title">智能体 · 企业专家</div>
            <div className="otto-agents__subtitle">
              选一位专家开始 —— 它会加载对应技能并按方法协助你
            </div>
          </div>
          <button
            type="button"
            className="otto-agents__close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="otto-agents__grid">
          {EXPERTS.map((expert, i) => (
            <button
              key={expert.id}
              ref={i === 0 ? firstCardRef : undefined}
              type="button"
              className="otto-agent-card"
              style={{ ['--card-accent' as string]: expert.accent }}
              onClick={() => onLaunch(expert)}
            >
              <span className="otto-agent-card__avatar" aria-hidden>
                {expert.emoji}
              </span>
              <span className="otto-agent-card__body">
                <span className="otto-agent-card__name">{expert.name}</span>
                <span className="otto-agent-card__tag">{expert.tagline}</span>
                <span className="otto-agent-card__skills">
                  {expert.skills.map((s) => (
                    <span key={s} className="otto-agent-card__skill">
                      {s}
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="otto-agents__foot">
          共 {EXPERTS.length} 位专家 · 点击即开一段新对话
        </div>
      </div>
    </div>
  );
}
