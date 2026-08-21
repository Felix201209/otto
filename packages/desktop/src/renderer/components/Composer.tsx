/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 底部输入区。spec §底部输入区：
 *   圆角输入框（占位「给 Otto 发送消息...」）+ model 选择器 pill（反映真实生效模型 ▾）
 *   + 回形针附件 + amber 圆形发送（↑），生成中发送按钮变「停止」。
 *
 * model pill 点击弹出可用模型菜单（来自协议 models_list）。pill 文字取 currentModel
 * （models_list/currentModel 帧）对应名，无则回退首个可用模型，不硬编码模型名。
 * Enter 发送、Shift+Enter 换行。
 *
 * 斜杠命令：textarea 以 `/` 开头且在首行时浮出命令面板（SlashCommands 组件）。
 * 面板打开时 Enter/Tab = 执行选中命令、方向键选择、Esc 关闭；面板关闭时 Enter 才发送。
 * 命令本地执行（新建/清空/开模型菜单/开设置），不经过 onSend 发给模型。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import * as transport from '../transport.js';
import type { Attachment } from '../state/useOttoStore.js';
import {
  fileToAttachment,
  isImageAttachment,
  attachmentToDataUrl,
  MAX_ATTACHMENTS,
} from '../lib/image.js';
import {
  SlashCommands,
  filterCommands,
  parseSlashQuery,
  splitSlashInput,
  type SlashCommand,
} from './SlashCommands.js';
import {
  IconChevronDown,
  IconPaperclip,
  IconArrowUp,
  IconCheck,
  IconCheckCheck,
  IconWarning,
  IconSettings,
  IconStop,
  IconClose,
  IconFolder,
} from './icons.js';

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取剪贴板文字失败'));
    reader.readAsText(blob);
  });
}

/**
 * 模型菜单超过此数量才显示搜索框 + 按 provider 分组。BYO-key 用户接多个
 * provider 后列表会很长，少量模型时平铺更省事，无需搜索噪声。
 */
const MODEL_SEARCH_THRESHOLD = 8;

function attachmentKey(attachment: Attachment): string {
  if ('id' in attachment) return attachment.id;
  if ('folderPath' in attachment) return `folder-${attachment.folderPath}-${attachment.folderName}`;
  return `file-${attachment.filePath}-${attachment.fileName}`;
}

/** 图片协议本身不要求路径，但桌面端会为用户明确选择/拖入的图片保留路径用于展示。 */
function attachmentLocalPath(attachment: Attachment): string | null {
  if ('folderPath' in attachment) return attachment.folderPath;
  const value = (attachment as Attachment & { filePath?: string }).filePath;
  return typeof value === 'string' && value.trim() ? value : null;
}

function attachmentName(attachment: Attachment): string {
  return 'folderName' in attachment ? attachment.folderName : attachment.fileName;
}

function isFolderAttachment(attachment: Attachment): boolean {
  return 'folderPath' in attachment;
}

function attachmentTypeLabel(fileName: string): string {
  const ext = fileName.split('.').pop()?.trim().toLowerCase();
  if (!ext || ext === fileName.toLowerCase()) return '文件';
  if (ext === 'pdf') return 'PDF 文档';
  if (ext === 'doc' || ext === 'docx') return 'Word 文档';
  if (ext === 'ppt' || ext === 'pptx') return 'PPT 演示';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'Excel 表格';
  return ext.toUpperCase().slice(0, 5);
}

function attachmentTypeKey(fileName: string): string {
  const ext = fileName.split('.').pop()?.trim().toLowerCase();
  if (!ext || ext === fileName.toLowerCase()) return 'FILE';
  if (ext === 'pdf') return 'PDF';
  if (ext === 'doc' || ext === 'docx') return 'WORD';
  if (ext === 'ppt' || ext === 'pptx') return 'PPT';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'EXCEL';
  return ext.toUpperCase().slice(0, 5);
}

function attachmentFileName(fileName: string): string {
  const lastDot = fileName.lastIndexOf('.');
  if (lastDot <= 0) return fileName;
  return fileName.slice(0, lastDot);
}

