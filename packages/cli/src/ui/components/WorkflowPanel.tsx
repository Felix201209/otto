/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import {
  WorkflowRegistry,
  WorkflowRecord,
  WorkflowPhaseRecord,
  WorkflowAgentRecord,
} from 'otto-core';
import { Colors } from '../colors.js';
import { setWorkflowPanelOpen } from '../utils/modalState.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function statusIcon(status: string): string {
  if (status === 'completed') return '✔';
  if (status === 'failed') return '✘';
  return '…';
}

function statusColor(status: string): string {
  if (status === 'completed') return Colors.AccentGreen;
  if (status === 'failed') return Colors.AccentRed;
  return Colors.AccentYellow;
}

function allAgents(wf: WorkflowRecord): WorkflowAgentRecord[] {
  const fromPhases = wf.phases.flatMap(p => p.agents);
  return fromPhases.length ? fromPhases : wf.agents;
}

function allAgentsForPhase(phase: WorkflowPhaseRecord): WorkflowAgentRecord[] {
  return phase.agents;
}

/** Truncate string to visWidth columns (CJK-aware), pad with spaces if shorter */
function visSlice(str: string, maxCols: number): string {
  maxCols = Math.max(0, maxCols);
  let cols = 0;
  let i = 0;
  const chars = [...str]; // handle multi-byte correctly
  while (i < chars.length) {
    const w = stringWidth(chars[i]!);
    if (cols + w > maxCols) break;
    cols += w;
    i++;
  }
  const truncated = chars.slice(0, i).join('');
  return truncated + ' '.repeat(maxCols - cols);
}

/** Like visSlice but append '…' if truncated */
function visTrunc(str: string, maxCols: number): string {
  maxCols = Math.max(1, maxCols); // Need at least 1 col for the character + ellipsis
  if (stringWidth(str) <= maxCols) {
    return str + ' '.repeat(maxCols - stringWidth(str));
  }
  // leave 1 col for '…'
  let cols = 0;
  let i = 0;
  const chars = [...str];
  while (i < chars.length) {
    const w = stringWidth(chars[i]!);
    if (cols + w > maxCols - 1) break;
    cols += w;
    i++;
  }
  const padLen = Math.max(0, maxCols - 1 - cols);
  return chars.slice(0, i).join('') + '…' + ' '.repeat(padLen);
}

/** Wrap a string to maxCols columns (CJK-aware), returning an array of visual lines */
function wrapText(text: string, maxCols: number): string[] {
  if (maxCols <= 0) return [text];
  const result: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine === '') { result.push(''); continue; }
    let line = '';
    let lineCols = 0;
    for (const ch of [...rawLine]) {
      const w = stringWidth(ch);
      if (lineCols + w > maxCols) {
        result.push(line);
        line = ch;
        lineCols = w;
      } else {
        line += ch;
        lineCols += w;
      }
    }
    result.push(line);
  }
  return result;
}

type View = 'list' | 'detail' | 'agent';

interface WorkflowPanelProps {
  isVisible: boolean;
  onClose: () => void;
  terminalWidth: number;
  terminalHeight: number;
}

// ─── List view ───────────────────────────────────────────────────────────────

const ListRow: React.FC<{
  wf: WorkflowRecord;
  selected: boolean;
  now: number;
  rowWidth: number;
}> = ({ wf, selected, now, rowWidth }) => {
  const agents = allAgents(wf);
  const duration = wf.endTime ? wf.endTime - wf.startTime : now - wf.startTime;
  const tok = wf.totalTokenUsage.totalTokens;
  const suffix = `  ${agents.length} agent${agents.length !== 1 ? 's' : ''}${tok > 0 ? ` · ${fmtTokens(tok)}` : ''} · ${formatDuration(duration)}`;
  const slugMaxCols = Math.max(6, rowWidth - stringWidth(suffix) - 4); // 4 = selector+icon
  const slugTrunc = visTrunc(wf.slug, slugMaxCols).trimEnd();

  return (
    <Box>
      <Text color={Colors.AccentCyan}>{selected ? '❯ ' : '  '}</Text>
      <Text color={statusColor(wf.status)}>{statusIcon(wf.status)} </Text>
      <Text bold={selected}>{slugTrunc}</Text>
      <Text color={Colors.Gray}>{suffix}</Text>
    </Box>
  );
};

