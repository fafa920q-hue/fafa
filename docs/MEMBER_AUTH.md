# 普通账户注册与账户安全（独立集成）

本分支从7ee1c7b97d6abfd95bf261b99b8242c5aeae203c开始，只开发普通账户认证。未改写 Muse 的 core.tsx、style.css、admin-nodes.spec.ts、原 CI 或部署工作流；不触发 AWS 发布，不操作线上数据库。既有 Google Owner 必须保留，不重复初始化。

## PR #8 当前整合与生产配置

本次整合保留Muse的Google来源跳转、Member安全绑定及现有登录卡片的普通账户入口。
生产Compose现只向API显式传递MAIL_PROVIDER、MAIL_API_KEY、MAIL_FROM，并完整继承既有运行时环境；
Worker不接收邮件密钥。不需要在受保护部署脚本外裸启动覆盖Compose。
现有.env.production和全部Google、数据库、加密密钥保持原值；持有人仅在受信秘密渠道补充邮件变量。
005迁移和fafa_app最小表权限、默认关闭注册、API可读取邮件配置均由隔离Production Startup验证；
真实投递和邮箱激活仍需持有人验收。下文“未改共享文件/等待整合”等为早期独立开发记录。

## 使用入口

- 前台 /member/register、/member/login、/member/verify、/member/resend、/member/forgot、/member/reset。
- /member/account：查看/撤销本人会话、安全退出、密码加正式 OIDC 绑定 Google。
- 管理后台 /member-registration：Owner 控制允许自由注册及所有用户共用的席位上限；Admin只读。用户启停及撤销仍使用现有用户管理。
- 原有 Google 登录入口保留。原登录卡片中的普通账户快捷链接属于共享 core.tsx 的后续集成项，本分支不改该文件。现可通过独立地址使用普通账户页面。

新注册默认关闭。普通账户验证邮箱后才建立 users 和 member_credentials，默认 Member；输入角色字段会失败。未激活申请不产生可登录身份。验证必须主动 POST 并再次输入注册密码，邮件客户端预取链接不会激活，避免他人预先冒用邮箱设置密码。

密码使用 Node24.7+ 内置异步 Argon2id：m=65536KiB、t=3、p=1、随机16字节盐、32字节输出，15至128字符，不静默截断。最多四个并行派生，超限失败而非无限排队。密码验证含不存在用户的等价派生；IP路由限流与数据库哈希标识符预算共同生效，不因多API进程而清零标识符限制。API仍保留现有可信代理/IP边界，本分支不信任任意 X-Forwarded-For。

邮箱及用户名冲突统一返回202条件式文案，不返回是否注册；邮件发送不阻塞响应，避免由提供商耗时暴露账户存在性。不存在的重置请求同样202。前端绝不宣称“邮件已发送”。邮件未配置时统一503，Owner也无法开启自由注册。

## 真实邮件依赖

当前实现 Resend HTTPS适配器，需管理员在秘密管理渠道配置以下服务端环境变量：

- MAIL_PROVIDER=resend
- MAIL_API_KEY：受限发信密钥，不放入客户端、聊天或仓库。
- MAIL_FROM：提供商已核验域名上的发件邮箱，不带显示名。

参考 [Resend发送接口](https://resend.com/docs/api-reference/emails/send-email)。发信域名验证属于未来独立授权操作，本分支不改DNS。不要启用会记录完整激活/重置链接的点击分析或邮件正文日志。

API使用固定HTTPS目的地址、禁止重定向、8秒超时，只检查状态，不记录提供商正文、收件人、密码、Cookie或Token。数据库只保存激活/重置Token的SHA256哈希，原始Token仅在内存和受信HTTPS邮件请求中短暂出现。链接使用fragment，页面读取后立即从地址栏移除；不进入访问日志和Referer。

投递队列位于API进程内存中，最多32项，不持久化原始Token。进程退出或提供商故障可能使邮件未投递，用户可重发/重新发起；这不是持久化邮件队列。失败使对应Token作废并写入脱敏审计，后台显示最近一小时失败数。真正的邮箱收件验收仍需要已配置提供商和真实收件人，CI提供商夹具不能替代。

激活Token30分钟、密码重置15分钟，重发使旧Token失效；成功消费在数据库事务中一次完成。密码重置撤销全部旧会话和未完成Google绑定，不自动登录。新密码之外不改变用户权限。既有Google-only账户和Owner不能通过注册/找回添加密码。

## Google 绑定

密码账户不能仅凭与Google相同的邮箱自动合并。Member先在原会话提交当前密码和CSRF，再完成正式Google授权。保留现有state、nonce、PKCE、签名、iss、aud、exp验证；5分钟绑定记录限定原会话和同一已验证邮箱，Google sub不得属于其他用户。成功后记录单次消费并轮换会话；既有唯一Owner与绑定数据库触发器保持不变。Google登录在自由注册开启时只创建Member；已有邀请角色流程仍按原权限处理。

## 数据库与未来集成

005_member_auth.sql只新增五张表及默认关闭的设置，不更新已有用户、密码、Google身份或Owner记录。迁移清单追加005，运行时角色脚本仅为新表增加业务所需权限；不重新生成现有运行时凭据。

先等待Muse版本稳定，由集成人员合并、处理迁移编号冲突并做全量回归，再走新的人工发布审批。附带compose.member-auth.yaml只提供未来邮件环境变量覆盖；未修改现有生产Compose和发布入口。集成人员须将这些环境变量显式纳入经过审批的API服务配置，不能在现有部署入口外直接启动生产服务。

已授权发布时继续原加密备份、锁、增量迁移和最小数据库角色机制；不能覆盖.env.production或删除卷。这里没有任何AWS执行结果。

## 验证

独立工作流Member authentication checks只读仓库权限，无AWS/OIDC/production Environment权限。它检验禁止触碰的文件、差异格式、Lint、类型、构建、独立随机_test数据库中的账户安全、现有Google/Owner/API回归，以及Chrome/WebKit/iPhone模拟的普通账户交互。所有密码、邮件和Google身份均为合成夹具。

pnpm test:member只允许本机_test连接，创建并最终删除它自己的随机测试库；拒绝远端或生产目标。浏览器夹具仅连接本机开发库，创建并软删除自己的随机Member，不修改seed Owner。请查本分支完整SHA的实际CI结论，不引用PR#2的成功结果。

真实邮件收件、生产Google新绑定、真机Safari以及生产数据库迁移尚未执行。本地Shell在启动前受bwrap权限限制，因此本会话的实际执行证据仅来自GitHub Actions。

真实邮件的最少持有人配置、只读检查及单封测试见 [MEMBER_MAIL_ACCEPTANCE.md](MEMBER_MAIL_ACCEPTANCE.md)。与Muse的只读冲突预览及整合规则见 [MEMBER_INTEGRATION_REVIEW.md](MEMBER_INTEGRATION_REVIEW.md)。
