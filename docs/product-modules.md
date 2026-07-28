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

第十四阶段将企业私聊、附件、未读通知与 A2A 请求状态迁入 `DirectMessageRepositoryStore`，旧的
`enterprise/directMessageRepository.ts` 不再保留实现。消息发送在持久化层重新验证发送方和接收方均为同一
企业的 active 账号；附件只允许会话双方读取，后台未读轮询保持只读，打开会话时只标记指定对端发给本人的
消息。A2A 回复继续按企业、双方方向、请求主键和协议正文精确匹配。`enterprise/db.ts` 只负责注入 SQLite、
账号状态和 ID 生成能力，现有 HTTP 路径与响应结构保持兼容。

第十五阶段建立 `enterprise_knowledge` 的物理内核，将企业知识写入、列表、搜索和成员作用域读取迁入
`EnterpriseKnowledgeRepositoryStore`。所有操作先验证企业存在并绑定 organization ID；普通成员只能读取企业
全局知识和本人部门知识，无部门成员只能读取全局知识。同一 source ID 只在同一企业内去重，不影响其他企业；
搜索输入中的 `%`、`_` 和反斜杠按普通字符匹配，不能借 SQL LIKE 通配符扩大结果范围。字段长度、置信度和空值
规则统一在 Repository 执行，`enterprise/db.ts` 只注入 SQLite、默认企业和企业存在性能力。

第十六阶段建立 `park_services` 的首个物理内核，将产业园邀请码、整企入驻和租户地址/门牌资料迁入
`ParkMembershipRepositoryStore`。邀请码只能由产业园管理企业的 active 管理员签发，企业只能由本企业 active 管理员
整企加入且不能重复或跨园入驻；过期、撤销、次数耗尽和并发核销均 fail-closed。邀请码次数核销、企业园区归属和
租户资料在同一即时事务中写入，任一步失败全部回滚。ID 与 nonce 由组合根注入，现有 HTTP 契约保持兼容。
园区创建、服务配置、公告、工单、会议室、统计和专员分派仍由后续 Issue 分批迁移。

第十七阶段将园区查询、平台认证创建、普通创建兼容入口和平台名称/服务品牌更新迁入
`ParkLifecycleRepositoryStore`。园区记录、管理企业 `park_id` 和九项默认服务在同一即时事务中创建；事务内锁定并
确认管理企业尚未加入任何园区，重复或并发认证不会留下半成品。普通创建重新验证企业 active 管理员，平台认证则
要求企业存在且至少有一名 active 管理员。平台更新只能修改 active 园区的名称与服务品牌，稳定 slug、邀请密钥和
管理企业归属不可变。园区 ID、默认 slug、邀请密钥和默认服务清单由组合根注入，现有 HTTP 契约保持兼容。

第十八阶段将九项服务的名称、开关、配置和多人专员分派迁入 `ParkServiceConfigurationRepositoryStore`。
所有写操作在 Repository 执行层重新确认园区仍为 active、操作者仍是园区管理企业的 active 管理员；专员只能从
管理企业的 active 账号中选择，跨企业账号、停用账号、停用园区和停用服务均 fail-closed。同一服务通过复合主键
支持多个专员，重复分派和重复移除保持幂等。读取专员列表时同时核验园区状态和账号企业归属，历史异常分派不会被
继续当作有效专员。`enterprise/db.ts` 只保留兼容入口与依赖注入，现有 HTTP 路径和响应结构不变。

第十九至二十二阶段继续完成 `park_services` 的物理内核：公告与问卷、会议室与时段资源、园区数据填报与
服务用量汇总、园区/企业 IT 工单依次迁入各自的 Types、Repository 和 Facade。工单表单规则单独维护，创建、
初始事件、收件人投递和审计共享同一事务；读取和处理在执行层重新校验账号、企业、园区、模块开关与当前分派，
跨园区账号、停用主体、已转交处理人和终态重复操作均 fail-closed。`enterprise/db.ts` 仅注入账号目录、园区配置、
审计、ID 与数据库能力，不再与工单 Repository 循环引用，现有 HTTP 路径和响应结构保持兼容。

第二十三阶段建立 `model_gateway` 的首个服务端物理内核，将客户端上报的标准 Token 用量迁入
`ModelUsageRepositoryStore`。账号和企业必须同时处于 active 状态；会话、消息、模型名和 Token 数值在持久化边界
统一校验，账号与消息幂等键、每日记录配额和写入在同一即时事务中完成。企业汇总只组合身份模块提供的同租户
账号目录，不直接读取身份模块拥有的账号表；停用账号不能产生新用量，但既有历史账继续保留，跨租户记录绝不混入。
`enterprise/db.ts` 只注入 SQLite、账号、企业和 ID 生成能力；`model_gateway` 对持久化的依赖通过 `data_platform`
公共契约显式声明，既有 HTTP 路径与响应结构保持兼容。

第二十四阶段建立 `personal_intelligence` 的首个服务端物理内核，将企业工作日志、可披露估算口径和人效报表迁入
独立的 Types、Estimates、Analytics、Repository 与 Facade。非默认企业写入必须携带企业上下文，企业和员工均须
处于 active 状态；日志与审计在同一即时事务提交，失败不留孤儿记录。历史和报表按企业隔离，通过身份模块注入的
员工目录完成部门过滤，不直接读取其数据表；员工离职后不能新增日志，但既有工作历史继续保留。周期、条数、文本、
耗时、Token 和成本都在持久化边界归一或拒绝，SQLite 日期窗口使用真实 datetime 比较，原 HTTP 契约保持兼容。

第二十五阶段将账号跨电脑恢复快照迁入 `personal_intelligence` 的 Types、Validation、Crypto、Repository 与 Facade。
个人记忆、工作日志和自动 Skill 继续使用原有 AES-256-GCM、gzip、密钥文件与 AAD 格式，已有密文无需迁移；路径、
文件数量、大小、时间戳和 SHA-256 在持久化边界统一校验。快照读写通过身份模块注入 active 账号与 active 企业，
账号换企业后不能读取或覆盖旧租户快照；密文、认证标签或摘要损坏统一 fail-closed，乐观版本冲突继续原子返回当前
版本。固定密钥路径由组合根交给 `data_platform` 管理密钥生命周期；`enterprise/db.ts` 只保留表结构、身份能力注入和
兼容导出，原 HTTP 与桌面恢复协议保持不变。

第二十六阶段将租户审计日志迁入 `commercial_control` 的 Types、Repository 与 Facade。身份、License、模块更新、
园区及数据导出继续通过同一组合入口写入审计，但模块不再反向导入 `enterprise/db.ts`。查询始终按企业隔离，负数
条数不再触发 SQLite 的不限量语义，单次读取硬限制为 500 条；审计写入复用调用方现有事务，因此审计失败仍会使
对应业务一起回滚。旧 `enterprise/auditRepository.ts` 仅保留兼容导出，现有后台字段和 HTTP 响应结构保持不变。

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
