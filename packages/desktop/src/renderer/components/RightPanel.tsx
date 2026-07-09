/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

/**
 * 右侧面板（原 RightMascotPanel 更名而来）。5 个 tab，默认「智能体」：
 *   - agents：8 个企业专家竖列卡片（数据 EXPERTS），点击 onLaunchExpert 起新会话，
 *     底部「全部智能体」入口 onOpenAgents 打开 AgentGallery 整页。
 *     （原左侧栏「常见任务」区块迁到这里，行为不变。）
 *   - tools：常用 slash 命令快捷列表（数据复用 Composer 的 SLASH_COMMANDS，
 *     排除与智能体 tab 重复的专家类命令），点击经 insertComposerDraft 把
 *     `/命令` 填入底部输入框（不发送），回车即执行。
 *   - memory / browser / notes：原功能原样保留（诚实空态 / iframe 浏览器 / 不落盘草稿）。
 * 样式全部走 app.css 的 .otto-right-panel* / .otto-expert-card* / .otto-tool-item*
 * BEM 类（tokens 变量，暗色自动跟随），不再有内联样式。
 */

import React, { useState } from 'react';
import { EXPERTS, type Expert } from '../agents/experts.js';
import { SLASH_COMMANDS, insertComposerDraft } from './Composer.js';
import { IconChevron, IconChevronDown, IconTerminal } from './icons.js';

/**
 * 「自主开发」入口（腰线下的 code 功能，Jeremy 需求）。不进 EXPERTS——
 * 它不是企业专家人设，而是研发向的代码任务入口；单独常量避免影响
 * AgentGallery 九宫格与既有测试。点击同样走 launchExpert 起新会话。
 */
const DEV_EXPERT: Expert = {
  id: 'self-dev',
  name: '自主开发',
  tagline: '写代码 · 改项目 · 自动化任务',
  emoji: '⌨️',
  accent: '#38bdf8',
  skills: [],
  kickoff:
    '我要进行代码开发任务。请先查看当前项目的结构和技术栈，然后问我本次要实现或修复的目标，给出实现计划，经我确认后动手完成；过程中的关键改动请逐步说明并在完成后运行必要的验证。',
};

type TabType = 'agents' | 'tools' | 'memory' | 'browser' | 'notes';

const TAB_LABEL: Record<TabType, string> = {
  agents: '智能体',
  tools: '工具',
  memory: '记忆',
  browser: '浏览器',
  notes: '笔记',
};

const TABS: TabType[] = ['agents', 'tools', 'memory', 'browser', 'notes'];

/**
 * 工具 tab 展示的高频命令 id。从 SLASH_COMMANDS 里挑：
 *   - 排除专家类（ppt/doc/pdf/excel/research）——智能体 tab 已以专家卡片形式提供；
 *   - 排除低频运维项（desktop 重装、feishu-start/stop——保留 feishu-status 即可查连状态）。
 * 列表顺序沿用 SLASH_COMMANDS 定义顺序（基础命令在前）。
 */
const TOOL_COMMAND_IDS = new Set([
  'new',
  'model',
  'clear',
  'settings',
  'doctor',
  'feishu-status',
  'multi-channel',
  'memory',
  'skills',
  'audio',
  'browser',
  'ide',
  'export',
  'workflow',
]);

const TOOL_COMMANDS = SLASH_COMMANDS.filter((c) => TOOL_COMMAND_IDS.has(c.id));

interface RightPanelProps {
  /** 点击专家卡片：起新会话并注入专家开场消息（与原 Sidebar 常见任务行为一致）。 */
  onLaunchExpert: (expert: Expert) => void;
  /** 打开「智能体」整页画廊（AgentGallery）。 */
  onOpenAgents: () => void;
}

