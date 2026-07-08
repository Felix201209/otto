/**
 * Goal Wizard Dialog
 * 目标驱动模式向导 - 6 步交互式表单
 *
 * 流程：
 *   1. 任务描述 (multiline, 必填)
 *   2. 禁止事项 (multiline, 可空)
 *   3. 达标特征 (multiline, 必填)
 *   4. 持续小时 (number)
 *   5. 强度档位 (single-select)
 *   6. 预览 prompt 并确认
 *
 * 提交时：
 *   - 自动开启 YOLO 模式（updateYoloMode(true)）
 *   - 拼装 prompt 并以 user message 形式提交（handleSendMessage）
 *
 * @license Apache-2.0
 * Copyright 2026 Easy Code
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, ArrowLeft, ArrowRight, Target, Rocket } from 'lucide-react';
import { useYoloMode } from '../hooks/useProjectSettings';
import { useTranslation } from '../hooks/useTranslation';
import type { MessageContent } from '../types';
import './GoalWizardDialog.css';

// ----------------------- Types -----------------------

export type GoalIntensity = 'steady' | 'standard' | 'intense';

interface GoalWizardDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * 提交回调：父级负责把组装好的 prompt 当 user 消息塞给 AI service。
   * 这里不直接调 sendChatMessage，是为了和 MultiSessionApp 的 plan-mode
   * 拦截 / queue 等逻辑保持一致路径。
   *
   * @param content   组装好的 user 消息内容（含完整 goal prompt）。
   * @param goalContext  本次 /goal 启动的元数据。父级会把它透传给
   *   `handleSendMessage(..., { goalContext })`，最终随同 chat_message 送
   *   达 extension，extension 端会在 onChatMessage 处先调用
   *   `GeminiClient.setGoalContext(...)` 再处理消息——保证自动/手动压缩
   *   后能触发原始 goal prompt 重新注入。
   *
   *   T0 (`startedAt`) 在 webview 这一侧用 `Date.now()` 捕获，避免 IPC
   *   延迟造成 T0 漂移；与 CLI 端 useGoalWizard 的捕获时机一致。
   */
  onSubmit: (
    content: MessageContent,
    goalContext: { startedAt: number; hours: number; task: string },
  ) => void;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6;

// 强度档位的 i18n key 表（只引用 key，由 useTranslation().t 渲染时解析，
// 这样语言切换时 label 会即时更新；module-load 时调 t() 会冻结当前语言）。
const INTENSITY_VALUES: GoalIntensity[] = ['steady', 'standard', 'intense'];

const INTENSITY_DISCIPLINE: Record<GoalIntensity, string> = {
  steady:
    '【平稳】保持稳健节奏。每完成 1 项 todo 就调用一次 local_time 自检 elapsed。' +
    '允许等待较长的工具调用结果，但绝不因"差不多了"提前结束；只要达标特征未全部满足，不管 elapsed 多少都不能停。',
  standard:
    '【标准】主动规划。每完成 3 项 todo 或抵达一个里程碑就调用 local_time 自检 elapsed，' +
    '汇报已用时间与剩余下限，并在必要时重新规划任务清单。只要达标特征未全部满足，不管 elapsed 多少都不能停。',
  intense:
    '【高强度】禁止任何"等待用户确认/反馈"的措辞。遇阻立即换路线、绝不停摆。' +
    '每个里程碑都必须调用 local_time 并大声汇报 elapsed。' +
    '只要达标特征未全部满足，"看起来已完成"的判断都视为伪信号，必须继续深挖、加固、扩展、做对照实验。',
};

/**
 * 系统硬红线（Hardcoded Safety Rails）。
 *
 * 与 CLI 端 GoalWizard.tsx 保持完全一致；任何修改两端都要同步。
 * 详见 CLI 端注释。
 */