function formatAttachmentSize(bytes: number | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * 首批斜杠命令定义（顺序即面板展示顺序）。执行分派见 runSlashCommand。
 * 导出给右侧面板「工具」tab 复用作数据源（RightPanel），避免两处维护命令清单。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'new', description: '新建会话', action: 'local' },
  { id: 'model', description: '打开模型菜单', action: 'local' },
  { id: 'clear', description: '清空当前会话上下文', action: 'local' },
  { id: 'settings', description: '打开设置面板', action: 'local' },
  { id: 'help', description: '查看全部可用命令', action: 'local' },
  { id: 'doctor', description: '依赖体检（pandoc/ffmpeg 等外部工具）', action: 'local' },
  // /memory 混合行为：裸调开「记忆」面板（保留旧肌肉记忆）；带 show/add/refresh/list
  // 参数时交给 server 命令层直接执行（对齐 CLI /memory 子命令）。
  {
    id: 'memory',
    description: '记忆：裸调开面板；子命令直接执行',
    action: 'server',
    bareLocal: true,
    usage: 'memory show|add|refresh|list …',
  },
  { id: 'skills', description: '浏览已装技能库', action: 'local' },
  { id: 'export', description: '导出当前会话为 Markdown', action: 'local' },
  { id: 'copy', description: '复制最近一条 Otto 回复', action: 'local' },
  { id: 'session', description: '浏览/检索全部会话', action: 'local' },
  { id: 'theme', description: '界面与偏好设置（对齐 CLI /theme）', action: 'local' },
  { id: 'config', description: '偏好设置（agent 风格 / 语言等）', action: 'local' },
  { id: 'hooks', description: '打开 hooks 文档', action: 'local' },
  { id: 'desktop', description: '启动/修复桌面端 Otto', action: 'prompt', prompt: '请检查并修复 Otto 桌面端：构建 renderer/main/preload，重新打包 Electron，覆盖 /Applications/Otto.app，并验证界面是否为最新。' },
  // 飞书全家桶：真实动作（配置面板 / REST 启停），不再发提示词让 AI 代办。
  { id: 'feishu', description: '飞书接入：配置凭证 / 查看状态', action: 'local' },
  { id: 'feishu-start', description: '启动飞书网关（立即执行）', action: 'local' },
  { id: 'feishu-stop', description: '停止飞书网关（立即执行）', action: 'local' },
  { id: 'feishu-status', description: '查看飞书连接状态', action: 'local' },
  { id: 'multi-channel', description: '检查微信/企微/钉钉多渠道', action: 'prompt', prompt: '请检查 Otto 的多渠道能力：微信、企业微信、钉钉、飞书适配器和 multi_channel 工具是否可用。' },
  { id: 'ppt', description: 'PPT 创作专家', action: 'agent', agentProfileId: 'ppt' },
  { id: 'doc', description: '文档写作专家', action: 'agent', agentProfileId: 'doc' },
  { id: 'pdf', description: 'PDF 处理专家', action: 'agent', agentProfileId: 'pdf' },
  { id: 'audio', description: '音视频转文本/纪要', action: 'prompt', prompt: '我要处理音视频或会议录音。请调用会议纪要/转录流程，先询问文件、参会人和输出格式。' },
  { id: 'excel', description: 'Excel 数据表格专家', action: 'agent', agentProfileId: 'sheet' },
  { id: 'research', description: '市场/竞品调研', action: 'prompt', prompt: '我要做市场或竞品调研。请调用市场调研专家流程，先询问行业、对象、竞品和决策目标。' },
  { id: 'browser', description: '内置浏览器/网页自动化', action: 'prompt', prompt: '请打开或使用内置浏览器/网页自动化能力。先询问目标网址和要完成的操作。' },
  { id: 'ide', description: '内置 IDE / 代码任务', action: 'prompt', prompt: '请进入代码任务模式。先检查当前项目结构，询问要实现或修复的目标，然后给出计划。' },
  { id: 'workflow', description: '启动 workflow 任务', action: 'prompt', prompt: 'workflow 请根据我的目标创建并执行一个完整工作流。先问我目标、输入材料、输出格式和约束。' },
];

/**
 * 右侧面板「工具」tab → Composer 的填入桥。走自定义事件而非 props：
 * Composer 深居 ChatView 之下，为一条注入通路把 draft/draftNonce 逐层穿透
 * App→ChatView→Composer 不值当；派发函数与事件监听同在本文件维护，耦合可见。
 */
const COMPOSER_INSERT_EVENT = 'otto:composer-insert';

/** 把一段文本填入底部输入框（只填入不发送，随后聚焦）。供 RightPanel 工具列表点击调用。 */
export function insertComposerDraft(text: string): void {
  window.dispatchEvent(
    new CustomEvent<string>(COMPOSER_INSERT_EVENT, { detail: text }),
  );
}

interface ComposerProps {
  models: ModelInfo[];
  currentModel: string | null;
  /** 当前选中会话 id：切换会话后据此自动聚焦 textarea，避免手动再点一下。 */
  sessionId?: string | null;
  /** 整体禁用（无选中会话）：textarea 与发送按钮都禁用。 */
  disabled?: boolean;
  /** 禁用原因，显示在输入框与按钮提示中。 */
  disabledReason?: string;
  /**
   * 流式生成中。busy 时 textarea 仍可输入下一条，发送按钮变「停止」按钮调 onCancel。
   * 与 disabled 解耦：disabled 锁全部，busy 只改发送按钮形态。
   */
  busy?: boolean;
  onSend: (text: string, attachments: Attachment[]) => void;
  /** 中止当前流式生成（busy 时停止按钮调用）。 */
  onCancel?: () => void;
  onSetModel: (model: string) => void;
  /** 受控初值（空态示例胶囊点击后注入草稿）。 */
  draft?: string;
  /** 注入序号：每次递增触发再注入（支持连点同一胶囊）。 */
  draftNonce?: number;
  /** 「在设置里管理模型」入口（接 Issue #7）。未传则不渲染该入口。 */
  onManageModels?: () => void;
  /** 斜杠命令 `/new`：新建会话（App 已有 handleNewChat）。未传则该命令不可用。 */
  onNewChat?: () => void;
  /** 斜杠命令 `/clear`：清空当前会话上下文。未传则该命令不可用。 */
  onClearContext?: () => void;
  /** 斜杠命令 `/settings`：打开设置面板（App 已有 onOpenSetup）。未传则该命令不可用。 */
  onOpenSettings?: () => void;
  /** 斜杠命令 `/doctor`：打开设置与诊断中心的「依赖体检」tab。 */
  onOpenDoctor?: () => void;
  /** 斜杠命令 `/feishu` 系列：打开设置与诊断中心的「飞书接入」tab。 */
  onOpenFeishu?: () => void;
  /** 斜杠命令 `/memory`：打开设置与诊断中心的「记忆」tab。 */
  onOpenMemory?: () => void;
  /** 斜杠命令 `/skills`：打开设置与诊断中心的「技能库」tab。 */
  onOpenSkills?: () => void;
  /** 斜杠命令 `/export`：导出当前会话为 Markdown（真实落盘）。 */
  onExport?: () => void;
  /**
   * 命令表（本地 + server 合并后的完整清单）。缺省用本地 SLASH_COMMANDS——
   * App 在收到 slash_commands_list 帧后经 mergeServerCommands 传入合并版。
   */
  commands?: readonly SlashCommand[];
  /** action='server' 命令：经 run_slash_command 帧交 server 执行（name + 原始 args）。 */
  onRunServerCommand?: (name: string, args: string) => void;
  /** 斜杠命令 `/theme` `/config`：打开设置与诊断中心的「偏好」tab。 */
  onOpenPrefs?: () => void;
  /** 斜杠命令 `/session`：打开「查看全部对话」检索面板。 */
  onOpenSessions?: () => void;
  /** 斜杠命令 `/copy`：复制最近一条 Otto 回复到剪贴板。 */
  onCopyLast?: () => void;
  /** 斜杠命令 `/help`：在聊天区展示命令总览（系统气泡）。 */
  onShowHelp?: () => void;
  /** 专家命令（如 /ppt）：新建绑定服务端 profile 的会话。 */
  onLaunchAgentProfile?: (profileId: string, title: string) => void;
}

