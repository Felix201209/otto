/**
 * @license
 * Copyright 2026 Felix
 * https://github.com/Felix201209/otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 飞书消息网关 — 基于 @larksuiteoapi/node-sdk WSClient 的长连接收发消息
 *
 * SDK 内部处理：
 *   - 两步握手：POST /callback/ws/endpoint 获取动态 WS URL → 建立 WebSocket
 *   - Protobuf 帧编码/解码 + 分片合并（seq/sum）
 *   - 控制帧（ping/pong）与数据帧（事件）分离
 *   - 自动重连（指数退避）
 *   - EventDispatcher 事件分发
 *
 * 收到消息 → 调 onMessage 回调 → 发回复走 REST API
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dlog, dwarn, derror } from './logger.js';
import { optimizeMarkdownStyle } from './markdown-style.js';
import { detectImageExtension } from './image-type.js';
import { loadCredentials, isSenderAuthorized } from './credentials.js';

/**
 * 下载资源的体积上限（字节）。防止恶意/异常的超大文件把整个进程 OOM。
 * 飞书图片/文件资源正常不会超过这个量级。
 */
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * 净化飞书资源 key（imageKey / fileKey），仅保留安全字符，杜绝路径穿越。
 *
 * 飞书的 image_key / file_key 形如 `img_v3_...` / `file_v3_...`，本身只含
 * 字母数字、下划线、连字符。但这些值来自外部事件负载、不可信，若被拼进
 * 落盘文件名（`feishu-image-${imageKey}`），含 `..`/`/` 的恶意 key 会借
 * path.join 写到目标目录之外。这里把任何非 `[A-Za-z0-9._-]` 字符替换为
 * `_`，并去掉前导点，确保结果只能是单层、安全的文件名片段。
 */
function sanitizeResourceKey(key: string): string {
  const cleaned = String(key || '').replace(/[^A-Za-z0-9._-]/g, '_');
  // 去掉前导点，避免 `..` / `.foo` 之类（path.join 不会折叠 `..`）。
  const noLeadingDots = cleaned.replace(/^\.+/, '');
  return noLeadingDots || 'resource';
}

/**
 * 按 Unicode 码点（而非 UTF-16 码元）截断字符串，避免把 emoji 等
 * 代理对（surrogate pair）从中间劈开产生乱码。
 */
function truncateByCodePoints(text: string, maxCodePoints: number): string {
  const cp = Array.from(text);
  if (cp.length <= maxCodePoints) return text;
  return cp.slice(0, maxCodePoints).join('');
}

const API_BASE_URLS: Record<string, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

type FeishuCardPrimitive = string | number | boolean | null;
export type FeishuCardValue =
  | FeishuCardPrimitive
  | FeishuCardObject
  | FeishuCardValue[];
export type FeishuCardObject = {
  [key: string]: FeishuCardValue | undefined;
};
type FeishuCardElement = FeishuCardObject;

type FeishuPostElement = {
  tag: string;
  text?: string;
  href?: string;
  style?: string[];
  image_key?: string;
};
type FeishuPostParagraph = FeishuPostElement[];

type FeishuApiResponse<
  TData extends Record<string, unknown> = Record<string, unknown>,
> = {
  code?: number;
  msg?: string;
  data?: TData;
  tenant_access_token?: string;
  expire?: number;
  [key: string]: unknown;
};

type FeishuWsClient = {
  start(options: { eventDispatcher: unknown }): Promise<void>;
  stop?: () => void;
};

type MergedForwardItem = {
  message_id?: string;
  upper_message_id?: string;
  create_time?: string | number;
  msg_type?: string;
  sender?: { id?: string };
  body?: { content?: string };
  [key: string]: unknown;
};

type FeishuIncomingMessage = {
  message_id?: string;
  message_type?: string;
  content?: string;
  chat_id?: string;
  chat_type?: string;
  [key: string]: unknown;
};

type FeishuIncomingEvent = {
  message?: FeishuIncomingMessage;
  sender?: {
    sender_id?: { open_id?: string };
    open_id?: string;
  };
  mentions?: Array<{ key?: string; open_id?: string }>;
  conversation?: { chat_id?: string };
  [key: string]: unknown;
};

type FeishuIncomingPayload = {
  event?: FeishuIncomingEvent;
  header?: { create_time?: string | number };
  [key: string]: unknown;
};

type FeishuCardActionPayload = {
  event?: {
    action?: FeishuCardAction;
    operator?: { open_id?: string };
    sender?: { sender_id?: { open_id?: string } };
    context?: { open_message_id?: string; open_chat_id?: string };
    message_id?: string;
    chat_id?: string;
  };
  action?: FeishuCardAction;
  operator?: { open_id?: string };
  context?: { open_message_id?: string };
  message_id?: string;
  [key: string]: unknown;
};

type FeishuCardAction = {
  value?: unknown;
  option?: unknown;
  form_value?: Record<string, unknown>;
  [key: string]: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function responseDataString(
  data: FeishuApiResponse,
  key: string,
): string | null {
  return (asRecord(data.data)?.[key] as string | undefined) || null;
}

/**
 * 卡片交互（等待用户点击/提交）的默认超时时间（毫秒）。
 *
 * 飞书侧无法像 CLI 终端那样真正无限期等待用户（常驻 Promise 会占内存、上游
 * AI 任务会僵死），因此给一个很长但有限的默认值：30 分钟。调用方可按需覆盖。
 */
const DEFAULT_CARD_ACTION_TIMEOUT_MS = 30 * 60 * 1000;

export interface FeishuMessage {
  text: string;
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | 'topic';
  senderOpenId: string;
  mentions: Array<{ key: string; openId: string }>;
  messageType: string;
  /** 待下载的图片信息（不在 gateway 中直接下载，留给 feishuCommand 在确定 projectRoot 后下载到 .otto/clipboard/） */
  pendingImages?: Array<{ imageKey: string; placeholder: string }>;
  /** 待下载的文件信息（不在 gateway 中直接下载，留给 feishuCommand 在确定 projectRoot 后下载到 .otto/inbound/） */
  pendingFiles?: Array<{ fileKey: string; fileName: string; placeholder: string }>;
  /** 消息创建时间（毫秒时间戳），来自飞书事件 header.create_time，用于陈旧消息过滤 */
  createTime?: number;
}

export type OnMessageCallback = (msg: FeishuMessage) => Promise<string | null>;

/** 卡片按钮点击回调的数据 */
export interface CardActionData {
  /** 用户点击的按钮 value */
  value: string;
  /** 用户的 open_id */
  openId: string;
  /** 触发回调的消息 message_id */
  messageId: string;
  /**
   * 表单提交时（form_action.type = 'submit'）携带的所有具名组件的值。
   * 键为组件的 `name`，值为单选选中的 value（string）、复选选中的 value 数组（string[]）或输入框文本（string）。
   * 非表单（普通按钮点击）时为 undefined。
   */
  formValue?: Record<string, string | string[]>;
}

export type OnCardActionCallback = (data: CardActionData) => void;

/** 单个问题的选项 */
export interface FeishuQuestionOption {
  label: string;
  description?: string;
}

/** 提交给表单卡片的单个问题 */
export interface FeishuQuestion {
  /** 问题正文 */
  question: string;
  /** 短标题（可选，显示在下拉框 label 上） */
  header?: string;
  /** 候选项（2-4 个） */
  options: FeishuQuestionOption[];
  /** 是否允许多选（保留字段，当前下拉为单选 + 自定义填空） */
  multiSelect?: boolean;
}

/** 表单卡片回答结果：key 为问题文本，value 为用户的最终答案文本 */
export type FeishuQuestionAnswers = Record<string, string>;

/** 飞书卡片页脚指标 */
export interface FeishuFooterMetrics {
  status?: string; // 例如: "Completed", "Error", "Processing"
  elapsedMs?: number; // 耗时 (毫秒)
  tokens?: { input: number; output: number }; // Token 使用量
  contextPercentage?: number; // 上下文剩余百分比
  model?: string; // 使用的模型名称
  cacheRead?: number; // 缓存读取 tokens 数
  cacheHitRate?: number; // 缓存命中百分比 (0-100)
  credits?: number; // 扣减点数
}

/** CardKit 2.0 流式卡片中正文的固定 element_id */
export const CARDKIT_STREAMING_ELEMENT_ID = 'streaming_content';

/** CardKit 2.0 流式卡片中页脚的固定 element_id */
export const CARDKIT_FOOTER_ELEMENT_ID = 'footer_content';

/** CardKit 2.0 流式卡片中 loading 图标的固定 element_id（终态由整卡覆盖移除） */
export const CARDKIT_LOADING_ELEMENT_ID = 'loading_icon';

/**
 * 全局开关：是否启用 CardKit 2.0 流式卡片。
 *
 * 当前 CardKit 2.0 在生产环境表现不稳定（创建/推送偶发 5xx、卡片渲染不一致），
 * 默认禁用 CardKit 2.0，统一走老版带标题的交互卡片（sendCard + updateCard）。
 * 设置环境变量 OTTO_FEISHU_CARDKIT_V2=1 可临时启用（仅供测试 / 开发）。
 * 向后兼容旧环境变量 OTTO_FEISHU_CARDKIT_V2。
 */
export function isCardKitV2Enabled(): boolean {
  const v =
    process.env['OTTO_FEISHU_CARDKIT_V2'] ??
    process.env['OTTO_FEISHU_CARDKIT_V2'];
  return v === '1';
}

/**
 * 飞书内置 loading 动画 img_key（与 openclaw-lark 插件一致）。
 *
 * 这个 img_key 是飞书官方提供给 streaming 卡片的转圈图标资源。
 * 只要 streaming_mode = true 且卡片里有这个图标元素，客户端就会自动渲染打字机
 * 加载视觉，不需要再在正文里写"思考中..."、"运行工具中..."之类的提示尾巴。
 */
const CARDKIT_LOADING_IMG_KEY = 'img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg';

/**
 * 格式化毫秒数为人类可读的持续时间字符串。
 */
function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * 把 footer metrics 渲染为单行 markdown 文本，供 CardKit 2.0 的 footer
 * markdown 元素直接作为 content 使用。
 */
export function renderFooterMarkdown(metrics: FeishuFooterMetrics): string {
  const parts: string[] = [];
  let isError = false;

  if (metrics.status) {
    let statusText = metrics.status;
    const lower = metrics.status.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('出错') || lower.includes('失败')) {
      statusText = `<font color='red'>${metrics.status}</font>`;
      isError = true;
    } else if (lower.includes('processing') || lower.includes('thinking') || lower.includes('思考中') || lower.includes('运行')) {
      statusText = `<font color='grey'>${metrics.status}</font>`;
    } else {
      statusText = `<font color='green'>${metrics.status}</font>`;
    }
    parts.push(statusText);
  }

  if (metrics.elapsedMs != null) {
    parts.push(`耗时 ${formatElapsed(metrics.elapsedMs)}`);
  }

  if (metrics.model) {
    parts.push(metrics.model);
  }

  if (metrics.tokens) {
    parts.push(`↑${metrics.tokens.input.toLocaleString()} ↓${metrics.tokens.output.toLocaleString()}`);
  }

  if (metrics.cacheRead != null && metrics.cacheRead > 0) {
    let cacheText = `缓存读取 ${metrics.cacheRead.toLocaleString()}`;
    if (metrics.cacheHitRate != null && metrics.cacheHitRate > 0) {
      cacheText += ` (${metrics.cacheHitRate.toFixed(1)}%)`;
    }
    parts.push(cacheText);
  }

  if (metrics.contextPercentage != null) {
    const remainingPercentage = Math.max(0, 100 - metrics.contextPercentage);
    parts.push(`上下文剩余 ${remainingPercentage.toFixed(0)}%`);
  }

  if (parts.length === 0) return '';
  const text = parts.join(' · ');
  return isError ? `<font color='red'>${text}</font>` : text;
}

/**
 * 构建一个标准飞书卡片页脚元素数组（旧版 1.x 卡片用）。
 * 新版 CardKit 2.0 的卡片直接走 renderFooterMarkdown + 单 markdown 元素。
 */
function buildFeishuFooterElements(metrics: FeishuFooterMetrics): FeishuCardElement[] {
  const content = renderFooterMarkdown(metrics);
  if (!content) return [];
  return [
    {
      tag: 'hr',
    },
    {
      tag: 'markdown',
      content,
    },
  ];
}

/**
 * 构建 CardKit 2.0 流式起始卡片（schema 2.0）。
 *
 * 包含：
 *   - 一个 markdown 元素（element_id=streaming_content）作为流式正文容器
 *   - 一个 markdown 元素（element_id=footer_content）作为可独立流式更新的页脚
 *   - 一个 loading 图标元素（element_id=loading_icon），streaming_mode 期间自动转圈
 *
 * 说明：飞书 CardKit 2.0 的流式打字机效果，必须满足
 *   1) config.streaming_mode = true
 *   2) 通过 cardkit.v1.cardElement.content() 接口（PUT 增量）只更新某个 element
 *   3) 调用 sequence 单调递增
 *   4) loading_icon 元素的存在让客户端显示加载动画 — 终态用 card.update 整卡
 *      覆盖时不再带这个元素，动画即自动消失（不需要主动 PATCH 移除）
 */
export function buildCardKitStreamingCard(initialContent: string = '', initialFooter: string = ''): FeishuCardObject {
  const elements: FeishuCardElement[] = [
    {
      tag: 'markdown',
      element_id: CARDKIT_STREAMING_ELEMENT_ID,
      content: initialContent ? optimizeMarkdownStyle(initialContent, 2) : ' ',
      text_align: 'left',
      text_size: 'normal_v2',
    },
    // loading 转圈图标 — 与 openclaw-lark 一致
    {
      tag: 'markdown',
      element_id: CARDKIT_LOADING_ELEMENT_ID,
      content: ' ',
      icon: {
        tag: 'custom_icon',
        img_key: CARDKIT_LOADING_IMG_KEY,
        size: '16px 16px',
      },
    },
  ];
  if (initialFooter) {
    elements.push({
      tag: 'markdown',
      element_id: CARDKIT_FOOTER_ELEMENT_ID,
      content: initialFooter,
      text_size: 'notation',
    });
  } else {
    // 占位 footer，方便后续 streamCardElement 直接更新
    elements.push({
      tag: 'markdown',
      element_id: CARDKIT_FOOTER_ELEMENT_ID,
      content: ' ',
      text_size: 'notation',
    });
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: {
        content: 'Processing...',
        i18n_content: { zh_cn: '处理中...', en_us: 'Processing...' },
      },
    },
    body: { elements },
  };
}

/**
 * 构建 CardKit 2.0 终态卡片（streaming_mode 关闭后用 card.update 整卡覆盖）。
 */