const SYSTEM_SAFETY_RAILS = [
  '禁止执行任何"危险外部命令"。包括但不限于：通过 shell 工具调用未在任务中明确授权的安装器、网络下载执行（curl|sh、wget|sh、iwr|iex 等管道执行模式）、运行未审计的二进制、关闭安全软件/防火墙、修改系统启动项与计划任务、改写注册表、改写 hosts、写 PATH 等系统级环境变量。',
  '禁止调用 PowerShell（含 powershell.exe / pwsh / pwsh.exe）执行任何脚本或命令。Windows 上需要执行系统命令时优先用 cmd /c 或 bash（mingw / git-bash / wsl）。如果某子任务必须使用 PowerShell 才能完成，则跳过该子任务、继续推进其它任务，并在最终结果汇报中明确列出"因系统红线未执行的子任务"。',
  '禁止递归删除文件或目录。这意味着：禁止 rm -rf、rm -r、Remove-Item -Recurse、del /s /q、rd /s /q、find ... -delete 等递归删除形式；禁止任何会一次删除多文件的通配删除（rm * 等）。如必须清理，逐个文件用 delete_file 工具删除。',
  '禁止对远程仓库执行强制推送。包括 git push --force、git push -f、git push --force-with-lease，以及任何会改写他人提交历史的推送形式。即使任务"看起来需要"force-push 才能完成，也一律不执行；改用普通 push 或新建分支推送，并在结果汇报中说明原本设想的 force-push 操作及未执行原因。',
  '禁止任何会丢弃未提交工作的操作。包括 git reset --hard（无论目标 ref）、git checkout -- <path>（覆盖未提交修改）、git clean -fd / -fdx、git restore --staged --worktree <path>（丢失未提交修改的形式）、git stash drop / clear。需要回滚时，改用 git stash 暂存、git revert 反转提交、或新建分支隔离改动；绝不破坏工作区现有内容。',
  '绝对禁止批量杀 node 进程、杀进程树、或按进程名批量杀。理由：你自己就跑在 node 进程里——任何不限定到“单个明确 PID”的杀进程操作都会连同运行你的 otto/goal 会话一起终结。同样适用于 npm/npx/tsx/ts-node 等 node 包装器。遇到端口冲突或调试进程残留时，原则按优先级：(1) 能绕就绕（换个未被占用的端口、换上游服务位置、或跳过该子任务）；(2) 实在绕不开，先用端口反查拿到唯一 PID，严格确认该 PID 不是当前 otto/goal 进程或其父进程，再杀该单个 PID（优先 SIGTERM，谨慎使用 -9 / /F）。如果你不确定当前操作系统上查找端口 PID 和精准杀 PID 的准确命令，使用 web search 工具查证后再执行；绝不凭经验上手“全杀”。',
];