export function RightPanel({
  onLaunchExpert,
  onOpenAgents,
}: RightPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabType>('agents');
  const [noteText, setNoteText] = useState<string>('');
  const [browserUrl, setBrowserUrl] = useState<string>('about:blank');
  // 分区折叠状态（点击组头展开/缩回）。默认全展开。
  const [expertsOpen, setExpertsOpen] = useState<boolean>(true);
  const [devOpen, setDevOpen] = useState<boolean>(true);

  return (
    <aside className="otto-right-panel">
      <div
        className="otto-right-panel__tabs"
        role="tablist"
        aria-label="右侧面板"
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={`otto-right-panel__tab${
              activeTab === tab ? ' is-active' : ''
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      <div className="otto-right-panel__body">
        {activeTab === 'agents' && (
          <div>
            {/* 企业专家组：组头可点击折叠/展开（交互栏过多时收起腾地方）。 */}
            <button
              type="button"
              className="otto-right-panel__grouphead"
              onClick={() => setExpertsOpen((v) => !v)}
              aria-expanded={expertsOpen}
            >
              <span>企业专家</span>
              <IconChevronDown
                size={14}
                className={
                  'otto-right-panel__grouphead-chev' +
                  (expertsOpen ? '' : ' is-collapsed')
                }
              />
            </button>
            {expertsOpen ? (
              <>
                <div className="otto-expert-list">
                  {EXPERTS.map((expert) => (
                    <button
                      key={expert.id}
                      type="button"
                      className="otto-expert-card"
                      onClick={() => onLaunchExpert(expert)}
                      title={expert.tagline}
                    >
                      <span
                        className="otto-expert-card__icon"
                        style={{ color: expert.accent }}
                        aria-hidden
                      >
                        {expert.emoji}
                      </span>
                      <span className="otto-expert-card__body">
                        <span className="otto-expert-card__name">
                          {expert.name}
                        </span>
                        <span className="otto-expert-card__desc">
                          {expert.tagline}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="otto-right-panel__moreagents"
                  onClick={onOpenAgents}
                  title="查看完整智能体画廊"
                >
                  全部智能体
                  <IconChevron
                    size={14}
                    className="otto-right-panel__moreagents-chev"
                  />
                </button>
              </>
            ) : null}

            {/* 腰线：企业专家与自主开发的视觉分隔（Jeremy 需求）。 */}
            <div className="otto-right-panel__waist" role="separator" />

            <button
              type="button"
              className="otto-right-panel__grouphead"
              onClick={() => setDevOpen((v) => !v)}
              aria-expanded={devOpen}
            >
              <span>自主开发</span>
              <IconChevronDown
                size={14}
                className={
                  'otto-right-panel__grouphead-chev' +
                  (devOpen ? '' : ' is-collapsed')
                }
              />
            </button>
            {devOpen ? (
              <div className="otto-expert-list">
                <button
                  type="button"
                  className="otto-expert-card"
                  onClick={() => onLaunchExpert(DEV_EXPERT)}
                  title={DEV_EXPERT.tagline}
                >
                  <span
                    className="otto-expert-card__icon otto-expert-card__icon--dev"
                    aria-hidden
                  >
                    <IconTerminal size={17} />
                  </span>
                  <span className="otto-expert-card__body">
                    <span className="otto-expert-card__name">
                      {DEV_EXPERT.name}
                    </span>
                    <span className="otto-expert-card__desc">
                      {DEV_EXPERT.tagline}
                    </span>
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        )}

        {activeTab === 'tools' && (
          <div>
            <div className="otto-right-panel__head">常用命令</div>
            <div className="otto-right-panel__hint">
              点击把命令填入输入框，回车执行
            </div>
            <div className="otto-tool-list">
              {TOOL_COMMANDS.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  className="otto-tool-item"
                  onClick={() => insertComposerDraft(`/${cmd.id}`)}
                  title={cmd.description}
                >
                  <span className="otto-tool-item__cmd">/{cmd.id}</span>
                  <span className="otto-tool-item__desc">
                    {cmd.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'memory' && (
          <div>
            <div className="otto-right-panel__head">组织/部门记忆文件</div>
            {/* 诚实空态：未接入记忆后端前不展示任何编造条目。 */}
            <div className="otto-right-panel__empty">
              接入记忆后端后，这里会显示组织 / 部门 / 角色的真实记忆文件。
              <br />
              当前尚未接入，暂无内容。
            </div>
          </div>
        )}

        {activeTab === 'browser' && (
          <div className="otto-right-panel__browser">
            <div className="otto-right-panel__urlrow">
              <input
                type="text"
                className="otto-right-panel__urlinput"
                value={browserUrl}
                onChange={(e) => setBrowserUrl(e.target.value)}
                aria-label="网址"
              />
              <button
                type="button"
                className="otto-right-panel__go"
                onClick={() => setBrowserUrl(browserUrl)}
              >
                Go
              </button>
            </div>
            <div className="otto-right-panel__frame">
              <iframe
                src={browserUrl}
                className="otto-right-panel__iframe"
                title="内置浏览器"
              />
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="otto-right-panel__notes">
            <div className="otto-right-panel__head">本地笔记</div>
            {/* 诚实：暂不落盘，明确告知仅当前会话有效，避免用户误以为已保存。 */}
            <div className="otto-right-panel__hint">
              临时草稿：仅当前会话有效，暂不保存到本地。
            </div>
            <textarea
              className="otto-right-panel__textarea"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="随手记点什么…（暂不保存）"
              aria-label="本地笔记"
            />
          </div>
        )}
      </div>
    </aside>
  );
}
