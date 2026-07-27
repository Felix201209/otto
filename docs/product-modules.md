# Otto 产品模块边界

Issue: [#152](https://github.com/Felix201209/otto/issues/152)

Otto 采用模块化单体架构。模块用于建立代码、数据、权限、License、更新和审计边界，
不表示每个模块都要成为独立进程。稳定英文 ID 是协议和持久化标识，中文名称只用于界面与文档。

唯一代码注册表位于 `packages/server/src/productModules.ts`。任何 License、模块更新或管理界面
需要模块清单时，都应从该注册表派生，禁止重新维护第二份模块 ID 列表。

## 稳定模块

| ID                      | 中文名称         | 主要数据所有权                               |
| ----------------------- | ---------------- | -------------------------------------------- |
| `agent_runtime`         | 智能体运行内核   | 回合执行状态、运行时检查点                   |
| `model_gateway`         | 模型接入中心     | 模型配置元数据、标准化 Token 用量            |
| `tool_skill_platform`   | 工具与技能中心   | Skill 清单、工具注册元数据                   |
| `personal_intelligence` | 个人智能中心     | 个人记忆、工作日志、自动 Skill、账号同步快照 |
| `document_experts`      | 文档专家中心     | 专家工作流模板、文档生成元数据               |
| `identity_organization` | 身份与组织管理   | 账号、会话、企业、部门、岗位、邀请码         |
| `authorization`         | 权限管理中心     | 权限策略、角色分配                           |
| `collaboration`         | 企业协作中心     | 私聊、附件、未读、在线状态、A2A 请求         |
| `enterprise_knowledge`  | 企业知识中心     | 企业知识、知识作用域                         |
| `park_services`         | 产业园服务中心   | 园区、入驻企业、服务、工单、统计             |
| `data_platform`         | 数据存储中心     | 数据迁移、加密密钥、备份和对象元数据         |
| `commercial_control`    | 商业授权中心     | 部署身份、License、遥测队列、更新清单、审计  |
| `desktop_shell`         | 桌面应用外壳     | 桌面偏好、登录信封、下载更新状态             |
| `integration_adapters`  | 外部服务接入中心 | 集成凭证、外部租户绑定                       |

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

`identity_organization` 的第一阶段企业邀请码内核位于
`packages/server/src/modules/identity_organization/`。邀请码类型、HMAC 派生与校验 Repository、
事务 Facade 和可信公开链接策略只有一份实现；账号、会话和企业结构持久化仍留待后续
Issue 分批迁移。

第二阶段将企业功能开关、部门和岗位 HTTP 路由迁入同一模块。路由通过
`OrganizationRouteServices` 声明所需能力，由企业 dispatcher 注入当前数据库实现；模块本身
不再反向导入 `enterprise/db.ts`。账号、会话以及组织结构的持久化实现仍待后续迁移。

第三阶段将企业成员目录 Repository 与 Facade 迁入同一模块。成员创建、租户内查询、列表和
离职操作只依赖 `MemberRepositoryStore`，由 `enterprise/db.ts` 注入 SQLite、组织存在性校验、
部门职位归一和审计能力。旧 `enterprise/employeeRepository.ts` 仅保留兼容导出，消除了
`db.ts -> employeeRepository.ts -> db.ts` 的循环依赖；旧 OrgMemoryStore 数据只允许回落到
默认企业，不能混入其他租户。

第四阶段将认证会话签发、查询和撤销迁入同一模块。明文令牌只返回登录调用方，数据库仅保存
SHA-256 摘要；读取会话时必须同时满足会话、账号与企业租户一致，且账号和企业均处于启用状态。
`enterprise/db.ts` 只通过 `AuthSessionRepositoryStore` 注入账号查询、企业状态和视图转换，
30 天中心会话与桌面端短身份租约仍是两个独立层级。

第五阶段将账号目录读取、企业账号列表、密码登录和手机号查找迁入同一模块。查询逻辑通过
`AccountDirectoryRepositoryStore` 使用 SQLite、标识符归一、密码比对、企业状态和视图转换；
企业列表与显式账号查询保留租户边界，登录同时要求账号和企业启用。账号创建、更新、删除、
密码哈希策略与短信验证仍留在后续 Issue，不能据此宣称账号持久化已经全部迁移。

第六阶段将账号创建、更新、软删除与账号标签写入迁入 `AccountLifecycleRepositoryStore`。
职位 `role_mapping` 继续作为管理员权限源，账号与员工档案在事务内联动；密码、状态、权限或
岗位变化会撤销旧会话，删除则清理登录身份并保留历史业务引用。密码策略与哈希算法、短信挑战、
普通注册和企业整体开户仍由现有流程注入或编排，不属于本阶段的物理迁移范围。

第七阶段将普通账号注册、个人空间注册和个人账号凭企业邀请码入企迁入
`AccountRegistrationRepositoryStore`。企业注册和入企都在持久化时重新读取当前企业、部门、
岗位与 `role_mapping`，邀请码名额核销、员工档案、账号、活跃会话、标签和审计在同一事务内完成；
个人注册则为每个账号创建隔离的个人组织。短信挑战、密码哈希策略与平台创建整家企业的流程仍不属于
本阶段，调用方继续通过既有接口编排这些能力。

第八阶段将企业实体创建与平台企业开户迁入 `OrganizationProvisioningRepositoryStore`。企业名称、
稳定 slug、独立邀请密钥和创建审计由同一内核维护；单独创建企业使用可嵌套事务，平台开户则原子组合
企业、首位企业管理员和首个 7 天邀请码，任一步失败都不会留下孤儿数据。企业读取与组织结构、短信挑战
和密码哈希策略仍由后续 Issue 分批迁移。

第九阶段将企业详情和企业列表读取迁入 `OrganizationDirectoryRepositoryStore`。内部身份流程可以读取
真实企业与个人隔离 organization；平台多企业目录则在 SQL 层只接受拥有未删除企业账号的组织，个人空间、
孤立组织和仅剩已删除账号的组织不能穿透平台边界。园区归属、地址和门牌字段统一使用同一行映射规则。
部门岗位结构、企业功能开关、短信挑战与密码策略仍留待后续迁移。

第十阶段将部门与岗位结构迁入 `OrganizationStructureRepositoryStore`。部门和岗位的读取、创建、重命名、
删除约束、岗位权限映射及会话撤销由同一事务边界管理；所有 SQL 均要求企业 ID，跨企业节点按不存在处理。
部门重命名会同步账号、员工档案与邀请，岗位变化会同步身份权限并保护最后一名可登录企业管理员。
企业功能开关、短信挑战、密码策略与在线状态仍留待后续迁移。

第十一阶段将企业功能配置迁入 `OrganizationFeatureRepositoryStore`，并由授权模块的
`OrganizationFeatureAccessFacade` 组合 License 得出服务端有效功能。企业期望配置与当前授权结果分开保存：
License 暂停时执行层关闭对应功能但不删除配置，授权恢复后自动恢复；License 判断异常一律 fail-closed。
短信挑战、密码策略与在线状态仍留待后续迁移。

第十二阶段将密码规则、scrypt 哈希与恒定时间比对迁入身份凭据内核，并将短信登录/注册挑战迁入
`SmsChallengeRepositoryStore`。挑战签发继续执行 60 秒冷却、每小时五次限制、五分钟有效期和五次错误锁定；
验证成功只能消费一次，账号禁用、挑战过期或状态异常一律 fail-closed。注册挑战继续绑定企业、邀请、部门和
岗位上下文，短信供应商发送失败时可撤销未消费挑战，不占用用户的冷却与小时额度。在线状态仍留待后续迁移。

第十三阶段建立 `collaboration` 的首个物理内核，将企业成员在线状态迁入 `AccountPresenceRepositoryStore`。
心跳写入必须验证 active 账号和企业归属，同账号多客户端按最近心跳聚合；服务端重启后从数据库恢复最后在线
时间，超过 60 秒窗口自动离线。非法未来时间不能制造永久在线，每个账号最多保留八个客户端并清理七天前的
陈旧记录，避免认证成员通过持续更换客户端 ID 膨胀数据库。私聊、附件、未读和 A2A 仍由后续 Issue 分批迁移。

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
