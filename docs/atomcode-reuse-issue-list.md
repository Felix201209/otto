# AtomCode Reuse Issue List for Otto

> 目标：只复用 AtomCode 的边界设计，不把 Rust 实现硬搬进 Otto。

## Issue 1: 固化可复用边界

**状态：已完成**。边界表与禁止项见 [AtomCode Reuse Boundary](./atomcode-reuse-boundary.md)。

- 问题：当前“借鉴 AtomCode”容易被误读成“替换 Otto 内核实现”。
- 目标：把可复用内容限定为 turn 边界、hook seam、checkpoint、tool contract、result 外部化、file history、conformance 思路。
- 验收：
  - 明确写出“可借设计 / 必须重写 / 不要碰”三栏清单。
  - 不引入 AtomCode 的具体 Rust crate 作为 Otto 运行时依赖。

## Issue 2: 对齐 turn 生命周期

**状态：已完成**。保持 `TurnStateMachine` 为唯一真相源；仅补充边界说明，未改动状态模型。

- 问题：Otto 现有 `Turn` / `TurnStateMachine` 已经有自己的生命周期边界，不能被 AtomCode 的命名或事件模型打乱。
- 目标：只吸收 AtomCode 的“单回合职责清晰”思想，不改 Otto 的 turn 状态真相源。
- 验收：
  - 保持 Otto 现有 turn 状态机为唯一来源。
  - 仅在文档或适配层补充 AtomCode 风格的边界说明。

## Issue 3: 补齐工具执行与回滚设计

**状态：已完成审计**。现有 checkpoint、影子 Git、工具状态、policy 与 audit 已覆盖恢复安全边界；“按工具交互撤销”记录为需独立产品设计的延后项，不能自动实现。

- 问题：AtomCode 的 checkpoint / undo / tool result 外部化 / file history 方案很实用，但 Otto 不能直接套用别人的实现。
- 目标：复用设计原则，评估 Otto 现有 `ToolExecutionEngine`、policy gate、session store、memory subsystem 中是否已覆盖同类能力；缺口再补。
- 验收：
  - 列出 Otto 已有对应实现。
  - 只为缺口新增 Otto-native 方案，不引入 AtomCode 代码。

## Issue 4: 不碰已更好的 Otto 组件

**状态：已完成**。稳定“不碰清单”已写入边界文档，评审时必须先核对。

- 问题：Otto 已经有自己的 `TurnStateMachine`、`ToolExecutionEngine`、`SceneManager`、`MemorySubsystem`、`SessionMemoryInjector`，不该为了“向 AtomCode 对齐”而重做。
- 目标：明确这些模块属于“已有更好实现，不碰”范围。
- 验收：
  - 形成一份稳定的“不碰清单”。
  - 以后评审新增改动时，默认先查这份清单。

## Issue 5: 最小迁移策略

**状态：已完成**。采用“先映射、后缺口、最后抽象”的最小变更策略；本轮无需引入新运行时抽象。

- 问题：如果想真的吸收 AtomCode 的优点，最容易走偏成大重构。
- 目标：先做文档级映射，再做最小代码面补强。
- 顺序：
  1. 先补边界映射表。
  2. 再补 Otto 缺口。
  3. 最后才考虑是否需要新抽象。
