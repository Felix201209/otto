#!/usr/bin/env bash
# ============================================================
# Otto Delivery Test Checklist — Interactive Test Runner
# ============================================================
# Usage:
#   chmod +x scripts/test-checklist.sh
#   ./scripts/test-checklist.sh
#
# Walks through each test item from docs/test-matrix.md,
# prompts the tester for PASS/FAIL/SKIP, and writes results
# to test-results-YYYY-MM-DD.md in the project root.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATE="$(date +%Y-%m-%d)"
TIME="$(date +%H:%M:%S)"
OUTPUT_FILE="$PROJECT_DIR/test-results-$DATE.md"

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ── Counters ────────────────────────────────────────────
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_COUNT=0

declare -a FAILED_ITEMS=()

# ── Helpers ─────────────────────────────────────────────

prompt_result() {
    local id="$1"
    local desc="$2"
    local expect="$3"
    local answer

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}测试项: ${id}${NC}"
    echo -e "  描述:     ${desc}"
    echo -e "  预期结果: ${expect}"
    echo ""
    
    while true; do
        printf "${YELLOW}  → 结果 [PASS/FAIL/SKIP]: ${NC}"
        read -r answer
        case "${answer^^}" in
            PASS|P)
                answer="PASS"
                break
                ;;
            FAIL|F)
                answer="FAIL"
                break
                ;;
            SKIP|S)
                answer="SKIP"
                break
                ;;
            *)
                echo -e "  ${RED}无效输入，请输入 PASS、FAIL 或 SKIP${NC}"
                ;;
        esac
    done

    local notes=""
    if [ "$answer" = "FAIL" ]; then
        printf "  ${RED}失败原因/备注: ${NC}"
        read -r notes
    elif [ "$answer" = "SKIP" ]; then
        printf "  ${YELLOW}跳过原因: ${NC}"
        read -r notes
    fi

    echo "$answer|$notes"
}

# ── Headers ─────────────────────────────────────────────

cat > "$OUTPUT_FILE" <<EOF
# Otto 交付测试结果 — $DATE

> 测试时间: $DATE $TIME
> 执行人: __________________
> 环境:    __________________ (macOS Apple Silicon / macOS Intel / Windows 10 / Windows 11 / 其他)

---

## 测试结果明细

| ID | 类别 | 描述 | 预期结果 | 结果 | 备注 |
|----|------|------|---------|------|------|
EOF

# ── Test Items ──────────────────────────────────────────
# Format: "ID|Category|Description|Expected Result"

TEST_ITEMS=(
    # ── macOS Apple Silicon ──
    "MAC-AS-01|macOS Apple Silicon|全新安装 Otto .app（未签名，右键打开）|安装成功，应用图标出现在 /Applications"
    "MAC-AS-02|macOS Apple Silicon|双击启动 .app，应用窗口正常打开|窗口无报错，显示首屏引导页或登录页"
    "MAC-AS-03|macOS Apple Silicon|输入消息并发送，收到流式 AI 回复|实时显示流式回复，无超时或卡死"
    "MAC-AS-04|macOS Apple Silicon|通过对话请求 AI 创建文件并保存到本地|文件正确创建，内容一致"
    "MAC-AS-05|macOS Apple Silicon|切换 AI 模型（Claude → GPT 等）|模型切换后新对话使用新模型，状态正确"
    "MAC-AS-06|macOS Apple Silicon|检查系统托盘/菜单栏图标|图标可见，右键菜单正常，可最小化到托盘"
    "MAC-AS-07|macOS Apple Silicon|系统通知功能|通知弹出，内容正确，可点击跳转"
    "MAC-AS-08|macOS Apple Silicon|通过菜单/Cmd+Q 退出应用|应用完全关闭，进程不残留"

    # ── macOS Intel ──
    "MAC-INTEL-01|macOS Intel|全新安装 Otto .app（未签名，右键打开）|安装成功，无架构不兼容提示"
    "MAC-INTEL-02|macOS Intel|双击启动 .app，首屏正常渲染|窗口无报错，显示首屏"
    "MAC-INTEL-03|macOS Intel|发送消息并接收流式回复|消息正常收发，Rosetta 2 下性能可接受"
    "MAC-INTEL-04|macOS Intel|通过对话操作本地文件|文件操作正常，权限正确"
    "MAC-INTEL-05|macOS Intel|切换 AI 模型|模型切换一致，无报错"
    "MAC-INTEL-06|macOS Intel|检查系统托盘/菜单栏|托盘图标正常，右键菜单可用"
    "MAC-INTEL-07|macOS Intel|系统通知功能|通知正常弹出"
    "MAC-INTEL-08|macOS Intel|完全退出应用|进程清理干净，无残留"

    # ── Windows 10 ──
    "WIN10-01|Windows 10|下载并安装 Otto 安装包 (.exe/.msi)|安装成功，快捷方式创建"
    "WIN10-02|Windows 10|双击启动 Otto，主窗口正常打开|窗口无报错，首屏渲染正确"
    "WIN10-03|Windows 10|发送消息并接收流式 AI 回复|消息收发正常，编码无乱码"
    "WIN10-04|Windows 10|通过对话操作本地文件|文件操作正常，路径处理正确"

    # ── Windows 11 ──
    "WIN11-01|Windows 11|下载并安装 Otto 安装包 (.exe/.msi)|安装成功，兼容 Windows 11"
    "WIN11-02|Windows 11|双击启动 Otto，主窗口正常渲染|窗口无报错，与现代窗口管理兼容"
    "WIN11-03|Windows 11|发送消息并接收流式 AI 回复|消息收发正常"
    "WIN11-04|Windows 11|通过对话操作本地文件|文件操作正常，权限模型兼容"

    # ── 低性能机器 ──
    "LOW-01|低性能机器|监控 Otto 运行时内存占用峰值|内存 < 500MB（不含模型推理）"
    "LOW-02|低性能机器|测量冷启动时间|冷启动 < 10 秒"

    # ── 飞书私聊 ──
    "FEISHU-DM-01|飞书私聊|飞书用户向 Otto 发送私聊消息|Otto 收到消息并在 app 中实时显示"
    "FEISHU-DM-02|飞书私聊|在 app 内对飞书私聊会话回复|回复推送飞书，对方收到（双向）"
    "FEISHU-DM-03|飞书私聊|飞书私聊中发送附件（图片/文件）|Otto 接收附件并在 app 中展示"

    # ── 飞书群聊 ──
    "FEISHU-GROUP-01|飞书群聊|多用户在群聊中同时发消息|正确区分用户，不串会话"
    "FEISHU-GROUP-02|飞书群聊|群聊中 @mention Otto|正确响应 @mention"

    # ── 企业版 vs 个人版 ──
    "ENT-01|企业版 vs 个人版|个人版：验证无企业功能入口|不显示团队管理、SSO 等企业功能"
    "ENT-02|企业版 vs 个人版|企业版：验证企业功能正常可用|正常显示团队管理、审计日志、SSO 等功能"
)

