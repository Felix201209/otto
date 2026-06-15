# Feishu Daemon — Autonomous Build Runbook

目标：`otto feishu daemon start|stop|status` —— 脱离终端的后台常驻飞书 bot。
关闭终端也活；pid + 日志写 `~/.otto-user/`。授权人：Felix（/loop-start，自主，做到完美）。

## 步骤
1. [ ] feishuCommand.ts：导出 handleStart + 提供 headless 停止句柄（activeGateway/handleStop）。
2. [ ] 新建 packages/cli/src/feishuDaemon.ts：
       - runDaemonControl(action): start=detached spawn `otto --__feishu_daemon`，写 pid/log；stop=kill pid；status=查 pid+uptime。
       - runFeishuDaemonHeadless(config, settings): 用最小 CommandContext 调 handleStart，挂活，SIGTERM 干净退出。
3. [ ] gemini.tsx：
       - main() 顶部：截获 `feishu daemon <action>` → runDaemonControl → exit（不进 bootstrap）。
       - config/client 就绪后、render 前：若 `--__feishu_daemon` → runFeishuDaemonHeadless → 常驻。
4. [ ] /feishu daemon 槽命令（TUI 内也能管）—— 可选。
5. [ ] build 绿 + 单测；管理层 spawn/pid/stop/status 用 dummy 验证；headless 入口能 boot。
6. [ ] bundle + relink。

## 安全红线（自主无人值守）
- 不留一个我无法核验的 live bot 连着 Felix 的飞书在后台跑：构建+验机制后保持 STOPPED，
  真·上线（连飞书、扫码实测）留给 Felix。
- 不 push 到远程除非全绿且明确。每步对照本目标，跑到完成或硬上限。
