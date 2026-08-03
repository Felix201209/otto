# Otto 私有服务器联邦网关接入

Otto Server 的 `federation_gateway` 模块负责把两个独立私有部署连接到 Otto Control
联邦网关。Control 只保存 E2EE 密文、部署 ID、消息类型、时间、大小和投递状态，不能解密
聊天、附件或 A2A 内容。部署签名私钥始终保留在客户服务器。

## 安全边界

- Control 管理员负责注册部署和登记公钥；客户服务器不持有 Control 管理员 Token。
- Otto Server 只接受 HTTPS 网关地址，测试环境的 loopback HTTP 必须显式开启。
- 每次投递、领取、回执和 A2A 授权都使用 Ed25519 签名，并带有效期和随机 nonce。
- 收到的消息必须先持久化，再向网关回执。服务重启或临时断网不会重复交付给业务层。
- A2A 授权在 Control 原子消费一次，收件服务器还会按部署、账号、scope 和消息 ID 二次校验。
- 本地屏蔽会丢弃并确认后续密文，Control 侧屏蔽或吊销仍是立即停止跨部署路由的权威控制。

## 服务器配置

```dotenv
OTTO_FEDERATION_ENABLED=true
OTTO_FEDERATION_GATEWAY_URL=https://federation.example.com
OTTO_FEDERATION_DISPLAY_NAME=示例企业私有部署
OTTO_FEDERATION_POLL_INTERVAL_MS=10000
```

默认签名私钥生成在 `${OTTO_ENTERPRISE_DIR}/federation-signing-key.pem`，文件权限为
`0600`。也可以通过 `OTTO_FEDERATION_SIGNING_KEY_FILE` 指向预置的 Ed25519 PKCS#8
PEM 私钥；该路径必须位于备份策略覆盖之外，并由客户的 KMS/HSM 或密钥托管流程保护。

## 首次注册

1. 启动启用了联邦模块的 Otto Server。
2. 使用企业管理员会话读取 `GET /enterprise/federation/admin/provisioning`。
3. 把返回的 `deployment` 交给 Control 管理员调用
   `POST /v1/admin/federation/deployments`。
4. 把返回的 `signingKey` 交给 Control 管理员调用
   `POST /v1/admin/federation/deployments/{deploymentId}/keys`。
5. 调用 `GET /enterprise/federation/admin/status`，确认 `configured=true`，再执行一次
   `POST /enterprise/federation/admin/run` 验证目录、发件箱和收件箱链路。

部署注册不能由客户服务器自动完成，因为那会迫使客户服务器保存 Control 管理员 Token，
破坏权限隔离。后续可以由 Control 的审批式 onboarding 流程替代上述人工登记，但不能把管理员
凭据下发到私有服务器。

## 签名密钥轮换

1. 在客户侧 KMS/HSM 或离线密钥机生成新的 Ed25519 PKCS#8 私钥，不覆盖旧密钥备份。
2. 先把新公钥和未来的 `notBefore` 登记到 Control，保留旧公钥为 active。
3. 把新私钥放到客户服务器的 root/otto 专用只读路径，权限限制为 `0600`，并更新
   `OTTO_FEDERATION_SIGNING_KEY_FILE` 后重启 Otto Server。
4. 从 `GET /enterprise/federation/admin/provisioning` 核对新的 `keyId`，运行一次
   `POST /enterprise/federation/admin/run`，确认新消息已使用新密钥且旧发件箱仍能投递。
5. 等旧密钥签名的待发送消息清空，并超过最长消息有效期后，再在 Control 吊销旧公钥。

不要直接删除仍有待发送消息依赖的旧公钥。紧急泄露时应先在 Control 吊销旧公钥和受影响部署，
完成调查后用新的部署签名密钥重新启用；被吊销后的永久拒绝会留在本地失败队列供管理员审计。

## 运行接口

- `GET /enterprise/federation/directory/{deploymentId}`：成员查询远端部署。
- `POST /enterprise/federation/messages`：提交已经由桌面端加密的消息或附件载荷。
- `GET /enterprise/federation/messages?after={cursor}`：按持久游标领取本账号密文。
- `POST /enterprise/federation/messages/{messageId}/consume`：标记本地业务消费完成。
- `POST /enterprise/federation/a2a/grants`：创建短时、单次、范围受限的 A2A 授权。
- `POST /enterprise/federation/a2a/grants/{grantId}/revoke`：撤销未消费授权。

这些接口不会把本地普通私聊明文自动转换为 E2EE。正式启用前，桌面端必须完成 E2EE
消息封装、设备信任和密钥恢复验收；否则联邦模块应保持关闭。

## 上线验收

正式启用前至少使用两个独立测试部署验证：密文消息与加密附件、断网恢复、重复领取、回执重试、
部署吊销、本地屏蔽、密钥轮换，以及 A2A 授权越权和重复消费。验收记录应包含部署 ID、构建提交、
测试时间和脱敏后的 Control 审计事件，不能包含聊天明文、附件原文、私钥或 claim token。
