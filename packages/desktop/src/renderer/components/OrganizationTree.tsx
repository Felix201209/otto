/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductWorkspaceSnapshot, ScheduleItemInfo } from 'otto-server';
import type {
  EnterpriseAccount,
  EnterpriseDirectMessage,
  EnterpriseDirectMessageAttachment,
  EnterpriseDirectMessageAttachmentDownload,
  EnterpriseDirectMessageAttachmentUpload,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import { buildAtoaRequest, displayDirectMessageContent } from '../atoaProtocol.js';
import { isAuthenticatedEnterpriseAccount } from '../internal-test-access.js';
import { askLocalPeerOtto } from '../peerOttoRunner.js';
import { IconChevronDown, IconPaperclip, IconPlus } from './icons.js';
import { AtoaConsultDialog } from './AtoaConsultDialog.js';
import type { EnterpriseUnreadCounts } from '../enterpriseUnreadNotifications.js';

const ORGANIZATION_REFRESH_MS = 10_000;

export interface EnterpriseDirectChatOpenRequest {
  peerAccountId: string;
  requestId: number;
}

export function OrganizationTree({
  workspace,
  schedules = [],
  enterpriseAccount,
  openRequest = 0,
  refreshRevision = 0,
  unreadCounts = {},
  directChatOpenRequest,
  onMessageRead,
}: {
  workspace: ProductWorkspaceSnapshot | null;
  schedules?: readonly ScheduleItemInfo[];
  enterpriseAccount?: EnterpriseAccount;
  /** 右侧企业入口递增该值时，展开这里唯一的真实组织树。 */
  openRequest?: number;
  /** 企业管理员提交成员/职位变化后递增，强制重读服务端组织目录。 */
  refreshRevision?: number;
  unreadCounts?: EnterpriseUnreadCounts;
  directChatOpenRequest?: EnterpriseDirectChatOpenRequest;
  onMessageRead?: (peerAccountId: string) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [orgView, setOrgView] = useState<EnterpriseOrganizationView | null>(null);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgSyncedAt, setOrgSyncedAt] = useState<Date | null>(null);
  const [manualRefreshRequest, setManualRefreshRequest] = useState(0);
  const [chatMember, setChatMember] = useState<EnterpriseOrganizationView['members'][number] | null>(null);
  const handledDirectChatOpenRequest = useRef(0);
  const hasLocalEnterpriseWorkspace = workspace?.context.edition === 'enterprise';
  const hasAuthenticatedOrganization = isAuthenticatedEnterpriseAccount(enterpriseAccount);
  // 真实中心账号以服务端目录为权威，不能被机器上残留的本机企业树覆盖。
  // 只有没有真实中心账号时，才展示本机 ProductWorkspace 的组织框架。
  const organization = hasLocalEnterpriseWorkspace && !hasAuthenticatedOrganization
    ? workspace?.managerWorkspace?.organization
    : undefined;
  const chatMemberByWorkspaceKey = useMemo(() => {
    const result = new Map<string, EnterpriseOrganizationView['members'][number]>();
    for (const member of orgView?.members ?? []) {
      if (member.status !== 'active') continue;
      if (member.id === enterpriseAccount?.id) continue;
      result.set(normalizeChatKey(member.id), member);
      result.set(normalizeChatKey(member.username), member);
      result.set(normalizeChatKey(member.name), member);
    }
    return result;
  }, [enterpriseAccount?.id, orgView?.members]);
  const openDirectChat = useCallback((member: EnterpriseOrganizationView['members'][number]): void => {
    onMessageRead?.(member.id);
    setChatMember(member);
  }, [onMessageRead]);
  const positionById = useMemo(
    () => new Map(organization?.positions.map((item) => [item.id, item]) ?? []),
    [organization?.positions],
  );
  const childrenByParent = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const item of organization?.companies ?? []) {
      if (!item.parentCompanyId) continue;
      result.set(item.parentCompanyId, [...(result.get(item.parentCompanyId) ?? []), item.id]);
    }
    return result;
  }, [organization?.companies]);

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  // 本地 workspace 没有管理员组织快照时，经 preload -> main 读取企业组织。
  // 会话 token 始终只保留在 main 的 EnterpriseClient 内。
  useEffect(() => {
    // 远程组织目录只允许真实企业账号触发；本机企业成员或内测假身份没有
    // Bearer 会话时展示占位信息，不调用 IPC，也不产生无意义的 401。
    if (!hasAuthenticatedOrganization) return;

    let cancelled = false;
    const loadOrganization = async (showLoading: boolean): Promise<void> => {
      if (showLoading) {
        setOrgLoading(true);
        setOrgView(null);
      }
      try {
        const view = await window.otto.enterpriseOrganizationView();
        if (cancelled) return;
        setOrgView(view);
        setOrgSyncedAt(new Date());
        setOrgError(null);
      } catch (error: unknown) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setOrgError(`组织信息加载失败：${message}`);
      } finally {
        if (!cancelled) setOrgLoading(false);
      }
    };

    void loadOrganization(true);
    const timer = window.setInterval(() => {
      void loadOrganization(false);
    }, ORGANIZATION_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    hasAuthenticatedOrganization,
    enterpriseAccount?.organizationId,
    enterpriseAccount?.updatedAt,
    refreshRevision,
    manualRefreshRequest,
  ]);

  useEffect(() => {
    if (!directChatOpenRequest) return;
    if (handledDirectChatOpenRequest.current === directChatOpenRequest.requestId) return;
    const member = orgView?.members.find((candidate) => (
      candidate.id === directChatOpenRequest.peerAccountId
      && candidate.id !== enterpriseAccount?.id
      && candidate.status === 'active'
    ));
    if (!member) return;
    handledDirectChatOpenRequest.current = directChatOpenRequest.requestId;
    setOpen(true);
    openDirectChat(member);
  }, [directChatOpenRequest, enterpriseAccount?.id, openDirectChat, orgView?.members]);

  if (!hasLocalEnterpriseWorkspace && !hasAuthenticatedOrganization) return null;

  return (
    <section className="otto-orgtree" aria-label="企业组织架构">
      <button
        type="button"
        className="otto-orgtree__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="otto-orgtree__company">企业组织</span>
        <IconChevronDown
          size={13}
          className={'otto-orgtree__chevron' + (open ? '' : ' is-collapsed')}
        />
      </button>

      {open ? (
        <div className="otto-orgtree__body">
          {organization && workspace ? (
            <CompanyBranch
              companyId={organization.rootCompanyId}
              organization={organization}
              workspace={workspace}
              positionById={positionById}
              childrenByParent={childrenByParent}
              chatMemberByWorkspaceKey={chatMemberByWorkspaceKey}
              unreadCounts={unreadCounts}
              onOpenChat={openDirectChat}
            />
          ) : orgView ? (
            <div className="otto-orgtree__member-list">
              {orgView.organization ? (
                <div className="otto-orgtree__company-node">{orgView.organization.name}</div>
              ) : null}
              <OrganizationPresenceSummary
                members={orgView.members}
                syncedAt={orgSyncedAt}
                refreshing={orgLoading}
                onRefresh={() => setManualRefreshRequest((value) => value + 1)}
              />
              {/* Group members by department */}
              {(() => {
                const deptMap = new Map<string, EnterpriseOrganizationView['members']>();
                for (const member of orgView.members) {
                  if (member.status !== 'active') continue;
                  const dept = member.department || '未分配部门';
                  if (!deptMap.has(dept)) deptMap.set(dept, []);
                  deptMap.get(dept)!.push(member);
                }
                return [...deptMap.entries()].map(([dept, members]) => (
                  <DepartmentSection key={dept} name={dept}>
                    {[...members].sort(compareEnterpriseMembers).map((member) => (
                      member.id === enterpriseAccount?.id ? (
                        <div
                          key={member.id}
                          className="otto-orgtree__member"
                          aria-label={`${member.name}（我）`}
                        >
                          <span>{member.name}</span>
                          <span>
                            {member.positionTitle ||
                              (member.isAdmin ? '管理员' : member.role || '成员')}
                          </span>
                          <small>我</small>
                        </div>
                      ) : (
                        <button
                          key={member.id}
                          type="button"
                          className="otto-orgtree__member otto-orgtree__member-button"
                          onClick={() => {
                            openDirectChat(member);
                          }}
                        >
                          <span>{member.name}</span>
                          <span>
                            {member.positionTitle ||
                              (member.isAdmin ? '管理员' : member.role || '成员')}
                          </span>
                          <PresenceBadge
                            online={member.ottoOnline}
                            lastSeenAt={member.ottoLastSeenAt}
                          />
                          <UnreadBadge count={unreadCounts[`enterprise:message:${member.id}`] ?? 0} />
                        </button>
                      )
                    ))}
                  </DepartmentSection>
                ));
              })()}
            </div>
          ) : orgLoading ? (
            <div className="otto-orgtree__vacant">正在加载组织信息…</div>
          ) : orgError ? (
            <div className="otto-orgtree__vacant">{orgError}</div>
          ) : (
            <div className="otto-orgtree__vacant">
              已通过链接加入；组织详情将在企业服务同步后显示。
            </div>
          )}
        </div>
      ) : null}
      {chatMember ? (
        <DirectMessagePanel
          member={chatMember}
          currentAccount={enterpriseAccount}
          schedules={schedules}
          onClose={() => setChatMember(null)}
        />
      ) : null}
    </section>
  );
}

