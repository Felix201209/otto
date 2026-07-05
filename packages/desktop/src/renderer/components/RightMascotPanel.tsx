/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';

type TabType = 'memory' | 'commands' | 'browser' | 'ide' | 'notes';

export function RightMascotPanel(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabType>('memory');
  const [memoryFiles, setMemoryFiles] = useState<string[]>([]);
  const [commandList, setCommandList] = useState<string[]>([]);
  const [noteText, setNoteText] = useState<string>('# 我的工作笔记\n\n- 今日任务：分析朝阳区数据并生成周报。');
  const [browserUrl, setBrowserUrl] = useState<string>('about:blank');

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

  const fetchCommands = async () => {
    setCommandList([
      '/new - 新建会话',
      '/model - 切换模型',
      '/settings - 模型与飞书设置',
      '/feishu-start - 开启飞书控制',
      '/feishu-stop - 停止飞书控制',
      '/doctor - 本机环境诊断',
      '/workflow - 启动工作流任务',
      '/export - 导出当前结果'
    ]);
  };

  useEffect(() => {
    fetchMemory();
    fetchCommands();
  }, []);

  return (
    <aside className="otto-right-panel" style={{ width: '300px', minWidth: '300px', height: '100%', background: 'var(--otto-sidebar-bg)', borderLeft: '1px solid var(--otto-border)', display: 'flex', flexDirection: 'column' }}>
      {/* Tab Selectors */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--otto-border)', background: 'var(--otto-surface)', padding: '4px' }}>
        {(['memory', 'commands', 'browser', 'ide', 'notes'] as TabType[]).map((tab) => (
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
            {tab === 'memory' ? '记忆' : tab === 'commands' ? '命令' : tab === 'browser' ? '浏览器' : tab === 'ide' ? 'IDE' : '笔记'}
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
                  <span style={{ color: 'var(--otto-text-secondary)', marginRight: '6px' }}>□</span>
                  {file}
                </div>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--otto-text-secondary)', marginTop: '16px', lineHeight: '1.4' }}>
              * 记忆由 learn 机制在干活过程中静默生长、脱敏，并在 onboard 时由新员工自动继承。
            </div>
          </div>
        )}

        {activeTab === 'commands' && (
          <div>
            <div style={{ fontSize: '10px', fontWeight: 'bold', color: 'var(--otto-text-secondary)', marginBottom: '8px', textTransform: 'uppercase' }}>Otto / EasyCode 命令索引</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {commandList.map((cmd, i) => (
                <div key={i} style={{ padding: '8px 10px', background: 'var(--otto-surface)', border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', fontSize: '11px', color: 'var(--otto-text)' }}>
                  <span style={{ color: 'var(--otto-text-secondary)', marginRight: '6px' }}>/</span>
                  {cmd}
                </div>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--otto-text-secondary)', marginTop: '16px', lineHeight: '1.4' }}>
              8 个专家已移入左侧「常见任务」。这里仅保留命令与工作台能力索引。
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
            <div style={{ flex: 1, border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', background: 'var(--otto-surface)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContext: 'center' }}>
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
            <div style={{ flex: 1, border: '1px solid var(--otto-border)', borderRadius: 'var(--otto-radius-sm)', background: 'var(--otto-surface)', padding: '8px', fontFamily: 'var(--otto-font-mono)', fontSize: '11px', color: 'var(--otto-text-secondary)', overflowY: 'auto' }}>
              <div><span style={{ color: 'var(--otto-text-secondary)' }}>const</span> <span style={{ color: 'var(--otto-text)' }}>main</span> = () =&gt; &#123;</div>
              <div>&nbsp;&nbsp;<span style={{ color: 'var(--otto-text-secondary)' }}>const</span> <span style={{ color: 'var(--otto-text-secondary)' }}>agent</span> = <span style={{ color: '#cc7832' }}>new</span> <span style={{ color: 'var(--otto-text)' }}>Otto</span>(&#123;</div>
              <div>&nbsp;&nbsp;&nbsp;&nbsp;role: <span style={{ color: 'var(--otto-text-tertiary)' }}>"real_estate_agent"</span>,</div>
              <div>&nbsp;&nbsp;&nbsp;&nbsp;memory: <span style={{ color: 'var(--otto-text-secondary)' }}>true</span></div>
              <div>&nbsp;&nbsp;&#125;);</div>
              <div>&nbsp;&nbsp;<span style={{ color: 'var(--otto-text-secondary)' }}>agent</span>.<span style={{ color: 'var(--otto-text)' }}>learn</span>(<span style={{ color: 'var(--otto-text-tertiary)' }}>"onboard"</span>);</div>
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
