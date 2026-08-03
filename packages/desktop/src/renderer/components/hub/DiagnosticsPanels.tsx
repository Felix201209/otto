/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心 ·「诊断」组面板：依赖体检 / Context 用量 / Workflow。
 * 数据与动作全部来自 useSettingsData，本文件只负责排版。
 */

import React from 'react';
import type { DesktopRuntimeDiagnostic } from '../../../preload/index.js';
import type { SessionSummary } from 'otto-server';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { IconCheck, IconClose } from '../icons.js';
import { Panel, Card, Badge, Empty } from './HubUI.js';

// ── 依赖体检 ──────────────────────────────────────────────────────────────

export function DoctorPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;
  const [bundleState, setBundleState] = React.useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const report = state.doctorReport;
  const [runtime, setRuntime] = React.useState<DesktopRuntimeDiagnostic | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void window.otto.runtimeDiagnostic().then((next) => {
      if (!cancelled) setRuntime(next);
    }).catch(() => {
      if (!cancelled) setRuntime(null);
    });
    return () => { cancelled = true; };
  }, []);
  // 缺失的排前面：体检的读者关心的是「缺什么」，就绪项只是背景。
  const checks = report
    ? [...report.checks].sort((a, b) => Number(a.present) - Number(b.present))
    : [];

  return (
    <Panel
      title="依赖体检"
      desc="检查文档 / 媒体 / 浏览器等能力所需的外部依赖是否就绪。"
      actions={
        <>
          <button
            type="button"
            className="otto-hub__btn"
            onClick={async () => {
              setBundleState('working');
              try {
                await window.otto.createDiagnosticBundle();
                setBundleState('done');
              } catch {
                setBundleState('error');
              }
            }}
            disabled={bundleState === 'working'}
          >
            {bundleState === 'working' ? '打包中…' : bundleState === 'done' ? '已保存诊断包' : bundleState === 'error' ? '重新导出诊断包' : '导出诊断包'}
          </button>
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            onClick={actions.runDoctor}
            disabled={state.doctorRunning}
          >
            {state.doctorRunning ? '体检中…' : '开始体检'}
          </button>
        </>
      }
    >
      <Card>
        <div className="otto-hub__item">
          <span className="otto-hub__row-name">本地服务</span>
          <span className="otto-hub__row-detail">{runtime?.server.message ?? '正在读取运行状态…'}</span>
          <Badge tone={runtime?.server.status === 'unavailable' ? 'danger' : 'accent'}>
            {runtime?.server.status === 'ready' ? `已就绪${runtime.server.ownership ? ` · ${runtime.server.ownership}` : ''}` : runtime?.server.status === 'unavailable' ? '不可用' : '启动中'}
          </Badge>
        </div>
        <div className="otto-hub__item">
          <span className="otto-hub__row-name">原生核心</span>
          <span className="otto-hub__row-detail">{runtime?.nativeCore.message ?? '正在读取原生核心状态…'}</span>
          <Badge>{runtime ? `${runtime.nativeCore.mode} · ${runtime.nativeCore.status}` : '未知'}</Badge>
        </div>
      </Card>
      {!report ? (
        <Empty>点击「开始体检」检查 pandoc / libreoffice / ffmpeg / playwright 等外部依赖。</Empty>
      ) : (
        <>
          <div className="otto-hub__statgrid">
            <div className="otto-hub__stat">
              <div className="otto-hub__stat-value">{report.presentCount}</div>
              <div className="otto-hub__stat-label">就绪</div>
            </div>
            <div className="otto-hub__stat">
              <div
                className={
                  'otto-hub__stat-value' +
                  (report.missingCount > 0 ? ' otto-hub__stat-value--warn' : '')
                }
              >
                {report.missingCount}
              </div>
              <div className="otto-hub__stat-label">缺失</div>
            </div>
            <div className="otto-hub__stat">
              <div className="otto-hub__stat-value otto-hub__stat-value--text">
                {report.platform}
              </div>
              <div className="otto-hub__stat-label">平台</div>
            </div>
          </div>
          <Card>
            {checks.map((c) => (
              <div key={c.name} className="otto-hub__item">
                <span className="otto-hub__item-lead" aria-hidden>
                  {c.present ? (
                    <IconCheck size={13} className="otto-hub__doctor-ok" />
                  ) : (
                    <IconClose size={13} className="otto-hub__doctor-missing" />
                  )}
                </span>
                <span className="otto-hub__row-name">{c.name}</span>
                <span className="otto-hub__row-detail">
                  {c.present
                    ? c.version
                      ? 'v' + c.version
                      : '已就绪'
                    : (c.installHint ?? '未安装')}
                </span>
                <Badge>{c.category}</Badge>
              </div>
            ))}
          </Card>
        </>
      )}
    </Panel>
  );
}

// ── Context 用量 ──────────────────────────────────────────────────────────