function OrganizationPresenceSummary({
  members,
  syncedAt,
  refreshing,
  onRefresh,
}: {
  members: EnterpriseOrganizationView['members'];
  syncedAt: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const activeMembers = members.filter((member) => member.status === 'active');
  const onlineCount = activeMembers.filter((member) => member.ottoOnline).length;
  const knownPresenceCount = activeMembers.filter((member) =>
    member.ottoOnline !== undefined || member.ottoLastSeenAt !== undefined,
  ).length;
  return (
    <div className="otto-orgtree__presence-summary" aria-label="Otto 在线状态">
      <span>
        {knownPresenceCount > 0
          ? `${onlineCount}/${activeMembers.length} 在线`
          : '等待在线状态'}
      </span>
      {syncedAt ? (
        <small title={syncedAt.toLocaleString('zh-CN')}>
          {formatSyncedAt(syncedAt)}
        </small>
      ) : null}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="刷新企业组织在线状态"
        title="刷新企业组织在线状态"
      >
        {refreshing ? '同步中' : '刷新'}
      </button>
    </div>
  );
}

function compareEnterpriseMembers(
  a: EnterpriseOrganizationView['members'][number],
  b: EnterpriseOrganizationView['members'][number],
): number {
  const onlineRank = Number(Boolean(b.ottoOnline)) - Number(Boolean(a.ottoOnline));
  if (onlineRank !== 0) return onlineRank;
  const unreadRank = Number(Boolean(b.ottoLastSeenAt)) - Number(Boolean(a.ottoLastSeenAt));
  if (unreadRank !== 0) return unreadRank;
  return a.name.localeCompare(b.name, 'zh-CN');
}

function formatSyncedAt(date: Date): string {
  return `同步 ${date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function formatDirectMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function memberInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return 'OT';
  const chars = Array.from(clean);
  return chars.slice(0, 2).join('').toUpperCase();
}

const DIRECT_MESSAGE_MAX_ATTACHMENTS = 6;
const DIRECT_MESSAGE_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DIRECT_MESSAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DIRECT_MESSAGE_FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'log', 'csv', 'json', 'xml', 'md', 'zip',
]);

function directAttachmentExtension(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index + 1).trim().toLowerCase() : '';
}

function directAttachmentTypeLabel(fileName: string, mimeType: string): string {
  if (mimeType.startsWith('image/')) return '图片';
  const extension = directAttachmentExtension(fileName);
  if (extension === 'pdf') return 'PDF';
  if (extension === 'doc' || extension === 'docx') return 'Word';
  if (extension === 'xls' || extension === 'xlsx' || extension === 'csv') return 'Excel';
  if (extension === 'ppt' || extension === 'pptx') return 'PPT';
  return extension ? extension.toUpperCase() : '文件';
}

function directAttachmentMimeType(fileName: string): string {

  const extension = directAttachmentExtension(fileName);
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    log: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    md: 'text/markdown',
    zip: 'application/zip',
  };
  return map[extension] || 'application/octet-stream';
}

function formatDirectAttachmentSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

function normalizeDirectAttachment(
  attachment: EnterpriseDirectMessageAttachmentUpload,
): EnterpriseDirectMessageAttachmentUpload {
  const fileName = attachment.fileName.trim();
  const extension = directAttachmentExtension(fileName);
  if (!fileName || !DIRECT_MESSAGE_FILE_EXTENSIONS.has(extension)) {
    throw new Error('暂不支持该文件格式，请选择图片、Word、PDF、Excel、PPT 或常用文本文件');
  }
  if (
    !Number.isInteger(attachment.size)
    || attachment.size < 1
    || attachment.size > DIRECT_MESSAGE_MAX_FILE_BYTES
  ) {
    throw new Error('单个附件不能超过 10 MB');
  }
  if (!attachment.data) throw new Error('附件内容为空');
  return {
    ...attachment,
    fileName,
    mimeType: directAttachmentMimeType(fileName),
  };
}

function browserFileToDirectAttachment(
  file: File,
): Promise<EnterpriseDirectMessageAttachmentUpload> {
  if (file.size > DIRECT_MESSAGE_MAX_FILE_BYTES) {
    return Promise.reject(new Error(file.name + ' 超过 10 MB'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const separator = result.indexOf(',');
      if (separator < 0) {
        reject(new Error('文件读取失败'));
        return;
      }
      try {
        resolve(normalizeDirectAttachment({
          fileName: file.name,
          mimeType: file.type,
          size: file.size,
          data: result.slice(separator + 1),
        }));
      } catch (reason) {
        reject(reason);
      }
    };
    reader.readAsDataURL(file);
  });
}

function DirectMessageAttachmentCard({
  attachment,
}: {
  attachment: EnterpriseDirectMessageAttachment;
}): React.JSX.Element {
  const [download, setDownload] = useState<EnterpriseDirectMessageAttachmentDownload | null>(null);
  const [loading, setLoading] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const image = attachment.mimeType.startsWith('image/');

  const readAttachment = useCallback(async (): Promise<EnterpriseDirectMessageAttachmentDownload> => {
    if (download) return download;
    setLoading(true);
    setAttachmentError('');
    try {
      const next = await window.otto.enterpriseMessageAttachmentRead(attachment.id);
      setDownload(next);
      return next;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setAttachmentError(message);
      throw reason;
    } finally {
      setLoading(false);
    }
  }, [attachment.id, download]);

  const saveAttachment = async (): Promise<void> => {
    const next = await readAttachment().catch(() => null);
    if (!next) return;
    const link = document.createElement('a');
    link.href = 'data:' + next.mimeType + ';base64,' + next.data;
    link.download = next.fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const previewUrl = image && download
    ? 'data:' + download.mimeType + ';base64,' + download.data
    : '';

  return (
    <div className={'otto-direct-chat__attachment' + (image ? ' is-image' : '')}>
      {previewUrl ? (
        <img src={previewUrl} alt={attachment.fileName} />
      ) : (
        <span className="otto-direct-chat__attachment-icon" aria-hidden="true">
          {directAttachmentTypeLabel(attachment.fileName, attachment.mimeType)}
        </span>
      )}
      <span className="otto-direct-chat__attachment-copy">
        <strong title={attachment.fileName}>{attachment.fileName}</strong>
        <small>
          {directAttachmentTypeLabel(attachment.fileName, attachment.mimeType)}
          {' · '}
          {formatDirectAttachmentSize(attachment.size)}
        </small>
        {attachmentError ? <em role="alert">{attachmentError}</em> : null}
      </span>
      <span className="otto-direct-chat__attachment-actions">
        {image && !previewUrl ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void readAttachment().catch(() => undefined)}
            aria-label={'预览 ' + attachment.fileName}
          >
            {loading ? '读取中' : '预览'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={loading}
          onClick={() => void saveAttachment()}
          aria-label={'下载 ' + attachment.fileName}
        >
          下载
        </button>
      </span>
    </div>
  );
}

function DirectMessagePanel({
  member,
  currentAccount,
  schedules,
  onClose,
}: {
  member: EnterpriseOrganizationView['members'][number];
  currentAccount?: EnterpriseAccount;
  schedules: readonly ScheduleItemInfo[];
  onClose: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<EnterpriseDirectMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<EnterpriseDirectMessageAttachmentUpload[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [askingOwnOtto, setAskingOwnOtto] = useState(false);
  const [askingPeerOtto, setAskingPeerOtto] = useState(false);
  const [collaborationMenuOpen, setCollaborationMenuOpen] = useState(false);
  const [consultOpen, setConsultOpen] = useState(false);

  useEffect(() => {
    setDraft('');
    setAttachments([]);
    setAttachmentError('');
    setError('');
  }, [member.id]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await window.otto.enterpriseMessagesList(member.id);
        if (active) {
          setMessages(next);
          setError('');
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [member.id]);

  const appendAttachments = (
    candidates: readonly EnterpriseDirectMessageAttachmentUpload[],
  ): void => {
    const next = [...attachments];
    const keys = new Set(next.map((item) => item.fileName + ':' + item.size));
    let totalBytes = next.reduce((sum, item) => sum + item.size, 0);
    let firstError = '';
    for (const candidate of candidates) {
      try {
        const normalized = normalizeDirectAttachment(candidate);
        const key = normalized.fileName + ':' + normalized.size;
        if (keys.has(key)) continue;
        if (next.length >= DIRECT_MESSAGE_MAX_ATTACHMENTS) {
          firstError ||= '每条消息最多发送 6 个附件';
          break;
        }
        if (totalBytes + normalized.size > DIRECT_MESSAGE_MAX_TOTAL_BYTES) {
          firstError ||= '每条消息的附件总大小不能超过 20 MB';
          continue;
        }
        next.push(normalized);
        keys.add(key);
        totalBytes += normalized.size;
      } catch (reason) {
        firstError ||= reason instanceof Error ? reason.message : String(reason);
      }
    }
    setAttachments(next);
    setAttachmentError(firstError);
  };

  const pickAttachments = async (): Promise<void> => {
    if (attaching) return;
    setAttaching(true);
    setAttachmentError('');
    try {
      const paths = await window.otto.selectFiles();
      const remaining = DIRECT_MESSAGE_MAX_ATTACHMENTS - attachments.length;
      const selected: EnterpriseDirectMessageAttachmentUpload[] = [];
      for (const filePath of paths.slice(0, Math.max(0, remaining))) {
        const file = await window.otto.readFilePath(filePath);
        selected.push({
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.size,
          data: file.data,
        });
      }
      appendAttachments(selected);
      if (paths.length > remaining) setAttachmentError('每条消息最多发送 6 个附件');
    } catch (reason) {
      setAttachmentError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAttaching(false);
    }
  };

  const addBrowserFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0 || attaching) return;
    setAttaching(true);
    setAttachmentError('');
    const remaining = DIRECT_MESSAGE_MAX_ATTACHMENTS - attachments.length;
    const selected: EnterpriseDirectMessageAttachmentUpload[] = [];
    let firstError = '';
    for (const file of files.slice(0, Math.max(0, remaining))) {
      try {
        selected.push(await browserFileToDirectAttachment(file));
      } catch (reason) {
        firstError ||= reason instanceof Error ? reason.message : String(reason);
      }
    }
    appendAttachments(selected);
    if (files.length > remaining) firstError ||= '每条消息最多发送 6 个附件';
    if (firstError) setAttachmentError(firstError);
    setAttaching(false);
  };

  const buildTranscriptContext = (): string => {
    const myName = currentAccount?.name || '我';
    const transcript = messages.slice(-40).map((message) => {
      const speaker = message.senderAccountId === member.id ? member.name : myName;
      const createdAt = message.createdAt
        ? new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })
        : '';
      const files = (message.attachments || []).map((item) => item.fileName);
      const fileSummary = files.length > 0 ? ' [附件：' + files.join('、') + ']' : '';
      return '- ' + createdAt + ' ' + speaker + ': ' + message.content + fileSummary;
    }).join('\n');
    return [
      '当前是在企业一对一聊天窗口中询问自己的 Otto；本次回答会发送给聊天对方可见。',
      '请结合当前聊天记录和我本机 Otto 已获授权的资料回答，不要编造。',
      '',
      '当前聊天记录：',
      transcript || '（当前还没有可用聊天记录）',
    ].join('\n');
  };

  const askOtto = async (question?: string) => {
    const cleanQuestion = (question?.trim() || draft.trim()).slice(0, 1200);
    if (!cleanQuestion || askingOwnOtto || attachments.length > 0) return;
    setAskingOwnOtto(true);
    try {
      const answer = await askLocalPeerOtto({
        question: cleanQuestion,
        workContext: buildTranscriptContext(),
        requestId: 'own-a2a-' + crypto.randomUUID(),
        clientMessageId: 'own-a2a-message-' + crypto.randomUUID(),
      });
      const content = [
        '我问了自己的 Otto（基于：我的 Otto 可用资料）：' + cleanQuestion,
        '',
        'Otto：',
        answer,
      ].join('\n');
      const message = await window.otto.enterpriseMessageSend(member.id, content);
      setMessages((current) => [...current, message]);
      setDraft('');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAskingOwnOtto(false);
    }
  };

  const askPeerOtto = async (question?: string) => {
    if (attachments.length > 0) return;
    const content = buildAtoaRequest(question?.trim() || draft.trim());
    setAskingPeerOtto(true);
    try {
      const message = await window.otto.enterpriseMessageSend(member.id, content);
      setMessages((current) => [...current, message]);
      setDraft('');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAskingPeerOtto(false);
    }
  };

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if ((!content && attachments.length === 0) || sending || attaching) return;
    if (attachments.length === 0) {
      const ottoShortcut = content.match(/^@otto(?:\s+|$)([\s\S]*)$/i);
      if (ottoShortcut) {
        await askOtto(ottoShortcut[1] || undefined);
        return;
      }
      const peerOttoShortcut = content.match(/^@peer-otto(?:\s+|$)([\s\S]*)$/i);
      if (peerOttoShortcut) {
        await askPeerOtto(peerOttoShortcut[1] || undefined);
        return;
      }
    }
    setSending(true);
    try {
      const message = attachments.length > 0
        ? await window.otto.enterpriseMessageSend(member.id, content, attachments)
        : await window.otto.enterpriseMessageSend(member.id, content);
      setMessages((current) => [...current, message]);
      setDraft('');
      setAttachments([]);
      setAttachmentError('');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };

  const subtitle = [member.department, member.role].filter(Boolean).join(' · ') || member.username;
  const presenceLabel = member.ottoOnline ? '在线' : member.ottoLastSeenAt ? '最近在线' : '离线';
  const canSend = (draft.trim().length > 0 || attachments.length > 0)
    && !sending
    && !attaching;

  return (
    <div className="otto-direct-chat" role="dialog" aria-label={'与 ' + member.name + ' 聊天'}>
      <header className="otto-direct-chat__header">
        <div className="otto-direct-chat__identity">
          <div className="otto-direct-chat__avatar" aria-hidden="true">{memberInitials(member.name)}</div>
          <div className="otto-direct-chat__titleblock">
            <strong>{member.name}</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <div className="otto-direct-chat__header-actions">
          <span className={'otto-direct-chat__presence' + (member.ottoOnline ? ' is-online' : '')}>{presenceLabel}</span>
          <button
            type="button"
            className="otto-direct-chat__icon"
            onClick={onClose}
            aria-label="关闭聊天"
            title="关闭聊天"
          >
            ×
          </button>
        </div>
      </header>

      <div className="otto-direct-chat__actionbar" aria-label="Otto 协作操作">
        <button
          type="button"
          className="otto-direct-chat__otto"
          disabled={askingOwnOtto || !draft.trim() || attachments.length > 0}
          onClick={() => void askOtto(draft)}
          title={attachments.length > 0 ? '附件不会自动交给 Otto，请先发送或移除附件' : undefined}
        >
          {askingOwnOtto ? '询问中' : '问 Otto'}
        </button>
        <button
          type="button"
          className="otto-direct-chat__otto"
          disabled={askingPeerOtto || attachments.length > 0}
          onClick={() => void askPeerOtto(draft)}
          title={attachments.length > 0 ? '附件不会自动交给对方 Otto，请先发送或移除附件' : undefined}
        >
          问对方 Otto
        </button>
        {currentAccount ? (
          <div className="otto-direct-chat__a2a-menu">
            <button
              type="button"
              className="otto-direct-chat__plus"
              aria-label="更多 Otto 协作"
              aria-expanded={collaborationMenuOpen}
              onClick={() => setCollaborationMenuOpen((value) => !value)}
            >
              <IconPlus size={15} />
            </button>
            {collaborationMenuOpen ? (
              <div className="otto-direct-chat__a2a-popover" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCollaborationMenuOpen(false);
                    setConsultOpen(true);
                  }}
                >
                  <strong>双方 Otto 协商</strong>
                  <small>会议时间、合作计划与双方日程</small>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="otto-direct-chat__messages">
        {messages.length === 0 ? (
          <div className="otto-direct-chat__empty">
            <strong>还没有消息，开始聊聊吧。</strong>
            <span>可直接发送文字、图片、Word、PDF；需要整理上下文时可使用 Otto 协作。</span>
          </div>
        ) : messages.map((message) => {
          const mine = message.senderAccountId !== member.id;
          const messageAttachments = message.attachments || [];
          const content = displayDirectMessageContent(message.content);
          return (
            <article
              key={message.id}
              className={'otto-direct-chat__message' + (mine ? ' is-me' : ' is-peer')}
            >
              <div className="otto-direct-chat__message-meta">
                <span>{mine ? '我' : member.name}</span>
                {message.createdAt ? (
                  <time dateTime={message.createdAt}>{formatDirectMessageTime(message.createdAt)}</time>
                ) : null}
              </div>
              {content ? <div className="otto-direct-chat__bubble">{content}</div> : null}
              {messageAttachments.length > 0 ? (
                <div className="otto-direct-chat__message-attachments">
                  {messageAttachments.map((attachment) => (
                    <DirectMessageAttachmentCard key={attachment.id} attachment={attachment} />
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {error ? <div className="otto-direct-chat__error" role="alert">{error}</div> : null}
      <form
        className={'otto-direct-chat__composer' + (dragOver ? ' is-drag-over' : '')}
        onSubmit={send}
        onDragOver={(event) => {
          event.preventDefault();
          if (event.dataTransfer.types.includes('Files')) setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragOver(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void addBrowserFiles(Array.from(event.dataTransfer.files || []));
        }}
      >
        {attachments.length > 0 || attaching || attachmentError ? (
          <div className="otto-direct-chat__pending-attachments">
            {attachments.map((attachment) => {
              const key = attachment.fileName + ':' + attachment.size;
              const image = attachment.mimeType.startsWith('image/');
              return (
                <div className="otto-direct-chat__pending-attachment" key={key}>
                  {image ? (
                    <img
                      src={'data:' + attachment.mimeType + ';base64,' + attachment.data}
                      alt=""
                    />
                  ) : (
                    <span aria-hidden="true">
                      {directAttachmentTypeLabel(attachment.fileName, attachment.mimeType)}
                    </span>
                  )}
                  <span>
                    <strong title={attachment.fileName}>{attachment.fileName}</strong>
                    <small>{formatDirectAttachmentSize(attachment.size)}</small>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachments((current) => current.filter(
                        (item) => item.fileName + ':' + item.size !== key,
                      ));
                      setAttachmentError('');
                    }}
                    aria-label={'移除 ' + attachment.fileName}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {attaching ? <span className="otto-direct-chat__attachment-status">正在读取附件…</span> : null}
            {attachmentError ? (
              <span className="otto-direct-chat__attachment-error" role="alert">
                {attachmentError}
              </span>
            ) : null}
          </div>
        ) : null}
        <textarea
          value={draft}
          maxLength={4000}
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files || []);
            if (files.length > 0) {
              event.preventDefault();
              void addBrowserFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter'
              && !event.shiftKey
              && !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={dragOver ? '松开发送这些文件' : '输入消息，或拖入 Word、PDF、图片'}
          aria-label="消息内容"
        />
        <div className="otto-direct-chat__composer-footer">
          <div className="otto-direct-chat__composer-tools">
            <button
              type="button"
              className="otto-direct-chat__attach"
              onClick={() => void pickAttachments()}
              disabled={attaching || attachments.length >= DIRECT_MESSAGE_MAX_ATTACHMENTS}
              aria-label="添加文件或图片"
              title="添加图片、Word、PDF 或其它常用文件"
            >
              <IconPaperclip size={15} />
              <span>文件</span>
            </button>
            <span>
              {attachments.length > 0
                ? '已选 ' + attachments.length + '/6'
                : draft.trim().length > 0
                  ? draft.trim().length + '/4000'
                  : 'Enter 发送 · Shift+Enter 换行'}
            </span>
          </div>
          <button type="submit" disabled={!canSend}>{sending ? '发送中' : '发送'}</button>
        </div>
      </form>
      {consultOpen && currentAccount ? (
        <AtoaConsultDialog
          account={currentAccount}
          member={member}
          schedules={schedules}
          initialQuestion={draft}
          onClose={() => setConsultOpen(false)}
          onSent={(message) => {
            setMessages((current) => [...current, message]);
            setDraft('');
            setError('');
          }}
        />
      ) : null}
    </div>
  );
}
type Organization = NonNullable<
  ProductWorkspaceSnapshot['managerWorkspace']
>['organization'];

function DepartmentSection({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="otto-orgtree__department">
      <button
        type="button"
        className="otto-orgtree__department-name otto-orgtree__department-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <IconChevronDown
          size={11}
          className={'otto-orgtree__chevron' + (expanded ? '' : ' is-collapsed')}
        />
        <span>{name}</span>
      </button>
      {expanded ? children : null}
    </div>
  );
}

function normalizeChatKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function UnreadBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  const label = count > 99 ? '99+' : String(count);
  return (
    <span
      className="otto-orgtree__unread"
      aria-label={`${label} 条未读消息`}
      title={`${label} 条未读消息`}
    >
      {label}
    </span>
  );
}

function PresenceBadge({
  online,
  lastSeenAt,
}: {
  online?: boolean;
  lastSeenAt?: string | null;
}): React.JSX.Element | null {
  if (online === undefined && lastSeenAt === undefined) return null;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : Number.NaN;
  const recentlySeen = !online
    && Number.isFinite(lastSeenMs)
    && Date.now() - lastSeenMs <= 5 * 60_000;
  const label = online ? '在线' : recentlySeen ? '刚刚在线' : '离线';
  return (
    <span
      className={
        'otto-orgtree__presence'
        + (online ? ' is-online' : recentlySeen ? ' is-recent' : '')
      }
      title={lastSeenAt ? `${label} · ${new Date(lastSeenAt).toLocaleString('zh-CN')}` : label}
    >
      {label}
    </span>
  );
}

function CompanyBranch({
  companyId,
  organization,
  workspace,
  positionById,
  childrenByParent,
  chatMemberByWorkspaceKey,
  unreadCounts,
  onOpenChat,
}: {
  companyId: string;
  organization: Organization;
  workspace: ProductWorkspaceSnapshot;
  positionById: Map<string, Organization['positions'][number]>;
  childrenByParent: Map<string, string[]>;
  chatMemberByWorkspaceKey: Map<string, EnterpriseOrganizationView['members'][number]>;
  unreadCounts: EnterpriseUnreadCounts;
  onOpenChat: (member: EnterpriseOrganizationView['members'][number]) => void;
}): React.JSX.Element | null {
  const company = organization.companies.find((item) => item.id === companyId);
  if (!company) return null;
  const departments = organization.departments.filter((item) => item.companyId === company.id);
  const childIds = childrenByParent.get(company.id) ?? [];

  return (
    <div className="otto-orgtree__company-branch">
      <div className="otto-orgtree__company-node">{company.name}</div>
      <div className="otto-orgtree__company-content">
        {departments.map((department) => {
          const members = workspace.members.filter(
            (member) => member.companyId === company.id && member.departmentId === department.id,
          );
          const positions = organization.positions.filter(
            (position) => position.departmentId === department.id,
          );
          return (
            <DepartmentSection key={department.id} name={department.name}>
              {members.map((member) => {
                const chatMember = chatMemberByWorkspaceKey.get(normalizeChatKey(member.userId))
                  ?? chatMemberByWorkspaceKey.get(normalizeChatKey(member.displayName));
                const content = (
                  <>
                    <span>{member.displayName}</span>
                    <span>{member.positionId ? positionById.get(member.positionId)?.title ?? '成员' : '成员'}</span>
                  </>
                );
                return chatMember ? (
                  <button
                    key={member.userId}
                    type="button"
                    className="otto-orgtree__member otto-orgtree__member-button"
                    onClick={() => onOpenChat(chatMember)}
                  >
                    {content}
                    <PresenceBadge
                      online={chatMember.ottoOnline}
                      lastSeenAt={chatMember.ottoLastSeenAt}
                    />
                    <UnreadBadge count={unreadCounts[`enterprise:message:${chatMember.id}`] ?? 0} />
                  </button>
                ) : (
                  <div key={member.userId} className="otto-orgtree__member">
                    {content}
                  </div>
                );
              })}
              {members.length === 0
                ? positions.map((position) => (
                    <div key={position.id} className="otto-orgtree__vacant">
                      {position.title} · 待加入
                    </div>
                  ))
                : null}
            </DepartmentSection>
          );
        })}
        {departments.length === 0 ? (
          <div className="otto-orgtree__vacant">组织详情等待企业服务同步</div>
        ) : null}
        {childIds.map((childId) => (
          <CompanyBranch
            key={childId}
            companyId={childId}
            organization={organization}
            workspace={workspace}
            positionById={positionById}
            childrenByParent={childrenByParent}
            chatMemberByWorkspaceKey={chatMemberByWorkspaceKey}
            unreadCounts={unreadCounts}
            onOpenChat={onOpenChat}
          />
        ))}
      </div>
    </div>
  );
}
