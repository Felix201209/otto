/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';

// 诚实原则：只保留有真实功能或诚实空态的 tab。
//   - memory：暂无后端 → 诚实空态占位（不再编造「望京店房源」等假条目）。
//   - browser：内置 iframe 浏览器，真实可用，保留。
//   - notes：真实可编辑的本地文本框；暂不落盘，明确标注「不保存」。
// 已移除的 tab：
//   - commands：纯展示文字、点了无反应，且含桌面端已禁用的假命令 → 撤下。
//   - ide：硬编码的假代码片段装饰、纯摆设 → 撤下。
type TabType = 'memory' | 'browser' | 'notes';

const TAB_LABEL: Record<TabType, string> = {
  memory: '记忆',
  browser: '浏览器',
  notes: '笔记',
};

const TABS: TabType[] = ['memory', 'browser', 'notes'];

export function RightMascotPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabType>('memory');
  const [noteText, setNoteText] = useState<string>('');
  const [browserUrl, setBrowserUrl] = useState<string>('about:blank');

  return (
    <aside className="otto-right-panel" style={{ width: '300px', minWidth: '300px', height: '100%', background: 'var(--otto-sidebar-bg)', borderLeft: '1px solid var(--otto-border)', display: 'flex', flexDirection: 'column' }}>
      {/* Tab Selectors */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--otto-border)', background: 'var(--otto-surface)', padding: '4px' }}>
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: '6px 2px',
              border: 'none',
              background: activeTab === tab ? 'var(--otto-accent-soft)' : 'transparent',
              color: activeTab === tab ? 'var(--otto-accent)' : 'var(--otto-text-secondary)',
              fontSize: '11px',
              fontWeight: activeTab === tab ? 'bold' : 'normal',
              borderRadius: 'var(--otto-radius-sm)',
              cursor: 'pointer',
              transition: 'all 0.12s'
            }}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      {/* Tab Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {activeTab === 'memory' && (
          <div>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>组织/部门记忆文件</div>
            {/* 诚实空态：未接入记忆后端前不展示任何编造条目。 */}
            <div style={{ padding: '20px 12px', textAlign: 'center', color: 'var(--otto-text-secondary)', fontSize: '11px', lineHeight: '1.6', background: 'var(--otto-surface)', border: '1px dashed var(--otto-border)', borderRadius: 'var(--otto-radius-sm)' }}>
              接入记忆后端后，这里会显示组织 / 部门 / 角色的真实记忆文件。
              <br />
              当前尚未接入，暂无内容。
            </div>
          </div>
        )}

        {activeTab === 'browser' && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <input
                type="text"
                value={browserUrl}
                onChange={(e) => setBrowserUrl(e.target.value)}
                style={{ flex: 1, fontSize: '11px', padding: '4px 8px', border: '1px solid var(--otto-border)', borderRadius: '4px', outline: 'none' }}
              />
              <button style={{ fontSize: '10px', padding: '4px 8px', background: 'var(--otto-accent)', color: 'var(--otto-bg)', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                      onClick={() => setBrowserUrl(browserUrl)}>Go</button>
            </div>
            <div style={{ flex: 1, border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', background: 'var(--otto-surface)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <iframe
                src={browserUrl}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Built-in Browser"
              />
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', textTransform: 'uppercase' }}>本地笔记</div>
            {/* 诚实：暂不落盘，明确告知仅当前会话有效，避免用户误以为已保存。 */}
            <div style={{ fontSize: '10px', color: 'var(--otto-text-secondary)', lineHeight: '1.4' }}>
              临时草稿：仅当前会话有效，暂不保存到本地。
            </div>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="随手记点什么…（暂不保存）"
              style={{
                flex: 1,
                width: '100%',
                padding: '8px',
                border: '1px solid var(--otto-border)',
                borderRadius: 'var(--otto-radius-sm)',
                fontFamily: 'var(--otto-font-mono)',
                fontSize: '11px',
                outline: 'none',
                resize: 'none'
              }}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
