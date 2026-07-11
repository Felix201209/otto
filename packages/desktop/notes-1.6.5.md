# Otto v1.6.5

v1.6.5 是 Windows 文档生成安全热修：

- 修复旧 PPT 回退链路中的 Marp 缺失、Windows 终端乱码和命令执行问题。
- Marp、Typst、Pandoc 改为参数数组执行，避免路径被拼进 shell。
- 全局 npm 安装始终要求人工确认；停止任务会中止外部渲染进程。
