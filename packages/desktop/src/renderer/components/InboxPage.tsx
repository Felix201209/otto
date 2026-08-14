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
  EnterpriseDirectMessageAttachmentUpload,
  EnterpriseFederationContact,
  EnterpriseOrganizationView,
  EnterpriseUnreadMessageNotification,
} from '../../preload/index.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { createQrMatrix } from '../lib/qrMatrix.js';
import {
  buildAtoaRequest,
  displayDirectMessageContent,
} from '../atoaProtocol.js';
import {
  IconCheckCheck,
  IconClose,
  IconCopy,
  IconPlus,
  IconWarning,
} from './icons.js';

const INBOX_REFRESH_MS = 8_000;

type InboxFilter = 'all' | 'unread' | 'handled';

function FederationVerificationQr({ payload }: { payload: string }): React.JSX.Element | null {
  const matrix = createQrMatrix(payload);
  if (!matrix) return null;
  const path = matrix
    .flatMap((row, y) =>
      row.flatMap((filled, x) => (filled ? [`M${x} ${y}h1v1h-1z`] : [])),
    )
    .join('');
  const size = matrix.length;
  return (
    <svg
      className="otto-inbox-page__security-qr"
      role="img"
      aria-label="联邦联系人安全号码二维码"
      viewBox={`-3 -3 ${size + 6} ${size + 6}`}
      shapeRendering="crispEdges"
    >
      <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

export interface InboxPageProps {
  enterpriseAccount?: EnterpriseAccount;
  enterpriseUnreadCounts?: Record<string, number>;
  onOpenDirectChat?: (peerAccountId: string) => void;
  /** 打开某会话后将该 peer 标记为已读（联动导航未读角标）。 */
  onMessageRead?: (peerAccountId: string) => void;
  federationContactOpenRequest?: { contactId: string; requestId: number };
  onFederationMessageRead?: (contactId: string) => void;
  onBack: () => void;
}

export interface ConversationItem {
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
  onOpenDirectChat: _onOpenDirectChat,
  onMessageRead,
  federationContactOpenRequest,
  onFederationMessageRead,
  onBack,
}: InboxPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [notifications, setNotifications] = useState<EnterpriseUnreadMessageNotification[]>([]);
  const [orgMembers, setOrgMembers] = useState<EnterpriseOrganizationView['members']>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [selectedFederationContactId, setSelectedFederationContactId] = useState<string | null>(null);
  const [federationContacts, setFederationContacts] = useState<EnterpriseFederationContact[]>([]);
  const [federationSetupOpen, setFederationSetupOpen] = useState(false);
  const [federationContactCode, setFederationContactCode] = useState('');
  const [federationError, setFederationError] = useState('');
  const [federationVerification, setFederationVerification] = useState<{
    safetyNumber: string;
    qrPayload: string;
    verifiedAt: string | null;
  } | null>(null);
  const [messages, setMessages] = useState<EnterpriseDirectMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyInput, setReplyInput] = useState('');
  const [federationAttachments, setFederationAttachments] = useState<
    EnterpriseDirectMessageAttachmentUpload[]
  >([]);
  const [sending, setSending] = useState(false);
  // 已读会话也要留在列表里：记录拉取过消息的 peer 及其最后一条消息
  const [historyPeers, setHistoryPeers] = useState<Record<string, { lastMessage: string; lastMessageAt: string }>>({});
  const hasAuth = isAuthenticatedEnterpriseAccount(enterpriseAccount);

  // —— 加载未读通知 ——
  const refreshNotifications = useCallback(async (): Promise<void> => {
    if (!hasAuth) return;
    try {
      const data = await window.otto.enterpriseMessagesUnread();
      setNotifications(Array.isArray(data) ? data : []);
    } catch { /* 网络错误不清空已有数据 */ }
  }, [hasAuth]);

  const refreshFederationContacts = useCallback(async (): Promise<void> => {
    if (!hasAuth) return;
    try {
      const contacts = await window.otto.enterpriseFederationContacts();
      setFederationContacts(Array.isArray(contacts) ? contacts : []);
    } catch {
      // Federation is optional. Keep the local inbox available when it is not licensed.
    }
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
    void Promise.all([
      refreshNotifications(),
      refreshFederationContacts(),
    ]).finally(() => setLoading(false));
    const timer = window.setInterval(() => {
      void refreshNotifications();
      void refreshFederationContacts();
    }, INBOX_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasAuth, refreshFederationContacts, refreshNotifications]);

  // —— 构建会话列表 ——
  const conversations = useMemo<ConversationItem[]>(() => {
    const memberMap = new Map(orgMembers.map((m) => [m.id, m]));
    const convMap = new Map<string, ConversationItem>();

    // 从未读通知构建
    for (const notif of notifications) {
      const member = memberMap.get(notif.senderAccountId);
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

    // 补充已读过消息的会话（未读为 0 也要留在列表，否则发完回复会话会消失）
    for (const [peerId, history] of Object.entries(historyPeers)) {
      if (convMap.has(peerId)) continue;
      const member = memberMap.get(peerId);
      if (!member) continue;
      convMap.set(peerId, {
        peerAccountId: peerId,
        peerName: member.name,
        peerDepartment: member.department,
        peerPositionTitle: member.positionTitle ?? null,
        lastMessage: history.lastMessage,
        lastMessageAt: history.lastMessageAt,
        unreadCount: 0,
        online: member.ottoOnline ?? false,
      });
    }

    return [...convMap.values()].sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      return b.lastMessageAt.localeCompare(a.lastMessageAt);
    });
  }, [notifications, orgMembers, enterpriseUnreadCounts, historyPeers]);

  // —— 过滤 ——
  const filtered = useMemo(() => {
    if (filter === 'unread') return conversations.filter((c) => c.unreadCount > 0);
    if (filter === 'handled') return conversations.filter((c) => c.unreadCount === 0);
    return conversations;
  }, [conversations, filter]);

  const filteredFederationContacts = useMemo(() => {
    if (filter === 'unread') {
      return federationContacts.filter((contact) => contact.unreadCount > 0);
    }
    if (filter === 'handled') {
      return federationContacts.filter((contact) => contact.unreadCount === 0);
    }
    return federationContacts;
  }, [federationContacts, filter]);

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + c.unreadCount, 0) +
      federationContacts.reduce((sum, contact) => sum + contact.unreadCount, 0),
    [conversations, federationContacts],
  );

  // —— 加载选中会话的消息，并标记该 peer 已读 ——
  useEffect(() => {
    if (!selectedPeer || selectedFederationContactId) return;
    let cancelled = false;
    setMessagesLoading(true);
    void window.otto.enterpriseMessagesList(selectedPeer).then((msgs) => {
      if (cancelled) return;
      const safeMessages = Array.isArray(msgs) ? msgs : [];
      setMessages(safeMessages);
      const last = safeMessages[safeMessages.length - 1];
      if (last) {
        setHistoryPeers((cur) => ({
          ...cur,
          [selectedPeer]: { lastMessage: last.content, lastMessageAt: last.createdAt },
        }));
      }
    }).catch(() => { /* 忽略 */ }).finally(() => {
      if (!cancelled) setMessagesLoading(false);
    });
    onMessageRead?.(selectedPeer);
    return () => { cancelled = true; };
  }, [selectedFederationContactId, selectedPeer, onMessageRead]);

  useEffect(() => {
    if (!selectedFederationContactId) return;
    let cancelled = false;
    setMessagesLoading(true);
    setFederationError('');
    void window.otto.enterpriseFederationMessagesList(selectedFederationContactId)
      .then((items) => {
        if (!cancelled) {
          setMessages(Array.isArray(items) ? items : []);
          onFederationMessageRead?.(selectedFederationContactId);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessages([]);
          setFederationError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
      });
    void window.otto.enterpriseFederationContactVerification(
      selectedFederationContactId,
    ).then((verification) => {
      if (!cancelled) setFederationVerification(verification);
    }).catch(() => {
      if (!cancelled) setFederationVerification(null);
    });
    return () => { cancelled = true; };
  }, [onFederationMessageRead, selectedFederationContactId]);

  const selectedMember = useMemo(
    () => orgMembers.find((m) => m.id === selectedPeer) ?? null,
    [orgMembers, selectedPeer],
  );

  const selectedFederationContact = useMemo(
    () => federationContacts.find(
      (contact) => contact.id === selectedFederationContactId,
    ) ?? null,
    [federationContacts, selectedFederationContactId],
  );

  useEffect(() => {
    setFederationAttachments([]);
  }, [selectedFederationContactId, selectedPeer]);

  useEffect(() => {
    const contactId = federationContactOpenRequest?.contactId;
    if (!contactId || !federationContacts.some((contact) => contact.id === contactId)) {
      return;
    }
    setSelectedPeer(null);
    setSelectedFederationContactId(contactId);
    setReplyInput('');
  }, [federationContactOpenRequest, federationContacts]);

  const handleSendReply = async (): Promise<void> => {
    const text = replyInput.trim();
    if (
      (!text && federationAttachments.length === 0) ||
      (!selectedPeer && !selectedFederationContactId) || sending
    ) return;
    setSending(true);
    try {
      const msg = selectedFederationContactId
        ? await window.otto.enterpriseFederationMessageSend(
            selectedFederationContactId,
            text,
            federationAttachments,
          )
        : await window.otto.enterpriseMessageSend(selectedPeer!, text);
      setMessages((cur) => [...cur, msg]);
      if (selectedPeer) {
        setHistoryPeers((cur) => ({
          ...cur,
          [selectedPeer]: { lastMessage: msg.content, lastMessageAt: msg.createdAt },
        }));
      }
      setReplyInput('');
      setFederationAttachments([]);
      setFederationError('');
      if (selectedFederationContactId) void refreshFederationContacts();
    } catch (error) {
      if (selectedFederationContactId) {
        setFederationError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSending(false);
    }
  };

  const askFederationPeerOtto = async (): Promise<void> => {
    const question = replyInput.trim();
    if (
      !selectedFederationContactId || !selectedFederationContact ||
      !question || sending || federationAttachments.length > 0
    ) return;
    if (selectedFederationContact.trustState !== 'verified') {
      setFederationError('请先核验联系人安全号码，再向对方 Otto 提问。');
      return;
    }
    setSending(true);
    try {
      const message = await window.otto.enterpriseFederationMessageSend(
        selectedFederationContactId,
        buildAtoaRequest(question, { mode: 'answer' }),
      );
      setMessages((current) => [...current, message]);
      setReplyInput('');
      setFederationError('');
      void refreshFederationContacts();
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const addFederationFiles = async (files: FileList | File[]): Promise<void> => {
    try {
      const next = [...federationAttachments];
      for (const file of Array.from(files)) {
        if (next.length >= 6) throw new Error('每条消息最多发送 6 个附件');
        if (file.size < 1 || file.size > 1024 * 1024 * 1024) {
          throw new Error(`${file.name} 超过 1 GB 或内容为空`);
        }
        const sourcePath = await window.otto.authorizeFileForAttachment(file);
        next.push({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          sourcePath,
        });
      }
      if (next.reduce((sum, item) => sum + item.size, 0) > 1024 * 1024 * 1024) {
        throw new Error('每条消息的附件总大小不能超过 1 GB');
      }
      setFederationAttachments(next);
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveFederationAttachment = async (
    messageId: string,
    attachment: NonNullable<EnterpriseDirectMessage['attachments']>[number],
  ): Promise<void> => {
    if (!selectedFederationContactId) return;
    try {
      await window.otto.enterpriseFederationAttachmentSave(
        selectedFederationContactId,
        messageId,
        attachment.id,
        attachment.fileName,
      );
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const copyFederationContactCode = async (): Promise<void> => {
    try {
      const code = await window.otto.enterpriseFederationContactCode();
      await navigator.clipboard.writeText(code);
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const importFederationContact = async (): Promise<void> => {
    if (!federationContactCode.trim()) return;
    try {
      const contact = await window.otto.enterpriseFederationContactImport(
        federationContactCode,
      );
      setFederationContactCode('');
      setFederationSetupOpen(false);
      setSelectedPeer(null);
      setSelectedFederationContactId(contact.id);
      await refreshFederationContacts();
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmFederationVerification = async (): Promise<void> => {
    if (!selectedFederationContactId) return;
    try {
      const verification = await window.otto.enterpriseFederationContactVerify(
        selectedFederationContactId,
      );
      setFederationVerification(verification);
      await refreshFederationContacts();
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeFederationContact = async (): Promise<void> => {
    if (!selectedFederationContactId || !selectedFederationContact) return;
    if (!window.confirm(`移除跨服务器联系人“${selectedFederationContact.displayName}”？`)) {
      return;
    }
    try {
      await window.otto.enterpriseFederationContactRemove(selectedFederationContactId);
      setSelectedFederationContactId(null);
      setFederationVerification(null);
      setMessages([]);
      await refreshFederationContacts();
      setFederationError('');
    } catch (error) {
      setFederationError(error instanceof Error ? error.message : String(error));
    }
  };

  const renderMessages = (emptyLabel: string): React.JSX.Element => (
    <div className="otto-inbox-page__messages">
      {messagesLoading ? (
        <div className="otto-inbox-page__empty">加载消息中…</div>
      ) : messages.length === 0 ? (
        <div className="otto-inbox-page__empty">{emptyLabel}</div>
      ) : messages.map((msg) => {
        const mine = msg.senderAccountId === enterpriseAccount?.id;
        const deliveryStatus = 'deliveryStatus' in msg &&
          typeof msg.deliveryStatus === 'string'
          ? msg.deliveryStatus
          : null;
        return (
          <div key={msg.id} className={`otto-inbox-page__msg${mine ? ' is-mine' : ''}`}>
            <span className="otto-inbox-page__msg-bubble">
              {msg.content ? (
                <span>{displayDirectMessageContent(msg.content)}</span>
              ) : null}
              {(msg.attachments ?? []).map((attachment) => (
                <span key={attachment.id} className="otto-inbox-page__attachment">
                  <span>
                    <strong>{attachment.fileName}</strong>
                    <small>{(attachment.size / 1024 / 1024).toFixed(1)} MB</small>
                  </span>
                  {selectedFederationContactId && !mine ? (
                    <button
                      type="button"
                      onClick={() => { void saveFederationAttachment(msg.id, attachment); }}
                    >
                      保存
                    </button>
                  ) : null}
                </span>
              ))}
            </span>
            <span className="otto-inbox-page__msg-meta">
              <time>{new Date(msg.createdAt).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}</time>
              {deliveryStatus ? (
                <span>{deliveryStatus === 'received' ? '已接收' : deliveryStatus === 'sent' ? '已送达' : deliveryStatus === 'queued' ? '待投递' : deliveryStatus === 'failed' ? '投递失败' : '已过期'}</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );

  const renderReply = (placeholder: string): React.JSX.Element => (
    <form
      className="otto-inbox-page__reply"
      onSubmit={(event) => { event.preventDefault(); void handleSendReply(); }}
    >
      <textarea
        value={replyInput}
        onChange={(event) => setReplyInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void handleSendReply();
          }
        }}
        placeholder={placeholder}
        rows={2}
        maxLength={4000}
        aria-label="回复消息"
      />
      {selectedFederationContactId ? (
        <div className="otto-inbox-page__reply-actions">
          <label className="otto-inbox-page__attach-button">
            <input
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) void addFederationFiles(event.target.files);
                event.target.value = '';
              }}
            />
            添加文件
          </label>
          <button
            type="button"
            className="otto-inbox-page__a2a-button"
            disabled={
              !replyInput.trim() || sending || federationAttachments.length > 0 ||
              selectedFederationContact?.trustState !== 'verified'
            }
            title={selectedFederationContact?.trustState === 'verified'
              ? '对方必须明确批准资料范围，授权仅使用一次'
              : '请先核验联系人身份'}
            onClick={() => { void askFederationPeerOtto(); }}
          >
            询问对方 Otto
          </button>
        </div>
      ) : null}
      {selectedFederationContactId && federationAttachments.length > 0 ? (
        <div className="otto-inbox-page__pending-attachments">
          {federationAttachments.map((attachment, index) => (
            <span key={`${attachment.fileName}:${index}`}>
              {attachment.fileName}
              <button
                type="button"
                aria-label={`移除 ${attachment.fileName}`}
                onClick={() => setFederationAttachments((items) =>
                  items.filter((_, itemIndex) => itemIndex !== index))}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={(!replyInput.trim() && federationAttachments.length === 0) || sending}
      >
        {sending ? '发送中' : '发送'}
      </button>
    </form>
  );

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
          <p>{conversations.length + federationContacts.length} 个会话{totalUnread > 0 ? ` · ${totalUnread} 条未读` : ''}</p>
        </div>
        <button type="button" onClick={onBack}>返回对话</button>
      </header>

      <div className="otto-inbox-page__filters" role="tablist" aria-label="消息过滤">
        {([
          ['all', `全部 ${conversations.length + federationContacts.length}`],
          ['unread', `未读 ${conversations.filter((c) => c.unreadCount > 0).length + federationContacts.filter((c) => c.unreadCount > 0).length}`],
          ['handled', `已处理 ${conversations.filter((c) => c.unreadCount === 0).length + federationContacts.filter((c) => c.unreadCount === 0).length}`],
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
          <div className="otto-inbox-page__federation-actions">
            <button
              type="button"
              title="复制我的跨服务器联系码"
              onClick={() => { void copyFederationContactCode(); }}
            >
              <IconCopy size={14} />
              复制我的联系码
            </button>
            <button
              type="button"
              title="添加跨服务器联系人"
              aria-expanded={federationSetupOpen}
              onClick={() => setFederationSetupOpen((open) => !open)}
            >
              <IconPlus size={14} />
              添加联系人
            </button>
          </div>
          {federationSetupOpen ? (
            <div className="otto-inbox-page__federation-setup">
              <label htmlFor="otto-federation-contact-code">粘贴对方的联系码</label>
              <textarea
                id="otto-federation-contact-code"
                value={federationContactCode}
                onChange={(event) => setFederationContactCode(event.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="OTTO_FEDERATION_CONTACT_V1:…"
              />
              <button
                type="button"
                disabled={!federationContactCode.trim()}
                onClick={() => { void importFederationContact(); }}
              >
                导入联系人
              </button>
            </div>
          ) : null}
          {federationError && !selectedFederationContactId ? (
            <div className="otto-inbox-page__error" role="alert">{federationError}</div>
          ) : null}
          {filteredFederationContacts.length > 0 ? (
            <>
              <div className="otto-inbox-page__section-label">跨服务器</div>
              {filteredFederationContacts.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  role="listitem"
                  aria-label={`${contact.displayName}，跨服务器联系人，${contact.unreadCount} 条未读`}
                  className={`otto-inbox-page__conv${selectedFederationContactId === contact.id ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSelectedPeer(null);
                    setSelectedFederationContactId(contact.id);
                    setReplyInput('');
                  }}
                >
                  <span className="otto-inbox-page__conv-avatar otto-inbox-page__conv-avatar--federated" aria-hidden>
                    {contact.displayName.slice(0, 1)}
                  </span>
                  <span className="otto-inbox-page__conv-body">
                    <strong>{contact.displayName}</strong>
                    <span className="otto-inbox-page__conv-meta">{contact.deploymentDisplayName}</span>
                    <span className={`otto-inbox-page__trust${contact.trustState === 'verified' ? ' is-verified' : ''}`}>
                      {contact.trustState === 'verified' ? '已核验身份' : '身份待核验'}
                    </span>
                  </span>
                  <span className="otto-inbox-page__conv-side">
                    {contact.unreadCount > 0 ? (
                      <span className="otto-inbox-page__unread" role="status">{contact.unreadCount}</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </>
          ) : null}
          {filtered.length > 0 ? <div className="otto-inbox-page__section-label">本企业</div> : null}
          {loading && conversations.length === 0 && federationContacts.length === 0 ? (
            <div className="otto-inbox-page__empty">正在加载消息…</div>
          ) : filtered.length === 0 && filteredFederationContacts.length === 0 ? (
            <div className="otto-inbox-page__empty">
              {filter === 'unread' ? '没有未读消息' : filter === 'handled' ? '没有已处理消息' : '暂无消息'}
            </div>
          ) : filtered.map((conv) => (
            <button
              key={conv.peerAccountId}
              type="button"
              role="listitem"
              aria-label={`${conv.peerName}，本企业联系人，${conv.unreadCount} 条未读`}
              className={`otto-inbox-page__conv${selectedPeer === conv.peerAccountId ? ' is-selected' : ''}`}
              onClick={() => {
                setSelectedFederationContactId(null);
                setSelectedPeer(conv.peerAccountId);
                setReplyInput('');
              }}
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
          {selectedFederationContactId && selectedFederationContact ? (
            <>
              <header className="otto-inbox-page__detail-header">
                <strong>{selectedFederationContact.displayName}</strong>
                <span>{selectedFederationContact.deploymentDisplayName}</span>
                <span className={`otto-inbox-page__security-state${selectedFederationContact.trustState === 'verified' ? ' is-verified' : ''}`}>
                  {selectedFederationContact.trustState === 'verified' ? <IconCheckCheck size={13} /> : <IconWarning size={13} />}
                  {selectedFederationContact.trustState === 'verified' ? '已核验' : '未核验'}
                </span>
                <button
                  type="button"
                  className="otto-inbox-page__remove-contact"
                  title="移除联系人"
                  aria-label="移除联系人"
                  onClick={() => { void removeFederationContact(); }}
                >
                  <IconClose size={14} />
                </button>
              </header>
              {federationVerification ? (
                <section className="otto-inbox-page__security" aria-label="端到端加密身份核验">
                  <FederationVerificationQr payload={federationVerification.qrPayload} />
                  <div>
                    <strong>端到端加密安全号码</strong>
                    <p>请通过电话或当面与对方核对。号码一致后再确认身份。</p>
                    <code>{federationVerification.safetyNumber.match(/.{1,4}/g)?.join(' ') ?? federationVerification.safetyNumber}</code>
                    {federationVerification.verifiedAt ? (
                      <span className="otto-inbox-page__verified-note"><IconCheckCheck size={14} /> 已于本设备核验</span>
                    ) : (
                      <button type="button" onClick={() => { void confirmFederationVerification(); }}>
                        我已核对，确认身份
                      </button>
                    )}
                  </div>
                </section>
              ) : null}
              {federationError ? (
                <div className="otto-inbox-page__error" role="alert">{federationError}</div>
              ) : null}
              {renderMessages(`开始与 ${selectedFederationContact.displayName} 进行加密对话`)}
              {renderReply(`加密回复 ${selectedFederationContact.displayName}…`)}
            </>
          ) : selectedPeer && selectedMember ? (
            <>
              <header className="otto-inbox-page__detail-header">
                <strong>{selectedMember.name}</strong>
                <span>{selectedMember.department || ''} · {selectedMember.positionTitle || selectedMember.role || ''}</span>
                {selectedMember.ottoOnline ? <span className="otto-inbox-page__presence">在线</span> : null}
              </header>
              {renderMessages(`开始与 ${selectedMember.name} 对话`)}
              {renderReply(`回复 ${selectedMember.name}…`)}
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