export function Composer({
  models,
  currentModel,
  sessionId,
  disabled,
  disabledReason,
  busy = false,
  onSend,
  onCancel,
  onSetModel,
  draft,
  draftNonce,
  onManageModels,
  onNewChat,
  onClearContext,
  onOpenSettings,
  onOpenDoctor,
  onOpenFeishu,
  onOpenMemory,
  onOpenSkills,
  onExport,
  commands = SLASH_COMMANDS,
  onRunServerCommand,
  onOpenPrefs,
  onOpenSessions,
  onCopyLast,
  onShowHelp,
  onLaunchAgentProfile,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [authorizationOpen, setAuthorizationOpen] = useState(false);
  const [initialAuthorizationPreference] = useState(() => {
    const stored = localStorage.getItem('otto.authorization.global-auto');
    return {
      globalAuto: stored === '1',
      // 缺失或非法值可能来自旧版错误默认；首次获得会话时必须纠正服务端。
      needsManualMigration: stored !== '0' && stored !== '1',
    };
  });
  const [globalAuto, setGlobalAuto] = useState(initialAuthorizationPreference.globalAuto);
  const authorizationMigrationPendingRef = useRef(
    initialAuthorizationPreference.needsManualMigration,
  );
  const [sessionAuthorization, setSessionAuthorization] = useState<Record<string, 'manual' | 'auto'>>({});
  const authorizationStateRef = useRef({ globalAuto, sessionAuthorization });
  authorizationStateRef.current = { globalAuto, sessionAuthorization };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentSizes, setAttachmentSizes] = useState<Record<string, number>>({});
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // 斜杠命令面板：当前高亮项下标。面板是否可见由 slashCommands.length>0 && !disabled 决定。
  const [slashIndex, setSlashIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const authorizationKind = globalAuto
    ? 'global'
    : sessionId && sessionAuthorization[sessionId] === 'auto'
      ? 'session'
      : 'manual';
  const authorizationLabel = authorizationKind === 'global'
    ? '所有会话自动'
    : authorizationKind === 'session'
      ? '当前会话自动'
      : '手动授权';

  React.useEffect(() => {
    if (!sessionId) return;
    if (globalAuto) {
      transport.send({
        type: 'set_authorization_mode',
        payload: { sessionId, mode: 'auto', scope: 'all' },
      });
      return;
    }

    if (!authorizationMigrationPendingRef.current) return;
    // 在发送前完成本地迁移，StrictMode 重放 effect 时也只会执行一次。
    authorizationMigrationPendingRef.current = false;
    localStorage.setItem('otto.authorization.global-auto', '0');
    transport.send({
      type: 'set_authorization_mode',
      payload: { sessionId, mode: 'manual', scope: 'all' },
    });
  }, [globalAuto, sessionId]);

  React.useEffect(() => {
    const departingSessionId = sessionId;
    return () => {
      const state = authorizationStateRef.current;
      if (departingSessionId
        && !state.globalAuto
        && state.sessionAuthorization[departingSessionId] === 'auto') {
        transport.send({
          type: 'set_authorization_mode',
          payload: { sessionId: departingSessionId, mode: 'manual', scope: 'session' },
        });
      }
    };
  }, [sessionId]);

  const pickAuthorization = (kind: 'manual' | 'session' | 'global'): void => {
    if (!sessionId) return;
    if (kind === 'global') {
      localStorage.setItem('otto.authorization.global-auto', '1');
      setGlobalAuto(true);
      setSessionAuthorization({});
      transport.send({ type: 'set_authorization_mode', payload: { sessionId, mode: 'auto', scope: 'all' } });
    } else if (kind === 'session') {
      const wasGlobal = globalAuto;
      localStorage.setItem('otto.authorization.global-auto', '0');
      setGlobalAuto(false);
      if (wasGlobal) {
        transport.send({
          type: 'set_authorization_mode',
          payload: { sessionId, mode: 'manual', scope: 'all' },
        });
      }
      setSessionAuthorization((prev) => ({ ...prev, [sessionId]: 'auto' }));
      transport.send({ type: 'set_authorization_mode', payload: { sessionId, mode: 'auto', scope: 'session' } });
    } else {
      const wasGlobal = globalAuto;
      localStorage.setItem('otto.authorization.global-auto', '0');
      setGlobalAuto(false);
      setSessionAuthorization((prev) => ({ ...prev, [sessionId]: 'manual' }));
      transport.send({
        type: 'set_authorization_mode',
        payload: { sessionId, mode: 'manual', scope: wasGlobal ? 'all' : 'session' },
      });
    }
    setAuthorizationOpen(false);
  };

  // 由当前文本解析斜杠命令 query，再过滤出候选。无会话（disabled）时不弹面板。
  // parseSlashQuery=null → 非命令输入态；候选为空 → 无匹配（如 `/xyz`），也不显示面板。
  //
  // 参数态（splitSlashInput.argMode）：命令名后已敲空白（如 `/kb search 报销`）
  // → 不再按整串前缀过滤（那会让 `/kb ` 一敲空格面板就消失），而是锁定命令名
  // **精确命中**的那条命令，空白后的文本作为 args 原样保留、Enter 时随命令发送。
  const slashQuery = disabled ? null : parseSlashQuery(text);
  const slashInput = slashQuery == null ? null : splitSlashInput(slashQuery);
  const slashCommands = useMemo(() => {
    if (slashInput == null) return [];
    if (!slashInput.argMode) return filterCommands(commands, slashInput.head);
    const exact = commands.find(
      (c) => c.id.toLowerCase() === slashInput.head.toLowerCase(),
    );
    return exact ? [exact] : [];
    // slashInput 每次 render 由 text 重建（引用恒变），依赖取其字段而非对象本身。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashInput?.head, slashInput?.argMode, commands]);
  const slashOpen = slashCommands.length > 0;
  // query 变化后把高亮夹回合法范围（候选变少时 slashIndex 可能越界）。
  const activeSlash =
    slashCommands.length > 0
      ? Math.min(slashIndex, slashCommands.length - 1)
      : 0;

  // 关闭面板 = 清空输入里的斜杠命令文本（面板本就随文本存在，单纯"关"要移除触发文本）。
  // 但 Esc 的语义是"我不想用命令了"：保留已输入文本、仅收起面板不自然，
  // 这里用一个显式的 dismissed 标志更稳妥。见 slashDismissed。
  const [slashDismissed, setSlashDismissed] = useState(false);
  // 面板真正可见：有候选、未被 Esc 主动关闭。文本再变化（onChange）会复位 dismissed。
  const slashVisible = slashOpen && !slashDismissed;

  // —— 每会话草稿隔离 ——
  // Composer 是底部输入区的全局单例，切换会话时组件不卸载、text state 原样留存；
  // 若不隔离，会话 A 里没发出去的草稿会串进会话 B（本次修的 bug）。用一张
  // sessionId→草稿 表，在「会话切换的那一次 render」里存下旧会话草稿、取出新会话草稿，
  // 让每个会话各记各的待发送内容。走 React 官方「prop 变化时同步调整 state」模式：
  // 有条件守卫（sessionId 变了才跑），React 立即丢弃本次输出并用新 state 重渲染，不额外 paint、无闪烁。
  const draftsRef = useRef<Record<string, string>>({});
  const [draftSessionId, setDraftSessionId] = useState<
    string | null | undefined
  >(sessionId);
  // 附件草稿隔离：同文本草稿，sessionId→attachments 表，切换会话时存旧取新。
  const attachmentsRef = useRef<Record<string, Attachment[]>>({});
  if (sessionId !== draftSessionId) {
    // 存下上一个会话此刻的草稿（无会话 id 时不存，避免以 '' 之类的键污染表）。
    if (draftSessionId != null) {
      draftsRef.current[draftSessionId] = text;
      attachmentsRef.current[draftSessionId] = attachments;
    }
    // 恢复目标会话的草稿；从未输入过则为空。切走再切回可原样复现。
    setText(sessionId != null ? draftsRef.current[sessionId] ?? '' : '');
    setAttachments(sessionId != null ? attachmentsRef.current[sessionId] ?? [] : []);
    // 会话变了，斜杠命令面板的高亮 / 关闭态一并复位，别把上个会话的命令态带进来。
    setSlashIndex(0);
    setSlashDismissed(false);
    setDraftSessionId(sessionId);
  }

  /** 浏览器 File（拖拽/隐藏 input/剪贴板图片）统一走同一条校验与路径解析。 */
  const addBrowserFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    setAttaching(true);
    let firstError: string | null = null;
    const added: Attachment[] = [];
    const addedSizes: Record<string, number> = {};
    for (const file of files.slice(0, room)) {
      try {
        // Electron 43 已移除 File.path；可信 preload 用 webUtils 提取路径，
        // 再交 main 进程授权账本登记。renderer 始终拿不到裸 grant IPC。
        // 剪贴板图片没有本地路径，但图片会转为内联 base64，可安全降级。
        let resolvedPath = '';
        try {
          resolvedPath = await window.otto.authorizeFileForAttachment(file);
        } catch (error) {
          if (!file.type.toLowerCase().startsWith('image/')) throw error;
        }
        const attachment = await fileToAttachment(file, resolvedPath);
        added.push(attachment);
        addedSizes[attachmentKey(attachment)] = file.size;
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof Error ? err.message : '附件处理失败';
        }
      }
    }
    if (added.length > 0) {
      setAttachments((prev) => [...prev, ...added]);
      setAttachmentSizes((prev) => ({ ...prev, ...addedSizes }));
    }
    setAttachError(
      firstError ??
        (files.length > room ? `一次最多添加 ${MAX_ATTACHMENTS} 个附件` : null),
    );
    setAttaching(false);
  }, [attachments.length]);

  const pickFiles = useCallback(() => {
    setAttachError(null);
    // 优先使用原生文件选择器（获取完整路径）
    if (window.otto?.selectFiles) {
      void (async () => {
        try {
          const paths = await window.otto.selectFiles();
          if (paths.length === 0) return;
          const room = MAX_ATTACHMENTS - attachments.length;
          if (room <= 0) {
            setAttachError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`);
            return;
          }
          setAttaching(true);
          const added: Attachment[] = [];
          const addedSizes: Record<string, number> = {};
          let firstError: string | null = null;
          for (const filePath of paths.slice(0, room)) {
            try {
              const result = await window.otto.readFilePath(filePath);
              const ext = result.fileName.split('.').pop()?.toLowerCase() ?? '';
              const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
              if (imgExts.includes(ext)) {
                const attachment: Attachment = {
                  id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  fileName: result.fileName,
                  data: result.data,
                  mimeType: result.mimeType,
                  originalSize: result.size,
                  compressedSize: result.size,
                  filePath: result.filePath,
                } as Attachment & { filePath: string };
                added.push(attachment);
              } else {
                added.push({
                  fileName: result.fileName,
                  filePath: result.filePath,
                });
              }
              addedSizes[result.filePath] = result.size;
            } catch (err) {
              if (!firstError) firstError = err instanceof Error ? err.message : '文件读取失败';
            }
          }
          if (added.length > 0) {
            setAttachments((prev) => [...prev, ...added]);
            setAttachmentSizes((prev) => ({ ...prev, ...addedSizes }));
          }
          setAttachError(
            firstError ??
              (paths.length > room ? `一次最多添加 ${MAX_ATTACHMENTS} 个附件` : null),
          );
        } catch {
          // 原生对话框被取消
        } finally {
          setAttaching(false);
        }
      })();
    } else {
      fileInputRef.current?.click();
    }
  }, [attachments.length]);

  const pickFolders = useCallback(() => {
    setAttachError(null);
    void (async () => {
      try {
        const paths = await window.otto.selectFolders();
        if (paths.length === 0) return;
        const room = MAX_ATTACHMENTS - attachments.length;
        if (room <= 0) {
          setAttachError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`);
          return;
        }
        const added = paths.slice(0, room).map((folderPath) => {
          const segments = folderPath.split(/[\\/]/u).filter(Boolean);
          return { folderName: segments.at(-1) ?? folderPath, folderPath };
        });
        setAttachments((prev) => [...prev, ...added]);
        setAttachError(paths.length > room ? `一次最多添加 ${MAX_ATTACHMENTS} 个附件` : null);
      } catch (error) {
        setAttachError(error instanceof Error ? error.message : '目录附件授权失败');
      }
    })();
  }, [attachments.length]);

  // 拖拽文件进入
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    await addBrowserFiles(files);
  }, [addBrowserFiles]);

  // 选中附件 → 图片走压缩 pipeline，文件走直传 pipeline。
  // 超出张数上限的截断并提示；单张失败记录首个错误但不阻断其余成功项。
  const onFilesChosen = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许连选同一文件
    if (files.length === 0) return;
    await addBrowserFiles(files);
  };

  const removeAttachment = (key: string): void => {
    setAttachments((prev) => prev.filter((attachment) => (
      attachmentKey(attachment) !== key
    )));
    setAttachmentSizes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setAttachError(null);
  };

  // 空态示例胶囊注入草稿：填入并聚焦、自适应高度。draftNonce 递增触发再注入。
  React.useEffect(() => {
    if (draft == null || draft === '') return;
    setText(draft);
    const el = taRef.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftNonce]);

  // 右侧面板「工具」点击 → 把命令文本填入输入框（不发送），聚焦以便直接回车执行。
  // 与手输行为一致：复位斜杠面板的 Esc 关闭/高亮态，`/xxx` 填入即弹出命令面板。
  React.useEffect(() => {
    const onInsert = (e: Event): void => {
      if (disabled) return;
      const value = (e as CustomEvent<string>).detail;
      if (typeof value !== 'string') return;
      setText(value);
      setSlashDismissed(false);
      setSlashIndex(0);
      const el = taRef.current;
      if (el) {
        el.focus();
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
      }
    };
    window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
  }, [disabled]);

  // 切换/新建会话就绪后自动聚焦 textarea，省去手动再点一下。
  // 仅在有会话（sessionId）且未禁用时聚焦；不依赖 busy，避免打断发送流。
  React.useEffect(() => {
    if (disabled || sessionId == null) return;
    const el = taRef.current;
    if (!el) return;
    el.focus();
    // 恢复草稿后按内容重算高度：不同会话草稿长短不同，避免沿用上个会话的输入框高度。
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [sessionId, disabled]);

  // 生成中（busy）不发送，但 textarea 仍可输入下一条；无会话（disabled）才整体锁死。
  // 有文本或有图片附件即可发送。
  const canSend =
    (text.trim().length > 0 || attachments.length > 0) && !disabled && !busy;

  const submit = () => {
    if (!canSend) return;
    onSend(text, attachments);
    setText('');
    setAttachments([]);
    setAttachmentSizes({});
    setAttachError(null);
    // 发送后清掉本会话草稿，避免切走再切回时又冒出已发送的内容。
    if (sessionId != null) draftsRef.current[sessionId] = '';
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  // 清空 textarea（命令执行后消费掉触发命令的文本）。
  const clearInput = () => {
    setText('');
    setSlashIndex(0);
    setSlashDismissed(false);
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  // 执行一条斜杠命令 → 按 action 分派（prompt=发模型 / server=发帧 / local=回调），
  // 随后清空输入。未接对应回调的命令静默忽略（面板本不该列出它，双保险）。
  const runSlashCommand = (cmd: SlashCommand) => {
    // 参数：命令名后的原始文本（`/kb search 报销` → 'search 报销'）。
    const args = (slashInput?.argMode ? slashInput.args : '').trim();

    if (cmd.action === 'agent' && cmd.agentProfileId) {
      onLaunchAgentProfile?.(cmd.agentProfileId, cmd.description);
      clearInput();
      taRef.current?.focus();
      return;
    }

    if (cmd.action === 'prompt' && cmd.prompt) {
      onSend(cmd.prompt, []);
      clearInput();
      taRef.current?.focus();
      return;
    }

    // server 命令：发 run_slash_command 帧；bareLocal 且无参数时退回本地分派
    // （如 `/memory` 裸调开「记忆」面板，`/memory add xx` 才走 server）。
    if (cmd.action === 'server' && !(cmd.bareLocal && args === '')) {
      onRunServerCommand?.(cmd.id, args);
      clearInput();
      taRef.current?.focus();
      return;
    }

    switch (cmd.id) {
      case 'new':
        onNewChat?.();
        break;
      case 'model':
        setMenuOpen(true);
        break;
      case 'clear':
        onClearContext?.();
        break;
      case 'settings':
        onOpenSettings?.();
        break;
      case 'help':
        onShowHelp?.();
        break;
      case 'doctor':
        onOpenDoctor?.();
        break;
      // 飞书：启停真调 REST（preload 通路），随后打开「飞书接入」面板看真实状态；
      // 裸 /feishu 与 /feishu-status 直接开面板（面板即配置 + 状态）。
      case 'feishu':
      case 'feishu-status':
        onOpenFeishu?.();
        break;
      case 'feishu-start':
        void window.otto?.feishuStart();
        onOpenFeishu?.();
        break;
      case 'feishu-stop':
        void window.otto?.feishuStop();
        onOpenFeishu?.();
        break;
      case 'memory':
        onOpenMemory?.();
        break;
      case 'skills':
        onOpenSkills?.();
        break;
      case 'export':
        onExport?.();
        break;
      case 'copy':
        onCopyLast?.();
        break;
      case 'session':
        onOpenSessions?.();
        break;
      case 'theme':
      case 'config':
        onOpenPrefs?.();
        break;
      case 'hooks':
        // 对齐 CLI /hooks：用系统浏览器打开 hooks 文档（preload openExternal）。
        void transport.openExternal('https://www.otto.bot/hooks-help');
        break;
      default:
        break;
    }
    clearInput();
    // 命令执行后把焦点还给 textarea，方便继续输入。
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // —— 斜杠命令面板打开时，键盘事件优先给面板，Enter 不再是「发送」——
    if (slashVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashCommands.length) % slashCommands.length,
        );
        return;
      }
      // Enter / Tab = 执行当前高亮命令（isComposing 时不拦，交给输入法）。
      if (
        (e.key === 'Enter' || e.key === 'Tab') &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        runSlashCommand(slashCommands[activeSlash]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // 收起面板但保留已输入文本（用户可能想把 `/foo` 当普通消息发）。
        setSlashDismissed(true);
        return;
      }
    }

    // —— 面板关闭：Enter 发送、Shift+Enter 换行 ——
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    // 文本变化即复位「Esc 主动关闭」标志与高亮：重新打字应让面板按新 query 复现。
    setSlashDismissed(false);
    setSlashIndex(0);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  const insertTextAtCursor = useCallback((value: string): void => {
    if (!value) return;
    const el = taRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = text.slice(0, start) + value + text.slice(end);
    setText(next);
    setSlashDismissed(false);
    requestAnimationFrame(() => {
      if (!el) return;
      const caret = start + value.length;
      el.focus();
      el.setSelectionRange(caret, caret);
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    });
  }, [text]);

  /** 右键“粘贴”同时支持文字与剪贴板图片；系统不开放 read() 时退回 readText()。 */
  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    try {
      const clipboard = navigator.clipboard as Clipboard & {
        read?: () => Promise<Array<{
          types: readonly string[];
          getType(type: string): Promise<Blob>;
        }>>;
      };
      if (clipboard.read) {
        const items = await clipboard.read();
        const files: File[] = [];
        const textParts: string[] = [];
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              const ext = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
              files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type }));
            } else if (type === 'text/plain') {
              textParts.push(await readBlobText(await item.getType(type)));
            }
          }
        }
        if (files.length > 0) await addBrowserFiles(files);
        if (textParts.length > 0) insertTextAtCursor(textParts.join(''));
        return;
      }
      insertTextAtCursor(await clipboard.readText());
    } catch (error) {
      setAttachError(
        error instanceof Error ? `无法读取剪贴板：${error.message}` : '无法读取剪贴板',
      );
    }
  }, [addBrowserFiles, insertTextAtCursor]);

  const copyOrCutSelection = useCallback(async (cut: boolean): Promise<void> => {
    const el = taRef.current;
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? text.length;
    const value = start === end ? text : text.slice(start, end);
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (cut) {
        const next = start === end ? '' : text.slice(0, start) + text.slice(end);
        setText(next);
        requestAnimationFrame(() => {
          if (!el) return;
          const caret = start === end ? 0 : start;
          el.focus();
          el.setSelectionRange(caret, caret);
        });
      }
    } catch {
      setAttachError('无法访问系统剪贴板，请检查 Otto 的剪贴板权限');
    }
  }, [text]);

  // 反映真实生效模型：优先 currentModel（来自 models_list/currentModel 帧）对应的 displayName，
  // 否则回退到首个可用模型的名字，最后才用「选择模型」占位。
  // 不再硬编码具体模型名（如 'claude-opus-4'）——BYO-key 用户可能根本没配 Claude。
  const modelLabel =
    models.find((m) => m.id === currentModel && m.enabled !== false)
        ?.displayName ??
      models.find((m) => m.enabled !== false)?.displayName ??
      '选择模型';

  // 发送按钮的悬浮提示：禁用时说明原因，让用户知道为何点不了（而非恒为「发送」）。
  //   无会话 → 先选/建会话；有会话但内容为空 → 先输入内容；否则正常「发送」。
  const sendTitle = disabled
    ? disabledReason ?? '请先选择或新建会话'
    : canSend
      ? '发送'
      : '请先输入内容';

  return (
    <div
      ref={composerRef}
      className={`otto-composer${disabled ? ' is-disabled' : ''}${dragOver ? ' is-dragover' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* 右键菜单 */}
      {contextMenu ? (
        <>
          <div
            className="otto-context-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <div
            className="otto-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button type="button" onClick={() => { void pasteFromClipboard(); setContextMenu(null); }}>
              粘贴
            </button>
            <button type="button" onClick={() => { void copyOrCutSelection(false); setContextMenu(null); }}>
              复制
            </button>
            <button type="button" onClick={() => { void copyOrCutSelection(true); setContextMenu(null); }}>
              剪切
            </button>
            <button type="button" onClick={() => { pickFiles(); setContextMenu(null); }}>
              选择文件…
            </button>
            <button type="button" onClick={() => { pickFolders(); setContextMenu(null); }}>
              选择文件夹…
            </button>
          </div>
        </>
      ) : null}
      <div className="otto-composer__inner">
        {attachments.length > 0 || attaching || attachError ? (
          <div className="otto-attachments">
            {attachments.map((attachment) => {
              const key = attachmentKey(attachment);
              const image = isImageAttachment(attachment);
              const folder = isFolderAttachment(attachment);
              const localPath = attachmentLocalPath(attachment);
              const name = attachmentName(attachment);
              const typeLabel = folder ? '目录' : attachmentTypeLabel(name);
              const typeKey = folder ? 'DIR' : attachmentTypeKey(name);
              const displayName = folder ? name : attachmentFileName(name);
              const size = attachmentSizes[key] ?? (
                image ? attachment.originalSize : undefined
              );
              return (
                <div
                  key={key}
                  className={`otto-attachment otto-attachment--${image ? 'image' : folder ? 'folder' : 'file'}`}
                >
                  {image ? (
                    <img
                      className="otto-attachment__img"
                      src={attachmentToDataUrl(attachment)}
                      alt=""
                    />
                  ) : (
                    <span className="otto-attachment__type-col" aria-hidden="true">
                      <span className="otto-attachment__type-icon" data-type={typeKey}>
                        {typeKey}
                      </span>
                      <span className="otto-attachment__type-label">{typeLabel}</span>
                    </span>
                  )}
                  <div className="otto-attachment__copy">
                    <span
                      className="otto-attachment__file-name"
                      title={name}
                    >
                      {displayName}
                    </span>
                    <span className="otto-attachment__meta">
                      {typeLabel}{size != null ? ` · ${formatAttachmentSize(size)}` : ''}
                    </span>
                    {localPath && localPath !== name ? (
                      <span className="otto-attachment__path" title={localPath}>
                        {localPath.length > 50
                          ? `…${localPath.slice(-47)}`
                          : localPath}
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="otto-attachment__remove"
                    title={`移除 ${name}`}
                    aria-label={`移除 ${name}`}
                    onClick={() => removeAttachment(key)}
                  >
                    <IconClose size={13} />
                  </button>
                </div>
              );
            })}
            {attaching ? (
              <div className="otto-attachment otto-attachment--loading">
                处理中…
              </div>
            ) : null}
            {attachError ? (
              <div className="otto-attachments__error" role="alert">
                {attachError}
              </div>
            ) : null}
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.json,.xml,.md,.zip"
          multiple
          hidden
          onChange={onFilesChosen}
        />

        {/* 斜杠命令面板：浮在输入框上方，焦点仍在 textarea。 */}
        {slashVisible ? (
          <SlashCommands
            commands={slashCommands}
            activeIndex={activeSlash}
            onExecute={runSlashCommand}
            onHover={setSlashIndex}
            onClose={() => setSlashDismissed(true)}
          />
        ) : null}

        <textarea
          ref={taRef}
          className="otto-composer__textarea"
          placeholder={disabledReason ?? '给 Otto 发送消息...'}
          rows={1}
          value={text}
          onChange={autoGrow}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files ?? []);
            if (files.length === 0) return;
            event.preventDefault();
            void addBrowserFiles(files);
          }}
          aria-expanded={slashVisible}
          aria-controls={slashVisible ? 'otto-slashmenu' : undefined}
          // 生成中仍可输入下一条；仅无会话（disabled）时锁死。
          disabled={disabled}
        />
        <div className="otto-composer__bar">
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="otto-modelpill"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              // 与 textarea 一致：无会话（disabled）时也锁模型菜单，避免「输入锁了菜单还能开」的不一致。
              disabled={disabled}
              title={disabled ? disabledReason ?? '请先选择或新建会话' : '切换模型'}
            >
              {modelLabel}
              <IconChevronDown size={14} className="otto-modelpill__chev" />
            </button>
            {menuOpen && !disabled ? (
              <ModelMenu
                models={models}
                current={currentModel}
                onPick={(id) => {
                  onSetModel(id);
                  setMenuOpen(false);
                }}
                onClose={() => setMenuOpen(false)}
                onManage={onManageModels}
              />
            ) : null}
          </div>

          <button
            type="button"
            className="otto-attach"
            title="添加文件或图片"
            aria-label="添加文件或图片"
            onClick={pickFiles}
            disabled={disabled || attaching}
          >
            <IconPaperclip size={17} />
          </button>

          <button
            type="button"
            className="otto-attach"
            title="添加文件夹"
            aria-label="添加文件夹"
            onClick={pickFolders}
            disabled={disabled || attaching}
          >
            <IconFolder size={17} />
          </button>

          <div className="otto-authorization">
            <button
              type="button"
              className="otto-authorization__trigger"
              aria-label={`执行授权：${authorizationLabel}`}
              aria-haspopup="menu"
              aria-expanded={authorizationOpen}
              disabled={disabled}
              onClick={() => setAuthorizationOpen((v) => !v)}
            >
              <AuthorizationModeIcon kind={authorizationKind} size={16} />
              <span>{authorizationLabel}</span>
              <IconChevronDown size={14} />
            </button>
            {authorizationOpen && !disabled ? (
              <AuthorizationMenu current={authorizationKind} onPick={pickAuthorization} />
            ) : null}
          </div>

          {busy && onCancel ? (
            <button
              type="button"
              className="otto-send otto-send--stop"
              title="停止生成"
              aria-label="停止生成"
              onClick={onCancel}
            >
              <IconStop size={15} />
            </button>
          ) : (
            <button
              type="button"
              className="otto-send"
              title={sendTitle}
              aria-label="发送"
              disabled={!canSend}
              onClick={submit}
            >
              <IconArrowUp size={17} />
            </button>
          )}
        </div>
      </div>

      {/* 极简键位提示：让首次使用者知道 Enter/Shift+Enter 的分工。无会话时不显示（避免噪声）。 */}
      {!disabled ? (
        <div className="otto-composer__hint" aria-hidden>
          Enter 发送 · Shift+Enter 换行 · 输入 / 唤起命令
        </div>
      ) : null}
    </div>
  );
}

function AuthorizationMenu({
  current,
  onPick,
}: {
  current: 'manual' | 'session' | 'global';
  onPick: (kind: 'manual' | 'session' | 'global') => void;
}): React.JSX.Element {
  const options = [
    { id: 'manual' as const, title: '手动授权', desc: 'Otto 执行操作前，需要你在弹窗中确认' },
    { id: 'session' as const, title: '自动授权（仅当前会话）', desc: '非高危操作无需确认，高危操作仍会询问' },
    { id: 'global' as const, title: '自动授权（所有会话）', desc: '所有会话放行非高危操作，高危操作仍会询问' },
  ];
  return (
    <div className="otto-authorization__menu" role="menu" aria-label="选择执行授权方式">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitemradio"
          aria-checked={current === option.id}
          className={`otto-authorization__option${current === option.id ? ' is-active' : ''}`}
          onClick={() => onPick(option.id)}
        >
          <span className={`otto-authorization__option-icon otto-authorization__option-icon--${option.id}`}>
            <AuthorizationModeIcon kind={option.id} size={18} />
          </span>
          <span className="otto-authorization__copy">
            <span className="otto-authorization__title">{option.title}</span>
            <span className="otto-authorization__desc">{option.desc}</span>
          </span>
          {current === option.id ? <IconCheck size={19} className="otto-authorization__selected" /> : null}
        </button>
      ))}
    </div>
  );
}

function AuthorizationModeIcon({
  kind,
  size,
}: {
  kind: 'manual' | 'session' | 'global';
  size: number;
}): React.JSX.Element {
  if (kind === 'manual') return <IconWarning size={size} />;
  if (kind === 'session') return <IconCheck size={size} />;
  return <IconCheckCheck size={size} />;
}

function ModelMenu({
  models,
  current,
  onPick,
  onClose,
  onManage,
}: {
  models: ModelInfo[];
  current: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
  onManage?: () => void;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');

  // 模型多到一定数量才显示搜索框（+ 分组）；少量时平铺即可，不加噪声。
  const showSearch = models.length > MODEL_SEARCH_THRESHOLD;

  // 点击菜单外关闭 + Esc 关闭。
  React.useEffect(() => {
    const onDoc = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 按 displayName 过滤（大小写不敏感，去空白）。空 query 返回全部。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.displayName.toLowerCase().includes(q));
  }, [models, query]);

  // 是否分组：显示搜索区（即模型较多）且存在多个 provider 时，按 provider 归类，
  // 便于多 provider 的 BYO-key 用户快速定位。搜索有结果时也保持分组，标题即上下文。
  const groups = useMemo(() => {
    if (!showSearch) return null;
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of filtered) {
      const key = m.provider ?? '其他';
      const list = byProvider.get(key);
      if (list) list.push(m);
      else byProvider.set(key, [m]);
    }
    // 仅一个 provider（或全无 provider）时不值得分组，退回平铺。
    if (byProvider.size <= 1) return null;
    return Array.from(byProvider.entries());
  }, [showSearch, filtered]);

  // 方向键在选项间移动焦点（role=listbox 名副其实）。搜索框聚焦时 ↓ 也能进入列表
  // （输入框非 .otto-modelmenu__item，idx=-1 → ArrowDown 落到首个候选）。
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '.otto-modelmenu__item',
      ) ?? [],
    );
    if (items.length === 0) return;
    const idx = items.findIndex((el) => el === document.activeElement);
    const next =
      e.key === 'ArrowDown'
        ? items[(idx + 1 + items.length) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next?.focus();
  };

  // 单个模型选项按钮（平铺与分组共用，保留勾选 + 当前高亮逻辑）。
  const renderItem = (m: ModelInfo): React.JSX.Element => {
    const active = m.id === current;
    const unavailable = m.enabled === false;
    return (
      <button
        key={m.id}
        type="button"
        role="option"
        aria-selected={active}
        className={`otto-modelmenu__item${
          active ? ' otto-modelmenu__item--active' : ''
        }`}
        disabled={unavailable}
        onClick={() => onPick(m.id)}
      >
        <span className="otto-modelmenu__check">
          {active ? <IconCheck size={15} /> : null}
        </span>
        <span className="otto-modelmenu__text">
          <span className="otto-modelmenu__name">{m.displayName}</span>
          {m.provider ? (
            <span className="otto-modelmenu__provider">
              {unavailable ? '暂不可用' : m.provider}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <div
      ref={menuRef}
      className="otto-modelmenu"
      role="listbox"
      aria-label="选择模型"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      {showSearch ? (
        <input
          className="otto-modelmenu__search"
          type="text"
          placeholder="搜索模型…"
          aria-label="搜索模型"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // 输入框内不吞 Esc/方向键给菜单：Esc 关菜单、↓ 进列表由 onMenuKeyDown 处理。
          autoFocus
        />
      ) : null}

      {models.length === 0 ? (
        <div className="otto-modelmenu__empty">
          暂无可用模型，先在「设置」里配置 BYO-key
        </div>
      ) : filtered.length === 0 ? (
        <div className="otto-modelmenu__empty">未找到匹配的模型</div>
      ) : groups ? (
        groups.map(([provider, items]) => (
          <div key={provider} className="otto-modelmenu__group">
            <div className="otto-modelmenu__grouphead">{provider}</div>
            {items.map(renderItem)}
          </div>
        ))
      ) : (
        filtered.map(renderItem)
      )}

      {onManage ? (
        <>
          <div className="otto-modelmenu__sep" />
          <button
            type="button"
            className="otto-modelmenu__manage"
            onClick={onManage}
          >
            <IconSettings size={14} />
            在设置里管理模型
          </button>
        </>
      ) : null}
    </div>
  );
}
