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

import React, { useMemo, useRef, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import type { ImageAttachment } from '../state/useOttoStore.js';
import {
  fileToImageAttachment,
  attachmentToDataUrl,
  MAX_ATTACHMENTS,
} from '../lib/image.js';
import {
  SlashCommands,
  filterCommands,
  parseSlashQuery,
  type SlashCommand,
} from './SlashCommands.js';
import {
  IconChevronDown,
  IconPaperclip,
  IconArrowUp,
  IconCheck,
  IconSettings,
  IconStop,
  IconClose,
} from './icons.js';

/**
 * 模型菜单超过此数量才显示搜索框 + 按 provider 分组。BYO-key 用户接多个
 * provider 后列表会很长，少量模型时平铺更省事，无需搜索噪声。
 */
const MODEL_SEARCH_THRESHOLD = 8;

/**
 * 首批斜杠命令定义（顺序即面板展示顺序）。执行分派见 runSlashCommand。
 * 导出给右侧面板「工具」tab 复用作数据源（RightPanel），避免两处维护命令清单。
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'new', description: '新建会话', action: 'local' },
  { id: 'model', description: '打开模型菜单', action: 'local' },
  { id: 'clear', description: '清空当前会话上下文', action: 'local' },
  { id: 'settings', description: '打开设置面板', action: 'local' },
  { id: 'doctor', description: '依赖体检（pandoc/ffmpeg 等外部工具）', action: 'local' },
  { id: 'memory', description: '查看/新增记忆（项目 + 全局 OTTO.md）', action: 'local' },
  { id: 'skills', description: '浏览已装技能库', action: 'local' },
  { id: 'export', description: '导出当前会话为 Markdown', action: 'local' },
  { id: 'desktop', description: '启动/修复桌面端 Otto', action: 'prompt', prompt: '请检查并修复 Otto 桌面端：构建 renderer/main/preload，重新打包 Electron，覆盖 /Applications/Otto.app，并验证界面是否为最新。' },
  { id: 'feishu-start', description: '开启飞书控制网关', action: 'prompt', prompt: '请开启飞书/Lark 控制网关并检查连接状态。' },
  { id: 'feishu-stop', description: '停止飞书控制网关', action: 'prompt', prompt: '请停止飞书/Lark 控制网关并确认进程已退出。' },
  { id: 'feishu-status', description: '检查飞书连接状态', action: 'prompt', prompt: '请检查飞书/Lark 网关、授权、消息同步和群绑定状态。' },
  { id: 'multi-channel', description: '检查微信/企微/钉钉多渠道', action: 'prompt', prompt: '请检查 Otto 的多渠道能力：微信、企业微信、钉钉、飞书适配器和 multi_channel 工具是否可用。' },
  { id: 'ppt', description: 'PPT 创作专家', action: 'prompt', prompt: '我要做一份 PPT。请调用 PPT 创作专家流程，先询问主题、受众、页数、风格和素材。' },
  { id: 'doc', description: '文档写作专家', action: 'prompt', prompt: '我要写一份正式文档。请调用文档写作专家流程，先询问文档类型、用途、读者、要点和篇幅。' },
  { id: 'pdf', description: 'PDF 处理', action: 'prompt', prompt: '我要处理 PDF。请调用 PDF 文档处理流程，先询问文件路径、操作类型和输出格式。' },
  { id: 'audio', description: '音视频转文本/纪要', action: 'prompt', prompt: '我要处理音视频或会议录音。请调用会议纪要/转录流程，先询问文件、参会人和输出格式。' },
  { id: 'excel', description: 'Excel 分析可视化', action: 'prompt', prompt: '我要处理 Excel/CSV 数据。请调用表格分析与数据可视化流程，先询问数据字段、目标结果和输出形式。' },
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
  /**
   * 流式生成中。busy 时 textarea 仍可输入下一条，发送按钮变「停止」按钮调 onCancel。
   * 与 disabled 解耦：disabled 锁全部，busy 只改发送按钮形态。
   */
  busy?: boolean;
  onSend: (text: string, attachments: ImageAttachment[]) => void;
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
  /** 斜杠命令 `/memory`：打开设置与诊断中心的「记忆」tab。 */
  onOpenMemory?: () => void;
  /** 斜杠命令 `/skills`：打开设置与诊断中心的「技能库」tab。 */
  onOpenSkills?: () => void;
  /** 斜杠命令 `/export`：导出当前会话为 Markdown（真实落盘）。 */
  onExport?: () => void;
}

