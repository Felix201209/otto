# 非交互模式下的斜杠命令支持

## 概述

从当前版本开始，Otto 在非交互模式（`--output-format stream-json`）下也支持斜杠命令。这意味着您可以在命令行中直接使用斜杠命令，而无需进入交互式界面。

## 工作原理

当您在非交互模式下使用斜杠命令时，系统会：

1. **识别斜杠命令**：检测输入是否以 `/` 开头
2. **加载命令定义**：从所有可用的命令加载器中加载命令（内置命令、MCP提示命令、扩展命令、文件命令等）
3. **执行命令处理**：
   - 如果命令返回**工具调用**（`tool`类型），直接执行工具并返回结果
   - 如果命令返回**提示内容**（`submit_prompt`类型），将内容作为普通提示发送给模型
   - 如果命令是UI专用的（如 `dialog`、`quit`等），返回不支持的错误

## 支持的命令类型

### ✅ 完全支持的命令

以下类型的命令在非交互模式下完全支持：

- **工具调用命令**（返回 `tool` 类型）：
  - 自定义工具命令
  - MCP 工具命令

- **提示转换命令**（返回 `submit_prompt` 类型）：
  - 某些自定义命令可以将斜杠命令转换为特定格式的提示

- **异步任务命令**（返回 `message` 类型）：
  - `/nanobanana` - 文生图命令（在非交互模式下会等待任务完成）
  - 其他需要长时间运行的异步任务命令

### ❌ 不支持的命令

以下类型的命令在非交互模式下不可用（会返回错误）：

- UI对话框命令（`dialog` 类型）：`/theme`、`/help`、`/auth` 等
- 退出命令（`quit` 类型）：`/quit`、`/exit`
- 会话管理命令（`switch_session`、`select_session` 类型）：`/session`
- 历史加载命令（`load_history` 类型）
- 润色结果命令（`refine_result` 类型）：`/refine`

## 使用示例

### 示例 1: 使用 /nanobanana 生成图片

```bash
# 使用 stream-json 格式输出，执行 nanobanana 命令
easycode --output-format stream-json --yolo "/nanobanana auto 1k 一个可爱的小猫照片"
```

输出（JSON 流格式，stderr 输出详细进度）：
```json
// stdout - 标准输出
{"type":"init","session_id":"xxx","model":"gemini-2.0-flash-exp"}
{"type":"message","role":"user","content":"/nanobanana auto 1k 一个可爱的小猫照片"}

// stderr - 详细进度输出（伪流式）
{"type":"nanobanana_submitted","timestamp":"2026-02-14T08:00:00.000Z","task_id":"task_abc123","prompt":"一个可爱的小猫照片","ratio":"auto","size":"1k","reference_image":null,"reference_image_url":null,"estimated_time_seconds":60,"credits_estimated":10}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:02.000Z","task_id":"task_abc123","status":"pending","elapsed_seconds":2,"estimated_seconds":60,"progress_percent":3}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:04.000Z","task_id":"task_abc123","status":"processing","elapsed_seconds":4,"estimated_seconds":60,"progress_percent":6}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:06.000Z","task_id":"task_abc123","status":"processing","elapsed_seconds":6,"estimated_seconds":60,"progress_percent":10}
...
{"type":"nanobanana_completed","timestamp":"2026-02-14T08:00:58.000Z","task_id":"task_abc123","status":"completed","elapsed_seconds":58,"credits_estimated":10,"credits_actual":8,"image_urls":["https://example.com/img1.jpg"],"image_count":1}

// stdout - 最终结果
{"type":"message","role":"assistant","content":"✅ Image generation completed successfully for prompt: \"一个可爱的小猫照片\""}
{"type":"result","status":"success","stats":{...}}
```

#### 带参考图的示例

```bash
easycode --output-format stream-json --yolo "/nanobanana 16:9 2K @ref.jpg 一个未来城市"
```