// ─── Detail view (phases left, agents right) ─────────────────────────────────

const DetailView: React.FC<{
  wf: WorkflowRecord;
  selectedPhase: number;
  selectedAgent: number;
  focus: 'left' | 'right';
  now: number;
  width: number;
  height: number;
}> = ({ wf, selectedPhase, selectedAgent, focus, now, width, height }) => {
  const leftWidth = Math.max(22, Math.floor(width * 0.26));
  const rightWidth = width - leftWidth - 3;
  const innerHeight = height - 8; // header=3 lines + footer=1 + borders

  const phases = wf.phases.length ? wf.phases : [{ index: 0, name: '执行', description: '', agents: wf.agents }];
  const currentPhase = phases[selectedPhase];
  const agents = currentPhase ? allAgentsForPhase(currentPhase) : wf.agents;

  // ── header ──────────────────────────────────────────────────────────────────
  const totalAgentCount = allAgents(wf).length;
  const doneAgentCount = allAgents(wf).filter(a => a.status === 'completed').length;
  const dur = formatDuration((wf.endTime ?? now) - wf.startTime);
  const summaryStr = `${doneAgentCount}/${totalAgentCount} agent${totalAgentCount !== 1 ? 's' : ''} · ${dur} · ${wf.status}`;
  // description truncated to fit, with summary right-aligned
  const summaryW = stringWidth(summaryStr);
  const descMaxCols = Math.max(10, width - summaryW - 4);
  const descTrunc = visTrunc(wf.description ?? '', descMaxCols).trimEnd();
  const descW = stringWidth(descTrunc);
  const gapSpaces = Math.max(1, width - descW - summaryW - 2);

  // ── left column: phase name alignment (CJK-aware) ───────────────────────────
  // inner usable cols = leftWidth - 2(border) - 2(paddingX) - 2(selector) - 2(icon)
  const phaseInnerWidth = leftWidth - 8;
  const maxCounterLen = Math.max(...phases.map(p => {
    const total = p.agents.length;
    const done = p.agents.filter(a => a.status === 'completed').length;
    return total > 0 ? `${done}/${total}`.length : 0;
  }), 0);
  const nameColCols = Math.max(4, phaseInnerWidth - maxCounterLen - 1);

  // ── right column: agent row layout (CJK-aware) ──────────────────────────────
  // inner usable cols = rightWidth - 2(border) - 2(paddingX) - 2(selector) - 2(icon)
  const rowInnerCols = rightWidth - 8;
  // stats format: "16.2k tok · 5 tools · 1m30s[ · failed: ...]"
  // worst case without failure: "000.0M tok · 99 tools · 99m 99s" ≈ 32 chars
  // reserve 34 cols for stats to be safe
  const STATS_COL = 34;
  // model col: use actual max or 0 if no agents yet
  const MODEL_COL = agents.length
    ? Math.max(...agents.map(a => stringWidth(a.model ?? '')), 0)
    : 0;
  // label gets remaining space
  const LABEL_COL = Math.max(8, rowInnerCols - MODEL_COL - (MODEL_COL > 0 ? 2 : 0) - STATS_COL - 2);

  const agentStatsStr = (a: WorkflowAgentRecord) => {
    const tok = a.tokenUsage ? fmtTokens(a.tokenUsage.totalTokens) : '0 tok';
    const d = formatDuration((a.endTime ?? now) - a.startTime);
    const fail = a.status === 'failed' && a.outcome ? ` · failed: ${a.outcome.slice(0, 28)}…` : '';
    return `${tok} · ${a.toolCallCount} tools · ${d}${fail}`;
  };

  return (
    <Box flexDirection="column">
      {/* Header: line1 = slug, line2 = desc (left) + summary (right) */}
      <Box>
        <Text bold>{wf.slug}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.Gray}>{descTrunc}</Text>
        <Text>{' '.repeat(gapSpaces)}</Text>
        <Text color={statusColor(wf.status)}>{summaryStr}</Text>
      </Box>

      {/* Two-pane layout */}
      <Box>
        {/* Left: phases */}
        <Box
          flexDirection="column"
          width={leftWidth}
          borderStyle="round"
          borderColor={focus === 'left' ? Colors.AccentCyan : Colors.Gray}
        >
          <Box paddingX={1}>
            <Text bold color={Colors.AccentCyan}>Phases</Text>
          </Box>
          {phases.map((phase, i) => {
            const doneCount = phase.agents.filter(a => a.status === 'completed').length;
            const totalCount = phase.agents.length;
            const phaseStatus = phase.agents.length === 0 ? 'running'
              : phase.agents.every(a => a.status === 'completed') ? 'completed'
              : phase.agents.some(a => a.status === 'failed') ? 'failed'
              : 'running';
            const isSelPhase = focus === 'left' && i === selectedPhase;
            const counterStr = totalCount > 0 ? `${doneCount}/${totalCount}` : '';
            // CJK-aware truncate+pad for name, then right-pad counter
            const namePadded = visTrunc(phase.name, nameColCols);
            const counterPadded = counterStr.padStart(maxCounterLen);
            return (
              <Box key={i} paddingX={1}>
                <Text color={isSelPhase ? Colors.AccentCyan : undefined}>{isSelPhase ? '❯ ' : '  '}</Text>
                <Text color={statusColor(phaseStatus)}>{statusIcon(phaseStatus)} </Text>
                <Text bold={isSelPhase}>{namePadded}</Text>
                {counterStr
                  ? <Text color={Colors.Gray}>{counterPadded}</Text>
                  : null}
              </Box>
            );
          })}
          {Array.from({ length: Math.max(0, innerHeight - phases.length - 1) }).map((_, i) => (
            <Box key={`pad-${i}`}><Text> </Text></Box>
          ))}
        </Box>

        <Text> </Text>

        {/* Right: agents in selected phase */}
        <Box
          flexDirection="column"
          width={rightWidth}
          borderStyle="round"
          borderColor={focus === 'right' ? Colors.AccentCyan : Colors.Gray}
        >
          <Box paddingX={1}>
            <Text bold color={Colors.AccentCyan}>
              {currentPhase?.name ?? '执行'} · {agents.length} agent{agents.length !== 1 ? 's' : ''}
            </Text>
          </Box>
          {agents.length === 0 && (
            <Box paddingX={1}><Text color={Colors.Gray}>No agents yet</Text></Box>
          )}
          {agents.map((agent, i) => {
            const isSelected = focus === 'right' && i === selectedAgent;
            // model: pad to MODEL_COL (ASCII only, safe)
            const modelStr = (agent.model ?? '').padEnd(MODEL_COL);
            const statsStr = agentStatsStr(agent);
            // label: CJK-aware truncate+pad to LABEL_COL
            const labelPadded = visTrunc(agent.label, LABEL_COL);
            return (
              <Box key={agent.agentId} paddingX={1}>
                <Text color={isSelected ? Colors.AccentCyan : undefined}>{isSelected ? '❯ ' : '  '}</Text>
                <Text color={statusColor(agent.status)}>{statusIcon(agent.status)} </Text>
                <Text bold={isSelected}>{labelPadded}</Text>
                <Text color={Colors.Gray}>{`  ${modelStr}  ${statsStr}`}</Text>
              </Box>
            );
          })}
          {Array.from({ length: Math.max(0, innerHeight - agents.length - 1) }).map((_, i) => (
            <Box key={`rpad-${i}`}><Text> </Text></Box>
          ))}
        </Box>
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {focus === 'left'
            ? '↑↓ select · ⏎ view agents · esc back'
            : '↑↓ select · ⏎ view detail · ← phases · esc close'}
        </Text>
      </Box>
    </Box>
  );
};