export function buildCardKitFinalCard(content: string, footerMetrics?: FeishuFooterMetrics, headerTitle?: string): FeishuCardObject {
  const elements: FeishuCardElement[] = [
    {
      tag: 'markdown',
      element_id: CARDKIT_STREAMING_ELEMENT_ID,
      content: content ? optimizeMarkdownStyle(content, 2) : ' ',
      text_align: 'left',
      text_size: 'normal_v2',
    },
  ];

  const footerContent = footerMetrics ? renderFooterMarkdown(footerMetrics) : '';
  if (footerContent) {
    elements.push({
      tag: 'markdown',
      element_id: CARDKIT_FOOTER_ELEMENT_ID,
      content: footerContent,
      text_size: 'notation',
    });
  }

  // 用文本前 120 字符做 feed summary（去掉 markdown 符号）
  // 按码点截断，避免把 emoji 等代理对从中间劈开。
  const summaryText = truncateByCodePoints(content.replace(/[*_`#>[\]()~]/g, '').trim(), 120) || 'Done';

  const card: FeishuCardObject = {
    schema: '2.0',
    config: {
      streaming_mode: false,
      summary: { content: summaryText },
    },
    body: { elements },
  };

  if (headerTitle) {
    card.header = {
      title: { tag: 'plain_text', content: headerTitle },
      template: 'blue',
    };
  }
  return card;
}

// ---------------------------------------------------------------------------
// 跨进程连接互斥锁（同一 appId 全机只允许一个进程建立飞书长连接）
//
// 背景：进程内去重表（processedMessages / inFlightMessages）只在单进程内生效。
// server 侧 FeishuAdapter（OTTO_FEISHU_ENABLED=1）与 cli 侧 daemon 若同时对
// 同一 appId connect，每条飞书消息会被两个进程各处理一遍、回复两遍。
// 因此 connect() 前必须先按 appId 拿到 ~/.otto-user/ 下的锁文件（O_EXCL 原子
// 创建，内容含 pid + startedAt）；持有者已死（stale）则接管，持有者存活则
// fail-loud 拒绝连接。
// ---------------------------------------------------------------------------

/** 连接互斥锁存放目录（与凭证同在 ~/.otto-user/；OTTO_FEISHU_LOCK_DIR 仅供测试隔离）。 */
function gatewayLockDir(): string {
  return process.env['OTTO_FEISHU_LOCK_DIR'] || path.join(os.homedir(), '.otto-user');
}

/** 某 appId 的连接锁文件路径（appId 经净化后拼入文件名，杜绝路径穿越）。 */
export function feishuGatewayLockPath(appId: string, dir = gatewayLockDir()): string {
  return path.join(dir, `feishu-gateway-${sanitizeResourceKey(appId)}.lock`);
}

/** 拿不到连接锁（另一存活进程持有）时抛出，调用方可据此提示用户。 */
export class FeishuGatewayLockError extends Error {
  constructor(
    message: string,
    readonly holderPid: number,
  ) {
    super(message);
    this.name = 'FeishuGatewayLockError';
  }
}

/** 连接锁句柄：release 幂等，只删自己写入的锁文件。 */
export interface FeishuGatewayLockHandle {
  readonly path: string;
  release(): void;
}

/** 读取锁文件里的持有者信息；文件缺失/损坏返回 null（视为可接管）。 */
function readLockHolder(lockPath: string): { pid: number; startedAt?: number } | null {
  try {
    const obj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pid = Number(obj?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const startedAt = Number(obj?.startedAt);
    return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : undefined };
  } catch {
    return null;
  }
}

/** 进程存活探测（signal 0；EPERM = 存在但无权限，也算存活）。 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * 按 appId 获取跨进程连接锁。
 *
 *   - O_EXCL 原子创建锁文件，内容 { pid, startedAt }；
 *   - 已存在且持有者存活（且不是自己）→ 抛 {@link FeishuGatewayLockError}；
 *   - 已存在但持有者已死 / 文件损坏 / 持有者就是本进程（残留）→ 接管（删旧重建）；
 *   - 进程正常退出时兜底释放（异常被杀由下一次的 stale 接管收尾）。
 *
 * @param opts.dir / opts.pid / opts.isPidAlive 仅供测试注入。
 */
export function acquireFeishuGatewayLock(
  appId: string,
  opts: { dir?: string; pid?: number; isPidAlive?: (pid: number) => boolean } = {},
): FeishuGatewayLockHandle {
  const dir = opts.dir ?? gatewayLockDir();
  const pid = opts.pid ?? process.pid;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const lockPath = feishuGatewayLockPath(appId, dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 最多两轮：首轮 EEXIST → 判定 stale 接管后重试一轮；再失败视为竞争冲突。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600); // O_EXCL：原子创建，已存在则抛 EEXIST
      fs.writeSync(fd, JSON.stringify({ pid, startedAt: Date.now() }));
      fs.closeSync(fd);
      return makeLockHandle(lockPath, pid);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      const holder = readLockHolder(lockPath);
      if (holder && holder.pid !== pid && isPidAlive(holder.pid)) {
        throw new FeishuGatewayLockError(
          `另一进程 (pid ${holder.pid}) 已持有该飞书应用 (${appId}) 的连接锁，拒绝重复连接` +
            `（两个进程同时连同一 appId 会导致每条消息被处理/回复两遍）。` +
            `若确认该进程已不再服务飞书，请先停掉它（如 otto feishu daemon stop）后重试。`,
          holder.pid,
        );
      }
      // stale：持有者已死 / 锁文件损坏 / 本进程残留 → 接管（删掉后重试原子创建）。
      dlog(`[Feishu] 接管 stale 连接锁：${lockPath}（原持有者 pid=${holder?.pid ?? '未知'}）`);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // 已被别的进程抢先清掉也无妨，下一轮重试见分晓。
      }
    }
  }
  throw new FeishuGatewayLockError(
    `飞书连接锁竞争冲突（${lockPath}），本次放弃连接，请稍后重试。`,
    -1,
  );
}

/** 构造锁句柄：release 幂等；进程正常退出时兜底释放（best effort）。 */
function makeLockHandle(lockPath: string, pid: number): FeishuGatewayLockHandle {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      // 只删自己写的锁：释放前校验文件里的 pid 仍是自己（防误删接管者的新锁）。
      const holder = readLockHolder(lockPath);
      if (holder && holder.pid === pid) fs.unlinkSync(lockPath);
    } catch {
      // best effort：删不掉留给下一次 stale 接管。
    }
  };
  process.once('exit', release);
  return { path: lockPath, release };
}

// ---------------------------------------------------------------------------
// 出站消息超长分片
// ---------------------------------------------------------------------------

/**
 * 出站单条消息的安全长度上限（字符数）。
 *
 * 飞书 im/v1/messages 的 content 官方上限为 150KB（UTF-8 字节），post 富文本经
 * mdToPostContent 展开还有结构开销。这里取远低于上限的保守值：超过即按段落/
 * 代码块边界分片为多条顺序发送，避免整条被飞书 API 拒收导致回复丢失。
 */
export const FEISHU_OUTBOUND_SAFE_CHARS = 20000;

/**
 * 把超长 markdown 按段落 / 代码块边界切成 ≤ limit 的多段。
 *
 * 规则：
 *   - 围栏代码块（``` / ~~~）视为整块，绝不在片间劈开围栏；
 *   - 普通文本以空行（段落）为边界贪心装箱，片内换行原样保留
 *     （片间重组时段落一律以空行分隔，连续多空行会折叠为一个空行）；
 *   - 单块自身超限时兜底硬切：代码块按行切并给每段首尾补回围栏（保留语言标签），
 *     普通段落按行切、单行仍超限再按码点硬切（不劈开 emoji 代理对）。
 */
export function splitMarkdownForFeishu(
  markdown: string,
  limit: number = FEISHU_OUTBOUND_SAFE_CHARS,
): string[] {
  if (markdown.length <= limit) return [markdown];

  const pieces: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur) {
      pieces.push(cur);
      cur = '';
    }
  };

  for (const block of splitMarkdownBlocks(markdown)) {
    const parts = block.length <= limit ? [block] : hardSplitBlock(block, limit);
    for (const part of parts) {
      if (!cur) {
        cur = part;
      } else if (cur.length + 2 + part.length <= limit) {
        cur = `${cur}\n\n${part}`;
      } else {
        flush();
        cur = part;
      }
    }
  }
  flush();
  return pieces.length > 0 ? pieces : [markdown];
}

/** 把 markdown 切成块：围栏代码块整块保留，其余按空行分段。 */
function splitMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  const flush = (): void => {
    if (cur.length > 0) {
      blocks.push(cur.join('\n'));
      cur = [];
    }
  };
  for (const line of lines) {
    const t = line.trimStart();
    if (!inFence && (t.startsWith('```') || t.startsWith('~~~'))) {
      flush();
      inFence = true;
      fenceMarker = t.startsWith('```') ? '```' : '~~~';
      cur.push(line);
      continue;
    }
    if (inFence) {
      cur.push(line);
      if (t.startsWith(fenceMarker)) {
        inFence = false;
        flush();
      }
      continue;
    }
    if (line.trim() === '') {
      flush(); // 段落边界：空行本身丢弃，重组时以 \n\n 连接
    } else {
      cur.push(line);
    }
  }
  flush();
  return blocks;
}

/** 单块超限时的兜底硬切（代码块补围栏；普通块按行/码点切）。 */
function hardSplitBlock(block: string, limit: number): string[] {
  const lines = block.split('\n');
  const first = lines[0]?.trimStart() ?? '';
  if (first.startsWith('```') || first.startsWith('~~~')) {
    // 超大代码块：去首尾围栏按行装箱，每段重新包围栏（保留 ```lang 语言标签）。
    const openLine = lines[0];
    const closeMarker = first.startsWith('~~~') ? '~~~' : '```';
    const hasClose =
      lines.length > 1 && lines[lines.length - 1].trimStart().startsWith(closeMarker);
    const body = hasClose ? lines.slice(1, -1) : lines.slice(1);
    const overhead = openLine.length + closeMarker.length + 2; // 首尾围栏 + 两个换行
    return packLines(body, Math.max(1, limit - overhead)).map(
      (chunk) => `${openLine}\n${chunk}\n${closeMarker}`,
    );
  }
  return packLines(lines, limit);
}

/** 按行贪心装箱到 ≤ limit；单行超限再按码点硬切。 */
function packLines(lines: string[], limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = (): void => {
    if (cur) {
      out.push(cur);
      cur = '';
    }
  };
  for (const line of lines) {
    const segs = line.length <= limit ? [line] : hardSplitByCodePoints(line, limit);
    for (const seg of segs) {
      if (!cur) {
        cur = seg;
      } else if (cur.length + 1 + seg.length <= limit) {
        cur = `${cur}\n${seg}`;
      } else {
        flush();
        cur = seg;
      }
    }
  }
  flush();
  return out.length > 0 ? out : [''];
}

/**
 * 按码点硬切单行（不劈开 emoji 代理对）。
 * 注：按码点计数时，全 emoji 的极端行单段 UTF-16 长度可能略超 limit，
 * 但相对真实 API 上限（150KB）仍有巨大余量，可接受。
 */
function hardSplitByCodePoints(line: string, limit: number): string[] {
  const cps = Array.from(line);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += limit) {
    out.push(cps.slice(i, i + limit).join(''));
  }
  return out;
}

/**
 * 飞书 WS 网关（基于 @larksuiteoapi/node-sdk）
 *
 * 用法：
 *   const gw = new FeishuGateway(appId, appSecret);
 *   gw.onMessage = async (msg) => { ... return replyText; };
 *   await gw.connect();
 *   // ...
 *   await gw.disconnect();
 */
export class FeishuGateway {
  private appId: string;
  private appSecret: string;
  private domain: string;
  private tenantToken: string = '';
  private tokenExpiresAt: number = 0;
  private wsClient: FeishuWsClient | null = null;
  private _onReady: (() => void) | null = null;
  private _onDisconnect: ((error?: Error) => void) | null = null;
  /**
   * SDK 内部重连的开始/成功回调透传。
   *
   * 为什么要透传：SDK（WSClient autoReconnect）掉线后会自行无限重连，期间
   * onError/_onDisconnect 不触发——上层若只听 onDisconnect，连接状态会长期
   * 停留在「已连接」的假象里。把这两个事件交给上层（server 侧 FeishuAdapter
   * 的守护循环），状态才诚实。不接（保持 null）时行为与旧版完全一致。
   */
  private _onReconnecting: (() => void) | null = null;
  private _onReconnected: (() => void) | null = null;
  /** 跨进程连接互斥锁（connect 时获取，disconnect/进程退出时释放）。 */
  private connectionLock: FeishuGatewayLockHandle | null = null;

  /**
   * 消息去重：记录已"受理"的消息 ID（at-most-once）。value 为首次受理的时间戳。
   *
   * 关键：一条消息**在决定处理它的那一刻就落盘**（而非等处理成功后），所以即便
   * 进程在处理途中被 self_update / 重启 / 崩溃 / 部署带走，这条 id 也已在磁盘上，
   * 飞书之后（含 WS 重连）重推同一条时必被识别丢弃，不会重复执行。
   *
   * 采用"按时间窗口淘汰"而非"按数量淘汰"：忙碌的一天若处理超过旧上限(500)条，
   * 会把当天早些时候的 id 挤掉，导致下午的重推认不出来。飞书的重推窗口远小于此，
   * 故保留 {@link processedRetentionMs}（默认 48h）足以覆盖任何重推，又有
   * {@link maxProcessedMessages} 作为内存/磁盘的安全上限。
   */
  private processedMessages: Map<string, number> = new Map();
  /** 安全上限：超过则按时间从最旧开始丢弃（正常达不到，仅防失控增长）。 */
  private readonly maxProcessedMessages = 5000;
  /** 去重记录保留时长：超过此年龄的 id 在落盘/加载时被清除。 */
  private readonly processedRetentionMs = 48 * 60 * 60 * 1000;

  /** 内存中的 in-flight 消息集合，用于在长耗时处理期间拦截飞书并发重试 */
  private inFlightMessages: Set<string> = new Set();

  /** 获取去重文件的绝对路径 */
  private getProcessedMessagesFilePath(): string {
    const homeDir = os.homedir();
    const geminiDir = path.join(homeDir, '.otto-user');
    return path.join(geminiDir, 'feishu-processed-messages.json');
  }

