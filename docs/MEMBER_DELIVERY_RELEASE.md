# 注册、Resend 与限时授权整合交付

本分支从PR #8的b623dac1420f07f0b54077ec0d87c059fe1dd13f建立，不写PR #2/#4/#5/#8，不访问生产数据库。代码与测试通过GitHub连接器及Actions执行；本地shell此前在启动前受bwrap限制，本轮没有重试或绕过。

## 架构与兼容

- apps/api/src/server.ts保留现有Google OIDC、Owner、CORS/CSRF及会话。普通认证路由在member-auth.ts；注册、旧链接和账户逻辑分别位于member-codes.ts、member.ts。
- 邮件统一使用member-mail.ts的Resend固定HTTPS地址、8秒超时、拒绝重定向。MAIL_FROM保持纯地址accounts@fafa888.uk，请求显示名称为FAFA ONE。
- 用户名统一小写；邮箱先去首尾空白及小写，再校验。密码使用现有Argon2id参数，不按邮箱自动合并Google身份。
- 新注册页面含确认密码与6位验证码，验证后建立正式Member和会话、进入个人中心。旧30分钟激活链接及15分钟重置链接保留，已有用户不重建。
- 验证码10分钟有效，随机生成，只保存绑定挑战的HMAC-SHA256；5次失败锁定，重发有额度且旧码失效。无原密码不能恢复未完成注册；刷新后可由本人邮箱及原密码恢复。
- 公开用户名冲突明确提示；邮箱是否已注册只在验证码和原注册密码证明后披露。找回等公开入口继续统一反馈以防枚举，不把202当送达。
- 邮件状态只含PENDING、ACCEPTED、FAILED，ACCEPTED是提供商接受而非实际收件。PENDING在进程中断后可能未知，不虚标成功。出站发送并发上限32；通知使用内存任务，非持久投递队列，失败记录供管理员处理。
- 验证成功、重置成功和改密安全通知不含旧/新密码或重置权限。管理API不返回验证码、完整链接、邮件正文或API Key。

## 自动授权

复用PR #5的006迁移和策略键/接口，授权实现共享给Google新建及邮箱激活。活动窗口最多72小时；窗口外新用户默认关闭节点、自有服务器连接和Codex任务，管理员逐个开放。窗口内的试用最长3天，自注册成功时间起计算；重复补处理不延长到期。

资源权限继续由原node_group_grants/server_access_grants及本人资源控制。服务器能力不授予任何他人服务器，不提供共享SSH凭据。第三方节点需真实再分发授权；未配置节点源显示待分配，不虚报在线。

新增能力截止时间由API、旧订阅下载、SSH消息/看门狗、任务开始与运行时复查。到期时即使boolean仍为true也拒绝。管理员手动开通清除此项试用截止时间，独立影响节点/服务器/Codex，并记录ADMIN来源、开始/结束时间及操作者。开放功能开关仍须满足资源分配和对象权限。

默认注册和自动授权不开启。Owner须选择已授权节点源、时间窗口和人数限制后启用；不自动把整个系统的私人节点分配给新用户。

## 增量迁移

005保持原字节不变；顺序为005→原PR #5的006→007_member_delivery。007新增验证码列、能力截止时间及邮件状态表；不清库、不重置现有Owner、Google sub、会话或加密数据。既有用户能力保留，新建用户默认关闭。应用运行角色仅增加新表SELECT/INSERT/UPDATE，无DELETE/TRUNCATE；部署前须确认真实权限差异。

升级测试在隔离数据库保留既有Owner/Google/会话/不透明密文并重复运行全部增量入口。生产Startup测试覆盖七项迁移、新表最小权限、备份及恢复。

## 测试边界

API/数据库测试使用localhost *_test隔离库；Chrome、iPhone WebKit和Android浏览器使用真实应用和隔离PostgreSQL，仅出站邮件由CI专用传输夹具捕获合成example.invalid收件信息。夹具要求Github Actions/开发/演示环境和固定假Key，且tests目录被生产Docker构建排除。

真实Resend收件、真实Google/Owner会话、真机Safari、Shadowrocket/WLOC与生产数据检查必须另验。不得把CI夹具说成真实邮件、移动WebKit模拟说成真机或CI绿说成已经上线。

## 生产发布与恢复

沿用PRODUCTION_RUNBOOK.md原受保护入口、部署锁、Git archive构建、配置校验、迁移前加密备份与失败恢复。只发布本分支最终通过完整CI且审批通过的固定SHA，不能继续用b623dac的批准代替新SHA。

先从获授权AWS通道核实实际HEAD、.deployed-sha、镜像、干净工作区与备份；不能把GitHub分支值当实际生产SHA，不能覆盖较新或分叉版本。保留.env.production/.env.runtime及所有卷、密钥、Owner。仅补充MAIL_PROVIDER=resend、MAIL_FROM=accounts@fafa888.uk和安全注入的MAIL_API_KEY；Secrets Manager保存不会自动注入此应用。

上线后真实测试注册、重发/过期/错误码、激活、用户名/邮箱登录、改密/找回、通知、撤销会话、普通用户后台拒绝、Google/Owner、节点/SSH/Codex试用到期与管理员单独开放。真实凭据不进入CI、报告或截图。

回滚保留007及新用户，不还原旧dump覆盖新写入。只有支持007能力/到期检查的镜像才可作为应用回退目标；旧b623dac及更早代码不执行新能力检查，不能盲目回退后宣称保留了撤权保证。无兼容镜像时沿用原失败恢复停止API/Worker，保留DB/备份/镜像，修复后按固定SHA发布；数据库灾难恢复仅恢复到新空库并另行审批切换。

当前生产执行权限与秘密配置未从AWS读取，缺少真实执行通道时不部署、不声称发送真实邮件。必须由有权限代理提供前后SHA、备份和线上证据后才能签收。