// ─── Agent detail view ────────────────────────────────────────────────────────

const AgentDetailView: React.FC<{
  wf: WorkflowRecord;
  agent: WorkflowAgentRecord;      // currently selected agent (right pane)
  phaseAgents: WorkflowAgentRecord[]; // all agents in the current phase (left pane)
  selectedAgentIndex: number;       // index into phaseAgents
  phaseName: string;
  now: number;
  width: number;
  height: number;
  promptExpanded: boolean;
  scrollOffset: number;
}> = ({ wf, agent, phaseAgents, selectedAgentIndex, phaseName, now, width, height, promptExpanded, scrollOffset }) => {
  const leftWidth = Math.max(24, Math.floor(width * 0.3));
  const rightWidth = width - leftWidth - 3;
  // content area inside right pane: rightWidth - 2(border) - 2(paddingX) - 3(indent)
  const contentCols = Math.max(20, rightWidth - 7);
  const dur = formatDuration((agent.endTime ?? now) - agent.startTime);
  const tok = agent.tokenUsage ? fmtTokens(agent.tokenUsage.totalTokens) : '';

  // Fixed pane height:
  // height = terminalHeight - 4 (panelHeight)
  // Layout rows consumed outside the two-pane box:
  //   header row: 1
  //   header marginBottom: 1
  //   footer marginTop: 1
  //   footer row: 1
  //   total = 4 rows outside → paneHeight = height - 4
  const paneHeight = Math.max(6, height - 4);
  // Inside right border: border top(1) + title row(1) + border bottom(1) = 3 overhead
  const viewportHeight = Math.max(3, paneHeight - 3);

  // Build all content lines for the right pane
  const contentLines: React.ReactNode[] = [];

  // Status line
  const statusLabel = agent.status === 'failed' ? 'Failed'
    : agent.status === 'completed' ? 'Completed'
    : agent.currentPhase === 'executing_tools' ? 'Executing tools'
    : 'Thinking';
  const failReason = agent.status === 'failed' && agent.outcome
    ? ` (${agent.outcome.slice(0, 60)})` : '';
  contentLines.push(
    <Box key="status" paddingX={1}>
      <Text color={statusColor(agent.status)}>{statusIcon(agent.status)} </Text>
      <Text bold>{statusLabel}</Text>
      <Text color={Colors.Gray}>
        {agent.model ? ` · ${agent.model}` : ''}
        {tok ? ` · ${tok}` : ''}
        {` · ${agent.toolCallCount} tool calls`}
        {` · ${dur}`}
        {failReason}
      </Text>
    </Box>
  );

  // Blank separator
  contentLines.push(<Box key="sep1"><Text> </Text></Box>);

  // Prompt section
  const promptLines = agent.prompt.split('\n');
  const isCollapsible = promptLines.length > 2;
  contentLines.push(
    <Box key="prompt-hdr" paddingX={1}>
      <Text color={Colors.Gray}>
        {`Prompt · ${promptLines.length} line${promptLines.length !== 1 ? 's' : ''}`}
        {isCollapsible
          ? promptExpanded ? ' · ⏎ collapse' : ' · ⏎ expand'
          : ''}
      </Text>
    </Box>
  );
  const visiblePromptLines = promptExpanded ? promptLines : promptLines.slice(0, 2);
  visiblePromptLines.forEach((line, i) => {
    // wrap each prompt line to contentCols
    wrapText(line, contentCols).forEach((wrapped, wi) => {
      contentLines.push(
        <Box key={`prompt-${i}-${wi}`} paddingLeft={3}>
          <Text color={Colors.AccentCyan}>{wrapped}</Text>
        </Box>
      );
    });
  });
  if (!promptExpanded && promptLines.length > 2) {
    contentLines.push(
      <Box key="prompt-more" paddingLeft={3}>
        <Text color={Colors.Gray}>{`… ${promptLines.length - 2} more lines`}</Text>
      </Box>
    );
  }

  // Activity section
  if (agent.toolCallCount > 0) {
    contentLines.push(<Box key="sep2"><Text> </Text></Box>);
    contentLines.push(
      <Box key="activity-hdr" paddingX={1}>
        <Text color={Colors.Gray}>
          {`Activity · last ${agent.recentToolCalls.length} of ${agent.toolCallCount} tool calls`}
        </Text>
      </Box>
    );
    agent.recentToolCalls.forEach((tc, i) => {
      wrapText(tc, contentCols).forEach((wrapped, wi) => {
        contentLines.push(
          <Box key={`tc-${i}-${wi}`} paddingLeft={3}>
            <Text>{wrapped}</Text>
          </Box>
        );
      });
    });
  }

  // Outcome section
  if (agent.outcome) {
    contentLines.push(<Box key="sep3"><Text> </Text></Box>);
    contentLines.push(
      <Box key="outcome-hdr" paddingX={1}>
        <Text color={Colors.Gray}>Outcome</Text>
      </Box>
    );
    // Split outcome into lines for scrollability, wrapping long lines
    wrapText(agent.outcome, contentCols).forEach((line, i) => {
      contentLines.push(
        <Box key={`outcome-${i}`} paddingLeft={3}>
          <Text color={agent.status === 'failed' ? Colors.AccentRed : Colors.AccentGreen}>
            {line}
          </Text>
        </Box>
      );
    });
  }

  const maxOffset = Math.max(0, contentLines.length - viewportHeight);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxOffset));
  const visibleLines = contentLines.slice(clampedOffset, clampedOffset + viewportHeight);
  const canScrollUp = clampedOffset > 0;
  const canScrollDown = clampedOffset < maxOffset;

  // agents / phaseName are now received as props — no need to recompute here

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>{wf.slug}</Text>
        <Text color={Colors.Gray}>{' — '}</Text>
        <Text color={Colors.Gray}>{visTrunc(wf.description ?? '', Math.max(10, width - stringWidth(wf.slug) - 5)).trimEnd()}</Text>
      </Box>

      {/* Two-pane */}
      <Box>
        {/* Left: agent list */}
        <Box
          flexDirection="column"
          width={leftWidth}
          height={paneHeight}
          borderStyle="round"
          borderColor={Colors.Gray}
          overflow="hidden"
        >
          <Box paddingX={1}>
            <Text bold color={Colors.AccentCyan}>
              {(() => {
                const suffix = ` · ${phaseAgents.length} agent${phaseAgents.length !== 1 ? 's' : ''}`;
                const maxNameCols = Math.max(4, leftWidth - 6 - suffix.length); // -2 border -2 paddingX -2 prefix
                return visTrunc(phaseName, maxNameCols).trimEnd() + suffix;
              })()}
            </Text>
          </Box>
          {phaseAgents.map((a, idx) => {
            const labelCols = Math.max(4, leftWidth - 8); // -2 border -2 paddingX -2 selector -2 icon
            const labelTrunc = visTrunc(a.label, labelCols).trimEnd();
            const isSelected = idx === selectedAgentIndex;
            return (
              <Box key={a.agentId} paddingX={1}>
                <Text color={isSelected ? Colors.AccentCyan : undefined}>{isSelected ? '❯ ' : '  '}</Text>
                <Text color={statusColor(a.status)}>{statusIcon(a.status)} </Text>
                <Text bold={isSelected}>{labelTrunc}</Text>
              </Box>
            );
          })}
        </Box>

        <Text> </Text>

        {/* Right: scrollable agent detail */}
        <Box
          flexDirection="column"
          width={rightWidth}
          height={paneHeight}
          borderStyle="round"
          borderColor={Colors.AccentCyan}
          overflow="hidden"
        >
          {/* Title + scroll hint */}
          <Box paddingX={1} justifyContent="space-between">
            <Text bold color={Colors.AccentCyan}>{visTrunc(agent.label, rightWidth - 6).trimEnd()}</Text>
            {(canScrollUp || canScrollDown) && (
              <Text color={Colors.Gray}>
                {canScrollUp ? '↑' : ' '}{canScrollDown ? '↓' : ' '}
              </Text>
            )}
          </Box>

          {/* Scrollable content */}
          {visibleLines}

          {/* Fill remaining rows so border stays consistent */}
          {Array.from({ length: Math.max(0, viewportHeight - visibleLines.length) }).map((_, i) => (
            <Box key={`fill-${i}`}><Text> </Text></Box>
          ))}
        </Box>
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          ↑↓/jk scroll · ⏎ {promptExpanded ? 'collapse' : 'expand'} prompt · ← back · esc close
        </Text>
      </Box>
    </Box>
  );
};