export function Composer({
  models,
  currentModel,
  sessionId,
  disabled,
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
  onOpenMemory,
  onOpenSkills,
  onExport,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  // 斜杠命令面板：当前高亮项下标。面板是否可见由 slashCommands.length>0 && !disabled 决定。
  const [slashIndex, setSlashIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 由当前文本解析斜杠命令 query，再过滤出候选。无会话（disabled）时不弹面板。
  // parseSlashQuery=null → 非命令输入态；候选为空 → 无匹配（如 `/xyz`），也不显示面板。
  const slashQuery = disabled ? null : parseSlashQuery(text);
  const slashCommands = useMemo(
    () => (slashQuery == null ? [] : filterCommands(SLASH_COMMANDS, slashQuery)),
    [slashQuery],
  );
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
  if (sessionId !== draftSessionId) {
    // 存下上一个会话此刻的草稿（无会话 id 时不存，避免以 '' 之类的键污染表）。
    if (draftSessionId != null) draftsRef.current[draftSessionId] = text;
    // 恢复目标会话的草稿；从未输入过则为空。切走再切回可原样复现。
    setText(sessionId != null ? draftsRef.current[sessionId] ?? '' : '');
    // 会话变了，斜杠命令面板的高亮 / 关闭态一并复位，别把上个会话的命令态带进来。
    setSlashIndex(0);
    setSlashDismissed(false);
    setDraftSessionId(sessionId);
  }

  const pickFiles = () => {
    setAttachError(null);
    fileInputRef.current?.click();
  };

  // 选中图片 → 逐张压缩成 image_reference。超出张数上限的截断并提示；
  // 单张失败（类型/过大/解码）记录首个错误但不阻断其余成功项。
  const onFilesChosen = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 允许连选同一文件
    if (files.length === 0) return;
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(`最多只能添加 ${MAX_ATTACHMENTS} 张图片`);
      return;
    }
    setAttaching(true);
    let firstError: string | null = null;
    const added: ImageAttachment[] = [];
    for (const file of files.slice(0, room)) {
      try {
        added.push(await fileToImageAttachment(file));
      } catch (err) {
        if (!firstError) {
          firstError = err instanceof Error ? err.message : '图片处理失败';
        }
      }
    }
    if (added.length > 0) setAttachments((prev) => [...prev, ...added]);
    setAttachError(
      firstError ??
        (files.length > room ? `一次最多添加 ${MAX_ATTACHMENTS} 张图片` : null),
    );
    setAttaching(false);
  };

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
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

  // 执行一条斜杠命令 → 本地分派（不发给模型），随后清空输入。
  // 未接对应回调的命令静默忽略（面板本不该列出它，双保险）。
  const runSlashCommand = (cmd: SlashCommand) => {
    if (cmd.action === 'prompt' && cmd.prompt) {
      onSend(cmd.prompt, []);
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
      case 'doctor':
        onOpenDoctor?.();
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

  // 反映真实生效模型：优先 currentModel（来自 models_list/currentModel 帧）对应的 displayName，
  // 否则回退到首个可用模型的名字，最后才用「选择模型」占位。
  // 不再硬编码具体模型名（如 'claude-opus-4'）——BYO-key 用户可能根本没配 Claude。
  const modelLabel =
    models.find((m) => m.id === currentModel)?.displayName ??
    currentModel ??
    models[0]?.displayName ??
    '选择模型';

  // 发送按钮的悬浮提示：禁用时说明原因，让用户知道为何点不了（而非恒为「发送」）。
  //   无会话 → 先选/建会话；有会话但内容为空 → 先输入内容；否则正常「发送」。
  const sendTitle = disabled
    ? '请先选择或新建会话'
    : canSend
      ? '发送'
      : '请先输入内容';

  return (
    <div className={`otto-composer${disabled ? ' is-disabled' : ''}`}>
      <div className="otto-composer__inner">
        {attachments.length > 0 || attaching || attachError ? (
          <div className="otto-attachments">
            {attachments.map((a) => (
              <div key={a.id} className="otto-attachment">
                <img
                  className="otto-attachment__img"
                  src={attachmentToDataUrl(a)}
                  alt={a.fileName}
                />
                <button
                  type="button"
                  className="otto-attachment__remove"
                  title="移除"
                  aria-label={`移除 ${a.fileName}`}
                  onClick={() => removeAttachment(a.id)}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
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
          accept="image/*"
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
          placeholder="给 Otto 发送消息..."
          rows={1}
          value={text}
          onChange={autoGrow}
          onKeyDown={onKeyDown}
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
              title={disabled ? '请先选择或新建会话' : '切换模型'}
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
            title="添加图片"
            aria-label="添加图片"
            onClick={pickFiles}
            disabled={disabled || attaching}
          >
            <IconPaperclip size={17} />
          </button>

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
    return (
      <button
        key={m.id}
        type="button"
        role="option"
        aria-selected={active}
        className={`otto-modelmenu__item${
          active ? ' otto-modelmenu__item--active' : ''
        }`}
        onClick={() => onPick(m.id)}
      >
        <span className="otto-modelmenu__check">
          {active ? <IconCheck size={15} /> : null}
        </span>
        <span className="otto-modelmenu__text">
          <span className="otto-modelmenu__name">{m.displayName}</span>
          {m.provider ? (
            <span className="otto-modelmenu__provider">{m.provider}</span>
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
