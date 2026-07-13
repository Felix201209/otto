/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import {
  BASE_AGENT_PROFILES,
  DEPARTMENT_LABELS,
  getEnterpriseAgentProfiles,
  getAgentComposerPrompt,
  type AgentProfile,
} from '../agents/departmentAgents.js';
import { GeneratedIcon } from './GeneratedIcon.js';
import { IconAgent, IconChevron } from './icons.js';

export interface AgentGalleryProps {
  mode?: 'personal' | 'enterprise';
  profiles?: readonly AgentProfile[];
  onLaunch: (profile: AgentProfile, composerPrompt: string) => void;
  onBack: () => void;
}

export function AgentGallery({
  mode = 'personal',
  profiles = mode === 'personal'
    ? BASE_AGENT_PROFILES
    : getEnterpriseAgentProfiles('company_owner'),
  onLaunch,
  onBack,
}: AgentGalleryProps): React.JSX.Element {
  const firstCardRef = useRef<HTMLButtonElement>(null);
  useEffect(() => firstCardRef.current?.focus(), []);

  return (
    <section className="otto-agents-page" aria-label="专家目录" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onBack(); }
    }}>
      <header className="otto-agents__head">
        <IconAgent size={20} className="otto-agents__headicon" />
        <div className="otto-agents__headtext">
          <div className="otto-agents__title">{mode === 'personal' ? '个人专家' : '企业专家目录'}</div>
          <div className="otto-agents__subtitle">选择一位专家开始，它会在独立会话中按对应方法协助你</div>
        </div>
        <button type="button" className="otto-agents__back" onClick={onBack} aria-label="返回对话">
          <IconChevron size={14} /> 返回对话
        </button>
      </header>
      <div className="otto-agents__scroll">
        <div className="otto-agents__grid">
          {profiles.map((profile, index) => (
            <button key={profile.id} ref={index === 0 ? firstCardRef : undefined} type="button" className="otto-agent-card" onClick={() => onLaunch(profile, getAgentComposerPrompt(profile))}>
              <span
                className="otto-agent-card__avatar"
                aria-hidden
                style={profile.accent ? { backgroundColor: `${profile.accent}24` } : undefined}
              >
                {profile.icon ? <GeneratedIcon name={profile.icon} size={26} /> : profile.name.slice(0, 1)}
              </span>
              <span className="otto-agent-card__body">
                <span className="otto-agent-card__name">{profile.name}</span>
                <span className="otto-agent-card__tag">{profile.tagline}</span>
                <span className="otto-agent-card__skills">
                  {profile.department ? <span className="otto-agent-card__skill">{DEPARTMENT_LABELS[profile.department]}</span> : null}
                  {profile.skills.map((skill) => <span key={skill} className="otto-agent-card__skill">{skill}</span>)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="otto-agents__foot">共 {profiles.length} 位专家 · 点击即可开始新对话</div>
      </div>
    </section>
  );
}
