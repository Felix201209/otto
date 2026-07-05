/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';

type TabType = 'memory' | 'skills' | 'browser' | 'ide' | 'notes';

export function RightMascotPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabType>('memory');
  const [memoryFiles, setMemoryFiles] = useState<string[]>([]);
  const [skillsList, setSkillsList] = useState<string[]>([]);
  const [noteText, setNoteText] = useState<string>('# 我的工作笔记\n\n- 今日任务：分析朝阳区数据并生成周报。');
  const [browserUrl, setBrowserUrl] = useState<string>('https://huggingface.co/spaces/DyrusQZ/LHM');

  // Load local memory indices
  const fetchMemory = async () => {
    try {
      // In production, fetch via window.otto API or endpoint.
      // Mocking highly descriptive organizational memories.
      setMemoryFiles([
        'employee.markdown - 个人习惯与效率趋势',
        'department.markdown - 望京店标准房源录入SOP',
        'role.markdown - 房产经纪人高频协作流程',
        'workflows/listing_entry.markdown - 3次自动沉淀模型',
        'reports/report_30d_2026.md - 团队省时与Token花费月报'
      ]);
    } catch {}
  };

  const fetchSkills = async () => {
    setSkillsList([
      'ppt-creator - 结构化叙事幻灯片',
      'doc-writer - Word 公文报告规范写作',
      'meeting-notes - 会议录音一键成纪要',
      'data-viz-pro - 图表选型与自动出图',
      'pdf-toolkit - PDF合并拆分与高压缩',
      'spreadsheet-pro - Excel 建模与透视表',
      'market-research - 竞品调研与 SWOT',
      'copywriting - 品牌营销文案生成'
    ]);
  };

  useEffect(() => {
    fetchMemory();
    fetchSkills();
  }, []);

  return (
    <aside className="otto-right-panel" style={{ width: '300px', minWidth: '300px', height: '100%', background: 'var(--otto-sidebar-bg)', borderLeft: '1px solid var(--otto-border)', display: 'flex', flexDirection: 'column' }}>
      {/* Tab Selectors */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--otto-border)', background: 'var(--otto-surface)', padding: '4px' }}>
        {(['memory', 'skills', 'browser', 'ide', 'notes'] as TabType[]).map((tab) => (
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
            {tab === 'memory' ? '记忆' : tab === 'skills' ? '技能' : tab === 'browser' ? '浏览器' : tab === 'ide' ? 'IDE' : '笔记'}
          </button>
        ))}
      </div>

      {/* Tab Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {activeTab === 'memory' && (
          <div>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>组织/部门记忆文件</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {memoryFiles.map((file, i) => (
                <div key={i} style={{ padding: '8px 10px', background: 'var(--otto-surface)', border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', fontSize: '11px', color: 'var(--otto-text)', cursor: 'pointer' }}
                     onClick={() => alert(`正在查看: ${file.split(' - ')[0]}`)}>
                  <span style={{ color: 'var(--otto-accent)', marginRight: '6px' }}>🗎</span>
                  {file}
                </div>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--otto-text-secondary)', marginTop: '16px', lineHeight: '1.4' }}>
              * 记忆由 learn 机制在干活过程中静默生长、脱敏，并在 onboard 时由新员工自动继承。
            </div>
          </div>
        )}

        {activeTab === 'skills' && (
          <div>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>已装载企业技能</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {skillsList.map((skill, i) => (
                <div key={i} style={{ padding: '8px 10px', background: 'var(--otto-surface)', border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', fontSize: '11px', color: 'var(--otto-text)' }}>
                  <span style={{ color: 'var(--otto-local-fg)', marginRight: '6px' }}>⚡</span>
                  {skill}
                </div>
              ))}
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
              <button style={{ fontSize: '10px', padding: '4px 8px', background: 'var(--otto-accent)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                      onClick={() => setBrowserUrl(browserUrl)}>Go</button>
            </div>
            <div style={{ flex: 1, border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', background: '#fff', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContext: 'center' }}>
              <iframe
                src={browserUrl}
                style={{ width: '100%', height: '100%', border: 'none' }}
                title="Built-in Browser"
              />
            </div>
          </div>
        )}

        {activeTab === 'ide' && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', textTransform: 'uppercase' }}>内置极客 IDE</div>
            <div style={{ flex: 1, border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', background: '#1e1e1e', padding: '8px', fontFamily: 'var(--otto-font-mono)', fontSize: '11px', color: '#a9b7c6', overflowY: 'auto' }}>
              <div><span style={{ color: '#cc7832' }}>const</span> <span style={{ color: '#ffc66d' }}>main</span> = () =&gt; &#123;</div>
              <div>&nbsp;&nbsp;<span style={{ color: '#cc7832' }}>const</span> <span style={{ color: '#9876aa' }}>agent</span> = <span style={{ color: '#cc7832' }}>new</span> <span style={{ color: '#ffc66d' }}>Otto</span>(&#123;</div>
              <div>&nbsp;&nbsp;&nbsp;&nbsp;role: <span style={{ color: '#6a8759' }}>"real_estate_agent"</span>,</div>
              <div>&nbsp;&nbsp;&nbsp;&nbsp;memory: <span style={{ color: '#cc7832' }}>true</span></div>
              <div>&nbsp;&nbsp;&#125;);</div>
              <div>&nbsp;&nbsp;<span style={{ color: '#9876aa' }}>agent</span>.<span style={{ color: '#ffc66d' }}>learn</span>(<span style={{ color: '#6a8759' }}>"onboard"</span>);</div>
              <div>&#125;;</div>
            </div>
          </div>
        )}

        {activeTab === 'notes' && (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', textTransform: 'uppercase' }}>Markdown 本地笔记</div>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
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
