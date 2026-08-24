# 阿里云零服务器部署契约（本地安全边界）

`otto-compute-nest-contract.json` 是 ROS/计算巢适配前的不可变契约层，覆盖 #281–#284、#289–#293 以及 #237 的部署注册边界。`plan-definitions.json` 定义试用、标准和高可用套餐，`templates/ros/*.json` 是从套餐定义生成的第一批 ROS 基础设施模板。它们描述私网资源、加密、秘密引用、幂等和 Portal 状态机，但 `realDeploymentEnabled` 固定为 `false`。

这不是阿里云 staging 证据，也不会创建真实资源。没有账户余额、RAM、KMS、RDS/Tair/OSS 或计算巢权限时，任何上层适配器都必须拒绝执行，而不是退回明文凭据、默认密码、HTTP 或“模拟成功”。

本地校验：

```bash
node scripts/validate-aliyun-deployment-contract.mjs
node scripts/scan-aliyun-deployment-secrets.mjs
npm run test:scripts -- --run scripts/tests/aliyun-deployment-contract.test.js
```

修改套餐后运行 `npm run deployment:aliyun:generate` 重新生成模板；CI 使用 `--check` 模式验证提交的模板没有漂移。

契约特别固定了：数据库、Tair、Otto Server 和秘密服务均为私网资源；公网只有 443，80 只作受控跳转/ACME；TLS 最低 1.2；SSH 默认关闭；ROS 参数和输出不得包含密码、License、AccessKey、私钥或连接串；重复订单必须由 `orderId + deploymentId + idempotencyKey + templateVersion` 去重；秘密依赖不可用时 fail-closed。

当前模板先建立 VPC、vSwitch、安全组、无公网 IP 的 ECS、私网 RDS、私网 Tair、私有 KMS 加密 OSS、AES-256 KMS 密钥和最小权限实例角色。ECS 镜像以及数据库、Tair 凭据只接受计算巢隐藏参数或 OOS 加密参数引用，不包含默认密码、AccessKey 或 License。

这里的 `trial` 是 Otto 的低配按量套餐，不等同于计算巢平台的“免费试用服务”。如果后续发布计算巢免费试用入口，须按平台规则另建“选择客户现有 VPC/vSwitch”的模板，不能复用当前会创建 VPC 的模板。

公网 HTTPS/ALB、签名服务器镜像安装、Control 自动注册和数据库初始化必须分别由 CLOUD-02、CLOUD-03、CLOUD-04 接上后，才允许把真实部署开关改为 `true`。真实完成仍需要版本化的阿里云证据：三套餐 ROS lint/预检/创建/删除、失败回滚、RDS/Tair/OSS/KMS 实例与网络验证、HTTPS 续期、Portal 全流程以及升级回滚。这些在本地不能伪造。
