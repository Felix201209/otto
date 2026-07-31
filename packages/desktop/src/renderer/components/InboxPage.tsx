/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * 我的消息（导航一级入口）。
 *
 * 企业收件箱：展示所有企业成员的对话列表、未读状态、
 * 点击进入私聊。数据源为 enterpriseMessagesUnread / enterpriseMessagesList IPC。
 * 同时展示园区服务通知（工单状态变更、公告、问卷）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseDirectMessage,
  EnterpriseOrganizationView,
  EnterpriseUnreadMessageNotification,
} from '../../preload/index.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';

const INBOX_REFRESH_MS = 8_000;

type InboxFilter = 'all' | 'unread' | 'handled';

export interface InboxPageProps {
  enterpriseAccount?: EnterpriseAccount;
  enterpriseUnreadCounts?: Record<string, number>;
  onOpenDirectChat?: (peerAccountId: string) => void;
  onBack: () => void;
}

interface ConversationItem {
  peerAccountId: string;
  peerName: string;
  peerDepartment: string | null;
  peerPositionTitle: string | null;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  online: boolean;
}

export function InboxPage({
  enterpriseAccount,
  enterpriseUnreadCounts = {},
  onOpenDirectChat,
  onBack,
}: InboxPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [notifications, setNotifications] = useState<EnterpriseUnreadMessageNotification[]>([]);
  const [orgMembers, setOrgMembers] = useState<EnterpriseOrganizationView['members']>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [messages, setMessages] = useState<EnterpriseDirectMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyInput, setReplyInput] = useState('');
  const [sending, setSending] = useState(false);
  const hasAuth = isAuthenticatedEnterpriseAccount(enterpriseAccount);

  // —— 加载未读通知 ——
  const refreshNotifications = useCallback(async (): Promise<void> => {
    if (!hasAuth) return;
    try {
      const data = await window.otto.enterpriseMessagesUnread();
      setNotifications(data);
    } catch { /* 网络错误不清空已有数据 */ }
  }, [hasAuth]);

  // —— 加载组织成员 ——
  useEffect(() => {
    if (!hasAuth) return;
    let cancelled = false;
    void window.otto.enterpriseOrganizationView().then((view) => {
      if (!cancelled && view?.members) setOrgMembers(view.members);
    }).catch(() => { /* 忽略 */ });
    return () => { cancelled = true; };
  }, [hasAuth, enterpriseAccount?.organizationId]);

  // —— 定时刷新 ——
  useEffect(() => {
    if (!hasAuth) return;
    setLoading(true);
    void refreshNotifications().finally(() => setLoading(false));
    const timer = window.setInterval(() => void refreshNotifications(), INBOX_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasAuth, refreshNotifications]);

  // —— 构建会话列表 ——
  const conversations = useMemo<ConversationItem[]>(() => {
    const memberMap = new Map(orgMembers.map((m) => [m.id, m]));
    const convMap = new Map<string, ConversationItem>();

    // 从未读通知构建
    for (const notif of notifications) {
      const member = memberMap.get(notif.senderAccountId);
      const existing = convMap.get(notif.senderAccountId);
      const unreadKey = `enterprise:message:${notif.senderAccountId}`;
      const unread = enterpriseUnreadCounts[unreadKey] ?? 0;
      convMap.set(notif.senderAccountId, {
        peerAccountId: notif.senderAccountId,
        peerName: notif.senderName || member?.name || notif.senderAccountId,
        peerDepartment: member?.department ?? null,
        peerPositionTitle: member?.positionTitle ?? null,
        lastMessage: notif.preview,
        lastMessageAt: notif.createdAt,
        unreadCount: unread,
        online: member?.ottoOnline ?? false,
      });
    }

    // 补充有未读计数但不在通知里的
    for (const [key, count] of Object.entries(enterpriseUnreadCounts)) {
      if (!key.startsWith('enterprise:message:') || count <= 0) continue;
      const peerId = key.slice('enterprise:message:'.length);
      if (convMap.has(peerId)) continue;
      const member = memberMap.get(peerId);
      if (!member) continue;
      convMap.set(peerId, {
        peerAccountId: peerId,
        peerName: member.name,
        peerDepartment: member.department,
        peerPositionTitle: member.positionTitle ?? null,
        lastMessage: '',
        lastMessageAt: '',
        unreadCount: count,
        online: member.ottoOnline ?? false,
      });
    }

    return [...convMap.values()].sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      return b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
  }, [notifications, orgMembers, enterpriseUnreadCounts]);

  // —— 过滤 ——
  const filtered = useMemo(() => {
    if (filter === 'unread') return conversations.filter((c) => c.unreadCount > 0);
    if (filter === 'handled') return conversations.filter((c) => c.unreadCount === 0);
    return conversations;
  }, [conversations, filter]);

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unreadCount, 0),
    [conversations],
  );

  // —— 加载选中会话的消息 ——
  useEffect(() => {
    if (!selectedPeer) { setMessages([]); return; }
    let cancelled = false;
    setMessagesLoading(true);
    void window.otto.enterpriseMessagesList(selectedPeer).then((msgs) => {
      if (!cancelled) setMessages(msgs);
    }).catch(() => { /* 忽略 */ }).finally(() => {
      if (!cancelled) setMessagesLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedPeer]);

  const selectedMember = useMemo(
    () => orgMembers.find((m) => m.id === selectedPeer) ?? null,
    [orgMembers, selectedPeer],
  );

  const handleSendReply = async (): Promise<void> => {
    const text = replyInput.trim();
    if (!text || !selectedPeer || sending) return;
    setSending(true);
    try {
      const msg = await window.otto.enterpriseMessageSend(selectedPeer, text);
      setMessages((cur) => [...cur, msg]);
      setReplyInput('');
    } catch { /* 保留输入 */ } finally {
      setSending(false);
    }
  };

  if (!hasAuth) {
    return (
      <div className="otto-inbox-page" role="region" aria-label="我的消息">
        <header className="otto-inbox-page__header">
          <h1>我的消息</h1>
          <button type="button" onClick={onBack}>返回</button>
        </header>
        <div className="otto-inbox-page__empty">需要企业账号登录后查看消息。</div>
      </div>
    );
  }

  return (
    <div className="otto-inbox-page" role="region" aria-label="我的消息">
      <header className="otto-inbox-page__header">
        <div>
          <h1>我的消息</h1>
          <p>{conversations.length} 个会话{totalUnread > 0 ? ` · ${totalUnread} 条未读` : ''}</p>
        </div>
        <button type="button" onClick={onBack}>返回对话</button>
      </header>

      <div className="otto-inbox-page__filters" role="tablist" aria-label="消息过滤">
        {([
          ['all', `全部 ${conversations.length}`],
          ['unread', `未读 ${conversations.filter((c) => c.unreadCount > 0).length}`],
          ['handled', `已处理 ${conversations.filter((c) => c.unreadCount === 0).length}`],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={filter === key ? 'is-active' : ''}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="otto-inbox-page__layout">
        {/* 左：会话列表 */}
        <div className="otto-inbox-page__list" role="list" aria-label="会话列表">
          {loading && conversations.length === 0 ? (
            <div className="otto-inbox-page__empty">正在加载消息…</div>
          ) : filtered.length === 0 ? (
            <div className="otto-inbox-page__empty">
              {filter === 'unread' ? '没有未读消息' : filter === 'handled' ? '没有已处理消息' : '暂无消息'}
            </div>
          ) : filtered.map((conv) => (
            <button
              key={conv.peerAccountId}
              type="button"
              role="listitem"
              className={`otto-inbox-page__conv${selectedPeer === conv.peerAccountId ? ' is-selected' : ''}`}
              onClick={() => setSelectedPeer(conv.peerAccountId)}
            >
              <span className="otto-inbox-page__conv-avatar" aria-hidden>
                {conv.peerName.slice(0, 1)}
              </span>
              <span className="otto-inbox-page__conv-body">
                <strong>{conv.peerName}</strong>
                <span className="otto-inbox-page__conv-meta">
                  {conv.peerDepartment || ''}{conv.peerPositionTitle ? ` · ${conv.peerPositionTitle}` : ''}
                </span>
                {conv.lastMessage ? (
                  <span className="otto-inbox-page__conv-preview">{conv.lastMessage}</span>
                ) : null}
              </span>
              <span className="otto-inbox-page__conv-side">
                {conv.online ? <span className="otto-inbox-page__online" aria-label="在线" /> : null}
                {conv.unreadCount > 0 ? (
                  <span className="otto-inbox-page__unread" role="status">{conv.unreadCount}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>

        {/* 右：消息详情 */}
        <div className="otto-inbox-page__detail" aria-label="消息详情">
          {selectedPeer && selectedMember ? (
            <>
              <header className="otto-inbox-page__detail-header">
                <strong>{selectedMember.name}</strong>
                <span>{selectedMember.department || ''} · {selectedMember.positionTitle || selectedMember.role || ''}</span>
                {selectedMember.ottoOnline ? <span className="otto-inbox-page__presence">在线</span> : null}
              </header>
              <div className="otto-inbox-page__messages">
                {messagesLoading ? (
                  <div className="otto-inbox-page__empty">加载消息中…</div>
                ) : messages.length === 0 ? (
                  <div className="otto-inbox-page__empty">开始与 {selectedMember.name} 对话</div>
                ) : messages.map((msg) => {
                  const mine = msg.senderAccountId === enterpriseAccount?.id;
                  return (
                    <div key={msg.id} className={`otto-inbox-page__msg${mine ? ' is-mine' : ''}`}>
                      <span className="otto-inbox-page__msg-bubble">{msg.content}</span>
                      <time>{new Date(msg.createdAt).toLocaleString('zh-CN', {
                        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
                      })}</time>
                    </div>
                  );
                })}
              </div>
              <form
                className="otto-inbox-page__reply"
                onSubmit={(e) => { e.preventDefault(); void handleSendReply(); }}
              >
                <textarea
                  value={replyInput}
                  onChange={(e) => setReplyInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void handleSendReply();
                    }
                  }}
                  placeholder={`回复 ${selectedMember.name}…`}
                  rows={2}
                  maxLength={4000}
                  aria-label="回复消息"
                />
                <button type="submit" disabled={!replyInput.trim() || sending}>
                  {sending ? '发送中' : '发送'}
                </button>
              </form>
            </>
          ) : (
            <div className="otto-inbox-page__empty otto-inbox-page__empty--detail">
              选择左侧会话查看消息
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