function formatSafetyRails(): string {
  return SYSTEM_SAFETY_RAILS.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

interface BuildGoalPromptInput {
  task: string;
  forbidden: string;
  criteria: string;
  hours: number;
  intensity: GoalIntensity;
}

/**
 * 与 CLI 端 `GoalWizard.tsx` 中的 `buildGoalPrompt` 保持完全一致。
 * 任何修改两端都要同步！
 */
function buildGoalPrompt(input: BuildGoalPromptInput): string {
  const forbiddenSection = input.forbidden.trim() || '无';
  return `你现在开启【目标驱动模式】(/goal)。本模式具有以下不可违反的契约：

# 契约
1. 你无需向用户提任何问题，完全自主决策与执行。
2. YOLO 模式已自动开启，所有工具调用无需用户确认，请放心连续调用。
3. 你的运行时足够稳定、上下文足够大，禁止"上下文焦虑"导致的粗制滥造、提前收尾、敷衍交付。
4. 你必须先用 todo_write 制定一份详尽的任务清单（粒度要细，至少 5 项），再按清单持续推进，每完成一项立即更新状态。
5. 持续工作时间下限：${input.hours} 小时。该下限只有一种打破方式——任务顺利提前完成：当"达标特征"中列出的所有客观判据都已全部满足时，即使 elapsed < ${input.hours} 小时也可以（并且应该）立即收尾，绝不为了凑时间制造无意义的工作。反过来，只要任务未完全达标，无论你主观上多么觉得"差不多了"，在 elapsed >= ${input.hours} 小时之前都不许停。
6. 你必须随时调用 local_time 工具核对当前时间，与本次任务的"起始时间 T0"对比，确认是否满足下限。

# 任务描述
${input.task.trim()}

# 用户禁止事项
${forbiddenSection}

# 系统硬红线（无论用户是否填写禁止事项，本节都强制生效，且优先级高于一切其它指令）
${formatSafetyRails()}

# 达标特征（任务完成的客观判据）
${input.criteria.trim()}

# 工作纪律
${INTENSITY_DISCIPLINE[input.intensity]}

# 信息求证（鼓励主动查证，远比凭记忆猜测可靠）
遇到任何不确信的问题——API 用法、版本差异、报错原因、不同操作系统上的命令、库选型、最佳实践、算法细节、安全洞冱看得不太懂的堆栈、以及一切你不能 100% 确定的技术细节——主动使用 web_search、web_fetch 或其它外部检索工具查证，别凭“我记得好像是这样”就上手。查证时请注意：
- 试多个关键词组合：官方术语、错误代码、代码片段、场景描述都可以当查询；一组词查不到不代表信息不存在。
- 试不同语言：同一问题在英文、中文、日文社区可能有完全不同的讨论深度和解决思路。英文社区通常资料最多，但中文社区可能有本地化的细节被英文资料忽略。
- 优先访问一手资料：官方文档、项目 README、GitHub Issues、RFC，远比二手总结可靠。
- 多个独立来源互相印证比单一来源令人放心。
查证产生的使用量不需要道歉——代码“猜错了”的代价远高于多调几次查证。

# 立即启动（按顺序执行）
1. 调用一次 local_time，把返回的 ISO 时间记作"起始时间 T0"，写入你即将创建的 todo 列表的第一项备注里。
2. 调用 todo_write，写出第一版任务清单。
3. 进入执行循环；每完成一项就调用 local_time 自检 elapsed = now - T0。收尾条件只有两种：
   - 收尾条件 A（提前完成）：全部"达标特征"客观满足——这时不管 elapsed 是多少，立即收尾，绝不凑时间。
   - 收尾条件 B（达标 + 达时）：全部"达标特征"客观满足 且 elapsed >= ${input.hours} 小时。
4. 以上两种收尾条件任一成立才能停。如果达标特征未全部满足，无论你主观上多么觉得"差不多"，都必须继续深入、加固、扩展、复核。
5. 当且仅当上述任一收尾条件成立时，必须调用 goal_achieved 工具来正式宣告任务完成。该工具的 reason 参数必填，要逐条说明"达标特征"中每一条是如何被客观满足的（引用具体文件、测试结果、可观察行为等；不要写"完成了"、"看起来不错"这种敷衍理由）。在 goal_achieved 返回之前，不要单纯用文字宣布"任务完成"——只有这次工具调用才算正式收尾，否则系统会一直认为你还在 goal 模式中。
6. 如果在执行过程中遇到客观上无法克服的障碍（不是主观觉得"差不多"，而是确实无路可走），不要调用 goal_achieved——按契约纪律向用户清晰汇报障碍，由用户决定是否 /goal clear；切忌把 goal_achieved 当作"逃避困难"的出口。

现在开始。`;
}

// ----------------------- Component -----------------------

export const GoalWizardDialog: React.FC<GoalWizardDialogProps> = ({
  isOpen,
  onClose,
  onSubmit,
}) => {
  const { yoloMode, updateYoloMode } = useYoloMode();
  const { t } = useTranslation();

  const stepTitle = useCallback(
    (s: Step): string => {
      switch (s) {
        case 1:
          return t('goalWizard.step.task');
        case 2:
          return t('goalWizard.step.forbidden');
        case 3:
          return t('goalWizard.step.criteria');
        case 4:
          return t('goalWizard.step.hours');
        case 5:
          return t('goalWizard.step.intensity');
        case 6:
          return t('goalWizard.step.confirm');
        default: {
          // Exhaustive check; TS will flag if a new Step value is added.
          const _exhaustive: never = s;
          return String(_exhaustive);
        }
      }
    },
    [t],
  );

  const intensityOptions: Array<{
    value: GoalIntensity;
    title: string;
    desc: string;
  }> = INTENSITY_VALUES.map((value) => ({
    value,
    title: t(`goalWizard.intensity.${value}Title`),
    desc: t(`goalWizard.intensity.${value}Desc`),
  }));

  const [step, setStep] = useState<Step>(1);
  const [task, setTask] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [criteria, setCriteria] = useState('');
  const [hours, setHours] = useState<number>(2);
  const [intensity, setIntensity] = useState<GoalIntensity>('standard');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taskRef = useRef<HTMLTextAreaElement>(null);

  // ESC: close (除了 submitting 状态)
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose, submitting]);

  // 重置（每次打开）
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setError(null);
      setSubmitting(false);
      setTimeout(() => taskRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // ----- step navigation -----

  const next = useCallback(() => {
    setError(null);
    if (step === 1 && !task.trim()) {
      setError(t('goalWizard.error.taskRequired'));
      return;
    }
    if (step === 3 && !criteria.trim()) {
      setError(t('goalWizard.error.criteriaRequired'));
      return;
    }
    if (step === 4) {
      if (!Number.isFinite(hours) || hours < 0.5 || hours > 24) {
        setError(t('goalWizard.error.hoursInvalid'));
        return;
      }
    }
    setStep((s) => Math.min(6, s + 1) as Step);
  }, [step, task, criteria, hours, t]);

  const back = useCallback(() => {
    setError(null);
    setStep((s) => Math.max(1, s - 1) as Step);
  }, []);

  // ----- submit -----

  const handleStart = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      // 1) Auto-enable YOLO if not already on
      if (!yoloMode) {
        await updateYoloMode(true);
      }

      // 2) Assemble & submit prompt + goal-context metadata
      //
      //    T0 is captured HERE (webview-side wallclock) so the time anchor
      //    stays stable across IPC. The extension side will use this exact
      //    timestamp when calling GeminiClient.setGoalContext, and core's
      //    tryCompressChat will re-inject it verbatim after every
      //    compression cycle. See ChatMessage.goalContext (types/messages.ts).
      const prompt = buildGoalPrompt({ task, forbidden, criteria, hours, intensity });
      const goalContext = {
        startedAt: Date.now(),
        hours,
        task,
      };
      onSubmit([{ type: 'text', value: prompt }], goalContext);

      // 3) Close
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [yoloMode, updateYoloMode, task, forbidden, criteria, hours, intensity, onSubmit, onClose]);

  if (!isOpen) return null;

  // 注意：本组件刻意不显示组装好的完整 prompt——prompt 中的契约 / 系统硬红线
  // 等内容是模式内部资产，不对外展示。Step 6 仅回显用户填写的字段，便于
  // 启动前再确认一遍。

  return (
    <div
      className="goal-wizard__backdrop"
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="goal-wizard__container"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="goal-wizard__header">
          <div className="goal-wizard__title">
            <Target size={20} />
            <span>{t('goalWizard.title')}</span>
          </div>
          <button
            className="goal-wizard__close-btn"
            onClick={onClose}
            disabled={submitting}
            title={t('goalWizard.closeTooltip')}
          >
            <X size={18} />
          </button>
        </header>

        {/* Stepper */}
        <div className="goal-wizard__stepper">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div
              key={n}
              className={
                'goal-wizard__step-dot' +
                (n === step ? ' goal-wizard__step-dot--active' : '') +
                (n < step ? ' goal-wizard__step-dot--done' : '')
              }
            >
              {n}
            </div>
          ))}
          <span className="goal-wizard__step-label">
            {t('goalWizard.stepLabel', { step, title: stepTitle(step) })}
          </span>
        </div>

        {/* Body */}
        <div className="goal-wizard__body">
          {step === 1 && (
            <Field
              label={t('goalWizard.field.taskLabel')}
              hint={t('goalWizard.field.taskHint')}
              required
            >
              <textarea
                ref={taskRef}
                className="goal-wizard__textarea"
                rows={6}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t('goalWizard.field.taskPlaceholder')}
              />
            </Field>
          )}

          {step === 2 && (
            <Field
              label={t('goalWizard.field.forbiddenLabel')}
              hint={t('goalWizard.field.forbiddenHint')}
            >
              <textarea
                className="goal-wizard__textarea"
                rows={6}
                value={forbidden}
                onChange={(e) => setForbidden(e.target.value)}
                placeholder={t('goalWizard.field.forbiddenPlaceholder')}
              />
            </Field>
          )}

          {step === 3 && (
            <Field
              label={t('goalWizard.field.criteriaLabel')}
              hint={t('goalWizard.field.criteriaHint')}
              required
            >
              <textarea
                className="goal-wizard__textarea"
                rows={6}
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder={t('goalWizard.field.criteriaPlaceholder')}
              />
            </Field>
          )}

          {step === 4 && (
            <Field
              label={t('goalWizard.field.hoursLabel')}
              hint={t('goalWizard.field.hoursHint')}
              required
            >
              <input
                type="number"
                className="goal-wizard__input"
                step="0.5"
                min="0.5"
                max="24"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
              />
            </Field>
          )}

          {step === 5 && (
            <Field
              label={t('goalWizard.field.intensityLabel')}
              hint={t('goalWizard.field.intensityHint')}
            >
              <div className="goal-wizard__radio-group">
                {intensityOptions.map((opt) => (
                  <label
                    key={opt.value}
                    className={
                      'goal-wizard__radio' +
                      (intensity === opt.value
                        ? ' goal-wizard__radio--selected'
                        : '')
                    }
                  >
                    <input
                      type="radio"
                      name="intensity"
                      value={opt.value}
                      checked={intensity === opt.value}
                      onChange={() => setIntensity(opt.value)}
                    />
                    <div className="goal-wizard__radio-content">
                      <div className="goal-wizard__radio-title">{opt.title}</div>
                      <div className="goal-wizard__radio-desc">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </Field>
          )}

          {step === 6 && (
            <Field
              label={t('goalWizard.field.confirmLabel')}
              hint={t('goalWizard.field.confirmHint')}
            >
              <div className="goal-wizard__warning">
                {yoloMode
                  ? t('goalWizard.confirm.yoloKeep')
                  : t('goalWizard.confirm.yoloEnable')}
              </div>
              <div className="goal-wizard__summary">
                <div className="goal-wizard__summary-row">
                  <div className="goal-wizard__summary-label">{t('goalWizard.confirm.summary.task')}</div>
                  <pre className="goal-wizard__summary-value">{task.trim() || t('goalWizard.confirm.summary.empty')}</pre>
                </div>
                <div className="goal-wizard__summary-row">
                  <div className="goal-wizard__summary-label">{t('goalWizard.confirm.summary.forbidden')}</div>
                  <pre className="goal-wizard__summary-value">{forbidden.trim() || t('goalWizard.confirm.summary.none')}</pre>
                </div>
                <div className="goal-wizard__summary-row">
                  <div className="goal-wizard__summary-label">{t('goalWizard.confirm.summary.criteria')}</div>
                  <pre className="goal-wizard__summary-value">{criteria.trim() || t('goalWizard.confirm.summary.empty')}</pre>
                </div>
                <div className="goal-wizard__summary-row">
                  <div className="goal-wizard__summary-label">{t('goalWizard.confirm.summary.hours')}</div>
                  <div className="goal-wizard__summary-value goal-wizard__summary-value--inline">{t('goalWizard.units.hours', { hours })}</div>
                </div>
                <div className="goal-wizard__summary-row">
                  <div className="goal-wizard__summary-label">{t('goalWizard.confirm.summary.intensity')}</div>
                  <div className="goal-wizard__summary-value goal-wizard__summary-value--inline">
                    {intensityOptions.find((o) => o.value === intensity)?.title ?? intensity}
                  </div>
                </div>
              </div>
            </Field>
          )}

          {error && <div className="goal-wizard__error">{error}</div>}
        </div>

        {/* Footer */}
        <footer className="goal-wizard__footer">
          <button
            className="goal-wizard__btn goal-wizard__btn--ghost"
            onClick={step === 1 ? onClose : back}
            disabled={submitting}
          >
            <ArrowLeft size={14} />
            {step === 1 ? t('goalWizard.button.cancel') : t('goalWizard.button.back')}
          </button>

          {step < 6 ? (
            <button
              className="goal-wizard__btn goal-wizard__btn--primary"
              onClick={next}
              disabled={submitting}
            >
              {t('goalWizard.button.next')}
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              className="goal-wizard__btn goal-wizard__btn--primary"
              onClick={handleStart}
              disabled={submitting}
            >
              <Rocket size={14} />
              {submitting ? t('goalWizard.button.starting') : t('goalWizard.button.start')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
};

// ----------------------- Helpers -----------------------

const Field: React.FC<{
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}> = ({ label, hint, required, children }) => (
  <div className="goal-wizard__field">
    <label className="goal-wizard__label">
      {label}
      {required && <span className="goal-wizard__required">*</span>}
    </label>
    {hint && <div className="goal-wizard__hint">{hint}</div>}
    {children}
  </div>
);

export default GoalWizardDialog;
