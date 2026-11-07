# 普通账户真实邮件验收

此方案只验证发信配置与投递，不操作AWS、DNS、用户数据库或Owner绑定。注册仍默认关闭；发信配置齐全和API接受请求都不能等同实际收件。自动测试只使用合成数据和提供商夹具。

## 可以自动完成

- 对注册/找回流程做真实本地PostgreSQL、HTTP API、单次Token、密码哈希、会话撤销及权限测试。
- 检查变量是否齐全、发件地址格式及正式双域名/OAuth回调一致性，不显示密钥或地址。
- 经账户持有人单独授权后，用现有受控非生产执行器发送一封无激活/重置凭据的测试邮件。
- 输出脱敏状态和非秘密核对编号；超时或拒绝立即失败，不自动重试，不转储提供商正文。
- 只读生成与Muse分支的Git合并冲突报告；这不合并代码、不批准生产发布。

## 账户持有人必须配置的最少事项

1. 在自己的Resend账户核验已有发信域名。按提供商实际生成的SPF/DKIM等记录操作；DNS变更由域名管理者单独授权，Codex本轮不执行。不更改现有网站A记录、不创建API子域名、不覆盖已有收件MX。仅发事务邮件无需启用收件功能。已有发信地址可继续使用，不要求购买域名或服务器。[域名官方说明](https://resend.com/docs/add-a-domain)
2. 创建只允许发信并尽可能限制到所选域名的API Key，把MAIL_PROVIDER=resend、MAIL_API_KEY、MAIL_FROM注入受控秘密环境。不要发到聊天、Issue或PR；无需向Codex提供密钥值。[密钥权限官方说明](https://resend.com/docs/dashboard/api-keys/introduction)
3. 指定本人可实际读取的MAIL_ACCEPTANCE_TO，通过秘密环境注入；核对收件箱/垃圾箱、编号及邮件认证结果。账户持有人确认收到才可标记收件通过。

发件域名关闭激活/重置邮件的打开、点击分析；不要截图或上传含完整链接的邮件正文。生产配置保留原有Google、数据库及加密密钥。

## 只读配置检查

在持有人已有的受控非生产执行器中，注入以上变量及NODE_ENV=production、现有WEB_ORIGIN/ADMIN_ORIGIN/API_PUBLIC_URL/GOOGLE_REDIRECT_URI。production只表示检查正式URL配置，不意味着在生产服务器执行。工具不自动读取或覆盖.env.production，不调用AWS或数据库。

代码检出已审核的账户分支提交后执行：

```bash
pnpm exec tsx infra/scripts/member-mail-acceptance.ts --check
```

返回configuration=VALID仅表示本地配置形状符合要求，provider仍为NOT_TESTED。缺少变量或错误URL返回非零，不打印值。

## 单封提供商验收

仅当账户持有人明确同意向自己的邮箱发测试邮件时，在同一秘密执行环境设置MAIL_ACCEPTANCE_CONFIRM=send-to-owned-mailbox，然后执行：

```bash
pnpm exec tsx infra/scripts/member-mail-acceptance.ts --send
```

不能把密钥或收件地址放在命令参数、命令历史、工作流输入或日志。普通push/PR CI不调用--send，也不读取真实邮件秘密。本仓库本轮没有启用自动真实发信工作流；如之后接入GitHub Actions，应单独审查环境保护、固定SHA、发信目标与批准人，不复用生产AWS权限。

工具最多发一封不含登录权限的纯文本邮件，使用固定Resend HTTPS地址、标准TLS验证、8秒超时、禁止重定向及单次请求幂等键。[发送接口](https://resend.com/docs/api-reference/emails/send-email)与[幂等语义](https://resend.com/docs/dashboard/emails/idempotency-keys)。

| 工具状态      | 含义                         | 下一步                                               |
| ------------- | ---------------------------- | ---------------------------------------------------- |
| NOT_TESTED    | 尚未发起请求                 | 不能标记发信成功                                     |
| ACCEPTED      | 提供商接受请求               | 持有人核对相同reference的邮件，查看投递状态          |
| REJECTED      | 提供商拒绝，含脱敏HTTP状态码 | 持有人在提供商控制台核验权限、域名、额度；不重复盲试 |
| NETWORK_ERROR | 网络/超时                    | 检查受控执行器出网与提供商状态，不关闭TLS验证        |

报告只含状态、时间无关核对编号、是否需要人工收件以及productionChanged=false；不含地址、Key、提供商正文、Cookie或Token。即使ACCEPTED，inbox也保持REQUIRES_ACCOUNT_HOLDER，accountFlow始终NOT_TESTED。投递成功不保证进入主收件箱，仍以持有人实际收到为准。

## 发布后的账户全流程

本阶段必须等Muse稳定版本完成整合、整合SHA完整CI通过、人工审核及针对新SHA的正式生产批准。当前不执行。

由持有人使用专用普通测试邮箱完成：Owner开启注册并设上限 → 注册 → 实际收件 → 输入原注册密码激活 → 再次使用链接被拒绝 → 用户名/邮箱登录 → 查看并撤销本人其他会话 → 找回密码收件 → 重置并验证旧密码/旧会话失效 → 新密码登录 → 正式Google绑定 → 普通账户后台API403 → 现有Owner的原Google登录和权限仍有效。

不要重新初始化Owner或用Owner邮箱测试密码注册/找回。测试只操作专用普通账户，不删除已有数据；记录用例状态及脱敏错误码，不提交密码、链接、Cookie、Token或Google sub。真机Safari与真实Google/邮箱确认由账户持有人完成。

## 已知交付边界

邮件任务目前在API进程内存中，最多32项；并非持久化投递队列。进程退出或提供商故障可能需重新申请，失败令牌会作废并记录脱敏审计。页面202只表示符合条件时尝试发送，不能保证投递或自动开启注册。

本轮没有配置真实服务密钥、修改DNS、发送真实邮件或执行生产数据库迁移。真实收件和生产账户流程均保持未验收，直到取得上述真实证据。
