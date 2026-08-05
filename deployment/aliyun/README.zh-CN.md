# 阿里云零服务器部署契约（本地安全边界）

`otto-compute-nest-contract.json` 是 ROS/计算巢适配前的不可变契约层，覆盖 #281–#284、#289–#293 以及 #237 的部署注册边界。它描述套餐、私网资源、HTTPS、秘密引用、幂等和 Portal 状态机，但 `realDeploymentEnabled` 固定为 `false`。

这不是阿里云 staging 证据，也不会创建真实资源。没有账户余额、RAM、KMS、RDS/Tair/OSS 或计算巢权限时，任何上层适配器都必须拒绝执行，而不是退回明文凭据、默认密码、HTTP 或“模拟成功”。

本地校验：

```bash
node scripts/validate-aliyun-deployment-contract.mjs
npm run test:scripts -- --run scripts/tests/aliyun-deployment-contract.test.js
```

契约特别固定了：数据库、Tair、Otto Server 和秘密服务均为私网资源；公网只有 443，80 只作受控跳转/ACME；TLS 最低 1.2；SSH 默认关闭；ROS 参数和输出不得包含密码、License、AccessKey、私钥或连接串；重复订单必须由 `orderId + deploymentId + idempotencyKey + templateVersion` 去重；秘密依赖不可用时 fail-closed。

真实完成仍需要版本化的阿里云证据：三套餐 ROS lint/预检/创建/删除、失败回滚、RDS/Tair/OSS/KMS 实例与网络验证、HTTPS 续期、Portal 全流程以及升级回滚。这些在本地不能伪造。
