/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「智能体」页面。整页展示 8 个企业专家卡片（PPT 创作 / 会议纪要 / 公文撰写 …），
 * 点击某张卡片即启动该专家（onLaunch）：由上层起一段新会话并注入专家开场消息、切回对话页。
 *
 * 这是**页面**不是弹窗：占据主内容区（右侧栏常驻），无遮罩。返回对话经头部「返回对话」
 * 或 Esc（onBack），也可直接点左侧栏任意会话/新建对话切走。打开即聚焦第一张卡片，
 * 键盘可直接回车启动。数据来自纯静态目录 agents/experts。
 */

import React, { useEffect, useRef } from 'react';
import type { Expert } from '../agents/experts.js';
import { getAllExperts } from '../agents/experts.js';
import { IconAgent, IconChevron } from './icons.js';

interface AgentGalleryProps {
  onLaunch: (expert: Expert) => void;
  onBack: () => void;
  /** 当前用户所属部门的 teamId 数组。undefined/空数组 = 个人版，仅显示基础专家 */
  userTeamIds?: string[];
}

export function AgentGallery({
  onLaunch,
  onBack,
  userTeamIds,
}: AgentGalleryProps): React.JSX.Element {
  const experts = getAllExperts(userTeamIds);
  const firstCardRef = useRef<HTMLButtonElement>(null);

  // 打开即聚焦第一张卡片（键盘可直接 Enter 启动）。
  useEffect(() => {
    firstCardRef.current?.focus();
  }, []);

  // Esc 返回对话页。
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onBack();
    }
  };

  return (
    <section
      className="otto-agents-page"
      aria-label="专家 · 企业专家"
      onKeyDown={onKeyDown}
    >
      <header className="otto-agents__head">
        <IconAgent size={20} className="otto-agents__headicon" />
        <div className="otto-agents__headtext">
          <div className="otto-agents__title">专家 · 企业专家</div>
          <div className="otto-agents__subtitle">
            选一位专家开始 —— 它会加载对应技能并按方法协助你
          </div>
        </div>
        <button
          type="button"
          className="otto-agents__back"
          onClick={onBack}
          title="返回对话"
          aria-label="返回对话"
        >
          <IconChevron size={14} className="otto-agents__back-chev" />
          返回对话
        </button>
      </header>

      <div className="otto-agents__scroll">
        <div className="otto-agents__grid">
          {experts.map((expert, i) => (
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
                  {expert.departments && expert.departments.length > 0 && (
                    <span className="otto-agent-card__skill otto-agent-card__skill--dept">
                      🔒 部门专属
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="otto-agents__foot">
          共 {experts.length} 位专家 · 点击即开一段新对话
        </div>
      </div>
    </section>
  );
}
