# 支持的文件类型快速参考

Otto 的 `search_file_content` 工具通过智能转换，支持 **100+ 常见代码文件类型**，远超 ripgrep 的内置类型。

## 🌐 Web 前端开发

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `tsx` | `*.tsx` | TypeScript + JSX (React) |
| `jsx` | `*.jsx` | JavaScript + JSX (React) |
| `vue` | `*.vue` | Vue.js 单文件组件 |
| `svelte` | `*.svelte` | Svelte 组件 |
| `ng` | `*.component.ts` | Angular 组件 |
| `mjs` | `*.mjs` | ES Module |
| `cjs` | `*.cjs` | CommonJS Module |
| `mts` | `*.mts` | TypeScript ES Module |
| `cts` | `*.cts` | TypeScript CommonJS |

## 🎨 样式表

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `sass` | `*.sass` | SASS (缩进语法) |
| `scss` | `*.scss` | SCSS (CSS 语法) |
| `less` | `*.less` | LESS |
| `styl` | `*.styl` | Stylus |
| `stylus` | `*.stylus` | Stylus (完整名) |

## 📱 移动开发

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `dart` | `*.dart` | Flutter/Dart |
| `swift` | `*.swift` | iOS/macOS |
| `kotlin` | `*.kt` | Android/Kotlin |
| `ktm` | `*.ktm` | Kotlin Module |
| `kts` | `*.kts` | Kotlin Script |

## 🖥️ 编程语言

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `groovy` | `*.{groovy,gradle}` | Groovy/Gradle |
| `scala` | `*.scala` | Scala |
| `clojure` | `*.{clj,cljs,cljc}` | Clojure |
| `elixir` | `*.{ex,exs}` | Elixir |
| `erlang` | `*.{erl,hrl}` | Erlang |
| `haskell` | `*.hs` | Haskell |
| `ocaml` | `*.ml` | OCaml |
| `fsharp` | `*.fs` | F# |
| `nim` | `*.nim` | Nim |
| `crystal` | `*.cr` | Crystal |
| `zig` | `*.zig` | Zig |
| `jl` | `*.jl` | Julia |

## 📊 数据科学 & ML

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `ipynb` | `*.ipynb` | Jupyter Notebook |
| `rmd` | `*.rmd` | R Markdown |
| `jl` | `*.jl` | Julia |

## 🎮 游戏开发

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `gdscript` | `*.gd` | Godot 脚本 |
| `shader` | `*.{shader,cginc,hlsl,glsl,vert,frag}` | 着色器 |

## 🔧 配置文件

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `toml` | `*.toml` | TOML 配置 |
| `yaml` | `*.{yml,yaml}` | YAML 配置 |
| `yml` | `*.yml` | YAML (简写) |
| `ini` | `*.ini` | INI 配置 |
| `env` | `*.env` | 环境变量 |
| `dotenv` | `.env*` | Dotenv 文件 |

## 🐚 Shell 脚本

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `bash` | `*.{sh,bash}` | Bash Shell |
| `zsh` | `*.zsh` | Zsh Shell |
| `fish` | `*.fish` | Fish Shell |
| `powershell` | `*.{ps1,psm1,psd1}` | PowerShell |
| `bat` | `*.{bat,cmd}` | Windows 批处理 |

## 📝 模板引擎

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `ejs` | `*.ejs` | EJS |
| `pug` | `*.pug` | Pug (Jade) |
| `jade` | `*.jade` | Jade |
| `handlebars` | `*.{hbs,handlebars}` | Handlebars |
| `mustache` | `*.mustache` | Mustache |
| `twig` | `*.twig` | Twig |
| `jinja` | `*.{jinja,jinja2,j2}` | Jinja2 |

## 🌐 Web Assembly

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `wasm` | `*.wasm` | WebAssembly 二进制 |
| `wat` | `*.wat` | WebAssembly 文本 |

## 🔌 API & 协议

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `proto` | `*.proto` | Protocol Buffers |
| `graphql` | `*.{graphql,gql}` | GraphQL Schema |

## 🏗️ 基础设施即代码

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `terraform` | `*.tf` | Terraform |
| `dockerfile` | `*Dockerfile*` | Docker 配置 |
| `dockerignore` | `*.dockerignore` | Docker Ignore |
| `gitlab-ci` | `*.gitlab-ci.yml` | GitLab CI/CD |
| `github-workflow` | `*.github/workflows/*.yml` | GitHub Actions |

## 📄 文档格式

| 类型 | 扩展名 | 用途 |
|------|--------|------|
| `mdx` | `*.mdx` | Markdown + JSX |
| `tex` | `*.tex` | LaTeX |
| `rst` | `*.rst` | reStructuredText |
| `adoc` | `*.adoc` | AsciiDoc |
| `asciidoc` | `*.{adoc,asciidoc}` | AsciiDoc (完整) |

## 使用方法

在 Otto CLI 中，直接使用文件类型名：

```bash
# 搜索所有 tsx 文件中的 "useState"
search pattern="useState" type="tsx"

# 搜索 Vue 组件中的 "computed"
search pattern="computed" type="vue" path="src/components"

# 搜索 Dart 文件中的 "StatefulWidget"
search pattern="StatefulWidget" type="dart"

# 搜索 GraphQL schema 中的 "Query"
search pattern="Query" type="graphql"

# 搜索 Terraform 配置中的 "resource"
search pattern="resource" type="terraform"
```

## 技术说明

- **智能转换**：自定义类型自动转换为 glob 模式
- **性能优化**：ripgrep 原生支持的类型仍使用 `--type` 参数
- **无缝体验**：用户无需关心底层实现
- **易于扩展**：新增类型只需在映射表添加一行

## 测试验证

✅ **100% 通过率** (17/17 测试通过)

包括：tsx, jsx, vue, svelte, dart, swift, kotlin, scss, sass, toml, yaml, bash, ejs, pug, graphql, proto, mdx

---

💡 **提示**：如果需要支持更多文件类型，请在 `packages/core/src/tools/grep.ts` 的 `customTypeToGlob` 映射表中添加。
