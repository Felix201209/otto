# Otto 网络安全等级保护材料包

本目录保存 Otto 网络安全等级保护工作的**脱敏模板、技术底稿和证据索引**。它用于帮助运营主体、客户安全负责人和测评机构理解系统，不代表 Otto 已经完成定级、备案或测评。

## 使用边界

- 仓库只保存不含真实客户数据、生产地址、口令、Token、私钥和漏洞利用细节的模板。
- 真实资产、IP、账号、测评报告、漏洞详情和运维证据应进入公司受控文档库，并按最小权限管理。
- 标记为 `模板` 的文件必须由实际系统运营主体填写、审批并签发。
- 定级结论、备案结果和测评结论以主管部门及具备资质的测评机构意见为准。
- 本材料包是工程和管理底稿，不替代法律意见或测评机构正式文书。

## 材料目录

| 编号 | 材料 | 文件 | 当前属性 |
| --- | --- | --- | --- |
| 01 | 系统边界与拓扑图 | [01-system-boundary-and-topology.md](./01-system-boundary-and-topology.md) | 技术底稿，部署时实例化 |
| 02 | 数据流图与数据目录 | [02-data-flow-and-data-catalog.md](./02-data-flow-and-data-catalog.md) | 技术底稿，供应商待确认 |
| 03 | 资产清单 | [03-asset-inventory.md](./03-asset-inventory.md) | 模板 |
| 04 | 端口与通信清单 | [04-port-and-communication-inventory.md](./04-port-and-communication-inventory.md) | 默认基线，部署时核验 |
| 05 | 权限矩阵 | [05-access-control-matrix.md](./05-access-control-matrix.md) | 产品基线，客户角色待确认 |
| 06 | 定级报告 | [06-classification-report-template.md](./06-classification-report-template.md) | 模板，必须评审与备案 |
| 07 | 安全管理制度 | [07-security-management-policy.md](./07-security-management-policy.md) | 制度模板，必须签发 |
| 08 | 审计管理制度 | [08-audit-management-policy.md](./08-audit-management-policy.md) | 制度模板，必须签发 |
| 09 | 备份与恢复方案 | [09-backup-and-recovery-plan.md](./09-backup-and-recovery-plan.md) | 产品基线，参数和演练待填 |
| 10 | 网络安全事件应急预案 | [10-incident-response-plan.md](./10-incident-response-plan.md) | 预案模板，联系人待填 |
| 11 | 漏洞整改报告 | [11-vulnerability-remediation-report.md](./11-vulnerability-remediation-report.md) | 报告模板，禁止虚构结果 |
| 12 | 供应商清单 | [12-supplier-register.md](./12-supplier-register.md) | 模板，合同与地域待核验 |
| 13 | 运维记录 | [13-operations-records.md](./13-operations-records.md) | 记录模板，运行中产生 |

## 文档状态

每份正式副本都应在受控文档库记录以下状态：

1. `DRAFT`：工程或制度草案。
2. `REVIEWED`：系统负责人、安全负责人、数据保护负责人完成复核。
3. `APPROVED`：运营主体正式批准并签发。
4. `EVIDENCED`：已经关联真实配置、截图、日志、工单或演练报告。
5. `SUBMITTED`：已提交专家评审、公安备案或测评机构。

## 证据来源

本材料引用的主要工程底稿包括：

- [Otto 架构概览](../../architecture.md)
- [企业存储拓扑](../../enterprise-storage-topology.md)
- [数据治理与合规实施基线](../data-governance.zh-CN.md)
- [企业渗透测试基线](../../security/enterprise-penetration-baseline.md)
- [密钥管理与轮换](../../security/key-management.md)
- [附件对象存储](../../security/attachment-object-storage.md)
- [私有化部署与备份恢复](../../../deployment/enterprise-oneclick/README.zh-CN.md)

Control、License、计费、联邦网关和 KMS 的证据位于 `krx521920/otto-control`。正式材料必须记录对应仓库、提交 ID、构建版本和部署版本，不能仅填写“最新版”。

## 版本控制

正式副本至少包含：文档编号、版本、适用系统版本、编制人、复核人、批准人、生效日期、下次复审日期和变更摘要。发生系统边界、云供应商、模型供应商、数据地域、认证方式、数据库或重大模块变化时，应重新评审整套材料。