  /**
   * 从文件加载已处理的消息 ID。兼容两种磁盘格式：
   *   - 旧版：`string[]`（仅 id，无时间戳）—— 迁移时按"当前时间"赋时间戳；
   *   - 新版：`Array<[id, timestamp]>`。
   * 加载时顺带清除超过 {@link processedRetentionMs} 的过期条目。
   */
  private loadProcessedMessages(): void {
    this.processedMessages = new Map();
    try {
      const filePath = this.getProcessedMessagesFilePath();
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const entry of parsed) {
        let id: string | undefined;
        let ts: number;
        if (typeof entry === 'string') {
          id = entry; // 旧格式：无时间戳，迁移为"现在"，让其再存活一个保留窗口
          ts = now;
        } else if (Array.isArray(entry) && typeof entry[0] === 'string') {
          id = entry[0];
          ts = typeof entry[1] === 'number' ? entry[1] : now;
        } else {
          continue;
        }
        if (!id.startsWith('om_')) continue;
        if (now - ts >= this.processedRetentionMs) continue; // 过期丢弃
        this.processedMessages.set(id, ts);
      }
      dlog(`[Feishu] Loaded ${this.processedMessages.size} processed message IDs from persistent cache.`);
    } catch (e: unknown) {
      dwarn(`[Feishu] Failed to load processed messages: ${errorMessage(e)}`);
      this.processedMessages = new Map();
    }
  }

  /** 保存已处理的消息 ID（含时间戳）到文件。 */
  private saveProcessedMessages(): void {
    try {
      const filePath = this.getProcessedMessagesFilePath();
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      const entries = Array.from(this.processedMessages.entries());
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
      dlog(`[Feishu] Saved ${entries.length} processed message IDs to persistent cache.`);
    } catch (e: unknown) {
      dwarn(`[Feishu] Failed to save processed messages: ${errorMessage(e)}`);
    }
  }

  /**
   * 受理即落盘（at-most-once 的核心）：在**决定处理某条消息的那一刻**调用，
   * 把它的 id 立刻写入持久去重表并落盘。即便随后进程在处理途中退出，这条 id
   * 也已在磁盘上，飞书重推会被识别丢弃。
   *
   * 同时执行清理：先按年龄淘汰过期条目，再按数量上限淘汰最旧条目。
   */
  private recordProcessedMessage(messageId: string): void {
    if (!messageId || !messageId.startsWith('om_')) return;
    const now = Date.now();
    // 刷新/写入时间戳（Map 保证 id 唯一）。
    this.processedMessages.delete(messageId);
    this.processedMessages.set(messageId, now);
    // 1) 按年龄淘汰过期条目。
    for (const [id, ts] of this.processedMessages) {
      if (now - ts >= this.processedRetentionMs) this.processedMessages.delete(id);
    }
    // 2) 按数量上限淘汰最旧条目（Map 迭代顺序即插入顺序，最旧在前）。
    while (this.processedMessages.size > this.maxProcessedMessages) {
      const oldest = this.processedMessages.keys().next().value;
      if (oldest === undefined) break;
      this.processedMessages.delete(oldest);
    }
    this.saveProcessedMessages();
  }

  /** 内容去重：key 为 "chatId:text"，value 为首次处理时间戳（5 秒窗口内相同内容视为重复） */
  private recentContents: Map<string, number> = new Map();
  private readonly dedupWindowMs = 5000;
  /** 内容去重表的硬上限：洪泛时按插入顺序淘汰最旧条目，防止内存无界增长。 */
  private readonly maxRecentContents = 2000;

  /**
   * 陈旧消息过滤：记录 WS 连接就绪的时间戳，丢弃早于此时间创建的消息，
   * 防止飞书重连后推送断连期间的积压旧消息。
   * 重连时也会更新此时间戳。
   */
  private connectedAtMs: number = 0;
  /** 陈旧消息允许的时钟偏移量（毫秒），消息创建时间早于 connectedAtMs 减去此值才被丢弃 */
  private readonly STALE_CLOCK_SKEW_MS = 5000;

  /**
   * 高风险操作内容哈希去重：针对 restart / self-update 等会导致进程退出的命令，
   * 飞书服务器可能因进程快速退出而认为消息未送达、延迟重发，导致反复重启。
   * 对匹配关键词的消息计算内容哈希，3 小时窗口内同哈希静默丢弃。
   * 持久化到磁盘，重启后依然生效。
   */
  private static readonly HIGH_RISK_KEYWORDS = [
    '/feishu restart', '/飞书 restart', '/feishu update',
    'self_update', 'self-update', '自更新', '重启', '热重启',
  ] as const;
  private static readonly HIGH_RISK_DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours
  private highRiskHashes: Map<string, number> = new Map(); // hash → first-seen timestamp

  /** 获取高风险哈希去重文件的绝对路径 */
  private getHighRiskDedupFilePath(): string {
    const homeDir = os.homedir();
    const geminiDir = path.join(homeDir, '.otto-user');
    return path.join(geminiDir, 'feishu-highrisk-dedup.json');
  }

  /** 从磁盘加载高风险哈希缓存，并清除过期条目 */
  private loadHighRiskDedup(): void {
    try {
      const filePath = this.getHighRiskDedupFilePath();
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const entries: Array<[string, number]> = JSON.parse(content);
        if (Array.isArray(entries)) {
          const now = Date.now();
          for (const [hash, ts] of entries) {
            if (typeof hash === 'string' && typeof ts === 'number' && now - ts < FeishuGateway.HIGH_RISK_DEDUP_WINDOW_MS) {
              this.highRiskHashes.set(hash, ts);
            }
          }
          dlog(`[Feishu] Loaded ${this.highRiskHashes.size} active high-risk dedup entries from disk.`);
        }
      }
    } catch (e: unknown) {
      dwarn(`[Feishu] Failed to load high-risk dedup cache: ${errorMessage(e)}`);
    }
  }

  /** 保存高风险哈希缓存到磁盘 */
  private saveHighRiskDedup(): void {
    try {
      const filePath = this.getHighRiskDedupFilePath();
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      const entries = Array.from(this.highRiskHashes.entries());
      fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
    } catch (e: unknown) {
      dwarn(`[Feishu] Failed to save high-risk dedup cache: ${errorMessage(e)}`);
    }
  }

  /** 判断消息内容是否匹配高风险关键词 */
  private isHighRiskMessage(text: string): boolean {
    const lower = text.toLowerCase();
    return FeishuGateway.HIGH_RISK_KEYWORDS.some(kw => lower.includes(kw));
  }

  /** 对消息内容计算简单哈希（用于去重比对） */
  private computeContentHash(chatId: string, text: string): string {
    const raw = `${chatId}:${text}`;
    // Simple DJB2 hash — fast, sufficient for dedup purposes
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
      hash = ((hash << 5) + hash + raw.charCodeAt(i)) & 0x7FFFFFFF;
    }
    return `hr_${hash.toString(36)}`;
  }

  /**
   * 检查高风险消息是否已在窗口内处理过。
   * 如果是新的高风险消息，记录其哈希并持久化。
   * @returns true 表示应静默丢弃，false 表示可以执行
   */
  private checkHighRiskDedup(chatId: string, text: string): boolean {
    if (!this.isHighRiskMessage(text)) return false;

    const hash = this.computeContentHash(chatId, text);
    const now = Date.now();
    const firstSeen = this.highRiskHashes.get(hash);

    if (firstSeen !== undefined && now - firstSeen < FeishuGateway.HIGH_RISK_DEDUP_WINDOW_MS) {
      dlog(`[Feishu] High-risk dedup: skipping duplicate "${text.slice(0, 40)}" (hash=${hash}, age=${Math.round((now - firstSeen) / 60000)}min)`);
      return true;
    }

    // 新的高风险消息，记录并持久化
    this.highRiskHashes.set(hash, now);
    // 清理过期条目
    for (const [h, ts] of this.highRiskHashes) {
      if (now - ts >= FeishuGateway.HIGH_RISK_DEDUP_WINDOW_MS) this.highRiskHashes.delete(h);
    }
    this.saveHighRiskDedup();
    return false;
  }

  /** 群名缓存：key 为 chatId，value 为解析出的群名（成功才缓存，失败/空名不缓存以便后续重试） */
  private chatNameCache: Map<string, string> = new Map();

  /**
   * 会话类型缓存：key 为 chatId，value 为飞书 chat_mode（'p2p' 单聊 / 'group' 群聊 / 'topic' 话题群）。
   * 由 getChatName 的同一次 API 调用顺带填充，getChatMode 优先命中此缓存，避免重复请求。
   * 注意：与 chatNameCache 独立——p2p 单聊无群名（name 为空，不进 chatNameCache），
   * 但其 chat_mode 仍须可被精确识别，故单独缓存。
   */
  private chatModeCache: Map<string, string> = new Map();

  /** 外部注入的消息处理回调 */
  onMessage: OnMessageCallback | null = null;

  /** 外部注入的卡片按钮点击回调 */
  onCardAction: OnCardActionCallback | null = null;

  /**
   * 卡片回调授权判定（C1）。可由调用方注入：给定点击者 open_id，返回是否允许
   * 该卡片操作生效。注入后优先于内置的凭证授权判定。
   *
   * 注入为 null（默认）时，gateway 在非测试环境下会**自行**加载飞书凭证、
   * 用 isSenderAuthorized(owner/allowlist) 做判定（与消息路径同源、同为 fail-closed），
   * 从而保证「群成员点按钮劫持等待 owner 的决策」被拦截，无需调用方额外接线。
   */
  cardActionAuthorizer: ((openId: string) => boolean) | null = null;

  /** 凭证授权判定的缓存（自加载一次后复用）；null 表示尚未尝试加载。 */
  private credAuthorizerCache: ((openId: string) => boolean) | null = null;
  /** 单飞加载凭证授权器：并发卡片回调复用同一次加载，避免竞态与重复读盘。 */
  private credAuthorizerPromise: Promise<((openId: string) => boolean) | null> | null = null;

  /**
   * 判定一次卡片回调是否被授权（C1）。
   *
   * 优先级：注入的 cardActionAuthorizer → 内置凭证授权（owner/allowlist）。
   * 设计要点：
   *   - 测试环境（VITEST / NODE_ENV=test）下不自加载凭证，保持既有用例行为不变；
   *   - 凭证存在且属于本 Bot（appId 匹配）但**未配置 owner/allowlist**（Bot 尚未
   *     绑定授权用户）时**拒绝**，与消息路径 isSenderAuthorized 一致（fail-closed，
   *     未配置授权即默认拒绝），避免群成员在 owner 绑定前的空窗期劫持卡片决策；
   *   - 仅当凭证完全无法读取（读盘异常）时才放行，交由上层流程处理。
   */
  private async isCardActionAuthorized(openId: string): Promise<boolean> {
    if (this.cardActionAuthorizer) {
      try {
        return this.cardActionAuthorizer(openId);
      } catch (e: unknown) {
        dwarn(`[Feishu] cardActionAuthorizer threw, denying: ${errorMessage(e)}`);
        return false;
      }
    }

    // 测试环境不触碰真实凭证文件，避免污染用例。
    if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
      return true;
    }

    // 单飞加载（并发回调共享同一次读盘，避免竞态导致首批回调误放行）。
    if (!this.credAuthorizerPromise) {
      this.credAuthorizerPromise = (async () => {
        try {
          const creds = await loadCredentials();
          // 凭证属于本 Bot 时一律走 isSenderAuthorized 判定：
          // 已配置 owner/allowlist → 按名单校验；
          // 未配置 owner/allowlist → isSenderAuthorized 默认拒绝（fail-closed，
          //   与消息路径一致），不在此处放行，避免空窗期劫持。
          if (creds && creds.appId === this.appId) {
            return (id: string) => isSenderAuthorized(creds, id);
          }
          return null; // 无凭证 / 非本 Bot 凭证 → 交由上层处理（见下方 fallback）
        } catch (e: unknown) {
          // 凭证无法读取：不阻断（与消息路径一致由上层处理），但记录。
          dwarn(`[Feishu] card-action authorization: failed to load credentials, allowing: ${errorMessage(e)}`);
          return null;
        }
      })();
    }

    this.credAuthorizerCache = await this.credAuthorizerPromise;
    return this.credAuthorizerCache ? this.credAuthorizerCache(openId) : true;
  }

  /**
   * 等待卡片按钮点击的 Promise 映射
   * key = 卡片 message_id, value = { resolve, timer }
   */
  private cardCallbacks = new Map<string, {
    resolve: (data: CardActionData) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * 文本选择模式的临时回调（C3：按 chatId 分桶）。
   *
   * 早期实现是单个标量回调，多群并发时后注册者覆盖前者 → 第一个等待方永久挂起，
   * 且 "1/2/yes/no" 之类回复会被跨群错误消费。改为 Map<chatId, callback>，
   * 每个 chat 只消费自己 chat 的回复，互不干扰。
   * 返回 true 表示已消费该消息，不让它进入主消息处理流程。
   */
  private textChoiceCallbacks = new Map<string, (msg: FeishuMessage) => boolean>();

  /**
   * 最近一次 waitForCardAction 发送的卡片 message_id
   * 用于调用方在获取用户选择后更新卡片内容
   */
  private lastCardMessageId: string | null = null;

  /** 获取最近一次卡片的 message_id */
  getLastCardMessageId(): string | null {
    return this.lastCardMessageId;
  }

  /** 连接状态回调 */
  get onReady(): (() => void) | null { return this._onReady; }
  set onReady(fn: (() => void) | null) { this._onReady = fn; }

  get onDisconnect(): ((error?: Error) => void) | null { return this._onDisconnect; }
  set onDisconnect(fn: ((error?: Error) => void) | null) { this._onDisconnect = fn; }

  get onReconnecting(): (() => void) | null { return this._onReconnecting; }
  set onReconnecting(fn: (() => void) | null) { this._onReconnecting = fn; }

  get onReconnected(): (() => void) | null { return this._onReconnected; }
  set onReconnected(fn: (() => void) | null) { this._onReconnected = fn; }

  getAppId(): string { return this.appId; }
  getAppSecret(): string { return this.appSecret; }
  getDomain(): string { return this.domain; }

  /**
   * 底层连接健康快照（僵尸连接探测用，只读、零网络开销）。
   *
   * 经 duck-typing 读 SDK WSClient 内部的 wsConfig.getWSInstance().readyState：
   *   - hasClient=false：wsClient 已被置空（未连接/已断开）；
   *   - socketOpen=true/false：底层 WebSocket 是否处于 OPEN；
   *   - socketOpen=null：SDK 内部结构不可读（版本变化/测试 fake）→ 探测方
   *     应视为「未知」而不是「已死」，避免误杀健康连接。
   */
  getConnectionHealth(): { hasClient: boolean; socketOpen: boolean | null } {
    const client = this.wsClient;
    if (!client) return { hasClient: false, socketOpen: null };
    try {
      const inst = (
        client as unknown as {
          wsConfig?: { getWSInstance?: () => { readyState?: number } | null };
        }
      ).wsConfig?.getWSInstance?.();
      if (!inst || typeof inst.readyState !== 'number') {
        return { hasClient: true, socketOpen: null };
      }
      // WebSocket.OPEN === 1（ws 库与浏览器标准一致）。
      return { hasClient: true, socketOpen: inst.readyState === 1 };
    } catch {
      return { hasClient: true, socketOpen: null };
    }
  }

  constructor(appId: string, appSecret: string, domain: 'feishu' | 'lark' = 'feishu') {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.loadProcessedMessages();
    this.loadHighRiskDedup();
  }

  private get apiBaseUrl(): string {
    return API_BASE_URLS[this.domain] || API_BASE_URLS.feishu;
  }

  /** 单飞锁:并发到期请求复用同一次刷新,防 OAuth 刷新风暴/429。 */
  private tokenRefreshPromise: Promise<string> | null = null;

  /**
   * 获取 tenant_access_token（自动缓存+刷新,单飞防并发风暴）
   */
  async getTenantToken(): Promise<string> {
    if (this.tenantToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.tenantToken;
    }
    if (this.tokenRefreshPromise) return this.tokenRefreshPromise;
    this.tokenRefreshPromise = this.fetchTenantToken().finally(() => {
      this.tokenRefreshPromise = null;
    });
    return this.tokenRefreshPromise;
  }

  private async fetchTenantToken(): Promise<string> {
    const res = await fetch(`${this.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    // 健壮性:先查 HTTP 状态,避免飞书返回 5xx/限流 HTML 时 res.json() 抛错掩盖真因。
    if (!res.ok) {
      throw new Error(`tenant_access_token HTTP ${res.status} ${res.statusText}`);
    }
    let data: FeishuApiResponse<{ tenant_access_token?: string; expire?: number }>;
    try {
      data = await res.json();
    } catch {
      throw new Error('tenant_access_token: invalid JSON response from Feishu');
    }
    if (!data.tenant_access_token) {
      // 脱敏:只暴露飞书错误码/描述,绝不 dump 整个响应体(可能含敏感信息)。
      throw new Error(
        `tenant_access_token failed (code=${data.code ?? '?'}): ${data.msg ?? 'unknown error'}`,
      );
    }
    this.tenantToken = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
    return this.tenantToken;
  }

  /**
   * 解析单条消息的 content 负载为文本并收集附件
   */
  private parseSingleMessageContent(
    messageId: string,
    msgType: string,
    contentStr: string,
    pendingImages: Array<{ imageKey: string; placeholder: string }>,
    pendingFiles: Array<{ fileKey: string; fileName: string; placeholder: string }>
  ): string {
    let text = '';
    if (msgType === 'text') {
      try {
        const content = JSON.parse(contentStr || '{}');
        text = typeof content.text === 'string' ? content.text : String(content.text || '');
      } catch {
        text = typeof contentStr === 'string' ? contentStr : String(contentStr || '');
      }
    } else if (msgType === 'image') {
      try {
        const content = JSON.parse(contentStr || '{}');
        const imageKey = content.image_key;
        if (imageKey) {
          text = '[图片消息]';
          pendingImages.push({ imageKey, placeholder: '[图片消息]' });
        } else {
          text = '[图片消息]';
        }
      } catch {
        text = '[图片消息]';
      }
    } else if (msgType === 'file') {
      try {
        const content = JSON.parse(contentStr || '{}');
        const fileKey = content.file_key;
        const fileName = content.file_name || 'unnamed_file';
        if (fileKey) {
          const placeholder = `[文件消息: ${fileName}]`;
          text = placeholder;
          pendingFiles.push({ fileKey, fileName, placeholder });
        } else {
          text = `[文件消息: ${fileName}]`;
        }
      } catch {
        text = '[文件消息]';
      }
    } else if (msgType === 'audio') {
      try {
        const content = JSON.parse(contentStr || '{}');
        const fileKey = content.file_key;
        if (fileKey) {
          const fileName = `audio_${messageId || 'unnamed'}.opus`;
          const placeholder = `[音频消息: ${fileName}]`;
          text = placeholder;
          pendingFiles.push({ fileKey, fileName, placeholder });
        } else {
          text = '[音频消息]';
        }
      } catch {
        text = '[音频消息]';
      }
    } else if (msgType === 'media') {
      try {
        const content = JSON.parse(contentStr || '{}');
        const fileKey = content.file_key;
        if (fileKey) {
          const fileName = `video_${messageId || 'unnamed'}.mp4`;
          const placeholder = `[视频消息: ${fileName}]`;
          text = placeholder;
          pendingFiles.push({ fileKey, fileName, placeholder });
        } else {
          text = '[视频消息]';
        }
      } catch {
        text = '[视频消息]';
      }
    } else if (msgType === 'post') {
      try {
        const content = JSON.parse(contentStr || '{}');
        let postContent: FeishuPostParagraph[] = [];
        let title = '';

        const locales = Object.keys(content);
        const firstLocale = locales[0];
        if (firstLocale && content[firstLocale] && Array.isArray(content[firstLocale].content)) {
          postContent = content[firstLocale].content;
          title = content[firstLocale].title || '';
        } else if (Array.isArray(content.content)) {
          postContent = content.content;
          title = content.title || '';
        } else if (Array.isArray(content)) {
          postContent = content;
        }

        const parts: string[] = [];
        if (title) {
          parts.push(`**${title}**`);
        }

        for (const paragraph of postContent) {
          if (!Array.isArray(paragraph)) continue;
          let paragraphText = '';
          for (const element of paragraph) {
            if (!element || typeof element !== 'object') continue;

            if (element.tag === 'text') {
              paragraphText += element.text || '';
            } else if (element.tag === 'a') {
              paragraphText += `[${element.text || ''}](${element.href || ''})`;
            } else if (element.tag === 'at') {
              paragraphText += element.text || '';
            } else if (element.tag === 'img') {
              const imageKey = element.image_key;
              if (imageKey) {
                const placeholder = `[图片_${pendingImages.length + 1}]`;
                pendingImages.push({ imageKey, placeholder });
                paragraphText += placeholder;
              }
            }
          }
          if (paragraphText.trim()) {
            parts.push(paragraphText);
          }
        }
        text = parts.join('\n');
      } catch (e: unknown) {
        derror('Parse feishu post message failed in sub-parser:', e);
        text = `[解析富文本消息失败]`;
      }
    } else if (msgType === 'interactive') {
      // 交互式卡片（其他 bot 发出的卡片转发过来时即为此类型）。
      // 飞书「获取消息内容」接口返回 {title, elements:[[...]], user_dsl} 结构：
      //   - user_dsl 是卡片完整 DSL（JSON 字符串），对 card 2.0（schema:"2.0"）卡片
      //     是【唯一】完整数据源——此时 content.elements 简化视图只有图片占位 +
      //     「请升级至最新版本客户端」降级提示，真实内容（含 table 组件）全在 user_dsl.body；
      //   - 同时兼容历史「直接结构」与 card 2.0「{data:{card}}」外层。
      // 故优先解析 user_dsl，再递归收集文本（table 组件重建为 markdown 表格），
      // user_dsl 缺失/解析失败时回退到 content 顶层结构（含二维简化视图）。
      try {
        const content = JSON.parse(contentStr || '{}');
        // 落盘原始卡片 content，便于收集多种卡片结构样本后统一适配解析
        this.dumpCardContentForDebug(messageId, contentStr);

        // 解析 user_dsl —— 卡片的完整 DSL，优先级最高
        let dsl: Record<string, unknown> | null = null;
        if (typeof content?.user_dsl === 'string') {
          try {
            dsl = JSON.parse(content.user_dsl);
          } catch {
            // user_dsl 解析失败则忽略，回退到 content
          }
        }
        // 卡片主体：user_dsl 优先 → card 2.0 的 data.card → content 本身
        const card = dsl ?? content?.data?.card ?? content;

        // 1) 标题 + 副标题：header.title / header.subtitle（兼容 plain_text 与 i18n_content）
        const titleNode = card?.header?.title;
        const title =
          (typeof titleNode?.content === 'string' && titleNode.content) ||
          (typeof titleNode?.i18n_content === 'object'
            ? Object.values(titleNode.i18n_content)[0]
            : '') ||
          '';
        const subtitleNode = card?.header?.subtitle;
        const subtitle =
          (typeof subtitleNode?.content === 'string' && subtitleNode.content) || '';

        // 2) 正文：card 2.0 走 body.elements，card 1.0 走 elements；
        //    user_dsl 提取不到内容时，兜底用 content.elements（飞书二维简化视图）。
        const bodyTexts: string[] = [];
        const seen = new Set<string>();
        const trimmedTitle = title ? String(title).trim() : '';
        const trimmedSubtitle = subtitle ? String(subtitle).trim() : '';
        // 标题/副标题先入 seen，避免递归正文时重复收集
        if (trimmedTitle) seen.add(trimmedTitle);
        if (trimmedSubtitle) seen.add(trimmedSubtitle);

        const bodySource =
          card?.body?.elements ?? card?.elements ?? content?.elements ?? card;
        this.extractCardText(bodySource, bodyTexts, seen);
        // user_dsl 正文为空时，回退到 content 简化视图（二维数组）
        if (bodyTexts.length === 0 && content?.elements) {
          this.extractCardText(content.elements, bodyTexts, seen);
        }

        const parts: string[] = ['[卡片]'];
        if (trimmedTitle) parts.push(`**${trimmedTitle}**`);
        if (trimmedSubtitle) parts.push(trimmedSubtitle);
        for (const t of bodyTexts) {
          if (t && t.trim()) parts.push(t.trim());
        }
        // 只有标注、没有任何可读文本时，给出更明确的兜底
        text = parts.length > 1 ? parts.join('\n') : '[卡片消息]';
      } catch (e: unknown) {
        derror('Parse feishu interactive card failed in sub-parser:', e);
        text = '[卡片消息]';
      }
    } else {
      text = `[不支持的消息类型: ${msgType}]`;
    }
    return text;
  }

  /**
   * 递归遍历飞书卡片结构，收集所有可读文本。
   *
   * 卡片元素种类繁多（div/markdown/text/note/column_set/column/action/button…）且可任意嵌套，
   * 与其穷举每种 tag，不如统一规则：凡是 `content` 或 `text`（字符串）字段即视为可读文本收集，
   * 并对数组/对象继续向下递归。对 `tag:'img'`、按钮等无正文文本的节点天然跳过（它们没有
   * content/text 字符串，或只有 image_key）。借助 `seen` 去重，避免同一段文本因结构重复被多次收集。
   *
   * 注意：这里有意 **不** 处理图片占位符与按钮文案——按产品决策，转发卡片仅提取正文文本并标注 [卡片]。
   */
  private extractCardText(node: unknown, out: string[], seen: Set<string>): void {
    if (node == null) return;

    if (typeof node === 'string') {
      // 清除飞书 lark_md 的 <font color='...'>...</font> 着色标签，保留内部文字
      const s = node.trim().replace(/<\/?font[^>]*>/gi, '');
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) this.extractCardText(item, out, seen);
      return;
    }

    if (typeof node === 'object') {
      const nodeRecord = asRecord(node);
      if (!nodeRecord) return;
      // table 组件需保留行列对应关系，单独渲染为 markdown 表格后即停止下钻，
      // 否则通用递归会把列定义与行数据平铺、丢失结构。
      if (nodeRecord['tag'] === 'table' && Array.isArray(nodeRecord['columns'])) {
        const tableMd = this.renderCardTable(nodeRecord);
        if (tableMd && !seen.has(tableMd)) {
          seen.add(tableMd);
          out.push(tableMd);
        }
        return;
      }

      // 直接文本承载字段：content / text（text 可能是字符串，也可能是 {content} 对象）
      if (typeof nodeRecord['content'] === 'string') {
        this.extractCardText(nodeRecord['content'], out, seen);
      }
      if (typeof nodeRecord['text'] === 'string') {
        this.extractCardText(nodeRecord['text'], out, seen);
      }
      // 递归常见的容器/子节点字段
      for (const key of ['text', 'elements', 'columns', 'fields', 'actions', 'options']) {
        const child = nodeRecord[key];
        if (child && typeof child === 'object') {
          this.extractCardText(child, out, seen);
        }
      }
    }
  }

  /**
   * 将飞书卡片 table 组件渲染为 Markdown 表格，保留行列对应关系。
   *
   * 结构（与飞书官方对齐）：
   *  - `columns[]`：列定义，`name` 为单元格取值的 key，`display_name` 为表头展示名；
   *  - `rows[]`：每行是对象，按列的 `name` 取单元格值。
   *
   * 单元格值类型多样，统一格式化为可读文本：
   *  - 字符串/数字：原样；
   *  - options：`[{text,color}]` → 取各 text 以逗号连接；
   *  - persons：id 字符串或 id 数组 → 以逗号连接；
   *  - 其它对象/数组：尽量取 text/content，再兜底 JSON 化。
   *
   * 无 rows 时仅输出表头（仍是合法 markdown 表格）。
   */
  private renderCardTable(node: Record<string, unknown>): string {
    const columns: Array<Record<string, unknown>> = Array.isArray(node.columns)
      ? node.columns.filter((column): column is Record<string, unknown> => Boolean(asRecord(column)))
      : [];
    if (columns.length === 0) return '';

    const headers = columns.map(
      (c, i) => String(c?.display_name ?? c?.name ?? `列${i + 1}`).trim() || `列${i + 1}`,
    );

    const formatCell = (val: unknown): string => {
      if (val == null) return '';
      if (typeof val === 'string') return val.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
      if (typeof val === 'number' || typeof val === 'boolean') return String(val);
      if (Array.isArray(val)) {
        return val
          .map((item) => {
            if (item == null) return '';
            if (typeof item === 'string' || typeof item === 'number') return String(item);
            // options: {text,color}；其它对象尽量取 text/content
            const itemRecord = asRecord(item);
            return String(itemRecord?.['text'] ?? itemRecord?.['content'] ?? '').trim();
          })
          .filter((s) => s)
          .join(', ');
      }
      if (typeof val === 'object') {
        // 飞书 table 单元格 data_type 为 markdown 时，值是嵌套对象：
        //   { tag: "markdown", property: { elements: [{ tag: "plain_text", property: { content: "2.24亿" } }] } }
        // 需要递归提取 property.elements 中的 content
        const valRecord = asRecord(val) ?? {};
        const prop = asRecord(valRecord['property']);
        if (prop && Array.isArray(prop.elements)) {
          const texts = prop.elements
            .map((el) => {
              const elRecord = asRecord(el);
              return asRecord(elRecord?.['property'])?.['content'] ?? elRecord?.['content'] ?? elRecord?.['text'] ?? '';
            })
            .filter(Boolean);
          if (texts.length > 0) return texts.join(', ');
        }
        // markdownElements 二级兜底
        if (prop && Array.isArray(prop.markdownElements) && prop.markdownElements.length > 0) {
          const texts = prop.markdownElements
            .map((el) => {
              const elRecord = asRecord(el);
              return asRecord(elRecord?.['property'])?.['content'] ?? elRecord?.['content'] ?? elRecord?.['text'] ?? '';
            })
            .filter(Boolean);
          if (texts.length > 0) return texts.join(', ');
        }
        return String(valRecord['text'] ?? valRecord['content'] ?? '').trim();
      }
      return '';
    };

    const rows: Array<Record<string, unknown>> = Array.isArray(node.rows)
      ? node.rows.filter((row): row is Record<string, unknown> => Boolean(asRecord(row)))
      : [];
    const lines: string[] = [];
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      const cells = columns.map((c) => formatCell(row[String(c.name ?? '')]));
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return lines.join('\n');
  }

  /**
   * 将卡片原始 content JSON 追加落盘到 `~/.otto-user/feishu-card-dumps.jsonl`，
   * 便于收集多种卡片结构样本后统一适配解析。每行一条记录（JSONL），含时间戳、
   * 消息 ID 与格式化后的原始 content。失败时静默吞掉，绝不影响主流程。
   */
  private dumpCardContentForDebug(messageId: string, contentStr: string): void {
    // 在 WS 事件回调中调用，必须非阻塞：用异步 fs（fire-and-forget），
    // 避免同步 appendFileSync 卡住事件循环。失败静默，绝不影响主流程。
    let pretty: unknown = contentStr;
    try {
      pretty = JSON.parse(contentStr || '{}');
    } catch {
      // 保留原始字符串
    }
    const record = {
      ts: new Date().toISOString(),
      messageId: messageId || '(unknown)',
      content: pretty,
    };
    void (async () => {
      try {
        const dir = path.join(os.homedir(), '.otto-user');
        await fsp.mkdir(dir, { recursive: true });
        const file = path.join(dir, 'feishu-card-dumps.jsonl');
        // 该调试文件可能含卡片原文，按 0o600 仅本人可读写（首次创建时即生效）。
        await fsp.appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
        // 防御性收紧已存在文件的权限（历史文件可能是默认 0o644）。
        await fsp.chmod(file, 0o600).catch(() => {/* best effort */});
      } catch {
        // 调试落盘失败不影响主流程
      }
    })();
  }

  /**
   * 将「获取指定消息内容」接口返回的扁平 `items[]` 渲染为合并转发的可读文本。
   *
   * items 是一棵扁平化的消息树：父消息（rootId，无 `upper_message_id`）在前，
   * 其后每条子孙消息通过 `upper_message_id` 指向其直接父级。本方法据此重建
   * 父→子映射，再从 rootId 出发递归渲染；嵌套的 merge_forward 子消息会就地
   * 递归展开（无需额外 API 调用，因为飞书已把整棵树平铺在同一个 items 里）。
   *
   * 关键字段（与飞书返回结构对齐）：
   *  - 子消息内容在 `item.body.content`（JSON 字符串），类型在 `item.msg_type`；
   *  - 时间在 `item.create_time`（毫秒时间戳字符串），发送者在 `item.sender.id`。
   *
   * pendingImages / pendingFiles 由调用方传入并在整棵树范围内共享，从而保证
   * 图片/文件占位符（如 `[图片_1]`、`[图片_2]`）全局唯一、不重号。
   */
  private renderMergedForwardItems(
    rootId: string,
    items: MergedForwardItem[],
    pendingImages: Array<{ imageKey: string; placeholder: string }>,
    pendingFiles: Array<{ fileKey: string; fileName: string; placeholder: string }>
  ): string {
    // 按 upper_message_id 构建 父id -> 子消息[] 映射（根消息本身不计入）
    const childrenMap = new Map<string, MergedForwardItem[]>();
    for (const item of items) {
      if (item.message_id === rootId && !item.upper_message_id) continue;
      const parentId = item.upper_message_id || rootId;
      const arr = childrenMap.get(parentId) || [];
      arr.push(item);
      childrenMap.set(parentId, arr);
    }
    // 同一父级下的子消息按创建时间升序排列
    for (const arr of childrenMap.values()) {
      arr.sort(
        (a, b) =>
          parseInt(String(a.create_time || '0'), 10) -
          parseInt(String(b.create_time || '0'), 10)
      );
    }

    const renderSubtree = (parentId: string, depth: number): string => {
      const children = childrenMap.get(parentId);
      if (!children || children.length === 0) return '';

      const parts: string[] = [];
      for (const item of children) {
        const subMsgType = item.msg_type || 'text';
        const senderName = item.sender?.id || '匿名';
        const timestampStr = item.create_time
          ? new Date(Number(item.create_time)).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })
          : '';
        const timeHeader = timestampStr ? ` [${timestampStr}]` : '';

        let subText: string;
        if (subMsgType === 'merge_forward') {
          // 嵌套合并转发：就地递归展开（子孙节点已在同一 items 中）
          const nested = renderSubtree(item.message_id as string, depth + 1);
          subText = nested || '[空的合并转发消息]';
        } else {
          subText = this.parseSingleMessageContent(
            item.message_id as string,
            subMsgType,
            item.body?.content as string,
            pendingImages,
            pendingFiles
          );
        }

        const indent = '  '.repeat(depth);
        parts.push(`${indent}**${senderName}**${timeHeader}:`);
        parts.push(
          subText
            .split('\n')
            .map((line) => `${indent}${line}`)
            .join('\n')
        );
        parts.push(`${indent}---`);
      }
      return parts.join('\n');
    };

    return renderSubtree(rootId, 0);
  }

  /**
   * 获取合并转发消息的子消息列表。
   *
   * 飞书并没有专门的「合并转发」读取端点（早期实现误用了不存在的
   * `/messages/:id/merged_forward`，飞书直接返回 HTTP 404）。正确做法是
   * 直接调用「获取指定消息内容」接口 `GET /open-apis/im/v1/messages/:message_id`：
   * 当目标是一条 merge_forward 消息时，飞书会在 `data.items[]` 中返回**扁平化**
   * 的消息树——第一条是父消息本身（无 `upper_message_id`），其后每条子孙消息
   * 都带有 `upper_message_id` 指向其直接父级。
   *
   * 这里只负责取回原始 `items`，树形拼装与渲染交由调用方处理。
   */
  async getMergedForwardMessages(messageId: string): Promise<{ items: MergedForwardItem[]; error?: string }> {
    try {
      const token = await this.getTenantToken();
      if (!token) {
        return { items: [], error: '无法获取 tenant_access_token' };
      }

      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const data = await res.json() as FeishuApiResponse<{ items?: MergedForwardItem[] }>;

      if (data.code !== 0) {
        dlog(`[Feishu] getMergedForwardMessages(${messageId}) failed: ${JSON.stringify(data)}`);
        return { items: [], error: `飞书接口返回错误 (code: ${data.code}): ${data.msg || '未知错误'}` };
      }

      const items = data.data?.items || [];
      return { items };
    } catch (e: unknown) {
      const message = errorMessage(e);
      dlog(`[Feishu] getMergedForwardMessages(${messageId}) threw: ${message}`);
      return { items: [], error: `网络或未知请求异常: ${message}` };
    }
  }

  /**
   * 解析飞书群（或会话）的名称。
   *
   * 调用 `GET /open-apis/im/v1/chats/:chat_id`，返回 `data.name` 作为群名。
   * 需要应用开通 `im:chat:read`（或 `im:chat`）权限——此权限属于 otto
   * 的 REQUIRED_APP_SCOPES，正常 setup 流程已引导用户开通。
   *
   * 设计为「尽力而为」：
   *  - 成功且群名非空 → 返回群名，并写入进程内缓存（同一 chatId 不再重复请求）。
   *  - 无权限 / 接口报错 / 网络异常 / 群名为空（如私聊会话本就没有名字）
   *    → 一律返回 `null`，由调用方 fallback 到展示 chatId。
   *  - 失败**不写缓存**，以便用户补齐权限后下次重试能成功。
   *
   * @param chatId 飞书会话 ID（oc_ 开头）
   * @returns 群名字符串；无法解析时返回 null
   */
  async getChatName(chatId: string): Promise<string | null> {
    if (!chatId) return null;

    const cached = this.chatNameCache.get(chatId);
    if (cached !== undefined) {
      return cached;
    }

    await this.fetchAndCacheChatInfo(chatId);
    return this.chatNameCache.get(chatId) ?? null;
  }

  /**
   * 精确判断会话类型（飞书 chat_mode 字段）。
   *
   * 用于 TUI 仪表板友好展示——例如把"与 Bot 的私聊"（chat_mode='p2p'）
   * 与普通群聊区分开。**这是唯一可靠的判据**：p2p 单聊和群聊的 chatId
   * 都是 `oc_` 前缀，无法靠前缀或"群名是否解析得出"来区分（无名群/无权限群
   * 同样没有群名，但它们不是 p2p）。
   *
   * 与 getChatName 共用同一次 API 调用结果（chatModeCache），优先命中缓存。
   *
   * @param chatId 飞书会话 ID（oc_ 开头）
   * @returns 'p2p' | 'group' | 'topic' 等飞书 chat_mode 值；无法解析时返回 null
   */
  async getChatMode(chatId: string): Promise<string | null> {
    if (!chatId) return null;

    const cached = this.chatModeCache.get(chatId);
    if (cached !== undefined) {
      return cached;
    }

    await this.fetchAndCacheChatInfo(chatId);
    return this.chatModeCache.get(chatId) ?? null;
  }

  /**
   * 拉取飞书会话详情（GET /im/v1/chats/{chat_id}），一次请求同时填充
   * chatNameCache（仅非空群名）与 chatModeCache（chat_mode）。
   *
   * 失败 / 无权限 / 网络异常时静默不缓存，允许后续重试。
   */
  private async fetchAndCacheChatInfo(chatId: string): Promise<void> {
    try {
      const token = await this.getTenantToken();
      if (!token) return;

      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      const data = await res.json() as FeishuApiResponse<{ chat_mode?: string; name?: string }>;

      if (data.code !== 0) {
        dlog(`[Feishu] fetchChatInfo(${chatId}) failed: ${JSON.stringify(data)}`);
        return;
      }

      // chat_mode：'p2p' / 'group' / 'topic'。即便群名为空（p2p 单聊）也要缓存类型。
      const mode =
        typeof data.data?.chat_mode === 'string' ? data.data.chat_mode.trim() : '';
      if (mode) {
        this.chatModeCache.set(chatId, mode);
      }

      // 群名：p2p 单聊或无名群为空，不缓存以便调用方 fallback。
      const name = typeof data.data?.name === 'string' ? data.data.name.trim() : '';
      if (name) {
        this.chatNameCache.set(chatId, name);
      }
    } catch (e: unknown) {
      dlog(`[Feishu] fetchChatInfo(${chatId}) threw: ${errorMessage(e)}`);
    }
  }

  /**
   * 下载飞书 IM 消息中的图片资源并保存为本地临时文件
   */
  async downloadImageResource(messageId: string, imageKey: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      if (!token) return null;

      // URL 路径段必须编码（messageId / imageKey 来自外部，可能含特殊字符）。
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;

      // 体积上限：先看 Content-Length，再校验实际字节数，防止超大文件 OOM。
      const declaredLen = Number(res.headers.get('content-length') || 0);
      if (declaredLen > MAX_DOWNLOAD_BYTES) {
        dwarn(`[Feishu] downloadImageResource: declared size ${declaredLen} exceeds limit ${MAX_DOWNLOAD_BYTES}`);
        return null;
      }
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        dwarn(`[Feishu] downloadImageResource: actual size ${buffer.byteLength} exceeds limit ${MAX_DOWNLOAD_BYTES}`);
        return null;
      }
      const bytes = new Uint8Array(buffer);

      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const tempDir = os.tmpdir();
      // 🎯 按真实类型落盘（字节头优先，Content-Type 兜底），避免一律 .png
      // 导致下游 mime.lookup 推断出错误的 media_type，触发供应商 400 报错。
      const ext = detectImageExtension(bytes, res.headers.get('content-type'));
      // 安全：imageKey 来自外部事件、不可信；path.join 不折叠 ".."，须先净化防路径穿越。
      const safeKey = sanitizeResourceKey(imageKey);
      const localPath = path.join(tempDir, `feishu-image-${safeKey}${ext}`);
      await fs.promises.writeFile(localPath, Buffer.from(buffer));
      return localPath;
    } catch (e: unknown) {
      dlog(`[Feishu] downloadImageResource failed: ${errorMessage(e)}`);
      return null;
    }
  }

  /**
   * 下载飞书 IM 消息中的图片资源到指定目录。
   *
   * @param messageId 飞书消息 ID
   * @param imageKey  飞书图片资源 key
   * @param targetDir 目标目录（会自动创建）
   * @returns 本地绝对路径，失败返回 null
   */
  async downloadImageToDir(messageId: string, imageKey: string, targetDir: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      if (!token) return null;

      // URL 路径段必须编码（messageId / imageKey 来自外部，可能含特殊字符）。
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(imageKey)}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;

      // 体积上限：先看 Content-Length，再校验实际字节数，防止超大文件 OOM。
      const declaredLen = Number(res.headers.get('content-length') || 0);
      if (declaredLen > MAX_DOWNLOAD_BYTES) {
        dwarn(`[Feishu] downloadImageToDir: declared size ${declaredLen} exceeds limit ${MAX_DOWNLOAD_BYTES}`);
        return null;
      }
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        dwarn(`[Feishu] downloadImageToDir: actual size ${buffer.byteLength} exceeds limit ${MAX_DOWNLOAD_BYTES}`);
        return null;
      }
      const bytes = new Uint8Array(buffer);

      const fs = await import('node:fs');
      const path = await import('node:path');
      await fs.promises.mkdir(targetDir, { recursive: true });
      // 🎯 按真实类型落盘（字节头优先，Content-Type 兜底），避免一律 .png
      // 导致下游 mime.lookup 推断出错误的 media_type，触发供应商 400 报错。
      const ext = detectImageExtension(bytes, res.headers.get('content-type'));
      // 安全：imageKey 来自外部事件、不可信；path.join 不折叠 ".."，须先净化防路径穿越。
      const safeKey = sanitizeResourceKey(imageKey);
      const localPath = path.join(targetDir, `feishu-image-${safeKey}${ext}`);
      await fs.promises.writeFile(localPath, Buffer.from(buffer));
      return localPath;
    } catch (e: unknown) {
      dlog(`[Feishu] downloadImageToDir failed: ${errorMessage(e)}`);
      return null;
    }
  }

  /**
   * 下载飞书 IM 消息中的文件资源并保存到指定目录。
   *
   * @param messageId 飞书消息 ID
   * @param fileKey   飞书文件资源 key
   * @param fileName  原始文件名
   * @param targetDir 目标目录（会自动创建）
   * @returns 本地绝对路径，失败返回 null
   */
  async downloadFileToDir(messageId: string, fileKey: string, fileName: string, targetDir: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      if (!token) return null;

      // URL 路径段必须编码（messageId / fileKey 来自外部，可能含特殊字符）。
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) return null;

      // 体积上限：先看 Content-Length，再校验实际字节数，防止超大文件 OOM。
      const declaredLen = Number(res.headers.get('content-length') || 0);
      if (declaredLen > MAX_DOWNLOAD_BYTES) {
        dwarn(`[Feishu] downloadFileToDir: declared size ${declaredLen} exceeds limit ${MAX_DOWNLOAD_BYTES}`);
        return null;
      }
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
        dwarn(`[Feishu] downloadFileToDir: actual size ${buffer.byteLength} exceeds limit ${MAX_DOWNLOAD_BYTES}`);
        return null;
      }

      const fs = await import('node:fs');
      const path = await import('node:path');
      await fs.promises.mkdir(targetDir, { recursive: true });

      // 净化文件名，防止路径穿越和非法字符
      // 安全:外部飞书用户上传的扩展名不可信(.sh/.py/.exe 落盘后可能被 run_shell_command 执行)。
      // 仅允许常见文档/媒体扩展名,其余一律降级为 .bin,杜绝"外部用户 → 本机 RCE"。
      const ALLOWED_DOWNLOAD_EXTS = new Set([
        '.txt', '.md', '.markdown', '.pdf', '.rtf',
        '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.xml', '.log',
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic',
        '.mp3', '.wav', '.m4a', '.mp4', '.mov', '.zip',
      ]);
      const rawExt = path.extname(fileName).toLowerCase();
      const ext = ALLOWED_DOWNLOAD_EXTS.has(rawExt) ? rawExt : '.bin';
      const base = path.basename(fileName, path.extname(fileName));
      const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_');
      let safeFileName = `${safeBase}${ext}`;

      // 如果文件已存在，自动重命名以防止冲突覆盖
      let localPath = path.join(targetDir, safeFileName);
      let counter = 1;
      while (fs.existsSync(localPath)) {
        safeFileName = `${safeBase}_${counter}${ext}`;
        localPath = path.join(targetDir, safeFileName);
        counter++;
      }

      await fs.promises.writeFile(localPath, Buffer.from(buffer));
      return localPath;
    } catch (e: unknown) {
      dlog(`[Feishu] downloadFileToDir failed: ${errorMessage(e)}`);
      return null;
    }
  }

  /**
   * 连接飞书 WS 事件订阅（通过 SDK WSClient）
   *
   * SDK 自动：
   *   - pullConnectConfig (POST /callback/ws/endpoint)
   *   - 建立 WebSocket（Protobuf 帧）
   *   - ping/pong 保活
   *   - 自动重连
   */
  async connect(): Promise<void> {
    // 先清理旧连接，避免事件处理器重复触发
    await this.disconnect();

    // 🔒 跨进程互斥：同一 appId 全机只允许一个进程建立飞书长连接。
    // 进程内去重表拦不住第二个进程（server 侧 adapter 与 cli 侧 daemon 同时
    // 在跑时每条消息会被处理/回复两遍）。拿不到锁 fail-loud：抛
    // FeishuGatewayLockError（含中文说明与持有者 pid），调用方能感知并提示用户。
    this.connectionLock = acquireFeishuGatewayLock(this.appId);

    const { WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');

    const domainUrl = this.domain === 'lark'
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    // 事件分发器：只处理 im.message.receive_v1
    const dispatcher = new EventDispatcher({
      encryptKey: '',
      verificationToken: '',
      loggerLevel: 3,
    });

    dispatcher.register({
      'im.message.receive_v1': async (data: FeishuIncomingPayload) => {
      try {
        const event = data.event || (data as FeishuIncomingEvent);
        const header = data.header || {};
        const message = event.message || {};
        const sender = event.sender || {};

        // 提取消息创建时间（飞书事件 header.create_time，毫秒时间戳字符串）
        const messageCreateTime: number | undefined =
          header.create_time ? parseInt(String(header.create_time), 10) : undefined;

        // 解析文本内容，确保始终返回字符串
        let text = '';
        const msgType = message.message_type || 'text';
        // 收集待下载的图片元数据（延迟到 feishuCommand 确定 projectRoot 后统一下载）
        const pendingImages: Array<{ imageKey: string; placeholder: string }> = [];
        // 收集待下载的文件元数据（延迟到 feishuCommand 确定 projectRoot 后统一下载）
        const pendingFiles: Array<{ fileKey: string; fileName: string; placeholder: string }> = [];

        if (msgType === 'merge_forward') {
          try {
            dlog(`Received merge_forward message, fetching sub-messages for ${message.message_id}...`);
            const { items: subMessages, error } = await this.getMergedForwardMessages(message.message_id as string);
            if (subMessages && subMessages.length > 0) {
              const body = this.renderMergedForwardItems(
                message.message_id as string,
                subMessages,
                pendingImages,
                pendingFiles
              );
              text = body
                ? `📢 **[合并转发的消息记录]**\n---\n${body}`
                : `[合并转发消息，但未能解析出任何子消息内容]`;
            } else {
              text = `[合并转发消息，但未获取到任何子消息内容${error ? `。原因: ${error}` : ''}]`;
            }
          } catch (err: unknown) {
            derror(`Failed to parse merge_forward message:`, err);
            text = `[解析合并转发消息失败: ${errorMessage(err)}]`;
          }
        } else {
          text = this.parseSingleMessageContent(
            message.message_id as string,
            msgType,
            message.content as string,
            pendingImages,
            pendingFiles
          );
        }

        // 去掉 @bot 占位符
        if (event.mentions) {
          for (const m of event.mentions) {
            if (m.key) {
              text = text.replace(m.key, '').trim();
            }
          }
        }

        const chatType = message.chat_type === 'p2p' ? 'p2p' :
                         message.chat_type === 'group' ? 'group' : 'topic';

        const feishuMsg: FeishuMessage = {
          text,
          messageId: message.message_id as string,
          chatId: message.chat_id || event.conversation?.chat_id || '',
          chatType,
          senderOpenId: sender.sender_id?.open_id || sender.open_id || '',
          mentions: (event.mentions || []).map((m: { key?: string; open_id?: string }) => ({
            key: m.key as string,
            openId: m.open_id || '',
          })),
          messageType: message.message_type || 'text',
          pendingImages: pendingImages.length > 0 ? pendingImages : undefined,
          pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
          createTime: messageCreateTime && !isNaN(messageCreateTime) ? messageCreateTime : undefined,
        };

        // 陈旧消息过滤：丢弃早于连接就绪时间创建的消息（飞书重连后推送的积压旧消息）
        if (feishuMsg.createTime && this.connectedAtMs) {
          const staleThreshold = this.connectedAtMs - this.STALE_CLOCK_SKEW_MS;
          if (feishuMsg.createTime < staleThreshold) {
            const ageSec = ((this.connectedAtMs - feishuMsg.createTime) / 1000).toFixed(1);
            dlog(`Skipped stale message (created ${ageSec}s before connection): ${feishuMsg.messageId}`);
            return { code: 0 };
          }
        }

        // 消息去重：先按 messageId (包括正在执行的和已成功执行的)，再按内容+时间窗口兜底
        if (feishuMsg.messageId && feishuMsg.messageId.startsWith('om_')) {
          if (this.inFlightMessages.has(feishuMsg.messageId)) {
            dlog(`Skipped in-flight message (messageId): ${feishuMsg.messageId}`);
            return { code: 0 };
          }
          if (this.processedMessages.has(feishuMsg.messageId)) {
            dlog(`Skipped duplicate message (messageId): ${feishuMsg.messageId}`);
            return { code: 0 };
          }
        }

        const contentKey = `${feishuMsg.chatId}:${feishuMsg.text}`;
        const now = Date.now();
        const firstSeen = this.recentContents.get(contentKey);
        if (firstSeen !== undefined && now - firstSeen < this.dedupWindowMs) {
          dlog(`Skipped duplicate message (content dedup): "${feishuMsg.text.slice(0, 30)}" (within ${now - firstSeen}ms)`);
          return { code: 0 };
        }

        // 高风险操作内容哈希去重：防止 restart / self-update 等命令因飞书重发而反复执行
        if (this.checkHighRiskDedup(feishuMsg.chatId, feishuMsg.text)) {
          // 按码点截断，避免把 emoji 等代理对从中间劈开产生乱码。
          const preview = Array.from(feishuMsg.text).length > 30
            ? truncateByCodePoints(feishuMsg.text, 30) + '…'
            : feishuMsg.text;
          await this.sendMessage(feishuMsg.chatId,
            `检测到疑似重复的飞书服务端消息推送：「${preview}」，已丢弃。如果是您自己发的消息，请变换措辞重发。`);
          return { code: 0 };
        }

        // 标记为正在处理（内存级并发拦截）+ 受理即落盘（at-most-once 的核心）。
        // 关键顺序：在调用 onMessage 之前就把 id 持久化，这样即便处理途中进程被
        // self_update / 重启 / 崩溃带走，飞书之后重推也会被识别丢弃，不会重跑。
        if (feishuMsg.messageId && feishuMsg.messageId.startsWith('om_')) {
          this.inFlightMessages.add(feishuMsg.messageId);
          this.recordProcessedMessage(feishuMsg.messageId);
        }

        this.recentContents.set(contentKey, now);
        // 清理过期的内容去重记录
        for (const [key, ts] of this.recentContents) {
          if (now - ts > this.dedupWindowMs * 2) this.recentContents.delete(key);
        }
        // 硬上限兜底：洪泛（同窗口内大量不同内容）时按插入顺序淘汰最旧条目，
        // 防止 recentContents 无界增长导致内存泄漏 / OOM。
        while (this.recentContents.size > this.maxRecentContents) {
          const oldest = this.recentContents.keys().next().value;
          if (oldest === undefined) break;
          this.recentContents.delete(oldest);
        }

        try {
          // 文本选择模式：如果该 chat 正在等待用户文本回复选项，优先处理（C3：按 chatId 取回调）
          const textChoiceCb = this.textChoiceCallbacks.get(feishuMsg.chatId);
          if (textChoiceCb) {
            const consumed = textChoiceCb(feishuMsg);
            if (consumed) {
              // 该消息已被文本选择器消费，不触发 onMessage。
              // 去重已在受理时落盘（见上方 recordProcessedMessage），此处无需再记。
              return { code: 0 };
            }
          }

          if (this.onMessage) {
            // 添加"思考中"表情，让用户知道 Bot 正在处理
            const reactionId = await this.addReaction(feishuMsg.messageId, 'THINKING');
            try {
              const reply = await this.onMessage(feishuMsg);
              if (reply) {
                await this.sendMessage(feishuMsg.chatId, reply, feishuMsg.messageId);
              }
              // 去重已在受理时（调用 onMessage 之前）落盘，处理成功无需再记。
            } catch (err) {
              derror('feishu onMessage handler error:', err);
            } finally {
              // 处理完成，移除"思考中"表情
              await this.removeReaction(feishuMsg.messageId, reactionId);
            }
          }
        } finally {
          // 无论成功还是失败，只要该消息处理流程结束，就从 in-flight 集合中移除
          if (feishuMsg.messageId && feishuMsg.messageId.startsWith('om_')) {
            this.inFlightMessages.delete(feishuMsg.messageId);
          }
        }

        return { code: 0 };
      } catch (err) {
        derror('feishu event handler error:', err);
        return { code: 0 };
      }
      }
    });

    // 注册卡片按钮点击回调事件
    dispatcher.register({
      'card.action.trigger': async (data: FeishuCardActionPayload) => {
        try {
          dlog('Received card.action.trigger event, full payload:', JSON.stringify(data, null, 2));
          dlog('Current pending cardCallbacks keys:', [...this.cardCallbacks.keys()]);

          const action = data?.event?.action || data?.action || (data as FeishuCardAction);
          const openId = data?.event?.operator?.open_id
            || data?.event?.sender?.sender_id?.open_id
            || data?.operator?.open_id
            || '';
          const messageId = data?.event?.context?.open_message_id
            || data?.event?.message_id
            || data?.context?.open_message_id
            || data?.message_id
            || '';
          const rawValue = action?.value ?? action?.option ?? '';
          // action.value 是对象 { choice: "xxx" }，需要提取实际值
          const choiceValue = typeof rawValue === 'object' && rawValue !== null && 'choice' in rawValue
            ? (rawValue as { choice?: unknown }).choice
            : rawValue;
          const strValue = String(choiceValue ?? '');

          // 🎯 表单提交（form_action.type='submit'）：飞书把所有具名组件的值放在
          // action.form_value 里，键为组件 name，值为下拉选中的 value（或复选组件选中值数组）或输入框文本。
          let formValue: Record<string, string | string[]> | undefined;
          const rawFormValue = action?.form_value;
          if (rawFormValue && typeof rawFormValue === 'object') {
            formValue = {};
            for (const [k, v] of Object.entries(rawFormValue)) {
              if (Array.isArray(v)) {
                formValue[k] = v.map(item => String(item ?? ''));
              } else {
                formValue[k] = String(v ?? '');
              }
            }
          }

          dlog(`Parsed: openId=${openId}, messageId=${messageId}, strValue=${strValue}, formValue=${JSON.stringify(formValue)}`);

          const actionData: CardActionData = { value: strValue, openId, messageId, formValue };

          // 🛡️ 授权检查（C1）：卡片按钮/表单提交与消息路径同样需要授权，否则
          // 群里任何成员都能点按钮劫持本应由 owner 拍板的等待中决策。未授权者的
          // 点击一律忽略——不触发 onCardAction、不 resolve 任何等待中的 Promise
          // （让其继续等待真正授权用户的操作或自然超时）。
          const authorized = await this.isCardActionAuthorized(openId);
          if (!authorized) {
            dwarn(`[Feishu] Ignored card action from unauthorized openId=${openId} (messageId=${messageId})`);
            const chatId = data?.event?.context?.open_chat_id || data?.event?.chat_id || '';
            if (chatId) {
              await this.sendMessage(
                String(chatId),
                '🛡️ 此卡片操作仅响应授权用户，已忽略你的点击。',
              ).catch(() => {/* best effort */});
            }
            return { code: 0 };
          }

          if (messageId && this.onCardAction) {
            this.onCardAction(actionData);
          }

          // 查找是否有等待中的 Promise
          const pending = this.cardCallbacks.get(messageId);
          if (pending) {
            dlog(`Matched pending callback, resolving with: ${strValue}`);
            clearTimeout(pending.timer);
            this.cardCallbacks.delete(messageId);
            pending.resolve(actionData);
          } else {
            dlog(`No matching pending callback for messageId=${messageId}`);
          }
        } catch (err) {
          derror('Feishu card callback handler error:', err);
        }
        return { code: 0 };
      },
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const client = new WSClient({
        appId: this.appId,
        appSecret: this.appSecret,
        domain: domainUrl,
        loggerLevel: 3, // error only
        onReady: () => {
          this.connectedAtMs = Date.now();
          dlog('Feishu Bot ready');
          this._onReady?.();
          if (!settled) { settled = true; resolve(); }
        },
        onError: (err: Error) => {
          derror('Feishu WSClient error:', err.message);
          this._onDisconnect?.(err);
          if (!settled) { settled = true; reject(err); }
        },
        onReconnecting: () => {
          dlog('Feishu reconnecting...');
          // 透传给上层守护（FeishuAdapter）：SDK 掉线自愈期间状态别谎报「已连接」。
          this._onReconnecting?.();
        },
        onReconnected: () => {
          this.connectedAtMs = Date.now();
          dlog('Feishu reconnected');
          // 透传给上层守护：SDK 自愈成功，恢复「已连接」并撤掉上层重连排程。
          this._onReconnected?.();
        },
      });

      this.wsClient = client;

      // start() 返回 Promise<void>，成功时 resolve
      client.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
        if (!settled) { settled = true; reject(err); }
      });
    });
  }

  /**
   * 发送消息到飞书聊天，返回 message_id（用于后续 updateMessage）
   */
  async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const body: {
      receive_id?: string;
      msg_type: string;
      content: string;
    } = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
    if (data.code === 0) {
      return responseDataString(data, 'message_id');
    }

    // fallback: 10003 错误时尝试直接发送（不 reply）
    if (data.code === 10003 && replyToMessageId) {
      const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      const directRes = await fetch(directUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
      const directData = await directRes.json() as FeishuApiResponse<{ message_id?: string }>;
      if (directData.code === 0) {
        return responseDataString(directData, 'message_id');
      }
      derror('Feishu sendMessage failed:', JSON.stringify(directData));
    } else {
      derror('Feishu sendMessage failed:', JSON.stringify(data));
    }
    return null;
  }

  /**
   * 以应用身份向指定用户发送私聊消息。
   *
   * 与 sendMessage（需 chatId）不同，此方法使用 open_id 作为 receive_id，
   * 飞书平台会自动创建或复用与该用户的 P2P 会话。
   *
   * @param openId 目标用户的 open_id
   * @param text 消息文本
   * @returns message_id 或 null
   */
  async sendPrivateMessage(openId: string, text: string): Promise<string | null> {
    // Basic format validation: Feishu open_ids start with 'ou_'
    if (!openId || !openId.startsWith('ou_')) {
      derror(`Feishu sendPrivateMessage: invalid openId format "${openId?.slice(0, 20)}" — expected 'ou_' prefix`);
      return null;
    }
    try {
      const token = await this.getTenantToken();

      const body = {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      };

      const url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
      if (data.code === 0) {
        return responseDataString(data, 'message_id');
      }

      // Provide specific guidance for common permission errors
      const errCode = data.code;
      if (errCode === 99991400 || errCode === 99991663) {
        derror('Feishu sendPrivateMessage failed: insufficient scope (im:message:send_as_bot). The bot needs this permission to send private messages.');
      } else {
        derror('Feishu sendPrivateMessage failed:', JSON.stringify(data));
      }
      return null;
    } catch (e: unknown) {
      derror('Feishu sendPrivateMessage threw:', errorMessage(e));
      return null;
    }
  }

  /**
   * 更新已发送消息的内容（用于流式进度更新）
   *
   * 注意事项:
   *   - 只能更新 bot 自己发送的消息
   *   - 更新时需要传入完整的 content JSON
   *   - 飞书 API 有频率限制，建议调用方做 3 秒节流
   *   - 更新后消息的 msg_type 不可变（初始是 text 就一直是 text）
   *
   * @returns true=更新成功, false=更新失败
   */
  async updateMessage(messageId: string, newText: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: JSON.stringify({ text: newText }),
          }),
        },
      );
      const data = await res.json() as FeishuApiResponse;
      if (data.code !== 0) {
        dwarn(`Failed to update Feishu message: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to update Feishu message:', err);
      return false;
    }
  }

  /**
   * 撤回机器人已发送的消息
   *
   * 需要 `im:message:recall` 权限。仅能撤回机器人自己发送的消息。
   *
   * @returns true=撤回成功, false=撤回失败
   */
  async recallMessage(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        },
      );
      const data = await res.json() as FeishuApiResponse;
      if (data.code !== 0) {
        dwarn(`Failed to recall Feishu message: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to recall Feishu message:', err);
      return false;
    }
  }

  /**
   * 更新已发送消息为 Markdown 富文本（post 格式）
   *
   * 注意：msg_type 不可变，初始消息必须是 post 类型才能用此方法更新为 post 格式。
   * 如果初始消息是 text 类型，此方法会失败。
   *
   * @returns true=更新成功, false=更新失败
   */
  async updateMessageMarkdown(messageId: string, markdown: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();
      const postContent = {
        zh_cn: {
          title: '',
          content: this.mdToPostContent(markdown),
        },
      };
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: JSON.stringify(postContent),
          }),
        },
      );
      const data = await res.json() as FeishuApiResponse;
      if (data.code !== 0) {
        dwarn(`Failed to update Feishu Markdown message: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to update Feishu Markdown message:', err);
      return false;
    }
  }

  /**
   * 发送 markdown 消息（post 格式，支持富文本），返回 message_id。
   *
   * 超长内容（> {@link FEISHU_OUTBOUND_SAFE_CHARS}）自动按段落/代码块边界分片
   * 为多条顺序发送，每片带 (i/n) 标记；单片失败重试一次，仍失败记失败并返回
   * null（调用方据此上报回推失败，不再整条静默丢失）。多片时返回首片 message_id。
   */
  async sendMarkdown(chatId: string, markdown: string, replyToMessageId?: string): Promise<string | null> {
    const pieces = splitMarkdownForFeishu(markdown);
    if (pieces.length <= 1) {
      return this.sendMarkdownSingle(chatId, markdown, replyToMessageId);
    }

    let firstId: string | null = null;
    for (let i = 0; i < pieces.length; i++) {
      const marked = `**(${i + 1}/${pieces.length})**\n\n${pieces[i]}`;
      // 分片路径把抛错也归一为 null（避免中途抛错吞掉"已发出前几片"的事实），
      // 单片失败重试一次，仍失败才放弃剩余分片并整体报失败。
      const trySend = async (): Promise<string | null> => {
        try {
          return await this.sendMarkdownSingle(chatId, marked, replyToMessageId);
        } catch (e: unknown) {
          dwarn(`[Feishu] 分片 ${i + 1}/${pieces.length} 发送抛错: ${errorMessage(e)}`);
          return null;
        }
      };
      let id = await trySend();
      if (id === null) {
        dwarn(`[Feishu] 分片 ${i + 1}/${pieces.length} 发送失败，重试一次…`);
        id = await trySend();
      }
      if (id === null) {
        derror(`[Feishu] 分片 ${i + 1}/${pieces.length} 重试后仍失败，放弃剩余分片。`);
        return null;
      }
      if (firstId === null) firstId = id;
    }
    return firstId;
  }

  /** 单条 markdown 发送（不分片），sendMarkdown 的底层实现。 */
  private async sendMarkdownSingle(chatId: string, markdown: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const postContent = {
      zh_cn: {
        title: '',
        content: this.mdToPostContent(markdown),
      },
    };

    const body: {
      receive_id?: string;
      msg_type: string;
      content: string;
    } = {
      receive_id: chatId,
      msg_type: 'post',
      content: JSON.stringify(postContent),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
    if (data.code !== 0) {
      derror('Feishu sendMarkdown failed:', JSON.stringify(data));
      return null;
    }
    return responseDataString(data, 'message_id');
  }

  /**
   * 增强版 Markdown → 飞书 post 格式转换
   *
   * 支持：标题、加粗、行内代码、代码块、链接、无序/有序列表、表格
   */
  private mdToPostContent(md: string): FeishuPostParagraph[] {
    const lines = md.split('\n');
    const paragraphs: FeishuPostParagraph[] = [];
    let currentPara: FeishuPostParagraph = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];

    const flushPara = () => {
      if (currentPara.length > 0) {
        paragraphs.push(currentPara);
        currentPara = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // --- 代码块处理 ---
      if (line.trimStart().startsWith('```')) {
        if (inCodeBlock) {
          // 代码块结束
          flushPara();
          const codeText = codeBlockContent.join('\n');
          const formatted = codeText.split('\n')
            .map(l => '  ' + l)
            .join('\n');
          paragraphs.push([
            { tag: 'text', text: formatted },
          ]);
          codeBlockContent = [];
          inCodeBlock = false;
        } else {
          // 代码块开始
          flushPara();
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
        continue;
      }

      // --- 空行 = 段落分隔 ---
      if (line.trim() === '') {
        flushPara();
        continue;
      }

      // --- 标题 ---
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        flushPara();
        paragraphs.push([
          { tag: 'text', text: headingMatch[2], style: ['bold'] },
        ]);
        continue;
      }

      // --- 无序列表（- / * / +） ---
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)/);
      if (ulMatch) {
        const indent = ulMatch[1].length;
        const bullet = '  '.repeat(Math.floor(indent / 2)) + '• ';
        flushPara();
        paragraphs.push([
          { tag: 'text', text: bullet },
          ...this.parseInlineMarkdown(ulMatch[2]),
        ]);
        continue;
      }

      // --- 有序列表（1. 2. 3.） ---
      const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/);
      if (olMatch) {
        const indent = olMatch[1].length;
        const num = olMatch[2] + '. ';
        const prefix = '  '.repeat(Math.floor(indent / 2)) + num;
        flushPara();
        paragraphs.push([
          { tag: 'text', text: prefix },
          ...this.parseInlineMarkdown(olMatch[3]),
        ]);
        continue;
      }

      // --- 表格行（| ... |） ---
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        // 跳过表格分隔行（|---|---|）
        if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;
        flushPara();
        const cells = line.trim().split('|').filter(c => c.trim() !== '');
        const tableText = cells.map(c => c.trim()).join(' | ');
        paragraphs.push([
          { tag: 'text', text: tableText },
        ]);
        continue;
      }

      // --- 普通文本（含行内 Markdown） ---
      currentPara.push(...this.parseInlineMarkdown(line));
    }

    // 处理未关闭的代码块
    if (inCodeBlock && codeBlockContent.length > 0) {
      paragraphs.push([{ tag: 'text', text: codeBlockContent.join('\n') }]);
    }

    flushPara();

    if (paragraphs.length === 0) {
      paragraphs.push([{ tag: 'text', text: md }]);
    }

    return paragraphs;
  }

  /**
   * 解析行内 Markdown：加粗、行内代码、链接
   * 返回飞书 post 元素数组
   */
  private parseInlineMarkdown(text: string): FeishuPostElement[] {
    const elements: FeishuPostElement[] = [];
    // 匹配顺序：行内代码 > 链接 > 加粗
    const regex = /(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*(.+?)\*\*)/g;

    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      // match 之前的普通文本
      if (match.index > lastIndex) {
        const plain = text.slice(lastIndex, match.index);
        if (plain) elements.push({ tag: 'text', text: plain });
      }

      if (match[1]) {
        // 行内代码 `code` —— 飞书 post 富文本不支持 inlineCode style(只认
        // bold/italic/underline/lineThrough),非法 style 会致整条 post 发送失败。
        // 反引号此处已剥除,直接以纯文本呈现。
        elements.push({ tag: 'text', text: match[2] });
      } else if (match[3]) {
        // 链接 [text](url)
        elements.push({ tag: 'a', text: match[4], href: match[5] });
      } else if (match[6]) {
        // 加粗 **text**
        elements.push({ tag: 'text', text: match[7], style: ['bold'] });
      }

      lastIndex = match.index + match[0].length;
    }

    // 剩余普通文本
    if (lastIndex < text.length) {
      elements.push({ tag: 'text', text: text.slice(lastIndex) });
    }

    return elements.length > 0 ? elements : [{ tag: 'text', text }];
  }

  /**
   * 给消息添加 emoji 反应
   * @returns reaction_id（用于后续删除），失败返回空字符串
   */
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/reactions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
        },
      );
      const data = await res.json() as FeishuApiResponse<{ reaction_id?: string }>;
      if (data.code === 0 && data.data?.reaction_id) {
        return data.data.reaction_id;
      }
      if (data.code !== 0) {
        dwarn(`Failed to add reaction: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      dwarn('Failed to add reaction:', err);
    }
    return '';
  }

  /**
   * 删除消息的 emoji 反应
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!reactionId) return;
    try {
      const token = await this.getTenantToken();
      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );
      const data = await res.json() as FeishuApiResponse;
      if (data.code !== 0) {
        dwarn(`Failed to remove reaction: ${JSON.stringify(data)}`);
      }
    } catch (err) {
      dwarn('Failed to remove reaction:', err);
    }
  }

  /**
   * 上传文件到飞书，返回 file_key
   */
  async uploadFile(filePath: string, fileType: string = 'stream'): Promise<string> {
    const token = await this.getTenantToken();
    const fs = await import('fs');
    const path = await import('path');
    const fileName = path.basename(filePath);
    const fileBuffer = await fs.promises.readFile(filePath);

    const formData = new FormData();
    formData.append('file_type', fileType);
    formData.append('file_name', fileName);
    formData.append('file', new Blob([fileBuffer]), fileName);

    const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json() as FeishuApiResponse<{ file_key?: string }>;
    if (data.code !== 0) throw new Error(`Upload file failed: ${JSON.stringify(data)}`);
    return (data.data as { file_key: string }).file_key;
  }

  /**
   * 发送文件消息，返回 message_id
   */
  async sendFile(chatId: string, fileKey: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const body: {
      receive_id?: string;
      msg_type: string;
      content: string;
    } = {
      receive_id: chatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
    if (data.code !== 0) {
      derror('Feishu sendFile failed:', JSON.stringify(data));
      return null;
    }
    return responseDataString(data, 'message_id');
  }

  /**
   * 上传图片并获取 image_key
   */
  async uploadImage(imagePath: string): Promise<string> {
    const token = await this.getTenantToken();
    const fs = await import('fs');
    const fileBuffer = await fs.promises.readFile(imagePath);

    const formData = new FormData();
    formData.append('image_type', 'message');
    formData.append('image', new Blob([fileBuffer]), 'image');

    const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/images`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json() as FeishuApiResponse<{ image_key?: string }>;
    if (data.code !== 0) throw new Error(`Upload image failed: ${JSON.stringify(data)}`);
    return (data.data as { image_key: string }).image_key;
  }

  /**
   * 发送图片消息，返回 message_id
   */
  async sendImage(chatId: string, imageKey: string, replyToMessageId?: string): Promise<string | null> {
    const token = await this.getTenantToken();

    const body: {
      receive_id?: string;
      msg_type: string;
      content: string;
    } = {
      receive_id: chatId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    };

    let url = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    if (replyToMessageId) {
      url = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      delete body.receive_id;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
    if (data.code !== 0) {
      derror('Feishu sendImage failed:', JSON.stringify(data));
      return null;
    }
    return responseDataString(data, 'message_id');
  }

  /**
   * 发送交互式卡片（带按钮），返回 message_id
   *
   * @param chatId 聊天 ID
   * @param title 卡片标题
   * @param content 卡片正文（支持 markdown 子集）
   * @param buttons 按钮列表 [{ label, value }]
   * @param replyToMessageId 回复的消息 ID（可选）
   * @returns message_id 或 null
   */
  async sendCard(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    footerMetrics?: FeishuFooterMetrics, // 新增 footerMetrics 参数
    replyToMessageId?: string,
  ): Promise<string | null> {
    const token = await this.getTenantToken();

    // 构建飞书卡片 JSON
    const elements: FeishuCardElement[] = [];

    // 正文内容
    if (content) {
      elements.push({
        tag: 'markdown',
        content: optimizeMarkdownStyle(content, 1),
      });
    }

    // 按钮行（最多 4 个）
    if (buttons.length > 0) {
      elements.push({
        tag: 'action',
        actions: buttons.map((btn) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: btn.label },
          type: 'primary',
          value: { choice: btn.value },
        })),
      });
    }

    // 添加页脚
    if (footerMetrics) {
      elements.push(...buildFeishuFooterElements(footerMetrics));
    }

    const cardContent: FeishuCardObject = {
      config: { wide_screen_mode: true, streaming: true },
      elements,
    };
    if (title) {
      cardContent.header = {
        template: 'blue',
        title: { tag: 'plain_text', content: title },
      };
    }

    const contentStr = JSON.stringify(cardContent);

    // 先尝试直接发送（不 reply），因为 reply 接口对 interactive 类型可能有限制
    const body: {
      receive_id: string;
      msg_type: string;
      content: string;
    } = {
      receive_id: chatId,
      msg_type: 'interactive',
      content: contentStr,
    };

    const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;

    dlog('Feishu sendCard request:', JSON.stringify({
      url: directUrl,
      msg_type: 'interactive',
      cardContent,
    }));

    const res = await fetch(directUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
    if (data.code === 0) {
      dlog('Feishu sendCard ok, message_id:', data.data?.message_id);
      return responseDataString(data, 'message_id');
    }

    // 直接发送失败，尝试 reply 方式
    dwarn(`Feishu sendCard direct failed (code=${data.code}): ${data.msg}`);
    if (replyToMessageId) {
      const replyUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
      const replyBody: {
        msg_type: string;
        content: string;
      } = {
        msg_type: 'interactive',
        content: contentStr,
      };
      dlog('Feishu retrying sendCard via reply...');
      const replyRes = await fetch(replyUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(replyBody),
      });
      const replyData = await replyRes.json() as FeishuApiResponse<{ message_id?: string }>;
      if (replyData.code === 0) {
        dlog('Feishu sendCard reply ok, message_id:', replyData.data?.message_id);
        return responseDataString(replyData, 'message_id');
      }
      derror('Feishu sendCard reply also failed:', JSON.stringify(replyData));
    } else {
      derror('Feishu sendCard failed:', JSON.stringify(data));
    }
    return null;
  }

  /**
   * 飞书建群并拉人
   * @param name 群名称
   * @param userOpenId 要拉入群的用户 open_id
   * @returns 新创建的群聊的 chat_id, 失败返回 null
   */
  async createGroupChat(name: string, userOpenId: string): Promise<string | null> {
    try {
      const token = await this.getTenantToken();

      const body = {
        name,
        description: 'Otto 自动创建的项目专属协作群',
        user_id_list: [userOpenId],
      };

      const res = await fetch(`${this.apiBaseUrl}/open-apis/im/v1/chats?uuid=${Date.now()}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as FeishuApiResponse<{ chat_id?: string }>;
      if (data.code === 0) {
        dlog(`Successfully created group chat '${name}', chat_id: ${data.data?.chat_id}`);
        return responseDataString(data, 'chat_id');
      }
      dwarn(`Failed to create group chat: ${JSON.stringify(data)}`);
      return null;
    } catch (err) {
      derror('Error creating group chat:', err);
      return null;
    }
  }

  /**
   * 更新已发送的交互式卡片内容（PATCH）
   *
   * 卡片 msg_type 为 interactive，PATCH 时也必须传 interactive 格式的 content。
   * 常用于用户点击按钮后将卡片更新为"已选择: XXX"状态，移除按钮。
   *
   * @param messageId 要更新的卡片消息 ID
   * @param title 新卡片标题
   * @param content 新卡片正文（markdown）
   * @returns true=更新成功, false=更新失败
   */
  async updateCard(
    messageId: string,
    title: string,
    content: string,
    footerMetrics?: FeishuFooterMetrics, // 新增 footerMetrics 参数
    useSchema2?: boolean, // 若原卡片是 schema 2.0（如表单卡片），须用 schema 2.0 格式更新
  ): Promise<boolean> {
    if (!messageId) return false;
    try {
      const token = await this.getTenantToken();

      const elements: FeishuCardElement[] = [];
      if (content) {
        elements.push({ tag: 'markdown', content: optimizeMarkdownStyle(content, 1) });
      }

      // 添加页脚（仅 schema 1.0 支持；schema 2.0 表单更新时通常不需要页脚）
      if (footerMetrics && !useSchema2) {
        elements.push(...buildFeishuFooterElements(footerMetrics));
      }

      let cardContent: FeishuCardObject;
      if (useSchema2) {
        // schema 2.0 格式：body.elements（与 sendRawInteractiveCard 发送时保持一致）
        cardContent = {
          schema: '2.0',
          config: { update_multi: true, wide_screen_mode: true },
          header: title
            ? {
                template: 'green',
                title: { tag: 'plain_text', content: title },
              }
            : undefined,
          body: { elements },
        };
      } else {
        // schema 1.0 格式（默认，兼容普通流式卡片）
        cardContent = {
          config: { wide_screen_mode: true, streaming: true },
          header: title
            ? {
                template: 'green',
                title: { tag: 'plain_text', content: title },
              }
            : undefined,
          elements,
        };
      }

      const res = await fetch(
        `${this.apiBaseUrl}/open-apis/im/v1/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: JSON.stringify(cardContent),
          }),
        },
      );
      const data = await res.json() as FeishuApiResponse;
      if (data.code !== 0) {
        dwarn(`Failed to update Feishu card: ${JSON.stringify(data)}`);
        return false;
      }
      return true;
    } catch (err) {
      dwarn('Failed to update Feishu card:', err);
      return false;
    }
  }

  /**
   * 发送一个 CardKit 2.0 流式卡片，并返回流式更新接口。
   *
   * 工作流程（参考 openclaw-lark 的 streaming-card-controller）：
   *   1. cardkit.v1.card.create  →  card_id
   *   2. im.message.create/reply (msg_type=interactive, content={type:'card',data:{card_id}})  →  message_id
   *   3. （流式中多次）cardkit.v1.cardElement.content  →  增量推送到 element_id 上，飞书自带打字机动画
   *   4. （结束时）cardkit.v1.card.settings(streaming_mode:false) + cardkit.v1.card.update(终态整卡)
   *
   * 节流策略：CardKit 流式更新接口节流极低（~100ms），调用方按需节流即可。
   *
   * @param chatId            目标 chat_id
   * @param initialContent    流式起始内容（可空）
   * @param initialFooter     初始页脚 metrics（可选，渲染为 footer markdown）
   * @param replyToMessageId  回复的源消息 message_id（可选）
   * @returns                 一个会话句柄；若 CardKit 创建失败，messageId 为 null
   */
  async sendStreamingCardWithFooter(
    chatId: string,
    initialContent: string,
    initialFooterMetrics?: FeishuFooterMetrics,
    replyToMessageId?: string,
  ): Promise<{
    messageId: string | null;
    cardId: string | null;
    /**
     * 增量推送正文到 streaming_content element。content 是当前累计的完整文本（不是 delta）。
     * 飞书自动 diff 渲染打字机效果。
     */
    pushContent: (content: string) => Promise<boolean>;
    /**
     * 增量更新 footer 元素（独立于正文，使用同一 sequence 计数器）。
     */
    pushFooter: (metrics: FeishuFooterMetrics) => Promise<boolean>;
    /**
     * 结束流式：关闭 streaming_mode 并整卡覆盖一次（终态文本 + footer）。
     */
    finalize: (finalContent: string, finalFooterMetrics?: FeishuFooterMetrics) => Promise<boolean>;
  }> {
    const noopHandle = {
      messageId: null,
      cardId: null,
      pushContent: async () => false,
      pushFooter: async () => false,
      finalize: async () => false,
    };

    // 短路开关：CardKit 2.0 暂时禁用，统一走老版卡片兜底路径。
    if (!isCardKitV2Enabled()) {
      dlog('[CardKit] V2 disabled by feature flag, fallback to legacy card');
      return noopHandle;
    }

    // Step 1: cardkit.v1.card.create — 拿到 card_id
    const initialFooterText = initialFooterMetrics ? renderFooterMarkdown(initialFooterMetrics) : '';
    const initialCard = buildCardKitStreamingCard(initialContent, initialFooterText);
    const cardId = await this.createCardKitCard(initialCard);
    if (!cardId) {
      // CardKit 创建失败 — 调用方走 sendCard 兜底
      return noopHandle;
    }

    // Step 2: im.message.create/reply 引用 card_id 把卡片送进群
    const messageId = await this.sendCardKitMessage(chatId, cardId, replyToMessageId);
    if (!messageId) {
      return { ...noopHandle, cardId };
    }

    // 持有一个递增的 sequence，所有后续 cardkit.v1.* 调用共享
    let sequence = 1;
    let lastPushedContent = initialContent;
    let lastPushedFooter = initialFooterText;

    const pushContent = async (content: string): Promise<boolean> => {
      if (content === lastPushedContent) return true; // 无变化，省一次 RPC
      sequence += 1;
      const ok = await this.streamCardKitElement(cardId, CARDKIT_STREAMING_ELEMENT_ID, optimizeMarkdownStyle(content, 2) || ' ', sequence);
      if (ok) lastPushedContent = content;
      return ok;
    };

    const pushFooter = async (metrics: FeishuFooterMetrics): Promise<boolean> => {
      const next = renderFooterMarkdown(metrics);
      if (!next || next === lastPushedFooter) return true;
      sequence += 1;
      const ok = await this.streamCardKitElement(cardId, CARDKIT_FOOTER_ELEMENT_ID, next, sequence);
      if (ok) lastPushedFooter = next;
      return ok;
    };

    const finalize = async (
      finalContent: string,
      finalFooterMetrics?: FeishuFooterMetrics,
    ): Promise<boolean> => {
      // 关闭流式模式
      sequence += 1;
      await this.setCardKitStreamingMode(cardId, false, sequence);

      // 整卡更新到终态
      sequence += 1;
      const finalCard = buildCardKitFinalCard(finalContent, finalFooterMetrics);
      return await this.updateCardKitCard(cardId, finalCard, sequence);
    };

    return { messageId, cardId, pushContent, pushFooter, finalize };
  }

  // ------------------------------------------------------------------
  // CardKit 2.0 底层 API（直接 fetch /open-apis/cardkit/v1/...）
  // ------------------------------------------------------------------

  /**
   * cardkit.v1.card.create — 在飞书侧创建一张 CardKit 2.0 卡片实体。
   * 注意：此时卡片尚未发送给任何用户，需要再调 im.message.create 引用 card_id 才会显示。
   *
   * @param card 完整卡片 JSON（schema:'2.0'）
   * @returns card_id 或 null
   */
  async createCardKitCard(card: FeishuCardObject): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      const res = await fetch(`${this.apiBaseUrl}/open-apis/cardkit/v1/cards`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'card_json',
          data: JSON.stringify(card),
        }),
      });
      const data = await res.json() as FeishuApiResponse<{ card_id?: string }>;
      if (data.code !== 0) {
        derror(`Feishu cardkit.card.create failed (code=${data.code}): ${data.msg}`);
        return null;
      }
      const cardId = data.data?.card_id || null;
      dlog('Feishu cardkit.card.create ok, card_id:', cardId);
      return cardId;
    } catch (err: unknown) {
      derror('Feishu cardkit.card.create error:', errorMessage(err));
      return null;
    }
  }

  /**
   * 把已创建的 CardKit 卡片以 IM 消息的形式发送到 chat。
   * content 格式必须是 {"type":"card","data":{"card_id":"<id>"}}。
   */
  async sendCardKitMessage(
    chatId: string,
    cardId: string,
    replyToMessageId?: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      const contentStr = JSON.stringify({ type: 'card', data: { card_id: cardId } });

      // 优先 reply（如果提供），否则直接发送
      if (replyToMessageId) {
        const replyUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
        const replyRes = await fetch(replyUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            msg_type: 'interactive',
            content: contentStr,
          }),
        });
        const replyData = await replyRes.json() as FeishuApiResponse<{ message_id?: string }>;
        if (replyData.code === 0) {
          dlog('Feishu sendCardKitMessage(reply) ok, message_id:', replyData.data?.message_id);
          return responseDataString(replyData, 'message_id');
        }
        dwarn(`Feishu sendCardKitMessage(reply) failed (code=${replyData.code}): ${replyData.msg}`);
        // 落到下面的直接发送
      }

      const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      const res = await fetch(directUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: contentStr,
        }),
      });
      const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
      if (data.code === 0) {
        dlog('Feishu sendCardKitMessage(direct) ok, message_id:', data.data?.message_id);
        return responseDataString(data, 'message_id');
      }
      derror(`Feishu sendCardKitMessage failed (code=${data.code}): ${data.msg}`);
      return null;
    } catch (err: unknown) {
      derror('Feishu sendCardKitMessage error:', errorMessage(err));
      return null;
    }
  }

  /**
   * cardkit.v1.cardElement.content — 流式增量更新某个 element 的 markdown content。
   *
   * 飞书会自动对比新旧 content，按字符差异渲染打字机动画。
   * content 是 **当前完整累计文本**，不是 delta。
   *
   * @param cardId    cardkit.card.create 返回的 card_id
   * @param elementId 要更新的元素 id（常用 'streaming_content' / 'footer_content'）
   * @param content   新的完整文本
   * @param sequence  单调递增的序号；同一 card_id 上必须严格递增，否则飞书会丢包/乱序
   */
  async streamCardKitElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.apiBaseUrl}/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content, sequence }),
      });
      const data = await res.json() as FeishuApiResponse;
      if (data.code === 0) return true;

      // 速率限制（230020）— 静默跳过这一帧，不算错
      if (data.code === 230020) {
        dlog(`Feishu cardkit.cardElement.content rate limited (seq=${sequence}), skip`);
        return false;
      }
      dwarn(
        `Feishu cardkit.cardElement.content failed (code=${data.code}, seq=${sequence}): ${data.msg}`,
      );
      return false;
    } catch (err: unknown) {
      derror('Feishu cardkit.cardElement.content error:', errorMessage(err));
      return false;
    }
  }

  /**
   * cardkit.v1.card.settings — 切换 streaming_mode（开/关）。
   * 流式结束时务必调一次 streamingMode=false，否则飞书会一直保留流式视觉。
   */
  async setCardKitStreamingMode(
    cardId: string,
    streamingMode: boolean,
    sequence: number,
  ): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.apiBaseUrl}/open-apis/cardkit/v1/cards/${cardId}/settings`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          settings: JSON.stringify({ streaming_mode: streamingMode }),
          sequence,
        }),
      });
      const data = await res.json() as FeishuApiResponse;
      if (data.code === 0) return true;
      dwarn(
        `Feishu cardkit.card.settings failed (code=${data.code}, seq=${sequence}): ${data.msg}`,
      );
      return false;
    } catch (err: unknown) {
      derror('Feishu cardkit.card.settings error:', errorMessage(err));
      return false;
    }
  }

  /**
   * cardkit.v1.card.update — 整卡覆盖更新（终态用）。
   * 与 streamCardKitElement 不同，这是一次性替换整张卡片的 JSON。
   */
  async updateCardKitCard(
    cardId: string,
    card: FeishuCardObject,
    sequence: number,
  ): Promise<boolean> {
    try {
      const token = await this.getTenantToken();
      const url = `${this.apiBaseUrl}/open-apis/cardkit/v1/cards/${cardId}`;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          card: { type: 'card_json', data: JSON.stringify(card) },
          sequence,
        }),
      });
      const data = await res.json() as FeishuApiResponse;
      if (data.code === 0) return true;
      dwarn(
        `Feishu cardkit.card.update failed (code=${data.code}, seq=${sequence}): ${data.msg}`,
      );
      return false;
    } catch (err: unknown) {
      derror('Feishu cardkit.card.update error:', errorMessage(err));
      return false;
    }
  }

  /**
   * 🎯 用一张「表单卡片」一次性收集多个问题的答案（飞书 schema 2.0 form）。
   *
   * 每个问题渲染为：
   *   - 一个下拉单选框（select_static），选项含各候选项 + 一个「✏️ 其他（填空）」
   *   - 一个单行输入框（input），当用户在下拉里选「其他」时填写自定义答案
   * 卡片底部是一个统一的「提交」按钮（form_action.type='submit'）。
   *
   * 用户点提交后，飞书通过长连接推送 card.action.trigger，action.form_value
   * 一次带回所有具名组件的值。我们按 name（q{idx} / q{idx}_other）解析回每个问题。
   *
   * 飞书 WS 长连接**支持**卡片回调（card.action.trigger 是官方推荐方式），
   * 因此这是主路径。仅当卡片发送失败时，调用方应回退到文本序号模式。
   *
   * @returns 成功返回 { ok: true, answers }；卡片发送失败返回 { ok: false }。
   *          超时则 answers 里对应问题为空字符串，交由调用方判定"未回答"。
   */
  async askQuestionsViaForm(
    chatId: string,
    questions: FeishuQuestion[],
    timeoutMs: number = DEFAULT_CARD_ACTION_TIMEOUT_MS,
    replyToMessageId?: string,
  ): Promise<{ ok: boolean; answers?: FeishuQuestionAnswers; otherIdeas?: boolean }> {
    if (!questions || questions.length === 0) {
      return { ok: true, answers: {} };
    }

    const OTHER_VALUE = '__other__';
    const formName = `aq_form_${Date.now()}`;

    // 构建表单内部元素
    const formElements: FeishuCardElement[] = [];
    questions.forEach((q, idx) => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;

      // 问题标题（markdown，作为下拉框上方的说明）
      formElements.push({
        tag: 'markdown',
        content: `**${idx + 1}. ${title}**`,
      });

      // 下拉选项：候选项 + "其他（填空）"
      const options = (q.options || []).map((opt, oi) => ({
        text: {
          tag: 'plain_text',
          content: opt.description ? `${opt.label} — ${opt.description}` : opt.label,
        },
        value: `opt_${oi}`,
      }));
      options.push({
        text: { tag: 'plain_text', content: '✏️ 其他（在下方填空）' },
        value: OTHER_VALUE,
      });

      if (q.multiSelect) {
        formElements.push({
          tag: 'multi_select_static',
          name: `q${idx}`,
          placeholder: { tag: 'plain_text', content: '请选择选项（可多选）' },
          options,
          width: 'fill',
        });
      } else {
        formElements.push({
          tag: 'select_static',
          name: `q${idx}`,
          placeholder: { tag: 'plain_text', content: '请选择一个选项' },
          options,
          width: 'fill',
        });
      }

      // 自定义填空（选择"其他"时填写；其它情况留空即可）
      formElements.push({
        tag: 'input',
        name: `q${idx}_other`,
        placeholder: { tag: 'plain_text', content: '如选「其他」，请在此填写自定义答案' },
      });
    });

    // 提交按钮
    formElements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '提交' },
      type: 'primary',
      width: 'default',
      name: 'submit_btn',
      form_action_type: 'submit',
    });

    const card: FeishuCardObject = {
      schema: '2.0',
      config: { update_multi: true, wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: '请回答以下问题' },
      },
      body: {
        elements: [
          {
            tag: 'form',
            name: formName,
            elements: formElements,
          },
          // schema 2.0 中按钮是一等组件，直接放进 body.elements，通过
          // behaviors:[{type:'callback'}] 声明服务端回调。⚠️ 绝不能用
          // schema 1.0 的 { tag:'action', actions:[...] } 容器包裹——2.0 不
          // 识别该 tag，会导致整卡 JSON 校验失败、卡片发送失败而回退到纯按钮模式。
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '💡 我有其他想法' },
            type: 'default',
            width: 'fill',
            behaviors: [
              {
                type: 'callback',
                value: { choice: 'other_ideas' },
              },
            ],
          },
        ],
      },
    };

    // 发送卡片
    const messageId = await this.sendRawInteractiveCard(chatId, card, replyToMessageId);
    if (!messageId) {
      dwarn('askQuestionsViaForm: failed to send form card, caller should fallback');
      return { ok: false };
    }
    this.lastCardMessageId = messageId;

    // 等待用户提交（card.action.trigger -> form_value）
    const actionData = await new Promise<CardActionData>((resolve) => {
      const timer = setTimeout(() => {
        this.cardCallbacks.delete(messageId);
        resolve({ value: '', openId: '', messageId });
      }, timeoutMs);
      this.cardCallbacks.set(messageId, { resolve, timer });
    });

    if (actionData.value === 'other_ideas') {
      // 🎯 更新原表单卡片为反馈已收到，避免原表单一直晾着
      const updateTitle = '💡 已收到反馈';
      const updateContent = '你选择直接提供其他想法，不回答预设选项。请直接在下方输入框发送你的要求。';
      await this.updateCard(messageId, updateTitle, updateContent, undefined, true);

      return { ok: true, otherIdeas: true };
    }

    // 检查是否是由于超时而未提交
    if (!actionData.formValue && !actionData.value) {
      const updateTitle = '⏰ 等待超时 — 未收到回答';
      const updateContent = '由于在规定时间内未收到作答，该问题卡片已超时失效。';
      await this.updateCard(messageId, updateTitle, updateContent, undefined, true);

      const emptyAnswers: FeishuQuestionAnswers = {};
      questions.forEach((q) => {
        emptyAnswers[q.question] = '';
      });
      return { ok: true, answers: emptyAnswers };
    }

    // 解析 form_value → 每个问题的答案
    const formValue = actionData.formValue || {};
    const answers: FeishuQuestionAnswers = {};
    questions.forEach((q, idx) => {
      const selectedRaw = formValue[`q${idx}`];
      const otherRaw = formValue[`q${idx}_other`] || '';
      const otherText = (typeof otherRaw === 'string' ? otherRaw : '').trim();

      let answer = '';
      if (q.multiSelect) {
        const selectedArr = Array.isArray(selectedRaw)
          ? selectedRaw
          : selectedRaw
          ? [selectedRaw]
          : [];

        const subAnswers: string[] = [];
        selectedArr.forEach(sel => {
          if (sel === OTHER_VALUE) {
            if (otherText) {
              subAnswers.push(otherText);
            }
          } else if (sel.startsWith('opt_')) {
            const oi = parseInt(sel.slice(4), 10);
            const label = q.options[oi]?.label;
            if (label) {
              subAnswers.push(label);
            }
          }
        });

        // 兜底：如果没在复选框选任何东西，但在输入框填了字，作为填空答案
        if (subAnswers.length === 0 && otherText) {
          subAnswers.push(otherText);
        }

        answer = subAnswers.join(', ');
      } else {
        const selected = typeof selectedRaw === 'string' ? selectedRaw : (selectedRaw?.[0] ?? '');
        if (selected === OTHER_VALUE) {
          answer = otherText; // 用户选了"其他"，取填空内容
        } else if (selected.startsWith('opt_')) {
          const oi = parseInt(selected.slice(4), 10);
          answer = q.options[oi]?.label ?? '';
        }
        // 兜底：没选下拉但填了空，也采纳填空内容
        if (!answer && otherText) {
          answer = otherText;
        }
      }
      answers[q.question] = answer;
    });

    // 🎯 用户提交答案后，将原表单卡片更新为“已收到回答”和具体的问答内容，避免原表单一直晾着
    const summaryLines: string[] = [];
    questions.forEach((q, idx) => {
      const ans = answers[q.question] || '';
      const title = q.header ? `${q.header}: ${q.question}` : q.question;
      if (ans) {
        summaryLines.push(`**${idx + 1}. ${title}**\n回答: ${ans}`);
      } else {
        summaryLines.push(`**${idx + 1}. ${title}**\n回答: *(未回答)*`);
      }
    });

    const updateTitle = '📋 已收到回答';
    const updateContent = summaryLines.join('\n\n');
    await this.updateCard(messageId, updateTitle, updateContent, undefined, true);

    return { ok: true, answers };
  }

  /**
   * 发送「目标驱动模式（/goal）」表单卡片，收集启动 goal 所需的全部字段。
   *
   * 字段（对齐 TUI GoalWizard）：
   *   - task        目标任务（必填，多行）
   *   - forbidden   禁止事项（可选，多行）
   *   - criteria    成功判定标准（必填，多行）
   *   - hours       最少持续小时数（必填，0.5–24）
   *   - intensity   强度（steady/standard/intense，单选，默认 standard）
   *
   * 提交后通过 card.action.trigger 的 form_value 一次性回传。返回原始字段值
   * （未做业务校验——校验/重填流程由调用方控制）。超时或失败返回 { ok:false }。
   */
  async askGoalFormViaCard(
    chatId: string,
    timeoutMs: number = 10 * 60 * 1000,
    replyToMessageId?: string,
  ): Promise<{
    ok: boolean;
    fields?: {
      task: string;
      forbidden: string;
      criteria: string;
      hours: string;
      intensity: string;
    };
    timedOut?: boolean;
  }> {
    const formName = `goal_form_${Date.now()}`;

    const intensityOptions = [
      { text: { tag: 'plain_text', content: '🐢 稳健 (steady) — 慢而稳，重质量' }, value: 'steady' },
      { text: { tag: 'plain_text', content: '⚖️ 标准 (standard) — 平衡（默认）' }, value: 'standard' },
      { text: { tag: 'plain_text', content: '🔥 激进 (intense) — 快而猛，重进度' }, value: 'intense' },
    ];

    const formElements: FeishuCardElement[] = [
      {
        tag: 'input',
        name: 'task',
        label: { tag: 'plain_text', content: '🎯 目标任务（必填）' },
        input_type: 'multiline_text',
        max_length: 1000,
        placeholder: { tag: 'plain_text', content: '你希望我持续完成的目标，越具体越好' },
      },
      {
        tag: 'input',
        name: 'criteria',
        label: { tag: 'plain_text', content: '✅ 成功判定标准（必填）' },
        input_type: 'multiline_text',
        max_length: 1000,
        placeholder: { tag: 'plain_text', content: '满足什么条件才算达成目标（可验证的特征）' },
      },
      {
        tag: 'input',
        name: 'forbidden',
        label: { tag: 'plain_text', content: '🚫 禁止事项（可选）' },
        input_type: 'multiline_text',
        max_length: 1000,
        placeholder: { tag: 'plain_text', content: '过程中绝对不能做的事，留空表示无' },
      },
      {
        tag: 'input',
        name: 'hours',
        label: { tag: 'plain_text', content: '⏱️ 最少持续小时数（0.5–24，必填）' },
        input_type: 'text',
        placeholder: { tag: 'plain_text', content: '例如 2（在达标前至少持续工作的小时数）' },
      },
      // ⚠️ select_static 不支持 label 属性（飞书 code=230099 "unknown
      //    property: label"），整卡 JSON 校验失败导致发送失败。标题改用
      //    前置 markdown 元素承载（与 input 的 label 视觉对齐）。
      {
        tag: 'markdown',
        content: '**🎚️ 执行强度（默认标准）**',
      },
      {
        tag: 'select_static',
        name: 'intensity',
        placeholder: { tag: 'plain_text', content: '不选则默认 标准 (standard)' },
        options: intensityOptions,
        width: 'fill',
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🚀 启动目标模式' },
        type: 'primary',
        width: 'default',
        name: 'submit_btn',
        form_action_type: 'submit',
      },
    ];

    const card: FeishuCardObject = {
      schema: '2.0',
      config: { update_multi: true, wide_screen_mode: true },
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '🎯 目标驱动模式 — 填写目标契约' },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content:
              '填写后点击「🚀 启动目标模式」，我将开启 **YOLO 自动执行**，' +
              '在达成目标前持续工作、不轻易停止。\n*（启动后可随时用 `/goal clear` 结束）*',
          },
          {
            tag: 'form',
            name: formName,
            elements: formElements,
          },
        ],
      },
    };

    const messageId = await this.sendRawInteractiveCard(chatId, card, replyToMessageId);
    if (!messageId) {
      dwarn('askGoalFormViaCard: failed to send goal form card');
      return { ok: false };
    }
    this.lastCardMessageId = messageId;

    // 等待用户提交
    const actionData = await new Promise<CardActionData>((resolve) => {
      const timer = setTimeout(() => {
        this.cardCallbacks.delete(messageId);
        resolve({ value: '', openId: '', messageId });
      }, timeoutMs);
      this.cardCallbacks.set(messageId, { resolve, timer });
    });

    // 超时未提交
    if (!actionData.formValue && !actionData.value) {
      await this.updateCard(
        messageId,
        '⏰ 等待超时',
        '由于在规定时间内未提交目标表单，已取消本次目标模式启动。',
        undefined,
        true,
      );
      return { ok: false, timedOut: true };
    }

    const formValue = actionData.formValue || {};
    const pick = (k: string): string => {
      const v = formValue[k];
      if (Array.isArray(v)) return (v[0] ?? '').trim();
      return (typeof v === 'string' ? v : '').trim();
    };

    return {
      ok: true,
      fields: {
        task: pick('task'),
        forbidden: pick('forbidden'),
        criteria: pick('criteria'),
        hours: pick('hours'),
        intensity: pick('intensity'),
      },
    };
  }

  /**
   * 发送一张原始 interactive 卡片（card JSON 直传），返回 message_id。
   * 与 sendCard 不同，这里直接发送调用方构造好的完整 card 对象（含 schema 2.0）。
   */
  async sendRawInteractiveCard(
    chatId: string,
    card: FeishuCardObject,
    replyToMessageId?: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantToken();
      const contentStr = JSON.stringify(card);

      // 优先直接发送
      const directUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      const res = await fetch(directUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: contentStr,
        }),
      });
      const data = await res.json() as FeishuApiResponse<{ message_id?: string }>;
      if (data.code === 0) {
        dlog('Feishu sendRawInteractiveCard ok, message_id:', data.data?.message_id);
        return responseDataString(data, 'message_id');
      }

      dwarn(`Feishu sendRawInteractiveCard direct failed (code=${data.code}): ${data.msg}`);
      // reply 兜底
      if (replyToMessageId) {
        const replyUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages/${replyToMessageId}/reply`;
        const replyRes = await fetch(replyUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ msg_type: 'interactive', content: contentStr }),
        });
        const replyData = await replyRes.json() as FeishuApiResponse<{ message_id?: string }>;
        if (replyData.code === 0) {
          dlog('Feishu sendRawInteractiveCard(reply) ok, message_id:', replyData.data?.message_id);
          return responseDataString(replyData, 'message_id');
        }
        derror('Feishu sendRawInteractiveCard reply also failed:', JSON.stringify(replyData));
      }
      return null;
    } catch (err: unknown) {
      derror('Feishu sendRawInteractiveCard error:', errorMessage(err));
      return null;
    }
  }

  /**
   * 发送卡片并等待用户点击按钮
   *
   * 飞书 WS 长连接**支持**卡片回调（card.action.trigger 是官方推荐方式）。
   * 本方法先发交互卡片，再在 cardCallbacks 注册等待点击；超时或卡片发送失败
   * 时回退到文本序号选择模式，保证在任何情况下都能拿到用户输入。
   *
   * @returns 用户选择的按钮 value，超时返回 defaultValue
   */
  async waitForCardAction(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs: number = DEFAULT_CARD_ACTION_TIMEOUT_MS,
    replyToMessageId?: string,
  ): Promise<string> {
    // 1) 先尝试发交互卡片
    const messageId = await this.sendCard(
      chatId,
      title,
      content,
      buttons,
      undefined,
      replyToMessageId,
    );

    // 2) 卡片发送失败 → 回退文本序号模式
    if (!messageId) {
      dwarn('waitForCardAction: sendCard failed, falling back to text-choice mode');
      return this.waitForTextChoice(chatId, title, content, buttons, defaultValue, timeoutMs);
    }
    this.lastCardMessageId = messageId;

    // 3) 注册等待点击
    const actionData = await new Promise<CardActionData>((resolve) => {
      const timer = setTimeout(() => {
        this.cardCallbacks.delete(messageId);
        resolve({ value: defaultValue, openId: '', messageId });
      }, timeoutMs);
      this.cardCallbacks.set(messageId, { resolve, timer });
    });

    return actionData.value || defaultValue;
  }

  /**
   * 文本选择模式：发送选项列表（markdown），等待用户回复匹配
   *
   * 因为飞书 WebSocket 长连接不支持卡片回调（card.action.trigger），
   * 这是唯一可用的交互方式。用户回复序号或选项名称来选择。
   *
   * 匹配逻辑：用户回复的文本与按钮 label 不区分大小写匹配。
   * 如果超时，返回 defaultValue。
   */
  private async waitForTextChoice(
    chatId: string,
    title: string,
    content: string,
    buttons: Array<{ label: string; value: string }>,
    defaultValue: string,
    timeoutMs: number,
  ): Promise<string> {
    // 构建 markdown 格式的选项列表
    const lines = [`**${title || '请选择'}**\n`];

    // 🎨 完美对齐：如果 LLM 给出了选项的详细描述/问题解析（content），必须要完整、清晰地展示给用户看，避免信息丢失！
    if (content && content.trim()) {
      lines.push(`${content.trim()}\n`);
    }

    buttons.forEach((btn, i) => {
      lines.push(`> **${i + 1}**. ${btn.label}`);
    });
    lines.push('\n请回复序号或选项名称进行选择。');
    const textContent = lines.join('\n');

    const buttonMap = new Map<string, string>();
    // label → value 映射（不区分大小写）
    buttons.forEach((btn) => {
      buttonMap.set(btn.label.toLowerCase(), btn.value);
    });
    // 序号 → value 映射
    buttons.forEach((btn, i) => {
      buttonMap.set(String(i + 1), btn.value);
    });

    // 先发送选项列表（在 Promise 之外 await，避免 async-executor 反模式：
    // 旧实现 `new Promise(async ...)` 中 sendMarkdown 抛错会被吞掉、resolve 永不触发，
    // 导致等待方永久挂起）。发送失败不阻断——仍注册监听，让用户主动回复也能继续。
    try {
      await this.sendMarkdown(chatId, textContent);
    } catch (e: unknown) {
      dwarn(`[Feishu] waitForTextChoice: sendMarkdown failed: ${errorMessage(e)}`);
    }

    return new Promise<string>((resolve) => {
      // 监听下一条来自同一聊天的消息（C3：按 chatId 注册，仅消费本 chat 回复）
      const timer = setTimeout(() => {
        this.textChoiceCallbacks.delete(chatId);
        resolve(defaultValue);
      }, timeoutMs);

      this.textChoiceCallbacks.set(chatId, (msg: FeishuMessage) => {
        if (msg.chatId !== chatId) return false;
        const reply = msg.text.trim();
        // 尝试匹配
        const matched = buttonMap.get(reply.toLowerCase());
        if (matched !== undefined) {
          clearTimeout(timer);
          this.textChoiceCallbacks.delete(chatId);
          resolve(matched);
          return true; // 已消费该消息
        }
        // 不匹配的回复，不做处理（交给主消息循环）
        return false;
      });
    });
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    // 清理所有等待中的卡片回调（以空数据 resolve，让等待方走"未回答"分支）
    for (const [, pending] of this.cardCallbacks) {
      clearTimeout(pending.timer);
      pending.resolve({ value: '', openId: '', messageId: '' });
    }
    this.cardCallbacks.clear();

    // 清理所有文本选择回调（C3：按 chatId 分桶）
    this.textChoiceCallbacks.clear();

    if (this.wsClient) {
      try {
        this.wsClient.stop?.();
      } catch {
        // ignore
      }
      this.wsClient = null;
    }

    // 释放跨进程连接锁（幂等，只删本进程写入的锁文件）。
    if (this.connectionLock) {
      this.connectionLock.release();
      this.connectionLock = null;
    }
  }
}