export function ContextPanel({
  data,
  activeSession,
}: {
  data: UseSettingsData;
  activeSession: SessionSummary | null;
}): React.JSX.Element {
  const { state, actions } = data;
  const b = state.contextBreakdown;
  const loaded = activeSession && b && b.sessionId === activeSession.sessionId;

  return (
    <Panel
      title="Context 用量"
      desc="当前会话的上下文窗口占用明细。"
      actions={
        activeSession ? (
          <>
            <button
              type="button"
              className="otto-hub__btn"
              onClick={() => actions.refreshContextBreakdown(activeSession.sessionId)}
            >
              刷新
            </button>
            <button
              type="button"
              className="otto-hub__btn otto-hub__btn--primary"
              onClick={() => actions.compressContext(activeSession.sessionId)}
              disabled={state.compressRunning || !loaded}
            >
              {state.compressRunning ? '压缩中…' : '压缩上下文'}
            </button>
          </>
        ) : undefined
      }
    >
      {!activeSession ? (
        <Empty>请先选择一个会话。</Empty>
      ) : !loaded ? (
        <Empty>正在加载 context 用量…</Empty>
      ) : (
        <ContextUsageCard data={data} sessionBreakdown={b} />
      )}
    </Panel>
  );
}

function ContextUsageCard({
  data,
  sessionBreakdown: b,
}: {
  data: UseSettingsData;
  sessionBreakdown: NonNullable<UseSettingsData['state']['contextBreakdown']>;
}): React.JSX.Element {
  const segments: Array<{ label: string; value: number; cls: string }> = [
    { label: 'System Prompt', value: b.systemPromptTokens, cls: 'sys' },
    { label: '工具定义', value: b.systemToolsTokens, cls: 'tools' },
    { label: '记忆文件', value: b.memoryFilesTokens, cls: 'memory' },
    { label: '消息历史', value: b.messagesTokens, cls: 'msgs' },
  ];
  const used = b.totalInputTokens;
  const pct = b.maxTokens > 0 ? Math.min(100, (used / b.maxTokens) * 100) : 0;

  return (
    <Card className="otto-hub__card--pad">
      <div className="otto-hub__ctx-head">
        <span>{b.modelDisplayName}</span>
        <span>
          {used.toLocaleString()} / {b.maxTokens.toLocaleString()} tokens ·{' '}
          {pct.toFixed(1)}% · 剩余 {b.freeSpaceTokens.toLocaleString()}
        </span>
      </div>
      {/* 分段着色的占用条：各段颜色与下方图例一一对应。 */}
      <div className="otto-hub__ctx-bar">
        {segments.map((seg) => (
          <div
            key={seg.cls}
            className={'otto-hub__ctx-seg otto-hub__ctx-seg--' + seg.cls}
            style={{
              width: b.maxTokens > 0 ? (seg.value / b.maxTokens) * 100 + '%' : '0%',
            }}
          />
        ))}
      </div>
      <div className="otto-hub__ctx-legend">
        {segments.map((seg) => (
          <div key={seg.label} className="otto-hub__ctx-legend-item">
            <span className={'otto-hub__ctx-dot otto-hub__ctx-dot--' + seg.cls} />
            {seg.label}: {seg.value.toLocaleString()}
          </div>
        ))}
      </div>
      {data.state.compressMessage ? (
        <div className="otto-hub__field-hint">{data.state.compressMessage}</div>
      ) : null}
    </Card>
  );
}

// ── Workflow ──────────────────────────────────────────────────────────────

function formatWorkflowDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function workflowStatusLabel(status: string): string {
  return status === 'completed' ? '已完成' : status === 'failed' ? '失败' : '运行中';
}

function workflowStatusClass(status: string): string {
  return status === 'completed'
    ? 'otto-hub__wfstatus--done'
    : status === 'failed'
      ? 'otto-hub__wfstatus--fail'
      : 'otto-hub__wfstatus--run';
}

export function WorkflowsPanel({ data }: { data: UseSettingsData }): React.JSX.Element {
  const { state, actions } = data;

  return (
    <Panel
      title="Workflow"
      desc="多专家 workflow 的运行记录与各 agent 明细。"
      actions={
        <button type="button" className="otto-hub__btn" onClick={actions.refreshWorkflows}>
          刷新
        </button>
      }
    >
      {state.workflows.length === 0 ? (
        <Empty>当前没有运行中或已完成的 workflow。</Empty>
      ) : (
        state.workflows.map((wf) => {
          const agents = wf.phases.length ? wf.phases.flatMap((p) => p.agents) : wf.agents;
          const duration = formatWorkflowDuration((wf.endTime ?? Date.now()) - wf.startTime);
          return (
            <Card key={wf.id} className="otto-hub__card--pad">
              <div className="otto-hub__workflow-head">
                <span className={'otto-hub__wfstatus ' + workflowStatusClass(wf.status)}>
                  {workflowStatusLabel(wf.status)}
                </span>
                <span className="otto-hub__row-name">{wf.description}</span>
                <span className="otto-hub__row-status">
                  {duration} · {wf.totalTokenUsage.totalTokens.toLocaleString()} tokens
                </span>
              </div>
              {agents.length > 0 ? (
                <div className="otto-hub__workflow-agents">
                  {agents.map((a) => (
                    <div key={a.agentId} className="otto-hub__workflow-agent">
                      <span className={'otto-hub__wfstatus ' + workflowStatusClass(a.status)}>
                        {workflowStatusLabel(a.status)}
                      </span>
                      <span className="otto-hub__row-name">{a.label}</span>
                      <span className="otto-hub__row-status">
                        工具调用 {a.toolCallCount}
                        {a.tokenUsage
                          ? ` · ${a.tokenUsage.totalTokens.toLocaleString()} tokens`
                          : ''}
                        {a.currentPhase === 'executing_tools' ? ' · 执行工具中' : ''}
                        {a.currentPhase === 'thinking' ? ' · 思考中' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          );
        })
      )}
    </Panel>
  );
}
