/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import type { ScheduleItemInfo } from 'otto-server';
import { IconChevron } from './icons.js';

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function DayAgenda({
  date,
  schedules,
  onCreate,
  onDelete,
  onBack,
}: {
  date: string;
  schedules: ScheduleItemInfo[];
  onCreate: (input: {
    title: string;
    startAt: string;
    endAt?: string;
    notes?: string;
  }) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [notes, setNotes] = useState('');
  const sorted = useMemo(
    () => [...schedules].sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [schedules],
  );

  const submit = (): void => {
    if (!title.trim() || !startTime) return;
    const startAt = new Date(`${date}T${startTime}:00`).toISOString();
    const endAt = endTime ? new Date(`${date}T${endTime}:00`).toISOString() : undefined;
    onCreate({
      title: title.trim(),
      startAt,
      ...(endAt ? { endAt } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    setTitle('');
    setNotes('');
    setAdding(false);
  };

  return (
    <section className="otto-agenda-page" aria-label={`${date} 日程安排`}>
      <header className="otto-agenda__head">
        <div>
          <div className="otto-agenda__eyebrow">工作日志 · 日期视图</div>
          <h1>{date} 日程安排</h1>
          <p>当天工作和安排集中在这里；标有“Otto”的项目由 Agent 自主创建。</p>
        </div>
        <div className="otto-agenda__actions">
          <button type="button" className="otto-hub__btn otto-hub__btn--primary" onClick={() => setAdding((value) => !value)}>
            {adding ? '取消新增' : '+ 新建日程'}
          </button>
          <button type="button" className="otto-hub__btn" onClick={onBack}>
            <IconChevron size={13} /> 返回对话
          </button>
        </div>
      </header>

      {adding ? (
        <div className="otto-agenda__form">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="日程标题" aria-label="日程标题" />
          <label>开始<input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
          <label>结束<input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="备注（可选）" aria-label="日程备注" />
          <button type="button" onClick={submit}>保存</button>
        </div>
      ) : null}

      <div className="otto-agenda__timeline">
        {sorted.length === 0 ? (
          <div className="otto-agenda__empty">
            <strong>这一天还没有日程</strong>
            <span>你可以手动新增，也可以直接告诉 Otto“帮我安排一个复盘”。</span>
          </div>
        ) : (
          sorted.map((item) => (
            <article key={item.id} className="otto-agenda__item">
              <div className="otto-agenda__time">
                {localTime(item.startAt)}
                {item.endAt ? <span>— {localTime(item.endAt)}</span> : null}
              </div>
              <div className="otto-agenda__card">
                <div className="otto-agenda__card-title">
                  <strong>{item.title}</strong>
                  <span className={'otto-agenda__source ' + (item.source === 'otto' ? 'is-otto' : '')}>
                    {item.source === 'otto' ? 'Otto 自主创建' : '手动创建'}
                  </span>
                </div>
                {item.notes ? <p>{item.notes}</p> : null}
                {item.reason ? <div className="otto-agenda__reason">创建原因：{item.reason}</div> : null}
                <button type="button" className="otto-agenda__delete" onClick={() => onDelete(item.id)}>删除</button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
