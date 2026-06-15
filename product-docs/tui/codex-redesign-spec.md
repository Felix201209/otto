Tengo todo lo necesario verificado contra el código real de Otto. Ahora sintetizo la spec final.

---

# Otto TUI 企业级重设计规格

> 目标:把 Otto 的 TUI 从"功能堆叠 + 多种视觉语言混杂"收敛到 Codex 那套"克制、单一语法、和终端浑然一体"的企业级气质。所有改动均针对真实文件、真实行号,Ink 能 1:1 的标出,只能近似的也标清楚边界。

---

## 一、总体设计原则:Codex 为什么显得"高级"

Codex 的高级感不来自漂亮的颜色或炫酷的动画,而来自**五条克制**。Otto 当前最大的问题是同时使用了 3-4 种视觉语言(灰底色块 + emoji + ASCII 状态字母 + 圆角框 + 彩虹关键词),这正是 Codex 刻意避免的。

1. **借终端的底,不抢主导权。** Codex 探测用户终端的默认 fg/bg,全场颜色从这两个值派生;它在任何主题里都浑然一体。Otto 在 `UserMessage.tsx:47` 硬编码 `#707070` 灰底,在任意终端主题下都会是一块"对不上的脏色"——这是最该删的反模式。

2. **单一强调色 + dim 做层级,而非多色 + 边框。** Codex 全场只有一个青色强调音,层级靠"2 列缩进 + ` · ` dim 分隔 + dim 弱化"建立,几乎不画框。Otto 现在到处是圆角框(输入框、欢迎区)、彩色 emoji 徽章(`Footer.tsx:96-101` 的 `⚡↗️🚀✳️🌈🌊`)。

3. **单一视觉语法:`•` 项目符号 + `└ ` 树形缩进。** Codex 所有"一个工作回合"都是 `• 标题` + `  └ 详情`,状态靠 `•` 的**颜色**编码(绿=成功/红=失败/dim=中性),不靠换字形。

4. **留白即层级:一根 2 列隐形竖线对齐一切。** Codex 用全局常量 `LIVE_PREFIX_COLS = 2`,composer、状态行、footer、历史行全部左对齐到同一列。Otto 各组件各自定 padding(`paddingX={1}`、`paddingLeft={5}`),对不齐。

5. **颜色是信息不是装饰,零 emoji,动画只做明度呼吸。** 红=危险/删除,绿=新增,青=强调,其余走终端默认前景(正文**不上色**)。emoji 几乎为零(宽度不稳会破坏对齐)。

**一句话方向**:Otto 的重设计不是"加装饰",而是"**删掉 Codex 没有的视觉寄存器(灰底块、emoji、ASCII 状态字母、彩虹词),收敛到 `•`/`└`/dim/单青色 这一套语言**"。

---

## 二、逐组件改法

### 组件 1 —— `colors.ts`(地基,先建立单一来源)

文件:`/Users/felix/Desktop/EasyCode/packages/cli/src/ui/colors.ts`

**现状问题**:`colors.ts` 只是把 `themeManager` 的色值原样转发(全是 getter),没有"语义层"。结果各组件直接写裸 hex(`UserMessage.tsx:47` 的 `#707070`、`InputPrompt.tsx:26` 的彩虹数组),颜色逻辑散落、无法统一收口。Ink 也拿不到终端真实 fg/bg,所以 Codex 的 alpha 浮层做不了。

**目标手感**:一个语义化的配色单一来源——正文走终端默认前景(不上色)、单一青色强调、dim 作为唯一弱化手段、语义色集中定义防泛滥。组件内**禁止**再出现裸 hex。

**Ink 实现要点**:在 `colors.ts` 旁新增一个语义封装(不改动现有 getter,向后兼容),组件改为从这里取色:

