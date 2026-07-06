# Otto 快速上手

> 你的飞书数字同事 —— 一个住在终端、也住在飞书里的 AI 同事。

## 环境要求

### 必需（核心功能）

- **Node.js 20+**（推荐用 [nvm](https://github.com/nvm-sh/nvm) 安装）
- macOS 或 Linux
- git

### 可选（高级功能，按需安装）

以下依赖为可选的高级功能模块。未安装时 Otto 核心功能不受影响，对应模块会自动降级。

| 依赖 | 安装命令 | 提供的能力 | 未装时的降级行为 |
|------|---------|-----------|----------------|
| **Python 3.10+** | 系统包管理器 | OR-Tools 任务优化服务 | — |
| **ortools + flask** | `pip install -r requirements.txt` | 多约束任务最优分配（数学优化层） | 降级为 LLM/规则分配 |
| **mem0ai** | 已包含在 npm 依赖中（`npm install` 自动安装） | 结构化记忆图谱（实体/关系/偏好自动提取） | 降级为文本文件记忆 |

> **Windows 用户注意**：`mem0ai` 依赖 `better-sqlite3` 原生模块。如果安装时报 SSL 证书错误或 node-gyp 编译失败，执行：
> ```bash
> # 方案1：关闭 SSL 验证后重装
> npm config set strict-ssl false
> npm install
> npm config set strict-ssl true
>
> # 方案2：如果 node-gyp 编译失败（Python 3.12+ 缺少 distutils）
> pip install setuptools
> # 或指定 Python 3.10/3.11 给 node-gyp
> ```

## 三步安装

```bash
# 1. 拿到仓库（需要 Felix 给你 GitHub 访问权）
git clone https://github.com/Felix201209/otto.git
cd otto

# 2. 一键安装（装依赖 + 构建 + 链接 otto 命令，约 3-5 分钟）
./install.sh

# 3. 启动
otto
```

## 配置模型（二选一）

Otto 自己不绑定模型，需要你给它接一个：

**A. 用 Codex 登录（有 ChatGPT 订阅最省事）**
把 Codex OAuth 凭证放在 `~/.codex/auth.json`，Otto 启动时自动读取，无需额外配置。

**B. 用 API key（OpenAI / DeepSeek 等）**
自己创建 `~/.otto-user/custom-models.json`，按下面结构填写（支持 `//` 注释）：

```json
{
  "models": [
    {
      "displayName": "我的模型",
      "provider": "openai-responses",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "modelId": "gpt-5.5"
    }
  ]
}
```

启动 `otto` 后用 `/model` 选中它。也可以直接在 `otto` 里跑 `/model` 走向导新增（向导会帮你写好这个文件）。

> 想最快体验：让 Felix 直接给你一份能用的 key，丢进 B 里即可。

## 接入飞书

启动 `otto` 后，在里面输入：

```
/feishu setup
```

按提示扫码，Otto 就会作为你的数字同事住进飞书，能操作日历、文档、表格、任务等。

## 让 Otto 常驻后台（关掉终端也活）

不想每次开终端都重新启动飞书 bot？用 daemon 让它在后台常驻：

```bash
otto feishu daemon start    # 后台拉起飞书 bot，关掉终端也继续运行
otto feishu daemon status   # 看在不在跑、跑了多久
otto feishu daemon stop     # 停止
```

启动前先在 `otto` 里 `/feishu setup` 扫码配置好；之后 `daemon start` 即可常驻。
pid 和日志写在 `~/.otto-user/`（`feishu-daemon.pid` / `feishu-daemon.log`）。

## 常用命令

| 命令 | 作用 |
|------|------|
| `otto` | 启动 |
| `/help` | 看所有命令 |
| `/model` | 切换模型 |
| `/feishu setup` | 配置并启动飞书 bot |
| `otto feishu daemon start` | 飞书 bot 后台常驻 |
| `/tools` | 查看可用工具 |

## 装不上？

把 `./install.sh` 的报错截图发给 Felix。常见问题：
- **Node 版本过低** → `nvm install 20 && nvm use 20`
- **otto 命令没链接上** → `sudo npm link --ignore-scripts`
