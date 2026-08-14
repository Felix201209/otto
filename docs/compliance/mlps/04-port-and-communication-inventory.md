# 04 端口与通信清单

文档状态：`DRAFT BASELINE`  
适用部署：待填写  
复核日期：待填写

## 1. 默认通信基线

| 来源区 | 目标 | 协议/端口 | 方向 | 用途 | 身份与加密 | 公网开放 | 默认结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 用户终端 | Caddy/LB/WAF | HTTPS `443/TCP` | 入站 | 登录、业务 API、附件 | TLS 1.2/1.3 + 会话令牌 | 是 | 必需 |
| 公网 | Caddy | HTTP `80/TCP` | 入站 | ACME/跳转 HTTPS | 仅跳转或证书验证 | 可选 | 最小开放 |
| 运维网/堡垒机 | 服务器 | SSH `22/TCP` | 入站 | 受控运维 | SSH Key、MFA、来源限制 | 否或严格白名单 | 按需 |
| Caddy/LB | Otto Server | HTTP `7778/TCP` 或编排内服务端口 | 私网/本机 | 反向代理回源 | 仅 `127.0.0.1` 或受控私网 | 否 | 禁止公网暴露 |
| Otto Server | PostgreSQL | PostgreSQL `5432/TCP` | 出站 | 权威业务数据 | TLS 校验 + 专用数据库角色 | 否 | 必需 |
| Otto Server | Redis/Tair | Redis TLS `6379/TCP` 或供应商端口 | 出站 | 会话、限流、在线状态、租约 | TLS + 专用凭据 | 否 | 集群必需 |
| Otto Server | S3/OSS/MinIO | HTTPS `443/TCP` | 出站 | 附件密文、备份 | TLS + IAM 最小权限 | 否 | 集群必需 |
| Otto Server | Otto Control | HTTPS `443/TCP` | 出站 | License、模块、健康、用量收据 | 签名、Token、防重放 | 是 | 按商业模式 |
| Otto Server/Desktop | Federation | HTTPS `443/TCP` | 出站 | 跨部署 E2EE 密文 | 部署签名 + E2EE | 是 | 启用时 |
| Otto Server/Desktop | 模型供应商 | HTTPS `443/TCP` | 出站 | 模型推理 | TLS + 客户 API 凭据 | 是 | 启用时 |
| Otto Server | 飞书 | HTTPS/WSS `443/TCP` | 出站 | 消息与开放平台 | 平台凭据 + TLS | 是 | 启用时 |
| Otto Server | 短信供应商 | HTTPS `443/TCP` | 出站 | 验证码、通知 | API 签名 + TLS | 是 | 启用时 |
| 监控采集器 | Metrics | 待填写，默认仅私网 | 入站 | Prometheus 指标 | 指标 Token/mTLS/网络隔离 | 否 | 不得公网裸露 |

## 2. 实际安全组/防火墙记录

| 规则编号 | 来源 CIDR/安全组 | 目标资产 | 端口 | 动作 | 业务依据 | 申请单 | 到期日 | 复核结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待填写 | 待填写 | 待填写 | 待填写 | 允许/拒绝 | 待填写 | 待填写 | 待填写 | 待填写 |

## 3. 核验要求

- 从公网扫描只应看到批准的 `80/443` 及严格受限的运维入口。
- PostgreSQL、Redis、MinIO 管理端、Otto Server 回源端、Prometheus 和调试端口不得直接暴露公网。
- 所有规则必须关联资产编号、变更工单、责任人和复核日期。
- 临时开放应设置到期时间；过期规则自动或人工关闭并留存证据。
- 云安全组、主机防火墙、容器端口映射和应用监听地址必须交叉核验。