```ts
// 能 1:1:语义命名 + 单一强调 + dim 唯一弱化
export const Semantic = {
  // 正文 = 终端默认前景,故意不返回颜色(identity),这是"和终端浑然一体"的本质
  body: undefined as string | undefined,
  // 全场唯一强调色:沿用主题的 AccentCyan(Codex 的 accent 也是 cyan)
  get accent() { return Colors.AccentCyan; },
  // 弱化层级:统一走 Gray + dimColor,而不是各写各的 hex
  get dim() { return Colors.Gray; },
  // 语义色(只在确有语义处用):
  get added() { return Colors.AccentGreen; },   // diff 新增 / 成功
  get removed() { return Colors.AccentRed; },    // diff 删除 / 错误
  get warning() { return Colors.AccentYellow; }, // 警告 / 待确认 / shell 模式
} as const;

// 几何字形,禁 emoji(Codex 用对齐过的字形而非 emoji)
export const Glyph = {
  bullet: '•',          // 工作回合 / 列表项
  tree: '└ ',           // 树形子项首行
  treeIndent: '  ',     // 树形子项续行(对齐到 bullet 之下)
  chevron: '›',         // 用户消息前缀(U+203A,非 '>' 非 '❯')
  shell: '!',           // shell 模式前缀
} as const;
```

**只能近似的(讲清楚)**:
- **拿不到终端真实 fg/bg** → Codex 的"user message 背景 = blend(白,bg,0.12)"那种 alpha 浮层**做不了**。对策:需要"区块感"时用**左侧 dim 竖条 `▏`** 或 `dimColor`,而**不要**用 `backgroundColor` 填一个固定灰(那正是当前 `UserMessage` 的病)。
- **明暗探测**:Ink 没有 query 接口。沿用现有 `Colors.type === 'dark'` 判断即可(主题已知),不需要 `COLORFGBG`。
- **降级**:chalk 自带 truecolor→256→16 降级,可接受;`GradientColors` 这类多色仅保留在 nightly 路径,日常对话流不用。

---

### 组件 2 —— `InputPrompt.tsx`(第一眼观感,影响最大)

文件:`/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/InputPrompt.tsx`

**现状问题**(均有行号):
- **圆角框**(`borderStyle="round"`,L1119)——Codex composer **不画框**,优雅恰恰来自无框。
- **前缀符号是 `> `**(`promptSymbol`,L1097)——Codex 用 `›`(U+203A)bold,不是 ASCII `>`。
- **彩虹高亮 "workflow"**(`applyWorkflowRainbow`,L24-41,在 L1078 应用到每一行)——6 色彩虹是纯装饰,违背"颜色是信息不是装饰",在企业级产品里显廉价。
- **placeholder 首字符用 `chalk.inverse`**(L1130)模拟光标块——可保留但属近似。
- **底部提示行**(L1141-1147)已经是对的方向(dim + ` · ` 分隔),但 emoji 提示散落在别处(L1154 的 💡、L1187 的 💡)。

**目标手感**:无框 composer——一个 `›` bold 前缀 + 2 列 gutter + 上下各 1 行留白 + 一行 dim footer(键亮、说明 dim)。shell 模式前缀变 `!` 红、`Plan/help` 用语义色,**颜色只为表意**。

**Ink 实现要点**:

能 1:1:
1. **去框**。把 L1117-1124 的 `borderStyle`/`borderColor`/`borderDimColor` 全部删除,改为纵向留白:
   ```tsx
   <Box flexDirection="column" marginTop={1}>
     <Box height={1} />{/* 上留白 1 行 = Codex inset top */}
     <Box>
       <Text bold color={shellModeActive ? Semantic.warning : undefined}>
         {shellModeActive ? '! ' : '› '}{/* gutter=2列:符号+空格 */}
       </Text>
       <Box flexGrow={1} flexDirection="column">{/* 输入区 */}</Box>
     </Box>
     <Box height={1} />{/* 下留白 1 行 */}
   </Box>
   ```
