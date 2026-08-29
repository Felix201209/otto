# Agent Runtime Engineering Wiki

Otto Agent Runtime 的工程导航页。具体规则只在对应权威契约中维护，本文不复制规则正文。

## 边界与生命周期

- [运行时内核边界](./runtime-kernel-boundary.md)
- [项目架构](./architecture.md)
- [产品模块边界](./product-modules.md)
- [Checkpointing](./checkpointing.md)
- [后台任务与成本安全](./background-task-cost-safety.md)

## 模型、工具与扩展

- [自定义模型架构](./custom-models-architecture.md)
- [自定义模型指南](./custom-models-guide.md)
- [MCP 响应防护](./mcp-response-guard.md)
- [MCP 顺序启动](./mcp-sequential-startup.md)
- [Skills 使用](./skills-usage.md)
- [Hooks 架构](./HOOKS_ARCHITECTURE.md)

## 验证与交付

- [贡献与验证](./CONTRIBUTING.md)
- [构建工作流](./build-workflow.md)
- [测试矩阵](./test-matrix.md)
- [集成测试](./integration-tests.md)
- [发布前检查](./release-preflight.md)

## 成熟度基线

- [成熟 Agent 收口标准](./mature-agent-closure.md)
- [服务器集成基线](./server-integration-baseline.md)
- [遥测](./telemetry.md)
- [沙箱](./sandbox.md)

若文档与代码不一致，应先用测试确认当前行为，再更新对应权威契约和本导航；不要创建另一份平行总结。
