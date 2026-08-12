export const ENTERPRISE_TRAY_POPOVER_WIDTH = 420;
export const ENTERPRISE_TRAY_POPOVER_MAX_CONTACTS = 5;

const ATOA_REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
const ATOA_RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';

export interface EnterpriseTrayContact {
  accountId: string;
  name: string;
  preview: string;
  count: number;
  createdAt: string;
}

/** 非企业消息的托盘提醒摘要（园区工单等）。 */
export interface EnterpriseTraySummarySection {
  kind: 'collaboration' | 'park-ticket' | 'other';
  label: string;
  count: number;
  preview: string;
}

interface EnterpriseUnreadMessageLike {
  senderAccountId: string;
  senderName: string;
  preview: string;
  createdAt: string;
  count?: number;
}

interface RectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SizeLike {
  width: number;
  height: number;
}

export function parseEnterpriseMessageTimestamp(value: string): number {
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
    trimmed,
  )
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePreview(value: string): string {
  if (value.startsWith(ATOA_REQUEST_PREFIX)) return '对方正在请求你的 Otto 协作';
  if (value.startsWith(ATOA_RESPONSE_PREFIX)) return '对方 Otto 已回复你的企业协作请求';
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '发来一条新消息';
  return compact.length > 140 ? `${compact.slice(0, 137)}…` : compact;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

function avatarTone(accountId: string): number {
  let hash = 0;
  for (const character of accountId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

function avatarText(name: string): string {
  return Array.from(name.trim())[0] || 'O';
}

function formatMessageTime(createdAt: string, now: number): string {
  const created = parseEnterpriseMessageTimestamp(createdAt);
  if (!created) return '';
  const elapsed = Math.max(0, now - created);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
  if (elapsed < 48 * 60 * 60_000) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(created));
}

export function summarizeEnterpriseTrayContacts(
  items: readonly EnterpriseUnreadMessageLike[],
): EnterpriseTrayContact[] {
  const byAccount = new Map<string, EnterpriseTrayContact>();
  for (const item of items) {
    const current = byAccount.get(item.senderAccountId);
    if (!current) {
      byAccount.set(item.senderAccountId, {
        accountId: item.senderAccountId,
        name: item.senderName.trim() || '企业联系人',
        preview: normalizePreview(item.preview),
        count: Math.max(1, Math.floor(item.count ?? 1)),
        createdAt: item.createdAt,
      });
      continue;
    }
    current.count += Math.max(1, Math.floor(item.count ?? 1));
    if (
      parseEnterpriseMessageTimestamp(item.createdAt) >=
      parseEnterpriseMessageTimestamp(current.createdAt)
    ) {
      current.name = item.senderName.trim() || current.name;
      current.preview = normalizePreview(item.preview);
      current.createdAt = item.createdAt;
    }
  }
  return [...byAccount.values()].sort(
    (left, right) =>
      parseEnterpriseMessageTimestamp(right.createdAt) -
      parseEnterpriseMessageTimestamp(left.createdAt),
  );
}

export function enterpriseTrayPopoverHeight(contactCount: number): number {
  const visibleCount = Math.min(
    ENTERPRISE_TRAY_POPOVER_MAX_CONTACTS,
    Math.max(1, Math.floor(contactCount)),
  );
  return Math.min(526, 142 + visibleCount * 76);
}

export function positionEnterpriseTrayPopover(
  trayBounds: RectangleLike,
  workArea: RectangleLike,
  windowSize: SizeLike,
): { x: number; y: number } {
  const margin = 12;
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  const centeredX = Math.round(trayBounds.x + trayBounds.width / 2 - windowSize.width / 2);
  const x = Math.min(
    workRight - windowSize.width - margin,
    Math.max(workArea.x + margin, centeredX),
  );
  const aboveTray = Math.round(trayBounds.y - windowSize.height - margin);
  const belowTray = Math.round(trayBounds.y + trayBounds.height + margin);
  const y = aboveTray >= workArea.y + margin
    ? aboveTray
    : Math.min(workBottom - windowSize.height - margin, belowTray);
  return { x, y };
}

export function renderEnterpriseTrayPopoverHtml(
  contacts: readonly EnterpriseTrayContact[],
  options: {
    now?: number;
    summarySections?: readonly EnterpriseTraySummarySection[];
    otherUnreadCount?: number;
  } = {},
): string {
  const now = options.now ?? Date.now();
  const summarySections = options.summarySections ?? [];
  const otherUnreadCount = options.otherUnreadCount ?? 0;
  const enterpriseUnread = contacts.reduce((total, contact) => total + contact.count, 0);
  const totalUnread = enterpriseUnread + otherUnreadCount;
  const visibleContacts = contacts.slice(0, ENTERPRISE_TRAY_POPOVER_MAX_CONTACTS);
  const hiddenContacts = Math.max(0, contacts.length - visibleContacts.length);
  const enterpriseRows = visibleContacts.length > 0
    ? visibleContacts.map((contact) => {
      const name = escapeHtml(contact.name);
      const preview = escapeHtml(contact.preview);
      const time = escapeHtml(formatMessageTime(contact.createdAt, now));
      const href = `otto-tray://message/${encodeURIComponent(contact.accountId)}`;
      const count = contact.count > 99 ? '99+' : String(contact.count);
      return `
        <a class="message" href="${href}" aria-label="打开与 ${name} 的未读会话">
          <span class="avatar tone-${avatarTone(contact.accountId)}">${escapeHtml(avatarText(contact.name))}</span>
          <span class="message-body">
            <span class="message-heading">
              <strong>${name}</strong>
              <time>${time}</time>
            </span>
            <span class="preview">${preview}</span>
          </span>
          <span class="unread-count" aria-label="${count} 条未读">${count}</span>
          <span class="chevron" aria-hidden="true">›</span>
        </a>`;
    }).join('')
    : '';

  const enterpriseSectionHeader = enterpriseUnread > 0
    ? `<div class="section-title">企业消息 <span>${enterpriseUnread} 条</span></div>`
    : '';

  const summaryRows = summarySections.length > 0
    ? summarySections.map((section) => {
      const href = section.kind === 'park-ticket'
        ? 'otto-tray://park'
        : 'otto-tray://open';
      return `
        <a class="message summary-item" href="${href}" aria-label="${section.label} ${section.count} 条">
          <span class="avatar tone-3">${escapeHtml(section.label.slice(0, 1))}</span>
          <span class="message-body">
            <span class="message-heading">
              <strong>${escapeHtml(section.label)}</strong>
            </span>
            <span class="preview">${escapeHtml(section.preview)}</span>
          </span>
          <span class="unread-count" aria-label="${section.count} 条未读">${section.count > 99 ? '99+' : String(section.count)}</span>
          <span class="chevron" aria-hidden="true">›</span>
        </a>`;
    }).join('')
    : '';

  const hasContent = enterpriseRows || summaryRows;
  const rows = hasContent
    ? `${enterpriseSectionHeader}${enterpriseRows}${summaryRows}`
    : `
      <div class="empty">
        <span class="empty-icon">✓</span>
        <strong>消息都已读完</strong>
        <span>有新消息时会在这里显示发送人和内容摘要</span>
      </div>`;

  const hiddenLabel = hiddenContacts > 0
    ? `<span class="more">另有 ${hiddenContacts} 位联系人</span>`
    : (hasContent ? '<span class="privacy"><i></i>仅展示消息摘要</span>' : '');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
  <meta name="color-scheme" content="light dark">
  <title>Otto 未读提醒</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", sans-serif;
      --surface: rgba(250, 251, 255, .98);
      --surface-strong: #fff;
      --text: #171a26;
      --muted: #747b8e;
      --line: rgba(70, 77, 105, .11);
      --accent: #5b64f4;
      --accent-soft: rgba(91, 100, 244, .11);
      --danger: #ef3f5f;
      --shadow: 0 22px 65px rgba(22, 29, 58, .24), 0 4px 16px rgba(22, 29, 58, .12);
    }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    body {
      padding: 8px;
      color: var(--text);
      background: transparent;
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }
    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      width: 100%;
      height: 100%;
      min-width: 0;
      overflow: hidden;
      border: 1px solid rgba(91, 100, 244, .12);
      border-radius: 20px;
      background: var(--surface);
      box-shadow: var(--shadow);
      backdrop-filter: blur(24px) saturate(1.18);
    }
    header {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-width: 0;
      min-height: 72px;
      padding: 15px 102px 13px 18px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(91, 100, 244, .10), rgba(124, 92, 246, .025) 60%);
    }
    .title { display: flex; flex: 1 1 0; align-items: center; gap: 11px; min-width: 0; }
    .logo {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 13px;
      color: #fff;
      font-size: 17px;
      font-weight: 800;
      letter-spacing: -.04em;
      background: linear-gradient(145deg, #6d72ff, #7654dc);
      box-shadow: 0 8px 20px rgba(91, 100, 244, .28);
    }
    .title-copy { display: grid; gap: 2px; min-width: 0; }
    .eyebrow { color: var(--accent); font-size: 9px; font-weight: 800; letter-spacing: .14em; }
    h1 { margin: 0; font-size: 17px; line-height: 1.2; letter-spacing: -.02em; }
    h1 span { margin-left: 5px; color: var(--muted); font-size: 12px; font-weight: 650; }
    .open-all {
      position: absolute;
      top: 21px;
      right: 18px;
      flex: 0 0 auto;
      padding: 7px 10px;
      border: 1px solid rgba(91, 100, 244, .18);
      border-radius: 9px;
      color: var(--accent);
      background: var(--accent-soft);
      font-size: 11px;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
      transition: transform .16s ease, background .16s ease;
    }
    .open-all:hover { transform: translateY(-1px); background: rgba(91, 100, 244, .17); }
    main { min-width: 0; min-height: 0; padding: 7px; overflow: auto; scrollbar-width: none; }
    main::-webkit-scrollbar { display: none; }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 4px 2px;
      color: var(--muted);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .section-title span { font-weight: 500; }
    .message {
      position: relative;
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      width: 100%;
      min-width: 0;
      min-height: 70px;
      padding: 9px 46px 9px 10px;
      border: 1px solid transparent;
      border-radius: 14px;
      color: inherit;
      text-decoration: none;
      transition: transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease;
    }
    .message + .message { margin-top: 2px; }
    .message:hover {
      z-index: 1;
      transform: translateY(-1px);
      border-color: rgba(91, 100, 244, .14);
      background: var(--surface-strong);
      box-shadow: 0 7px 18px rgba(35, 42, 76, .08);
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 2px solid rgba(255, 255, 255, .72);
      border-radius: 14px;
      color: #fff;
      font-size: 16px;
      font-weight: 760;
      box-shadow: 0 4px 11px rgba(31, 38, 70, .13);
    }
    .tone-0 { background: linear-gradient(145deg, #6675f6, #8057d9); }
    .tone-1 { background: linear-gradient(145deg, #15a6a1, #087f96); }
    .tone-2 { background: linear-gradient(145deg, #f08b4a, #d85b73); }
    .tone-3 { background: linear-gradient(145deg, #4f9ce9, #5365d8); }
    .tone-4 { background: linear-gradient(145deg, #6ba85a, #329082); }
    .tone-5 { background: linear-gradient(145deg, #bd65d4, #7658dd); }
    .message-body { display: grid; gap: 5px; min-width: 0; }
    .message-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .message-heading strong { overflow: hidden; font-size: 13px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
    time { flex: none; color: var(--muted); font-size: 9px; }
    .preview {
      display: -webkit-box;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow-wrap: anywhere;
    }
    .unread-count {
      position: absolute;
      top: 50%;
      right: 12px;
      transform: translateY(-50%);
      display: grid;
      place-items: center;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      border: 2px solid var(--surface-strong);
      border-radius: 999px;
      color: #fff;
      background: linear-gradient(145deg, #f04b68, #dc294e);
      box-shadow: 0 4px 10px rgba(239, 63, 95, .24);
      font-size: 9px;
      font-weight: 780;
    }
    .chevron { display: none; }
    .empty { display: grid; place-items: center; align-content: center; height: 100%; min-height: 92px; gap: 6px; text-align: center; }
    .empty-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; color: #fff; background: linear-gradient(145deg, #35b88a, #229a77); }
    .empty strong { font-size: 13px; }
    .empty > span:last-child { color: var(--muted); font-size: 10px; }
    footer {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
      min-height: 42px;
      padding: 9px 86px 10px 17px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 9px;
    }
    .privacy, .more { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .privacy i { width: 6px; height: 6px; border-radius: 50%; background: #31aa82; box-shadow: 0 0 0 4px rgba(49, 170, 130, .10); }
    .footer-link { position: absolute; top: 50%; right: 17px; transform: translateY(-50%); color: var(--accent); font-weight: 720; text-decoration: none; white-space: nowrap; }
    @media (prefers-color-scheme: dark) {
      :root {
        --surface: rgba(27, 29, 39, .98);
        --surface-strong: #232632;
        --text: #f3f4fa;
        --muted: #9ba2b5;
        --line: rgba(211, 216, 239, .10);
        --accent: #9da3ff;
        --accent-soft: rgba(124, 132, 255, .14);
        --shadow: 0 24px 70px rgba(0, 0, 0, .48), 0 5px 18px rgba(0, 0, 0, .28);
      }
      .shell { border-color: rgba(157, 163, 255, .13); }
      header { background: linear-gradient(135deg, rgba(101, 108, 240, .16), rgba(79, 58, 133, .04) 65%); }
      .avatar { border-color: rgba(255, 255, 255, .12); }
      .unread-count { border-color: #232632; }
    }
  </style>
</head>
<body>
  <section class="shell" aria-label="Otto 未读企业消息">
    <header>
      <div class="title">
        <span class="logo">O</span>
        <span class="title-copy">
          <span class="eyebrow">OTTO NOTIFICATIONS</span>
          <h1>未读提醒 <span>${totalUnread} 条</span></h1>
        </span>
      </div>
      <a class="open-all" href="otto-tray://open">打开 Otto</a>
    </header>
    <main>${rows}
    </main>
    <footer>
      ${hiddenLabel}
      <a class="footer-link" href="otto-tray://open">查看全部 ›</a>
    </footer>
  </section>
</body>
</html>`;
}