2. **前缀符号换字形**:L1097 改为 `const promptSymbol = shellModeActive ? '! ' : helpModeActive ? '› ' : '› ';`,普通态用 `›`,**不再用 `>`**。颜色:普通态**不上色**(走默认前景,bold 即可),shell=`Semantic.warning`,help=`Semantic.accent`。Codex 的普通 `›` 是 bold 无色,不是 `AccentBlue`。
3. **删彩虹**:移除 `applyWorkflowRainbow`(L24-41)及 L1075-1079 的调用。关键词高亮如果要保留,改为**单色 accent**(`chalk.hex` 换成 `Semantic.accent` 一种色),不要 6 色。
4. **footer 提示行**(L1141-1147):保持 dim + ` · `,但把**可按的键**(`⏎`、`/`、`@`)用 `Semantic.accent` 提亮,说明文字保持 dim——这是 Codex "键亮、解释暗"的铁律。当前是整行全 dim,键没有突出:
   ```tsx
   <Text>
     <Text color={Semantic.accent}>⏎</Text><Text dimColor> 发送  </Text>
     <Text color={Semantic.accent}>/</Text><Text dimColor> 命令  </Text>
     <Text color={Semantic.accent}>@</Text><Text dimColor> 文件  ·  {getNewlineHint()}</Text>
   </Text>
   ```
5. **shell 模式 badge**:L1142-1143 已有 `! working`,改为 footer 里一段 `Semantic.warning` 的 `Shell 模式` badge,固定位置。

只能近似的:
- **光标形状**(块/竖线):Ink 不能可移植地控制终端光标形状,沿用 `chalk.inverse(' ')`(L1066)模拟,接受近似。
- **窄屏渐进降级**:Codex 有 5 级 FSM。Otto 用 `useStdout().stdout.columns` 做 2-3 级即可(已有 `inputWidth` 可用):窄屏先丢 footer 右侧、再缩短键说明。不必抄全 5 级。

**反模式(别做)**:不要因为"看起来太空"又把框加回来;Codex 的空就是设计。不要在 placeholder 里塞 emoji。

---

### 组件 3 —— `Footer.tsx`(全局气质,emoji 重灾区)

文件:`/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/Footer.tsx`

**现状问题**:
- **Agent Style 用彩色 emoji 徽章**:L93-103 的 `⚡ ↗️ 🚀 ✳️ 🌈 🌊`——6 个 emoji,宽度不稳(`↗️🚀` 是双宽 emoji,会破坏对齐),是 Codex 最忌讳的。
- **thinking effort 用 🧠 emoji**:L124-125 的 ` 🧠 ${effortLabel}`。
- **结构本身已对**:`Separator` 用 ` · ` dim(L80)、model 领头、context 次之、cwd 殿后(L84-86 注释写得很清楚),这部分是好的,保留。

**目标手感**:一行 dim 状态行,`model · NN% ctx · cwd · branch`,**零 emoji**,分隔符 dim,可按/可读信息用文字而非图标。mode 标签带语义色(Plan=紫、Execute=dim)。

**Ink 实现要点**:

能 1:1:
1. **删 emoji 徽章,换文字标签**。L91-106 改为:agent style 用一个**短文字标签 + accent 色**,而非 emoji:
   ```tsx
   {agentStyle !== 'default' ? (
     <Box>
       <Text color={Semantic.accent}>{agentStyle}</Text>{/* 直接显示 'codex'/'cursor' 文字 */}
       <Separator />
     </Box>
   ) : null}
   ```
   若嫌长,用首字母大写缩写(`Cdx`/`Cur`),但**不用 emoji**。
2. **thinking effort 去 🧠**。L124-125 改为纯文字,dim:
   ```tsx
   <Text color={Colors.Gray} dimColor>{' '}{effortLabel}</Text>
   ```
   (effort label 本身已是 `max`/`med`/`high` 紧凑形,见 `footerUtils.ts:122-136`,无需图标点缀。)
3. **context 正向表达**:`getContextDisplay`(`footerUtils.ts:71-85`)已输出 `92% ctx left`(剩余而非已用),完全符合 Codex 的 `{percent}% left`,保留。
4. **mode 语义色**:Otto 若有 Plan/Execute 模式,在 footer 加一段 mode 标签,Plan=`Colors.AccentPurple`、Execute=`dim`,与 Codex `styled_span` 一致。