// ─── Main panel ───────────────────────────────────────────────────────────────

export const WorkflowPanel: React.FC<WorkflowPanelProps> = ({
  isVisible,
  onClose,
  terminalWidth,
  terminalHeight,
}) => {
  const [records, setRecords] = useState<WorkflowRecord[]>([]);
  const [, setTick] = useState(0);
  const [view, setView] = useState<View>('list');
  const [selectedWorkflow, setSelectedWorkflow] = useState(0);
  const [selectedPhase, setSelectedPhase] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [detailFocus, setDetailFocus] = useState<'left' | 'right'>('left');
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [currentAgent, setCurrentAgent] = useState<WorkflowAgentRecord | null>(null);
  const [agentListIndex, setAgentListIndex] = useState(0); // index in phase agents list
  const [agentScrollOffset, setAgentScrollOffset] = useState(0);

  const refresh = useCallback(() => {
    const all = [...WorkflowRegistry.getAll()];
    setRecords(all);
    // Clamp selectedWorkflow index after records change (e.g., after trimming)
    setSelectedWorkflow(prev => Math.min(prev, Math.max(0, all.length - 1)));
  }, []);

  // 同步全局 modal 状态，防止 ESC 触发 stream abort
  useEffect(() => {
    setWorkflowPanelOpen(isVisible);
    return () => { if (isVisible) setWorkflowPanelOpen(false); };
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) return;
    refresh();

    // Throttle redraws to max once per 500ms to reduce terminal flicker.
    // WorkflowRegistry may fire notify() many times per second (token updates etc.)
    // but the panel only needs to reflect changes at human-perceptible speed.
    let pending = false;
    const throttledRefresh = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        refresh();
        setTick(t => t + 1);
      }, 500);
    };

    const unsub = WorkflowRegistry.subscribe(throttledRefresh);
    // Tick for duration counter — only when at least one workflow is running.
    // This avoids unnecessary redraws when all workflows have completed.
    let timer: ReturnType<typeof setInterval> | undefined;
    const hasRunning = () => WorkflowRegistry.getAll().some(r => r.status === 'running');
    if (hasRunning()) {
      timer = setInterval(() => {
        setTick(t => t + 1);
        // Stop the timer once all workflows have completed
        if (!hasRunning()) {
          clearInterval(timer!);
          timer = undefined;
        }
      }, 2000);
    }
    return () => { unsub(); if (timer) clearInterval(timer); };
  }, [isVisible, refresh]);

  const now = Date.now();
  const wf = records[selectedWorkflow];
  const phases = wf ? (wf.phases.length ? wf.phases : [{ index: 0, name: '执行', description: '', agents: wf.agents }]) : [];
  const phase = phases[selectedPhase];
  const agentsInPhase = phase ? allAgentsForPhase(phase) : (wf ? wf.agents : []);

  useInput((input, key) => {
    if (!isVisible) return;

    if (view === 'list') {
      if (key.upArrow) setSelectedWorkflow(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedWorkflow(i => Math.min(records.length - 1, i + 1));
      if (key.return && wf) {
        setView('detail');
        setSelectedPhase(0);
        setSelectedAgent(0);
        setDetailFocus('left');
      }
      if (key.escape) onClose();
    } else if (view === 'detail') {
      if (detailFocus === 'left') {
        if (key.upArrow) setSelectedPhase(i => Math.max(0, i - 1));
        if (key.downArrow) setSelectedPhase(i => Math.min(phases.length - 1, i + 1));
        if (key.return) {
          setDetailFocus('right');
          setSelectedAgent(0);
        }
        if (key.escape) { setView('list'); }
      } else {
        if (key.upArrow) setSelectedAgent(i => Math.max(0, i - 1));
        if (key.downArrow) setSelectedAgent(i => Math.min(agentsInPhase.length - 1, i + 1));
        if (key.return && agentsInPhase[selectedAgent]) {
          setCurrentAgent(agentsInPhase[selectedAgent]!);
          setAgentListIndex(selectedAgent);
          setPromptExpanded(false);
          setAgentScrollOffset(0);
          setView('agent');
        }
        if (key.leftArrow) setDetailFocus('left');
        if (key.escape) onClose();
      }
    } else if (view === 'agent') {
      // Compute current phase agents for navigation
      const curPhase = wf?.phases.find(p => currentAgent && p.agents.includes(currentAgent));
      const phaseAgents = curPhase ? curPhase.agents : (wf ? wf.agents : []);

      // ↑/↓ — switch to prev/next agent in the phase (left panel navigation)
      if (key.upArrow && agentListIndex > 0) {
        const newIdx = agentListIndex - 1;
        setAgentListIndex(newIdx);
        setCurrentAgent(phaseAgents[newIdx]!);
        setAgentScrollOffset(0);
        setPromptExpanded(false);
      } else if (key.downArrow && agentListIndex < phaseAgents.length - 1) {
        const newIdx = agentListIndex + 1;
        setAgentListIndex(newIdx);
        setCurrentAgent(phaseAgents[newIdx]!);
        setAgentScrollOffset(0);
        setPromptExpanded(false);
      }
      // j/k — scroll right pane content
      if (input === 'j') setAgentScrollOffset(o => o + 1);
      if (input === 'k') setAgentScrollOffset(o => Math.max(0, o - 1));
      // Enter — toggle prompt expand/collapse
      if (key.return) setPromptExpanded(e => !e);
      if (key.leftArrow || key.escape) {
        if (key.leftArrow) { setView('detail'); setDetailFocus('right'); setAgentScrollOffset(0); }
        else { onClose(); }
      }
    }
  }, { isActive: isVisible });

  if (!isVisible) return null;

  const panelWidth = Math.min(terminalWidth - 2, 120);
  // Keep panel height well below terminal height to prevent Ink from falling back
  // to full-screen clear-and-redraw mode, which is the primary cause of flicker.
  // Reserve at least 6 rows: status bar(1) + input(1) + margins(4).
  const panelHeight = Math.max(10, terminalHeight - 8);

  return (
    <Box flexDirection="column" width={panelWidth}>
      {/* Title bar */}
      <Box marginBottom={1}>
        <Text bold color={Colors.AccentCyan}>Dynamic workflows</Text>
        {records.length > 0 && (
          <Text color={Colors.Gray}>
            {'  '}
            {records.filter(r => r.status === 'completed').length} completed
            {records.some(r => r.status === 'running') ? `, ${records.filter(r => r.status === 'running').length} running` : ''}
          </Text>
        )}
      </Box>

      {/* Horizontal rule */}
      <Box marginBottom={1}>
        <Text color={Colors.Gray}>{'─'.repeat(panelWidth - 2)}</Text>
      </Box>

      {/* Content */}
      {view === 'list' && (
        <>
          {records.length === 0 ? (
            <Box paddingX={2}><Text color={Colors.Gray}>No workflows have run in this session.</Text></Box>
          ) : (
            records.map((r, i) => (
              <ListRow key={r.id} wf={r} selected={i === selectedWorkflow} now={now} rowWidth={panelWidth - 2} />
            ))
          )}
          <Box marginTop={1}>
            <Text color={Colors.Gray}>↑/↓ to select · Enter to view · Esc to close</Text>
          </Box>
        </>
      )}

      {view === 'detail' && wf && (
        <DetailView
          wf={wf}
          selectedPhase={selectedPhase}
          selectedAgent={selectedAgent}
          focus={detailFocus}
          now={now}
          width={panelWidth}
          height={panelHeight}
        />
      )}

      {view === 'agent' && wf && currentAgent && (() => {
        const curPhase = wf.phases.find(p => currentAgent && p.agents.includes(currentAgent));
        const phaseAgents = curPhase ? curPhase.agents : wf.agents;
        const phaseName = curPhase?.name ?? '执行';
        return (
          <AgentDetailView
            wf={wf}
            agent={currentAgent}
            phaseAgents={phaseAgents}
            selectedAgentIndex={agentListIndex}
            phaseName={phaseName}
            now={now}
            width={panelWidth}
            height={panelHeight}
            promptExpanded={promptExpanded}
            scrollOffset={agentScrollOffset}
          />
        );
      })()}
    </Box>
  );
};
