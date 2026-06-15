# Otto 快速上手

> 你的飞书数字同事 —— 一个住在终端、也住在飞书里的 AI 同事。

## 环境要求

- **Node.js 20+**（推荐用 [nvm](https://github.com/nvm-sh/nvm) 安装）
- macOS 或 Linux
- git

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
编辑 `~/.otto-user/custom-models.json`，填上模型的 `endpoint` 和 `apiKey`。首次运行 `otto` 会生成 `~/.otto-user/` 配置目录。

> 想最快体验：让 Felix 直接给你一份能用的 key，丢进 B 里即可。

## 接入飞书

启动 `otto` 后，在里面输入：

```
/feishu setup
```

按提示扫码，Otto 就会作为你的数字同事住进飞书，能操作日历、文档、表格、任务等。

## 常用命令

| 命令 | 作用 |
|------|------|
| `otto` | 启动 |
| `/help` | 看所有命令 |
| `/model` | 切换模型 |
| `/feishu setup` | 配置并启动飞书 bot |
| `/tools` | 查看可用工具 |

## 装不上？

把 `./install.sh` 的报错截图发给 Felix。常见问题：
- **Node 版本过低** → `nvm install 20 && nvm use 20`
- **otto 命令没链接上** → `sudo npm link --ignore-scripts`