输出：
```json
// stderr - 参考图上传进度
{"type":"nanobanana_upload_start","timestamp":"2026-02-14T08:00:00.000Z","reference_image":"ref.jpg"}
{"type":"nanobanana_upload_success","timestamp":"2026-02-14T08:00:01.000Z","reference_image":"ref.jpg","uploaded_url":"https://cdn.example.com/ref123.jpg"}
{"type":"nanobanana_submitted","timestamp":"2026-02-14T08:00:01.500Z","task_id":"task_def456","prompt":"一个未来城市","ratio":"16:9","size":"2K","reference_image":"ref.jpg","reference_image_url":"https://cdn.example.com/ref123.jpg","estimated_time_seconds":90,"credits_estimated":20}
...
```

### 示例 2: 普通文本（非斜杠命令）

```bash
# 普通提示，不会被当作斜杠命令处理
easycode --output-format stream-json --yolo "生成一个React组件"
```

### 示例 3: 不支持的斜杠命令

```bash
# 尝试使用 UI 专用命令会返回错误
easycode --output-format stream-json "/theme"
```

输出：
```json
{"type":"error","message":"Command /theme (dialog) is not supported in non-interactive mode"}
{"type":"result","status":"error"}
```

## 技术实现

### 架构设计

```
用户输入
    ↓
nonInteractiveCli.ts
    ↓
handleNonInteractiveSlashCommand() ← nonInteractiveSlashCommandHandler.ts
    ↓
    ├─→ 不是斜杠命令 → 正常发送给模型
    ├─→ 工具调用命令 → 直接执行工具
    ├─→ 提示转换命令 → 转换后发送给模型
    ├─→ 消息命令（异步任务）→ 等待完成后返回结果
    └─→ 不支持的命令 → 返回错误
```

### 关键文件

- `packages/cli/src/nonInteractiveSlashCommandHandler.ts` - 斜杠命令处理器
- `packages/cli/src/nonInteractiveCli.ts` - 非交互模式主逻辑（已集成斜杠命令支持）
- `packages/cli/src/services/CommandService.ts` - 命令服务（命令加载和管理）
- `packages/cli/src/ui/commands/types.ts` - 命令上下文接口（新增 `isNonInteractive` 标志）

### 特殊处理：异步任务命令

某些命令（如 `/nanobanana`）在交互模式下使用"触发即忘"（fire-and-forget）模式，在后台异步执行任务，并通过UI消息更新进度。在非交互模式下，这种模式不适用，因此这些命令会：

1. 检测 `context.isNonInteractive` 标志
2. 如果为 `true`，等待异步任务完成
3. 返回 `message` 类型的结果（成功或失败消息）
4. 系统将 `message` 类型转换为 `complete` 类型结果
5. 直接输出消息并退出，不再继续与模型交互

这种处理方式确保了：
- 在交互模式下，任务在后台运行，用户可以继续与AI交互
- 在非交互模式下，等待任务完成并返回明确的结果（成功或失败）

## 限制和注意事项

1. **命令加载范围**：非交互模式下不会加载插件命令（PluginCommandLoader），因为它依赖于 SkillLoader，在非交互模式下可能不可用。

2. **上下文简化**：非交互模式下的 `CommandContext` 是简化版本，许多UI相关的功能被设置为 no-op（空操作）。

3. **错误处理**：如果斜杠命令执行失败，程序会以非零退出码退出，并输出错误信息。

4. **YOLO模式推荐**：建议配合 `--yolo` 参数使用，自动批准所有工具调用，避免需要手动确认。

## 未来改进方向

- [ ] 支持更多类型的命令在非交互模式下运行
- [ ] 添加命令链式调用支持（例如 `/nanobanana ... | /refine ...`）
- [ ] 优化命令加载性能（缓存已加载的命令）
- [ ] 支持插件命令在非交互模式下运行

## 相关文档

- [命令行接口文档](./cli/commands.md)
- [斜杠命令开发指南](./custom-commands-guide.md)
- [非交互模式输出格式](./cli/output-formats.md)