只能近似的:
- **窄屏降级链**:`getFooterDisplayConfig`(`footerUtils.ts:156-174`)目前只有 2 级(full / compact)。可扩到 3 级(full → 丢右侧状态 → 只留 model+ctx),但 Codex 的 5 级边界 case 不必全抄。保住"窄屏藏信息顺序固定、不横跳"即可。

**反模式**:中间那段 Sandbox 信息(L177-194)用了 `color="green"` 纯绿,如果不是真·语义(沙箱=安全态)就改 dim;是语义则保留。

---

### 组件 4 —— `UserMessage.tsx`(最刺眼的视觉寄存器,必删)

文件:`/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/messages/UserMessage.tsx`

**现状问题**(这是全局最该改的一处):
- **硬编码灰底色块**:L47 `backgroundColor = isDarkTheme ? '#707070' : '#C0C0C0'`,L59 应用到 Box。在任意终端主题下都是一块对不上的脏色,正是 Codex 用"相对 bg alpha"极力避免的。
- **白字加粗压灰底**:L48/L61 `#FFFFFF` + `bold`——第三种视觉寄存器(没有任何其他 cell 这么做)。
- **右对齐的 emoji**:L21 `🧑💬` + L65-69 右侧对齐——又一个孤立的视觉语言。
- **前缀是 `❯ `**:L20,powerline 字形,Codex 用 `›`(U+203A)。

**目标手感**:用户消息 = 一行 `› 用户说的话`,`›` 是 dim chevron,文字走默认前景,**无底色、无框、无 emoji**。它与 assistant 的 `•` 对齐在同一列 0,一眼就读出"这是用户回合"。

**Ink 实现要点**(能 1:1,这条改动小、收益大):

```tsx
export const UserMessage: React.FC<UserMessageProps> = ({ text, terminalWidth }) => {
  let displayText = text;
  if (isLongText(text, 20)) displayText = smartTruncateText(text, 15);
  displayText = formatAttachmentReferencesForDisplay(displayText);

  return (
    <Box flexDirection="row" marginY={1}>
      <Box flexShrink={0}>
        <Text color={Colors.Gray} bold dimColor>{'› '}</Text>{/* chevron dim+bold */}
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">{displayText}</Text>{/* 默认前景,不上色不加粗 */}
      </Box>
    </Box>
  );
};
```

- 删除 L24-26 的宽度计算、L45-48 的 `backgroundColor`/`textColor`、L65-69 的右侧 emoji。
- 保留 `smartTruncateText`(L32-33)和附件格式化(L37)——这是功能,不是装饰。
- chevron 用 `Colors.Gray + dimColor + bold`(对应 Codex `"› ".bold().dim()`);多行续行用 2 空格对齐(`wrap="wrap"` 默认会对齐到容器左缘,已满足)。

**反模式**:绝不用 `backgroundColor` 给消息加底色;需要区分用户/AI 就靠 `›` vs `•` 的字形和位置,不靠色块。

---

### 组件 5 —— 消息 & 工具渲染(`GeminiMessage` + 工具状态字形)

文件:`/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/messages/GeminiMessage.tsx`(+ 关联 `ToolMessage.tsx`、`ToolGroupMessage.tsx`,在第三位专家的分析里已有 C2-C9 细则)

**现状问题**:
- `GeminiMessage.tsx:26,33`:bullet `• ` 用 `Colors.Foreground`(全亮前景)。Codex 的 assistant bullet 是 **dim**(`"• ".dim()`)——前景留给内容,bullet 退后。
- 工具状态指示器(`ToolMessage.tsx` 的 `ToolStatusIndicator`)用一套分散字形 `o / ⊷ / ▸ / • / ? / - / x / 🤖`,Codex 用**一个** `•` 靠颜色编码状态。

**目标手感**:assistant 回合 = `•`(dim)+ markdown 内容(默认前景);工具回合 = `•`(颜色编码状态)+ `└ ` 详情。整个对话流只有一个字形 `•`,颜色讲状态。

