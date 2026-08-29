/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 我的工作（导航一级入口）。
 *
 * 整合日程管理（DayAgenda）与工作日志（WorkLog），
 * 提供统一的工作台视图：今日概览 + 日程 + 工作成果。
 * 数据源：product.state.schedules + window.otto.workLogToday/workLogRecent IPC。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScheduleItemInfo } from 'otto-server';
import { DayAgenda } from './DayAgenda.js';
import { WorkLogCalendar } from './WorkLogCalendar.js';
import { localDateKey } from '../localDateKey.js';

interface WorkLogEntry {
  time: string;
  action: string;
  taskTitle?: string;
  entryType: string;
  category?: string;
  success?: boolean;
  details?: string;
}

interface WorkLogDay {
  date: string;
  entries: WorkLogEntry[];
}

interface WorkSummary {
  summary: string;
  date: string;
  totalActions: number;
  workResults: number;
}

export interface WorkPageProps {
  schedules: readonly ScheduleItemInfo[];
  selectedDate: string;
  onSelectDate: (date: string) => void;
  onCreateSchedule: (input: { title: string; startAt: string; endAt?: string; note?: string }) => void;
  onDeleteSchedule: (id: string) => void;
  onBack: () => void;
}

export function WorkPage({
  schedules,
  selectedDate,
  onSelectDate,
  onCreateSchedule,
  onDeleteSchedule,
  onBack,
}: WorkPageProps): React.JSX.Element {
  const [workSummary, setWorkSummary] = useState<WorkSummary | null>(null);
  const [worklogDays, setWorklogDays] = useState<WorkLogDay[]>([]);
  const [worklogLoading, setWorklogLoading] = useState(false);
  const [workReportMessage, setWorkReportMessage] = useState('');
  const [workReportPath, setWorkReportPath] = useState('');
  const [activeSection, setActiveSection] = useState<'overview' | 'agenda'>('overview');

  const refreshWorkLog = useCallback(async (): Promise<void> => {
    setWorklogLoading(true);
    try {
      const [today, days] = await Promise.all([
        window.otto.workLogToday(),
        window.otto.workLogRecent(92),
      ]);
      setWorkSummary(today);
      setWorklogDays(days);
    } catch { /* 保留已有数据 */ } finally {
      setWorklogLoading(false);
    }
  }, []);

  useEffect(() => { void refreshWorkLog(); }, [refreshWorkLog]);

  const today = localDateKey();
  const todaySchedules = useMemo(
    () => schedules.filter((item) => {
      const d = new Date(item.startAt);
      if (Number.isNaN(d.getTime())) return false;
      const key = localDateKey(d);
      return key === today;
    }),
    [schedules, today],
  );

  const worklogByDate = useMemo(
    () => Object.fromEntries(worklogDays.map((day) => [day.date, day.entries])),
    [worklogDays],
  );
  const todayEntries = workSummary ? worklogByDate[workSummary.date] ?? [] : [];
  const todayResults = todayEntries.filter((e) => e.entryType === 'work_result');
  const todayActions = todayEntries.filter((e) => e.entryType !== 'work_result');
  const selectedDayResults = (worklogByDate[selectedDate] ?? [])
    .filter((entry) => entry.entryType === 'work_result');

  return (
    <div className="otto-work-page" role="region" aria-label="我的工作">
      <header className="otto-work-page__header">
        <div>
          <h1>我的工作</h1>
          <p>
            {todaySchedules.length} 项日程
            {workSummary ? ` · ${workSummary.workResults} 项成果 · ${workSummary.totalActions} 次操作` : ''}
          </p>
        </div>
        <div className="otto-work-page__header-actions">
          <div className="otto-work-page__view-toggle" role="tablist" aria-label="视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={activeSection === 'overview'}
              className={activeSection === 'overview' ? 'is-active' : ''}
              onClick={() => setActiveSection('overview')}
            >
              总览
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeSection === 'agenda'}
              className={activeSection === 'agenda' ? 'is-active' : ''}
              onClick={() => setActiveSection('agenda')}
            >
              日程
            </button>
          </div>
          <button type="button" onClick={onBack}>返回对话</button>
        </div>
      </header>

      {activeSection === 'agenda' ? (
        <div className="otto-work-page__agenda">
          <section className="otto-work-page__calendar" aria-label="工作月历">
            <div className="otto-work-page__calendar-head">
              <div>
                <h2>工作月历</h2>
                <p>悬浮日期查看当天成果，点击日期查看日程与工作详情。</p>
              </div>
              <button type="button" disabled={worklogLoading} onClick={() => void refreshWorkLog()}>
                {worklogLoading ? '更新中…' : '刷新'}
              </button>
            </div>
            <WorkLogCalendar
              selectedDate={selectedDate}
              onSelectDate={onSelectDate}
              byDate={worklogByDate}
            />
          </section>
          <DayAgenda
            date={selectedDate}
            schedules={schedules.filter((item) => {
              const d = new Date(item.startAt);
              if (Number.isNaN(d.getTime())) return false;
              const key = localDateKey(d);
              return key === selectedDate;
            })}
            workResults={selectedDayResults}
            onCreate={onCreateSchedule}
            onDelete={onDeleteSchedule}
            onBack={() => setActiveSection('overview')}
            backLabel="返回总览"
          />
        </div>
      ) : (
        <div className="otto-work-page__body">
          {/* 今日概览卡片 */}
          <div className="otto-work-page__stats">
            <div className="otto-work-page__stat">
              <b>{todaySchedules.length}</b>
              <span>今日日程</span>
            </div>
            <div className="otto-work-page__stat">
              <b>{workSummary?.workResults ?? 0}</b>
              <span>工作成果</span>
            </div>
            <div className="otto-work-page__stat">
              <b>{workSummary?.totalActions ?? 0}</b>
              <span>操作次数</span>
            </div>
          </div>

          {/* 今日日程 */}
          {todaySchedules.length > 0 ? (
            <section className="otto-work-page__section">
              <h2>今日日程</h2>
              <div className="otto-work-page__schedule-list">
                {todaySchedules.map((item) => {
                  const start = new Date(item.startAt);
                  const end = item.endAt ? new Date(item.endAt) : null;
                  return (
                    <div key={item.id} className="otto-work-page__schedule-item">
                      <time>
                        {start.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
                        {end ? `–${end.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}
                      </time>
                      <strong>{item.title}</strong>
                      {item.notes ? <span>{item.notes}</span> : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* 工作成果 */}
          <section className="otto-work-page__section">
            <div className="otto-work-page__section-head">
              <h2>工作成果</h2>
              <div>
                <button
                  type="button"
                  disabled={worklogLoading}
                  onClick={() => void refreshWorkLog()}
                >
                  {worklogLoading ? '更新中…' : '刷新'}
                </button>
                <button
                  type="button"
                  className="is-primary"
                  onClick={async () => {
                    try {
                      const report = await window.otto.workLogReport();
                      setWorkReportPath(report.ok ? report.path : '');
                      setWorkReportMessage(report.message);
                    } catch { /* 保留 */ }
                  }}
                >
                  生成今日总结
                </button>
              </div>
            </div>

            {workReportMessage ? (
              <div className="otto-work-page__report-msg">{workReportMessage}</div>
            ) : null}
            {workReportPath ? (
              <button type="button" onClick={() => void window.otto.openPath(workReportPath)}>
                打开总结文件
              </button>
            ) : null}

            {todayResults.length > 0 ? (
              <div className="otto-work-page__results">
                {todayResults.map((entry, i) => (
                  <article key={`${entry.time}-${i}`} className="otto-work-page__result">
                    <span className="otto-work-page__result-dot" aria-hidden />
                    <div>
                      <strong>{entry.taskTitle || entry.action}</strong>
                      <small>
                        {entry.time}
                        {entry.details ? ` · ${entry.details.replace(/\s+/g, ' ').slice(0, 80)}` : ''}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="otto-work-page__empty">
                今天完成的报告、方案和任务会自动出现在这里。
              </div>
            )}
          </section>

          {/* 操作记录 */}
          {todayActions.length > 0 ? (
            <section className="otto-work-page__section">
              <h2>操作记录</h2>
              <div className="otto-work-page__actions-list">
                {todayActions.slice(0, 10).map((entry, i) => (
                  <div key={`${entry.time}-${i}`} className="otto-work-page__action-item">
                    <time>{entry.time}</time>
                    <span>{entry.action}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* 历史日志摘要 */}
          {worklogDays.length > 1 ? (
            <section className="otto-work-page__section">
              <h2>近期工作</h2>
              <div className="otto-work-page__history">
                {worklogDays.slice(0, 7).map((day) => (
                  <button
                    type="button"
                    key={day.date}
                    className="otto-work-page__history-day"
                    onClick={() => {
                      onSelectDate(day.date);
                      setActiveSection('agenda');
                    }}
                  >
                    <time>{day.date}</time>
                    <span>{day.entries.length} 条记录</span>
                    <span>{day.entries.filter((e) => e.entryType === 'work_result').length} 项成果</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {/* 执行明细 */}
          {workSummary ? (
            <details className="otto-work-page__details">
              <summary>查看执行明细</summary>
              <pre>{workSummary.summary}</pre>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
