#!/usr/bin/env bash
#
# Otto 一键安装脚本
# 用法：在仓库根目录执行  ./install.sh
#
# 做的事：装依赖 → 构建自包含 bundle → 把 `otto` 命令链接到全局。
# 完成后终端里直接敲 `otto` 即可启动。
#
set -euo pipefail

cyan='\033[36m'; green='\033[32m'; yellow='\033[33m'; red='\033[31m'; dim='\033[2m'; reset='\033[0m'
step() { printf "${cyan}▸ %s${reset}\n" "$1"; }
ok()   { printf "${green}✓ %s${reset}\n" "$1"; }
warn() { printf "${yellow}! %s${reset}\n" "$1"; }
die()  { printf "${red}✗ %s${reset}\n" "$1" >&2; exit 1; }

cd "$(dirname "$0")"

# ── 0. 环境检查 ────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "未找到 Node.js。请先装 Node 20+（推荐 nvm：https://github.com/nvm-sh/nvm）"
command -v npm  >/dev/null 2>&1 || die "未找到 npm。"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本过低（当前 $(node -v)），需要 20+。"
ok "Node $(node -v) / npm $(npm -v)"

# ── 1. 安装依赖 ────────────────────────────────────────────────
# --ignore-scripts：跳过 prepare 钩子里的提前打包（鸡生蛋问题），随后手动 bundle。
step "安装依赖（npm install --ignore-scripts，首次约 1-3 分钟）"
npm install --ignore-scripts
ok "依赖就绪"

# ── 2. 构建自包含 bundle ───────────────────────────────────────
# 等价于 build + esbuild + 拷贝平台资产。
# DOWNLOAD_ALL_PLATFORMS=true：用仓库里已 committed 的 ripgrep 二进制
# (temp/ripgrep-binaries/，含全平台)，不依赖联网下载。这一点很关键——上一步
# 的 --ignore-scripts 会跳过 @vscode/ripgrep 的 postinstall 下载，若这里走默认
# 单平台路径会因找不到 rg 而构建失败。
step "构建 bundle（编译 + 打包 + 内置全平台 ripgrep，约 1-2 分钟）"
DOWNLOAD_ALL_PLATFORMS=true npm run bundle
[ -f bundle/otto.js ] || die "构建未产出 bundle/otto.js，请把上面的报错发给 Felix。"
ok "bundle/otto.js 已生成"

# ── 3. 链接全局 otto 命令 ─────────────────────────────────────
step "链接全局命令 otto（npm link）"
npm link --ignore-scripts
command -v otto >/dev/null 2>&1 || die "otto 命令未链接成功（可能是全局目录无写权限）。试试：sudo npm link --ignore-scripts"
ok "otto 命令已就位：$(command -v otto)"

# ── 完成 ───────────────────────────────────────────────────────
printf "\n${green}安装完成！${reset}\n\n"
printf "${cyan}下一步：配置一个模型${reset}（二选一）\n"
printf "  ${dim}A) 有 ChatGPT 订阅 → 用 Codex 登录：${reset}\n"
printf "     在 ~/.codex/auth.json 放好 Codex OAuth 凭证（或运行 codex login），Otto 会自动读取。\n"
printf "  ${dim}B) 有 API key（OpenAI / DeepSeek 等）→ 编辑：${reset}\n"
printf "     ~/.otto-user/custom-models.json 填上 endpoint 与 key（首次运行 otto 会生成模板）。\n\n"
printf "${cyan}启动：${reset}直接敲  ${green}otto${reset}\n"
printf "${cyan}接飞书：${reset}启动后在 otto 里输入  ${green}/feishu setup${reset}  扫码即可。\n\n"
