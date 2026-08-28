# Otto 工程知识库

这里是仓库文档的权威入口。代码行为优先于历史说明；同一主题有多份资料时，以本页列出的“权威契约”为准。

## 首先阅读

- [项目架构](./architecture.md)：系统组件和主要数据流。
- [产品模块边界](./product-modules.md)：稳定模块 ID、所有权和依赖方向。
- [运行时内核边界](./runtime-kernel-boundary.md)：哪些能力可以进入 core，哪些必须留在外层。
- [贡献与验证](./CONTRIBUTING.md)：开发纪律、测试顺序和提交要求。
- [Agent Runtime Engineering Wiki](./agent-runtime-engineering-wiki.md)：运行时主题导航。

## 安全与运行时契约

- [后台任务与成本安全](./background-task-cost-safety.md)：后台任务登记、付费默认值、输入版本、外呼审计和恢复要求。
- [成熟 Agent 收口标准](./mature-agent-closure.md)：面向成熟运行时的验收标准。
- [MCP 响应防护](./mcp-response-guard.md)及其[接入指南](./mcp-response-guard-integration-guide.md)。
- [沙箱](./sandbox.md)：执行隔离和权限边界。
- [遥测](./telemetry.md)：可观测性与数据边界。
- [数据治理与合规基线](./compliance/data-governance.zh-CN.md)。

## 构建、测试与发布

- [构建工作流](./build-workflow.md)
- [测试矩阵](./test-matrix.md)
- [集成测试](./integration-tests.md)
- [发布前检查](./release-preflight.md)
- [发布手册](./RELEASE.md)
- [GitHub Actions 发布](./github-actions-release.md)
- [仓库迁移说明](./repository-migration.md)

## 产品与集成

- [桌面 UI 规范](./otto-desktop-ui-spec.md)
- [产品 UX 契约](./product-ux-contracts.md)
- [企业组件架构](./enterprise-component-architecture.md)
- [企业存储拓扑](./enterprise-storage-topology.md)
- [自定义模型](./custom-models-guide.md)及其[架构](./custom-models-architecture.md)
- [MCP 顺序启动](./mcp-sequential-startup.md)
- [Skills 使用](./skills-usage.md)
- [Hooks 架构](./HOOKS_ARCHITECTURE.md)及其[用户指南](./hooks-user-guide.md)
- [LSP 使用](./LSP_USAGE_GUIDE.md)

## 知识维护规则

1. 新文档必须从本索引或某个已索引的专题页可达。
2. 设计变更应更新权威契约，不再新增“最终总结”“修复总结”类平行文档。
3. 临时计划和历史交付记录不作为当前行为依据；需要保留时应明确标注状态和替代文档。
4. 文档中的配置、命令和路径必须有代码、测试或 CI 检查支撑。
5. [Otto 知识库](./llm-wiki-guide.md)描述无需配置的自动知识整理体验，不是本仓库工程规范的替代品。
