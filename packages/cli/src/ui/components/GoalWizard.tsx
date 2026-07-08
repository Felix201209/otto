/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GoalWizard — interactive 6-step wizard for /goal (Goal-Driven Mode).
 *
 * Steps:
 *   1. TASK         — multi-line task description (required)
 *   2. FORBIDDEN    — multi-line forbidden items (optional)
 *   3. CRITERIA     — multi-line completion criteria (required)
 *   4. HOURS        — minimum continuous-work duration in hours (number)
 *   5. INTENSITY    — single-select: steady / standard / intense
 *   6. CONFIRM      — preview the assembled prompt; Enter to submit, Esc back
 *
 * Multi-line collection strategy:
 *   - SimpleTextInput is single-line. We collect successive Enter-submitted
 *     lines into an array, and pressing Enter on an EMPTY line finishes the
 *     current step. This matches user expectation ("press Enter twice to
 *     finish") without dragging in a full text-buffer editor.
 *   - For required fields, an empty submission with no collected lines
 *     surfaces an inline error.
 */

import React, { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { SimpleTextInput } from './shared/SimpleTextInput.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress, Key } from '../hooks/useKeypress.js';
import { t, tp } from '../utils/i18n.js'; // Added import for t, tp

export type GoalIntensity = 'steady' | 'standard' | 'intense';

export interface GoalWizardResult {
  task: string;
  forbidden: string;
  criteria: string;
  hours: number;
  intensity: GoalIntensity;
}

export interface GoalWizardProps {
  onComplete: (result: GoalWizardResult) => void;
  onCancel: () => void;
}

enum Step {
  TASK = 'task',
  FORBIDDEN = 'forbidden',
  CRITERIA = 'criteria',
  HOURS = 'hours',
  INTENSITY = 'intensity',
  CONFIRM = 'confirm',
}

const STEPS_ORDER: Step[] = [
  Step.TASK,
  Step.FORBIDDEN,
  Step.CRITERIA,
  Step.HOURS,
  Step.INTENSITY,
  Step.CONFIRM,
];

/**
 * Build the intensity options at render time so language switches reflect
 * immediately. Module-level `t()` calls would freeze labels at module load.
 */
function getIntensityOptions(): Array<{
  label: string;
  value: GoalIntensity;
}> {
  return [
    { label: t('goalWizard.intensity.steady'), value: 'steady' },
    { label: t('goalWizard.intensity.standard'), value: 'standard' },
    { label: t('goalWizard.intensity.intense'), value: 'intense' },
  ];
}

function stepTitle(s: Step): string {
  switch (s) {
    case Step.TASK:
      return t('goalWizard.step.task.title');
    case Step.FORBIDDEN:
      return t('goalWizard.step.forbidden.title');
    case Step.CRITERIA:
      return t('goalWizard.step.criteria.title');
    case Step.HOURS:
      return t('goalWizard.step.hours.title');
    case Step.INTENSITY:
      return t('goalWizard.step.intensity.title');
    case Step.CONFIRM:
      return t('goalWizard.step.confirm.title');
    default: {
      // Exhaustive check — if a new Step value is added but not handled,
      // TypeScript will flag this assignment.
      const _exhaustive: never = s;
      return String(_exhaustive);
    }
  }
}

function stepHelp(s: Step): string {
  switch (s) {
    case Step.TASK:
      return t('goalWizard.step.task.help');
    case Step.FORBIDDEN:
      return t('goalWizard.step.forbidden.help');
    case Step.CRITERIA:
      return t('goalWizard.step.criteria.help');
    case Step.HOURS:
      return t('goalWizard.step.hours.help');
    case Step.INTENSITY:
      return t('goalWizard.step.intensity.help');
    case Step.CONFIRM:
      return t('goalWizard.step.confirm.help');
    default: {
      const _exhaustive: never = s;
      return String(_exhaustive);
    }
  }
}

export function GoalWizard({
  onComplete,
  onCancel,
}: GoalWizardProps): React.JSX.Element {
  const [step, setStep] = useState<Step>(Step.TASK);

  // Multi-line buffers
  const [taskLines, setTaskLines] = useState<string[]>([]);
  const [forbiddenLines, setForbiddenLines] = useState<string[]>([]);
  const [criteriaLines, setCriteriaLines] = useState<string[]>([]);

  // Current single-line input (used by all multi-line steps and HOURS)
  const [currentInput, setCurrentInput] = useState<string>('');

  const [hours, setHours] = useState<number>(2);
  const [intensity, setIntensity] = useState<GoalIntensity>('standard');
  const [error, setError] = useState<string | null>(null);

  const stepIndex = STEPS_ORDER.indexOf(step);
  const totalSteps = STEPS_ORDER.length;

  const goToStep = useCallback((next: Step) => {
    setError(null);
    setCurrentInput('');
    setStep(next);
  }, []);

  const goNext = useCallback(() => {
    const idx = STEPS_ORDER.indexOf(step);
    if (idx < STEPS_ORDER.length - 1) {
      goToStep(STEPS_ORDER[idx + 1]!);
    }
  }, [step, goToStep]);

  const goBack = useCallback(() => {
    const idx = STEPS_ORDER.indexOf(step);
    if (idx > 0) {
      goToStep(STEPS_ORDER[idx - 1]!);
    } else {
      onCancel();
    }
  }, [step, goToStep, onCancel]);

  // ESC handling: from non-input steps, go back. From input steps, the
  // SimpleTextInput's onCancel callback already routes here.
  useKeypress(
    (key: Key) => {
      if (key.name === 'escape') {
        goBack();
      }
    },
    {
      isActive: step === Step.INTENSITY || step === Step.CONFIRM,
    },
  );

  // ---------- TASK / FORBIDDEN / CRITERIA shared submit logic ----------

  const handleMultilineSubmit = useCallback(
    (line: string, current: string[], setLines: (v: string[]) => void, required: boolean) => {
      const trimmed = line.trim();
      if (trimmed === '') {
        // Empty line → finish this step
        if (required && current.length === 0) {
          setError(t('goalWizard.error.required_field'));
          return;
        }
        setError(null);
        goNext();
        return;
      }
      setError(null);
      setLines([...current, trimmed]);
      setCurrentInput('');
    },
    [goNext],
  );

  const handleHoursSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        // accept default
        goNext();
        return;
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0.5 || n > 24) {
        setError(t('goalWizard.error.invalid_hours'));
        return;
      }
      setError(null);
      setHours(n);
      goNext();
    },
    [goNext],
  );

  // ---------- Confirm step ----------

  // 注意：本步骤刻意不显示组装好的完整 prompt——prompt 中的契约 / 系统硬红线
  // 等内容是模式内部资产，不向终端展示。预览面板仅回显用户自己填写的字段，
  // 帮助用户在按 Enter 启动前再确认一遍输入是否正确。

  const confirmItems = [
    { label: t('goalWizard.confirm.start_goal_mode'), value: 'start' },
    { label: t('goalWizard.confirm.back_to_edit'), value: 'back' },
    { label: t('goalWizard.confirm.cancel'), value: 'cancel' },
  ];

  const handleConfirm = useCallback(
    (value: string) => {
      if (value === 'start') {
        onComplete({
          task: taskLines.join('\n'),
          forbidden: forbiddenLines.join('\n'),
          criteria: criteriaLines.join('\n'),
          hours,
          intensity,
        });
      } else if (value === 'back') {
        goToStep(Step.INTENSITY);
      } else {
        onCancel();
      }
    },
    [taskLines, forbiddenLines, criteriaLines, hours, intensity, goToStep, onComplete, onCancel],
  );

  // ---------- Render helpers ----------

  const renderCollectedLines = (lines: string[], emptyHint: string) => {
    if (lines.length === 0) {
      return <Text color={Colors.Gray}>{emptyHint}</Text>;
    }
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} color={Colors.AccentGreen}>
            ✓ {line}
          </Text>
        ))}
      </Box>
    );
  };

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <Box marginBottom={1}>
        <Text color={Colors.AccentCyan} bold>
          {t('goalWizard.title')}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.Gray}>
          Step {stepIndex + 1}/{totalSteps}: {stepTitle(step)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={Colors.Comment}>{stepHelp(step)}</Text>
      </Box>

      <Box
        borderStyle="single"
        borderColor={Colors.Gray}
        paddingX={1}
        paddingY={1}
        flexDirection="column"
      >
        {step === Step.TASK && (
          <Box flexDirection="column">
            {renderCollectedLines(taskLines, t('goalWizard.empty_input_hint'))}
            <Box marginTop={1}>
              <SimpleTextInput
                value={currentInput}
                onChange={setCurrentInput}
                onSubmit={(line) =>
                  handleMultilineSubmit(line, taskLines, setTaskLines, true)
                }
                onCancel={onCancel}
                isActive
              />
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>
                {t('goalWizard.multiline_input_actions_cancel')}
              </Text>
            </Box>
          </Box>
        )}

        {step === Step.FORBIDDEN && (
          <Box flexDirection="column">
            {renderCollectedLines(forbiddenLines, t('goalWizard.optional_input_hint'))}
            <Box marginTop={1}>
              <SimpleTextInput
                value={currentInput}
                onChange={setCurrentInput}
                onSubmit={(line) =>
                  handleMultilineSubmit(line, forbiddenLines, setForbiddenLines, false)
                }
                onCancel={goBack}
                isActive
              />
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>
                {t('goalWizard.multiline_input_actions_goback')}
              </Text>
            </Box>
          </Box>
        )}

        {step === Step.CRITERIA && (
          <Box flexDirection="column">
            {renderCollectedLines(criteriaLines, t('goalWizard.empty_input_hint'))}
            <Box marginTop={1}>
              <SimpleTextInput
                value={currentInput}
                onChange={setCurrentInput}
                onSubmit={(line) =>
                  handleMultilineSubmit(line, criteriaLines, setCriteriaLines, true)
                }
                onCancel={goBack}
                isActive
              />
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>
                {t('goalWizard.multiline_input_actions_goback')}
              </Text>
            </Box>
          </Box>
        )}

        {step === Step.HOURS && (
          <Box flexDirection="column">
            <Text>
              <Text color={Colors.Gray}>{t('goalWizard.current_default')}</Text>
              <Text color={Colors.AccentCyan}>{tp('goalWizard.hours_display', { hours })}</Text>
            </Text>
            <Box marginTop={1}>
              <SimpleTextInput
                value={currentInput}
                onChange={setCurrentInput}
                onSubmit={handleHoursSubmit}
                onCancel={goBack}
                isActive
                placeholder={tp('goalWizard.hours_placeholder', { hours })}
              />
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={Colors.AccentRed}>✗ {error}</Text>
              </Box>
            )}
            <Box marginTop={1}>
              <Text color={Colors.Gray}>
                {t('goalWizard.hours_input_actions')}
              </Text>
            </Box>
          </Box>
        )}

        {step === Step.INTENSITY && (() => {
          const intensityOptions = getIntensityOptions();
          return (
            <RadioButtonSelect
              items={intensityOptions.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
              initialIndex={intensityOptions.findIndex((o) => o.value === intensity)}
              onSelect={(v) => {
                setIntensity(v);
                goNext();
              }}
              onHighlight={() => {}}
              isFocused
            />
          );
        })()}

        {step === Step.CONFIRM && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={Colors.AccentYellow} bold>
                {t('goalWizard.confirm.yolo_warning')}
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              <Text color={Colors.AccentCyan} bold>{t('goalWizard.confirm.summary_title')}</Text>
            </Box>
            <Box
              flexDirection="column"
              borderStyle="single"
              borderColor={Colors.Gray}
              paddingX={1}
              marginBottom={1}
            >
              <Text color={Colors.AccentCyan}>{t('goalWizard.confirm.summary.task')}</Text>
              {taskLines.length === 0 ? (
                <Text color={Colors.Gray}>  -</Text>
              ) : (
                taskLines.map((line, i) => (
                  <Text key={`t-${i}`} color={Colors.Foreground}>  {line}</Text>
                ))
              )}

              <Text> </Text>
              <Text color={Colors.AccentCyan}>{t('goalWizard.confirm.summary.forbidden')}</Text>
              {forbiddenLines.length === 0 ? (
                <Text color={Colors.Gray}>  {t('goalWizard.confirm.summary.none')}</Text>
              ) : (
                forbiddenLines.map((line, i) => (
                  <Text key={`f-${i}`} color={Colors.Foreground}>  {line}</Text>
                ))
              )}

              <Text> </Text>
              <Text color={Colors.AccentCyan}>{t('goalWizard.confirm.summary.criteria')}</Text>
              {criteriaLines.length === 0 ? (
                <Text color={Colors.Gray}>  -</Text>
              ) : (
                criteriaLines.map((line, i) => (
                  <Text key={`c-${i}`} color={Colors.Foreground}>  {line}</Text>
                ))
              )}

              <Text> </Text>
              <Text color={Colors.AccentCyan}>
                {t('goalWizard.confirm.summary.hours')}{' '}
                <Text color={Colors.Foreground}>{tp('goalWizard.hours_display', { hours })}</Text>
              </Text>
              <Text color={Colors.AccentCyan}>
                {t('goalWizard.confirm.summary.intensity')}{' '}
                <Text color={Colors.Foreground}>
                  {getIntensityOptions().find((o) => o.value === intensity)?.label ?? intensity}
                </Text>
              </Text>
            </Box>
            <RadioButtonSelect
              items={confirmItems}
              initialIndex={0}
              onSelect={handleConfirm}
              onHighlight={() => {}}
              isFocused
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Prompt assembly — exported so other surfaces (e.g. VSCode UI plugin) can
// build an identical prompt. Keep this pure / dependency-free.
// ---------------------------------------------------------------------------

export interface BuildGoalPromptInput {
  task: string;
  forbidden: string;
  criteria: string;
  hours: number;
  intensity: GoalIntensity;
}

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
 * 这些红线在 /goal 模式下由系统强制注入，独立于用户填写的"禁止事项"，
 * 任何情况下都不得违反。理由：
 *   - /goal 自动开启 YOLO，工具调用不再逐次确认；
 *   - AI 在长时间自主推进过程中，遇阻可能产生破坏性"快速恢复"冲动；
 *   - 这些操作的爆炸半径大、不可逆，必须在 prompt 层硬阻止。
 *
 * 与 VSCode 端 GoalWizardDialog.tsx 保持完全一致；任何修改两端都要同步。
 *
 * 注：本 prompt 内容刻意不走 i18n —— 模型对中文 prompt 理解一致，且统一
 * 文案可避免不同语言用户下模型行为漂移。仅 wizard 的界面文案走 i18n。
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

export function buildGoalPrompt(input: BuildGoalPromptInput): string {
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
5. 当且仅当上述任一收尾条件成立时，必须调用 goal_achieved 工具来正式宣告任务完成。该工具的 reason 参数必填，要逐条说明"达标特征"中每一条是如何被客观满足的（引用具体文件、测试结果、可观察行为等；不要写"完成了"、"看起来不错"这种敷衍理由）。在 goal_achieved 返回之前，不要单纯用文字宣布"任务完成"——只有这次工具调用才算正式收尾，否则系统会一直认为你还在 goal 模式中（底部状态栏会一直显示 ◎ /goal active 计时）。
6. 如果在执行过程中遇到客观上无法克服的障碍（不是主观觉得"差不多"，而是确实无路可走），不要调用 goal_achieved——按契约纪律向用户清晰汇报障碍，由用户决定是否 /goal clear；切忌把 goal_achieved 当作"逃避困难"的出口。

现在开始。`;
}