# ── Run Tests ───────────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║     Otto 交付测试清单 — 交互式测试执行器         ║${NC}"
echo -e "${BOLD}${CYAN}║     结果将写入: test-results-${DATE}.md           ║${NC}"
echo -e "${BOLD}${CYAN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "共 ${#TEST_ITEMS[@]} 个测试项，按 Enter 开始..."
read -r

for item in "${TEST_ITEMS[@]}"; do
    IFS='|' read -r id cat desc expect <<< "$item"
    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    result_line="$(prompt_result "$id" "$desc" "$expect")"
    result="${result_line%%|*}"
    notes="${result_line#*|}"

    case "$result" in
        PASS)
            PASS_COUNT=$((PASS_COUNT + 1))
            emoji="✅"
            ;;
        FAIL)
            FAIL_COUNT=$((FAIL_COUNT + 1))
            emoji="❌"
            FAILED_ITEMS+=("$id: $desc → $notes")
            ;;
        SKIP)
            SKIP_COUNT=$((SKIP_COUNT + 1))
            emoji="⏭️"
            ;;
    esac

    echo "| $id | $cat | $desc | $expect | $emoji $result | $notes |" >> "$OUTPUT_FILE"
    echo -e "  ${GREEN}已记录: $id → $result${NC}"
done

# ── Summary ─────────────────────────────────────────────

cat >> "$OUTPUT_FILE" <<EOF

---

## 测试摘要

| 指标 | 数值 |
|------|------|
| 总测试项 | $TOTAL_COUNT |
| ✅ 通过 | $PASS_COUNT |
| ❌ 失败 | $FAIL_COUNT |
| ⏭️ 跳过 | $SKIP_COUNT |
| 通过率 | $(( PASS_COUNT * 100 / TOTAL_COUNT ))% |

EOF

if [ ${#FAILED_ITEMS[@]} -gt 0 ]; then
    {
        echo "### 失败项明细"
        echo ""
        for fi in "${FAILED_ITEMS[@]}"; do
            echo "- ❌ $fi"
        done
        echo ""
    } >> "$OUTPUT_FILE"
fi

{
    echo "---"
    echo ""
    echo "> 请将以上结果同步更新到 \`docs/test-matrix.md\` 的摘要表和各项"通过/失败"列。"
    echo "> 测试时间: $DATE $TIME"
} >> "$OUTPUT_FILE"

# ── Print Summary ───────────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}╔═══════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║              测 试 完 成                          ║${NC}"
echo -e "${BOLD}${CYAN}╚═══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  总测试项: ${BOLD}${TOTAL_COUNT}${NC}"
echo -e "  ${GREEN}✅ 通过:   ${PASS_COUNT}${NC}"
echo -e "  ${RED}❌ 失败:   ${FAIL_COUNT}${NC}"
echo -e "  ${YELLOW}⏭️  跳过:   ${SKIP_COUNT}${NC}"
echo ""
echo -e "  ${BOLD}通过率: $(( PASS_COUNT * 100 / TOTAL_COUNT ))%${NC}"
echo ""
echo -e "  结果文件: ${CYAN}${OUTPUT_FILE}${NC}"
echo ""

if [ ${#FAILED_ITEMS[@]} -gt 0 ]; then
    echo -e "${RED}${BOLD}失败项:${NC}"
    for fi in "${FAILED_ITEMS[@]}"; do
        echo -e "  ${RED}❌ $fi${NC}"
    done
    echo ""
fi

echo -e "${YELLOW}请将结果同步更新到 docs/test-matrix.md${NC}"
echo ""
