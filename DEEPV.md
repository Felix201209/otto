## Otto Added Memories
### 项目概述
Otto 是一个 AI 驱动的智能编程助手，采用 monorepo 架构，包含 4 个主要包：
- **cli** (easycode-cli): 命令行界面 (binary: "easycode")
- **core** (easycode-core): 核心功能库，被其他包依赖
- **vscode-ui-plugin** (easycode-ai-vscode-ui-plugin): 完整的 VS Code 扩展，提供可视化 AI 编码辅助
- **vscode-ide-companion** (easycode-ai-vscode-companion): 轻量级 IDE 集成伙伴（不常更新）

**技术栈**: Node.js 20+, TypeScript 5.9+, React 19, Ink 6.4.7, esbuild 0.25, Vitest 3.2

### 项目架构
```
Otto (Monorepo)
├── packages/
│   ├── cli/                     # 命令行界面
│   │   ├── src/ui/              # React-based terminal UI (Ink框架)
│   │   ├── src/services/        # 服务层 (CommandService, SkillLoader等)
│   │   ├── src/auth/            # 身份认证
│   │   ├── src/config/          # 配置管理 (extensions, settings)
│   │   ├── src/commands/        # 内置命令 + extensions 命令
│   │   ├── src/acp/             # 自动代码补全
│   │   ├── src/remote/          # 远程功能
│   │   └── gemini.tsx           # 主入口点
│   ├── core/                    # 核心功能库
│   │   ├── src/tools/           # 工具系统 (文件、shell、web、MCP等)
│   │   ├── src/core/            # 核心逻辑 (GeminiChat、prompt管理)
│   │   ├── src/auth/            # 身份认证系统 (OAuth2)
│   │   ├── src/mcp/             # Model Context Protocol 支持
│   │   ├── src/code_assist/     # 代码辅助功能
│   │   ├── src/hooks/           # Hooks 钩子系统
│   │   ├── src/skills/          # Skills 技能系统
│   │   ├── src/lsp/             # Language Server Protocol
│   │   ├── src/services/        # 核心服务层
│   │   ├── src/telemetry/       # 遥测系统
│   │   └── src/utils/           # 工具函数
│   ├── vscode-ui-plugin/        # VS Code 完整扩展
│   │   ├── src/                 # Extension 主代码
│   │   └── webview/             # React webview UI
│   └── vscode-ide-companion/    # VS Code 轻量级集成
├── docs/                        # 完整文档系统
│   ├── HOOKS_*.md              # Hooks 系统文档
│   ├── cli/                    # CLI 文档
│   ├── core/                   # Core 文档
│   └── tools/                  # 工具文档
├── scripts/                     # 构建和工具脚本
│   ├── build.js                # 主构建脚本
│   ├── newpack.js              # 打包脚本
│   └── tests/                  # 脚本测试
└── 配置文件 (package.json, tsconfig.json, eslint.config.js等)
```

**内部依赖关系**: cli → core; vscode-ui-plugin → core (通过 npm workspaces)

**核心特点**:
- 🏗️ 单仓库架构 (npm workspaces)
- 🔧 丰富的工具系统 (20+ 内置工具)
- 🔌 MCP 协议支持 (与外部服务集成)
- 🪝 Hooks 钩子机制 (安全控制和扩展)
- 🎯 Skills 技能系统 (可复用的 AI 工作流)
- 🧪 完整测试覆盖 (194+ 测试文件)
- 📦 跨平台支持 (Windows, macOS, Linux)
- 🌐 i18n 国际化支持

### 开发规范

#### AI 工作流程规范
1. **构建测试**: 始终使用 `npm run build` 测试代码是否能通过编译
2. **禁止交互式启动**: 不要使用 `npm run dev` 或 `npm start`（会启动交互式 CLI）
3. **临时脚本管理**: 可以编写临时测试脚本验证功能，但完成后必须清理
4. **测试要求**: 对 cli 和 core 包的业务修改，必须同时更新对应的 test 文件。测试难度大时可先用 skip 占位
5. **单文件测试优先**: ⚠️ 禁止运行全量测试（`npm run test`）！仅测试修改的文件：
   - 使用 `npx vitest run <test-file-path>` 测试单个文件
   - 例如：`npx vitest run packages/cli/src/ui/hooks/useCompletion.test.ts`
   - 全量测试由 CI/CD 自动运行，本地开发节省时间
