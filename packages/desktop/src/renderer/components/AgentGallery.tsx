/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「智能体」页面。按个人版/企业版权限展示新版 Agent profile。
 * 点击某张卡片只回传白名单 profile，由服务端在新会话里注入能力与 Skill。
 *
 * 这是**页面**不是弹窗：占据主内容区（右侧栏常驻），无遮罩。返回对话经头部「返回对话」
 * 或 Esc（onBack），也可直接点左侧栏任意会话/新建对话切走。打开即聚焦第一张卡片，
 * 键盘可直接回车启动。数据来自纯静态目录 agents/experts。
 */

import React, { useEffect, useRef } from 'react';
import {
  getEnterpriseAgentProfiles,
  getPersonalAgentProfiles,
  type AgentProfile,
} from '../agents/departmentAgents.js';
import { GeneratedIcon } from './GeneratedIcon.js';
import { IconAgent, IconChevron } from './icons.js';

interface AgentGalleryProps {
  mode?: 'personal' | 'enterprise';
  profiles?: readonly AgentProfile[];
  onLaunch: (profile: AgentProfile) => void;
  onBack: () => void;
}

export function AgentGallery({
  mode = 'personal',
  profiles,
  onLaunch,
  onBack,
}: AgentGalleryProps): React.JSX.Element {
  const visibleProfiles = profiles ?? (
    mode === 'enterprise'
      ? getEnterpriseAgentProfiles('company_owner')
      : getPersonalAgentProfiles()
  );
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
      aria-label="专家目录"
      onKeyDown={onKeyDown}
    >
      <header className="otto-agents__head">
        <IconAgent size={20} className="otto-agents__headicon" />
        <div className="otto-agents__headtext">
          <div className="otto-agents__title">专家</div>
          <div className="otto-agents__subtitle">
            选择一位专家开始，它会在独立会话中按对应方法协助你
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
          {visibleProfiles.map((profile, i) => (
            <button
              key={profile.id}
              ref={i === 0 ? firstCardRef : undefined}
              type="button"
              className="otto-agent-card"
              style={{ ['--card-accent' as string]: profile.accent ?? '#38bdf8' }}
              onClick={() => onLaunch(profile)}
            >
              <span className="otto-agent-card__avatar" aria-hidden>
                {profile.icon
                  ? <GeneratedIcon name={profile.icon} size={28} />
                  : profile.name.slice(0, 1)}
              </span>
              <span className="otto-agent-card__body">
                <span className="otto-agent-card__name">{profile.name}</span>
                <span className="otto-agent-card__tag">{profile.tagline}</span>
                <span className="otto-agent-card__skills">
                  {profile.skills.map((s) => (
                    <span key={s} className="otto-agent-card__skill">
                      {s}
                    </span>
                  ))}
                  {profile.scope === 'department' && (
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
          共 {visibleProfiles.length} 位专家 · 点击即可开始新对话
        </div>
      </div>
    </section>
  );
}
