/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  ATOA_CONTEXT_SOURCES,
  type AtoaContextSource,
  type AtoaRequestPayload,
} from '../atoaProtocol.js';
import type {
  AtoaPeerIdentity,
  AtoaPermissionDecision,
} from '../enterpriseAtoaCoordinator.js';

export interface AtoaPermissionRequest {
  peer: AtoaPeerIdentity;
  payload: AtoaRequestPayload;
}
const SOURCE_DETAILS: Record<
  AtoaContextSource,
  { label: string; detail: string }
> = {
  current_chat: {
    label: '当前聊天',
    detail: '仅这位同事与你最近的私聊内容',
  },
  enterprise_knowledge: {
    label: '企业知识',
    detail: '你当前账号可访问的企业共享知识',
  },
  work_logs: {
    label: '工作日志',
    detail: '本机最近 7 天的工作记录',
  },
  schedules: {
    label: '日程',
    detail: '当前 Otto 中已加载的日程安排',
  },
};

export function AtoaPermissionDialog({
  request,
  onDecision,
}: {
  request: AtoaPermissionRequest;
  onDecision(decision: AtoaPermissionDecision): void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<AtoaContextSource[]>([]);
  const peerMeta = [request.peer.department, request.peer.positionTitle]
    .filter(Boolean)
    .join(' · ');

  const toggle = (source: AtoaContextSource): void => {
    setSelected((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : ATOA_CONTEXT_SOURCES.filter(
            (item) => item === source || current.includes(item),
          ),
    );
  };

  return (
    <div className="otto-a2a-permission-backdrop">
      <section
        className="otto-a2a-permission"
        role="dialog"
        aria-modal="true"
        aria-label="Otto 协作权限"
      >
        <header>
          <div>
            <span className="otto-a2a-permission__eyebrow">
              {request.payload.mode === 'consult'
                ? '双方 Otto 协商请求'
                : '对方 Otto 提问'}
            </span>
            <h2>{request.peer.name}</h2>
            {peerMeta ? <p>{peerMeta}</p> : null}
          </div>
        </header>

        <div className="otto-a2a-permission__question">
          {request.payload.question}
        </div>
        {request.payload.mode === 'consult' &&
        request.payload.initiatorProposal ? (
          <div className="otto-a2a-permission__proposal">
            <strong>发起方 Otto 的提案</strong>
            <p>{request.payload.initiatorProposal}</p>
          </div>
        ) : null}

        <p className="otto-a2a-permission__notice">
          默认不授权。请选择本次允许 Otto 查阅的资料；“全部”只包括下列四类，
          不包括本机文件、模型密钥、其他聊天或未列出的数据。
        </p>

        <div className="otto-a2a-permission__sources">
          {ATOA_CONTEXT_SOURCES.map((source) => (
            <label key={source}>
              <input
                type="checkbox"
                checked={selected.includes(source)}
                onChange={() => toggle(source)}
              />
              <span>
                <strong>{SOURCE_DETAILS[source].label}</strong>
                <small>{SOURCE_DETAILS[source].detail}</small>
              </span>
            </label>
          ))}
        </div>

        <footer>
          <button
            type="button"
            className="is-danger"
            onClick={() => onDecision({ kind: 'deny' })}
          >
            拒绝回答
          </button>
          <button
            type="button"
            disabled={selected.length === 0}
            onClick={() =>
              onDecision({ kind: 'allow', sources: [...selected] })
            }
          >
            允许所选范围
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() =>
              onDecision({
                kind: 'allow',
                sources: [...ATOA_CONTEXT_SOURCES],
              })
            }
          >
            允许全部可授权资料
          </button>
        </footer>
      </section>
    </div>
  );
}
