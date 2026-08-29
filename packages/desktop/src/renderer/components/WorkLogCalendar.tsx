/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { localDateKey } from '../localDateKey.js';

export interface CalendarWorkLogEntry {
  time: string;
  action: string;
  entryType: string;
  category?: string;
  success?: boolean;
  details?: string;
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function WorkLogCalendar({
  selectedDate,
  onSelectDate,
  byDate,
}: {
  selectedDate: string;
  onSelectDate: (date: string) => void;
  byDate: Record<string, CalendarWorkLogEntry[]>;
}): React.JSX.Element {
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const selected = new Date(`${selectedDate}T00:00:00`);
    const initial = Number.isNaN(selected.getTime()) ? new Date() : selected;
    return new Date(initial.getFullYear(), initial.getMonth(), 1);
  });
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();
  const days = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const todayKey = localDateKey();

  return (
    <div className="otto-wcal">
      <div className="otto-wcal__title">
        <button type="button" onClick={() => setVisibleMonth(new Date(year, month - 1, 1))} aria-label="上个月">‹</button>
        <span>{year} 年 {month + 1} 月</span>
        <button type="button" onClick={() => setVisibleMonth(new Date(year, month + 1, 1))} aria-label="下个月">›</button>
      </div>
      <div className="otto-wcal__grid">
        {['一', '二', '三', '四', '五', '六', '日'].map((weekday) => <div key={weekday} className="otto-wcal__weekday">{weekday}</div>)}
        {Array.from({ length: firstWeekday }, (_, index) => <div key={`pad-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const day = index + 1;
          const key = dateKey(year, month, day);
          const entries = byDate[key] ?? [];
          const weekdayColumn = (firstWeekday + index) % 7;
          const orderedEntries = [...entries].sort((left, right) =>
            left.entryType === right.entryType ? 0 : left.entryType === 'work_result' ? -1 : 1,
          );
          return (
            <button
              key={key}
              type="button"
              aria-label={`${key}${entries.length ? `，${entries.length} 条工作记录` : ''}`}
              aria-pressed={key === selectedDate}
              className={
                'otto-wcal__day'
                + (entries.length ? ' has-log' : '')
                + (key === todayKey ? ' is-today' : '')
                + (key === selectedDate ? ' is-selected' : '')
                + ` is-pop-col-${weekdayColumn}`
                + (weekdayColumn <= 2 ? ' is-pop-left' : '')
                + (weekdayColumn >= 4 ? ' is-pop-right' : '')
              }
              onClick={() => onSelectDate(key)}
              title={entries.length
                ? entries.map((entry) => `• ${entry.time} ${entry.action}`).join('\n')
                : '点击查看/新增当日日程'}
            >
              {day}{entries.length ? <span className="otto-wcal__dot" /> : null}
              {entries.length ? (
                <span className="otto-wcal__pop" role="tooltip">
                  <span className="otto-wcal__pop-title">
                    {month + 1} 月 {day} 日 · {entries.length} 条
                  </span>
                  {orderedEntries.slice(0, 12).map((entry, entryIndex) => (
                    <span className="otto-wcal__pop-item" key={`${entry.time}-${entryIndex}`}>
                      <span className="otto-wcal__pop-time">{entry.time}</span>
                      <span className="otto-wcal__pop-copy">
                        <span className="otto-wcal__pop-action">
                          • {entry.entryType === 'work_result' ? '完成' : entry.category || '操作'} · {entry.action}
                          {entry.success === false ? '（失败）' : ''}
                        </span>
                        {entry.details ? (
                          <span className="otto-wcal__pop-detail">
                            {entry.details.replace(/\s+/g, ' ').slice(0, 140)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  ))}
                  {entries.length > 12 ? (
                    <span className="otto-wcal__pop-more">…还有 {entries.length - 12} 条</span>
                  ) : null}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