**Ink 实现要点**(能 1:1):
1. **`GeminiMessage` bullet 改 dim**:L33 `<Text color={Colors.Foreground}>` → `<Text color={Colors.Gray} dimColor>`。内容仍走 markdown 默认前景。流式续行不要重复 `•`(用 2 空格),确认 `MarkdownDisplay` 不会每段重画 bullet。
2. **工具状态统一为 `•` + 颜色**(对应第三位专家 C2):success→`•` 绿、error→`•` 红 bold、pending/neutral→`•` dim、executing→spinner(静止态字符也用 `•`)、canceled→`•` dim + 标题 `strikethrough`。删掉 `🤖` 等 emoji,subagent→`•` accent 色。
3. **树形缩进统一 4 列 `  └ ` / `    `**(对应 C6),替代现在的 `paddingLeft={5}` + `└ ` 混用,让 `└` 正落在 `•` 之下。
4. **diff 统计去 emoji**(对应 C7):`📄/🗑️/📝` 换成 git 风格 `A`/`D` 字母 + `+N`(绿)`-N`(红),文件名 dim。

只能近似的:diff 行的 alpha 染色背景(Codex 按终端明度自适应)→ Ink 用 2-3 个固定色 + 数字 gutter + 符号,数字+符号部分是 1:1,背景色是近似。

---

## 三、优先级:先改这 3 个,第一眼观感提升最大

按"影响第一眼 × 改动成本"排序,前三必做:

| 优先级 | 组件 | 为什么是它 | 成本 |
|---|---|---|---|
| **P0** | **`UserMessage.tsx`**(组件 4) | 灰底色块 + 白粗字 + 右侧 emoji 是全屏**最刺眼、最不协调**的一块,且是唯一用 `backgroundColor` 的 cell。删掉它,对话流立刻从"花"变"静"。改动最小(整文件 < 30 行),收益最直观。 | 低 |
| **P1** | **`InputPrompt.tsx` 去框 + `›` + 删彩虹**(组件 2) | composer 是用户**全程盯着**的焦点。去掉圆角框、换 `›`、删 6 色彩虹关键词,是"从工具感变企业感"最关键的一跳。footer 键提亮顺带做。 | 中 |
| **P2** | **`Footer.tsx` 去 emoji 徽章**(组件 3) | 底栏常驻可见,`⚡↗️🚀✳️🌈🌊` 6 个 emoji 既破坏对齐又显廉价。换成文字标签即净化全局气质。结构已对,只替换图标,成本低。 | 低 |

P0-P2 完成后,再做 `colors.ts` 语义层(组件 1,为后续统一兜底)与消息/工具字形统一(组件 5,第三位专家 C2/C6/C8 已给细则)。

**底层共识**:这三个改动的共同动作都是**删**——删色块、删框、删彩虹、删 emoji。Otto 已经做对了两件事(Footer 的 ` · ` dim 分隔、GeminiMessage 的 `•` 前缀),方向是**收敛到这套已有的好语言**,而不是另起炉灶。

---

涉及的真实文件(绝对路径):
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/colors.ts` — 组件 1
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/InputPrompt.tsx` — 组件 2(去框 L1117-1124、`›` L1097、删彩虹 L24-41/L1075-1079、footer 键提亮 L1141-1147)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/Footer.tsx` — 组件 3(去 emoji 徽章 L91-106、去 🧠 L124-125)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/messages/UserMessage.tsx` — 组件 4(删灰底 L45-48/L59、删 emoji L21/L65-69、`❯`→`›` L20)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/components/messages/GeminiMessage.tsx` — 组件 5(bullet dim L33)
- `/Users/felix/Desktop/EasyCode/packages/cli/src/ui/utils/footerUtils.ts` — 组件 3 支撑(context/effort label 已合规,窄屏降级可扩到 3 级)
- (第三位专家已覆盖)`ToolMessage.tsx` / `ToolGroupMessage.tsx` — 组件 5 的 C2/C6/C7 细则