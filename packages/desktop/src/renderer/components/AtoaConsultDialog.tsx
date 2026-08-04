/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import type { ScheduleItemInfo } from 'otto-server';
import type {
  EnterpriseAccount,
  EnterpriseDirectMessage,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import {
  collectAuthorizedAtoaContext,
  type AuthorizedAtoaContext,
} from '../a2aContext.js';
import {
  ATOA_CONTEXT_SOURCES,
  buildAtoaRequest,
  type AtoaContextSource,
} from '../atoaProtocol.js';
import { askLocalPeerOtto } from '../peerOttoRunner.js';

type Member = EnterpriseOrganizationView['members'][number];

const SOURCE_LABELS: Record<AtoaContextSource, string> = {
  current_chat: '当前聊天',
  enterprise_knowledge: '企业知识',
  work_logs: '工作日志',
  schedules: '日程',
};
const CONSULT_CONTEXT_SOURCES = ATOA_CONTEXT_SOURCES.filter(
  (source) => source !== 'current_chat',
);

export function AtoaConsultDialog({
  account,
  member,
  schedules,
  initialQuestion = '',
  onClose,
  onSent,
  collectContext,
  askOtto = (input) => askLocalPeerOtto(input),
  sendMessage = (peerAccountId, content) =>
    window.otto.enterpriseMessageSend(peerAccountId, content),
}: {
  account: EnterpriseAccount;
  member: Member;
  schedules: readonly ScheduleItemInfo[];
  initialQuestion?: string;
  onClose(): void;
  onSent(message: EnterpriseDirectMessage): void;
  collectContext?: (
    sources: AtoaContextSource[],
  ) => Promise<AuthorizedAtoaContext>;
  askOtto?: (input: {
    question: string;
    workContext: string;
    mode: 'consult_initiator';
  }) => Promise<string>;
  sendMessage?: (
    peerAccountId: string,
    content: string,
  ) => Promise<EnterpriseDirectMessage>;
}): React.JSX.Element {
  const [question, setQuestion] = useState(initialQuestion.trim());
  const [sources, setSources] = useState<AtoaContextSource[]>([]);
  const [proposal, setProposal] = useState('');
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const resetProposal = (): void => {
    setProposal('');
    setError('');
  };
  const toggleSource = (source: AtoaContextSource): void => {
    setSources((current) =>
      current.includes(source)
        ? current.filter((item) => item !== source)
        : CONSULT_CONTEXT_SOURCES.filter(
            (item) => item === source || current.includes(item),
          ),
    );
    resetProposal();
  };

  const generate = async (): Promise<void> => {
    const cleanQuestion = question.trim();
    if (!cleanQuestion || generating) return;
    setGenerating(true);
    setError('');
    try {
      const context = collectContext
        ? await collectContext(sources)
        : await collectAuthorizedAtoaContext({
            sources,
            peerAccountId: member.id,
            currentAccountId: account.id,
            currentAccountName: account.name,
            peerName: member.name,
            listMessages: window.otto.enterpriseMessagesList,
            listKnowledge: () => window.otto.enterpriseKnowledgeList(),
            workLogRecent: window.otto.workLogRecent,
            schedules,
          });
      const next = await askOtto({
        question: cleanQuestion,
        workContext: context.context,
        mode: 'consult_initiator',
      });
      setProposal(next.trim().slice(0, 4000));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGenerating(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!proposal || sending) return;
    setSending(true);
    setError('');
    try {
      const message = await sendMessage(
        member.id,
        buildAtoaRequest(question, {
          mode: 'consult',
          requestedSources: sources,
          initiatorProposal: proposal,
        }),
      );
      onSent(message);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="otto-a2a-consult-backdrop">
      <section
        className="otto-a2a-consult"
        role="dialog"
        aria-modal="true"
        aria-label="双方 Otto 协商"
      >
        <header>
          <div>
            <span>双方 Otto 协商</span>
            <h2>与 {member.name} 形成协作方案</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭协商">
            ×
          </button>
        </header>

        <label className="otto-a2a-consult__goal">
          <strong>协商目标</strong>
          <textarea
            aria-label="协商目标"
            maxLength={1200}
            value={question}
            placeholder="例如：比较双方日程，协商本周评审时间和分工"
            onChange={(event) => {
              setQuestion(event.target.value);
              resetProposal();
            }}
          />
        </label>

        <fieldset>
          <legend>允许我的 Otto 用于提案的资料（默认不选）</legend>
          <div className="otto-a2a-consult__sources">
            {CONSULT_CONTEXT_SOURCES.map((source) => (
              <label key={source}>
                <input
                  type="checkbox"
                  checked={sources.includes(source)}
                  onChange={() => toggleSource(source)}
                />
                {SOURCE_LABELS[source]}
              </label>
            ))}
          </div>
          <small>
            对方会在自己的客户端再次选择其资料范围；你的选择不会替对方授权。
          </small>
        </fieldset>

        {proposal ? (
          <div className="otto-a2a-consult__proposal">
            <strong>发送前预览</strong>
            <p>{proposal}</p>
          </div>
        ) : null}
        {error ? (
          <p className="otto-a2a-consult__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          {!proposal ? (
            <button
              type="button"
              className="is-primary"
              disabled={!question.trim() || generating}
              onClick={() => void generate()}
            >
              {generating ? 'Otto 正在生成…' : '让我的 Otto 生成提案'}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={generating}
                onClick={() => void generate()}
              >
                重新生成
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={sending}
                onClick={() => void send()}
              >
                {sending ? '发送中…' : '确认发送给对方 Otto'}
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
