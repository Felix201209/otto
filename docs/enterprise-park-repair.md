# 园区报修服务器配置

多人抢单唯一锁定，以及“Otto + 飞书立即通知、5 分钟未读再发短信”的已确认后续工作，见 [园区服务上线待办](./park-services-production-todo.md)。

客户报修使用企业服务器的账号、SQLite 数据库和登录会话。管理员在“企业身份控制台”编辑成员，勾选“设为维修工作人员”；新工单会自动投递给同企业内所有已启用的维修工作人员。

## 通知通道

Otto 工单收件箱始终启用。短信与飞书需要在运行企业服务器的机器上配置环境变量；缺少配置或接收人资料时，工单仍会创建，但通知记录会明确标记为“未配置”或“发送失败”。

阿里云短信通知使用独立模板，模板变量为 `title` 和 `body`：

```text
ALIYUN_SMS_ACCESS_KEY_ID=...
ALIYUN_SMS_ACCESS_KEY_SECRET=...
ALIYUN_SMS_SIGN_NAME=...
ALIYUN_SMS_NOTIFICATION_TEMPLATE_ID=SMS_...
```

飞书通知使用企业自建应用，以机器人身份向维修人员的 `open_id` 发送私聊：

```text
OTTO_ENTERPRISE_FEISHU_APP_ID=cli_...
OTTO_ENTERPRISE_FEISHU_APP_SECRET=...
OTTO_ENTERPRISE_FEISHU_DOMAIN=feishu
```

国际版 Lark 将最后一项设为 `lark`。飞书应用需要开通机器人发消息权限（`im:message:send_as_bot`），并发布到企业。管理员还需在成员资料中填写对应的 `ou_...` open_id。

## 状态流程

```text
提交报修 → 自动投递维修工作人员 → 接单维修 → 提交维修完成 → 报修人确认验收 → 已完成
```

维修工作人员可以在任意阶段使用结构化“处理方式 + 说明”回复报修人，不提供自由聊天窗口。每次关键操作都会写入 Otto、短信、飞书通知记录，便于排查是否真实送达。
