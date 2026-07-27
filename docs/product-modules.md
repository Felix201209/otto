# Otto 产品模块边界

Issue: [#152](https://github.com/Felix201209/otto/issues/152)

Otto 采用模块化单体架构。模块用于建立代码、数据、权限、License、更新和审计边界，
不表示每个模块都要成为独立进程。稳定英文 ID 是协议和持久化标识，中文名称只用于界面与文档。

唯一代码注册表位于 `packages/server/src/productModules.ts`。任何 License、模块更新或管理界面
需要模块清单时，都应从该注册表派生，禁止重新维护第二份模块 ID 列表。

## 稳定模块

| ID | 中文名称 | 主要数据所有权 |
| --- | --- | --- |
| `agent_runtime` | 智能体运行内核 | 回合执行状态、运行时检查点 |
| `model_gateway` | 模型接入中心 | 模型配置元数据、标准化 Token 用量 |
| `tool_skill_platform` | 工具与技能中心 | Skill 清单、工具注册元数据 |
| `personal_intelligence` | 个人智能中心 | 个人记忆、工作日志、自动 Skill、账号同步快照 |
| `document_experts` | 文档专家中心 | 专家工作流模板、文档生成元数据 |
| `identity_organization` | 身份与组织管理 | 账号、会话、企业、部门、岗位、邀请码 |
| `authorization` | 权限管理中心 | 权限策略、角色分配 |
| `collaboration` | 企业协作中心 | 私聊、附件、未读、在线状态、A2A 请求 |
| `enterprise_knowledge` | 企业知识中心 | 企业知识、知识作用域 |
| `park_services` | 产业园服务中心 | 园区、入驻企业、服务、工单、统计 |
| `data_platform` | 数据存储中心 | 数据迁移、加密密钥、备份和对象元数据 |
| `commercial_control` | 商业授权中心 | 部署身份、License、遥测队列、更新清单、审计 |
| `desktop_shell` | 桌面应用外壳 | 桌面偏好、登录信封、下载更新状态 |
| `integration_adapters` | 外部服务接入中心 | 集成凭证、外部租户绑定 |

## 物理迁移状态

`commercial_control` 是第一个完成物理目录迁移的模块，实现位于
`packages/server/src/modules/commercial_control/`，统一通过该目录的 `index.ts` 暴露能力。
原 `packages/server/src/enterprise/` 下的同名文件只保留兼容导出，不允许继续加入实现。

`data_platform` 的第一阶段存储内核位于 `packages/server/src/modules/data_platform/`。
服务端业务模块统一通过其公共入口使用 SQLite 数据库能力；业务表结构、SQL 和 Repository
仍归各业务模块所有，不由数据平台接管业务判断。

`authorization` 的第一阶段策略内核位于 `packages/server/src/modules/authorization/`。
Agent 工具确认策略与企业 HTTP 路由鉴权分类统一通过该模块的 `index.ts` 暴露；旧路径只保留
兼容导出。企业各业务路由中的岗位、数据范围与资源所有权判断仍由后续 Issue 分批迁移，
不得据此宣称权限层已全部重构完成。

其他模块目前仍以注册表边界为主，将按 Issue 分批迁移。模块未完成物理迁移前，不得为了追求目录整齐
一次性移动跨业务链路代码。

## 商业能力

产品模块和收费能力不是一一对应。`collaboration` 内的私聊与 A2A 仍可分别授权。
当前正式能力 ID 为：

- `enterprise_tree`
- `direct_messages`
- `atoa`
- `knowledge`
- `park_service`
- `feishu_auto_reply`

旧 License 中的 `park_services`、`feishu`、`enterprise_memory` 会在读取时映射到正式 ID；
新 License 与模块更新 API 不再公开这些别名。`tui_sync` 已随终端 UI 退役而删除。

## 边界规则

1. 模块只能依赖注册表声明的模块，依赖图必须无环。
2. 业务模块不得直接读取其他模块拥有的数据；跨模块访问通过公开接口或领域事件完成。
3. `authorization` 是执行层权限事实来源，UI 隐藏不能替代服务端拒绝。
4. `data_platform` 提供持久化、事务、加密和迁移能力，不包含业务判断。
5. `commercial_control` 管理授权和运行元数据，默认不得采集聊天、文件、会议或记忆原文。
6. `agent_runtime` 不依赖桌面、企业、园区、飞书或具体存储实现。
7. 新增或改名模块必须更新注册表、契约测试和本文件；稳定 ID 不允许原地改义。

## 部署边界

默认仍将业务模块编译到同一个 Otto Server，保证私有化部署简单。只有控制面、客户数据面和
对象存储在规模或隔离要求明确时才独立部署。拆分服务不能绕过现有权限、审计和迁移契约。