6. **Git 提交规范**: 在解决同一个任务或修复同一个问题的过程中，应优先使用 `git commit --amend` 将多次修改合并为一笔提交，避免产生大量琐碎的提交记录。只有在完成一个逻辑独立的阶段性功能时，才创建新的提交。
7. **发版流程规范**: 在执行任何代码提交推送和发版流程前，**必须在主线分支上拉取最终代码并双重执行 `npm run build` 确保本地构建 100% 全绿**！创建与合并 Merge Request 时，应**优先使用本地 `glab` 命令行工具**。严禁“带病发版”或越过本地编译，详情请务必主动阅读并查阅发版指南 Wiki [`.llm-wiki/wiki/release-process.md`](.llm-wiki/wiki/release-process.md)。

#### 代码规范
1. **i18n 国际化**: 所有面向最终用户的 UI 文案必须国际化
2. **日志语言**: 开发调试日志可不做 i18n，但尽量使用英文
3. **类型安全**: 使用 TypeScript strict 模式
4. **代码风格**: 遵循 ESLint 配置 (eslint.config.js)

#### 测试规范
- **单元测试**: 使用 Vitest 3.2
- **测试覆盖**: 194+ 测试文件覆盖核心功能
- **CI/CD**: `npm run test:ci` 自动化测试
- **测试命令**:
  - ⚠️ `npm run test` - 全量测试（AI 禁止使用，仅用于 CI）
  - ✅ `npx vitest run <file>` - 单文件测试（AI 推荐使用）
  - ✅ `npx vitest run packages/cli/src/**/*.test.ts` - 按目录测试
  - `npm run test:ci` - CI 模式（含覆盖率）
  - `npm run test:scripts` - 脚本测试
- **AI 测试策略**:
  - 只测试你修改的文件及其对应的 test 文件
  - 示例：修改了 `useCompletion.ts` → 运行 `npx vitest run packages/cli/src/ui/hooks/useCompletion.test.ts`
  - 避免运行全量测试以节省开发时间和系统资源

### 用户偏好
- ❌ 尽量不生成 .md 文件（除非用于 AI 任务记忆，且用完必须删除）
- ❌ 尽量不使用 sequentialthinking 工具

### 项目关键文件
- `Otto_Code_Whitepaper.md` - 项目白皮书
- `EASYCODE.md` - 本文件（AI记忆文件）
- `docs/index.md` - 文档总索引
- ls-dev 是用户的常驻开发分支，提 MR 时绝对不要加 --remove-source-branch。
- Otto 项目发布规则（CI）：package.json 里的版本号无所谓（CI 发布时会自动注入真实版本号），但 **package.json 的版本号必须严格低于 release tag 的版本号**，否则 CI 会失败。例如 release tag 为 cli-release-v1.0.334 时，package.json 版本必须 < 1.0.334（例如 1.0.319 就满足）。打 tag 前务必确认版本号关系。
- Otto 项目目录命名约定（极易搞错，务必记住）：全局配置目录是 `~/.easycode-user/`（用户家目录下），项目级配置目录是 `<projectRoot>/.easycode/`（项目根目录下）。两个目录名前缀不同是为了规避命名冲突，绝不能混用：项目里出现 `.easycode-user` 是错误，全局出现 `.easycode` 也是错误。`PROJECT_DIR_PREFIX = '.easycode'` 定义在 `packages/core/src/utils/paths.ts`。例如飞书凭证只走全局，固定写入 `~/.easycode-user/feishu-credentials.json`，不接受 projectRoot 参数。
- 用户要求交流时：1) 不使用浮夸的赞美和认同；2) 保持独立思辨能力，对用户的说法进行批判性判断，不盲从（用户说的不一定都对）；3) 用词严谨专业，不使用网络用语。
- 始终使用中文进行交流。

## Otto Added Memories
- Otto/Otto 品牌改名时，MCP OAuth 相关的 "Gemini" 标识符必须保留不改——因为对外需以 Gemini 身份才能被第三方 OAuth 服务授权识别（对方系统只认 Gemini）。品牌改名只针对用户可见的文案提示，不动这类对外身份标识符。
