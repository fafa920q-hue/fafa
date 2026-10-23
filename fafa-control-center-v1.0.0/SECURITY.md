# 安全模型与验收边界

## 认证与权限

- 密码使用 Argon2id（64MiB，3 次，2 并行度），允许验证旧 PBKDF2 格式并在成功登录时升级。统一 12 小时可撤销会话，服务器仅持有随机 token 的 SHA256 digest。
- Cookie：HttpOnly、SameSite=Lax、Secure（生产强制）、Path=/。开发只能在显式 APP_ENV=development 下关闭 Secure。过短 APP_SECRET 或生产 HTTP/不安全 Cookie 将拒绝启动。
- 公开注册只读取 email/password/display_name，忽略 role/is_admin/permissions 等额外字段；role='user'、grants={}，新用户无默认模块权限。管理员只能通过本地首次初始化或已有超级管理员分配。
- 所有管理员 API 均在后端校验角色；模块权限不能授予管理员能力。前端同时隐藏入口并拒绝直接管理员 URL。普通用户直接调用管理员 API 返回 403；未登录返回 401。
- 最后一个有效超级管理员不能禁用或降级。没有公开删除用户接口。锁内计数避免并发同时降级所有管理员。恢复用户不会恢复已撤销会话。
- 修改角色、授权、预算、状态均撤销目标全部会话。每次请求重新读取账户 active 与权限，禁用立即生效。任务开始前后的权限变更不自动终止已授权执行中的外部任务，应由管理员取消。
- 角色/用户授权的模块取并集；资源账户/模型/节点授权还需显式 ID 白名单。超级管理员最高权限。Codex 普通用户仅能访问自己的项目/任务。

## Web 防护

所有 POST/PUT/PATCH/DELETE，包括注册、登录、退出、邮件动作，要求 `/api/v1/auth/csrf` 返回的 token 通过 X-CSRF-Token 提交，且匹配 HttpOnly 签名 Cookie；Origin 存在时必须精确匹配 PUBLIC_ORIGIN。不允许跨域 CORS；生产同源访问。CSRF cookie SameSite=Strict。无 Origin 的 API 客户端仍必须持有双份签名 token。

限流计数存数据库，不受 API 重启/多进程绕过：登录每 15 分钟 10 次、注册 5 次、邮件 5 次、OAuth 10 次，AI 每用户每分钟 30 次。地址依据直连 socket，**不信任客户端 X-Forwarded-For**；默认代理部署会共享保守的认证速率桶。大规模部署应由经过审查的边缘代理实施真实客户端 IP 限流，再审查调整服务端阈值。边缘 HTTP body 限制 1MB；密码/提示词/任务/字段有长度限制。

Nginx 添加 CSP、禁止 iframe、nosniff、Referrer-Policy；API 所有响应 no-store；Caddy 模板只追加一个站点块，不修改已有站点。安全 Cookie 要求真实 HTTPS，直接在 HTTP 入口测试生产 Cookie 会无法登录，这是预期。

## 邮箱与 OAuth

验证/重置令牌仅存摘要，30 分钟过期、一次消费。密码重置撤销旧会话；不存在/禁用邮箱请求统一响应。SMTP 必须 STARTTLS，不支持不安全明文降级。缺少 SMTP 时明确 503；注册响应告知投递未配置。

Google 授权使用精确预配置回调、PKCE S256、一次性 state（绑定发起浏览器 HttpOnly Cookie）、nonce、官方 HTTPS token/JWKS；仅 RS256，校验签名、iss、aud、exp、iat 和 email_verified。Google subject 单独映射用户，不按邮箱自动关联已有账号。OAuth secret 不进入浏览器、不保存供应商 token/Cookie。真实 Google 登录未进行。

## 密钥、数据与审计

API Key 只经 `SECRETS_DIR` 的只读文件引用读取；引用名受正则约束，拒绝符号链接和路径穿越。前端即使管理员也拿不到 Key，仅看到 secret_ref。供应商 endpoint 为固定官方 HTTPS 地址，无客户端自定义 URL。不支持复制 Cookie/共享订阅会话。

AI 提示词和响应不写数据库；只存账户、模型、用户、状态和可验证用量。未知费用保留预算预留，本地核算非供应商结算；配置错误价格会影响预算保障，必须管理员核价。节点配置可能包含节点凭据，存入 DB 历史；DB/备份需最小权限、磁盘加密和访问控制。此交付不内置 KMS/字段级加密。

审计含操作者 ID、目标、动作、时间和结果，成功记录在业务事务内；拒绝/失败通过中间件/权限依赖记录。DB 管理员仍能修改审计，不是外部防篡改日志。日志无 query/body/Cookie/密钥；验证错误响应去除原始输入，避免回显密码。worker 输出必须可信且执行端脱敏，API 做模式脱敏，但不能保证识别任意自由文本中的秘密。

## 执行隔离

Web API 无 subprocess/shell/root/Docker socket。独立节点 Agent 固定官方 CLI 参数，不支持 shell/systemctl/restart。独立 worker 的安全契约和参考 rootless Docker 启动器详见 [Agent/Worker](docs/AGENT_WORKER.md)。远端服务 URL 只由受信运维设置，必须 HTTPS。不得把安装 URL 当作已验证连接或隔离证明。

## 剩余工作

真实凭据验收、可信 worker 实现和镜像审查、节点运行态 reload、备份调度、外部防篡改日志/告警、KMS、全主机遥测、边缘 IP 限流与生产负载测试需要部署阶段实施。没有声称通过外部渗透审计或完全生产认证。完整清单见 [INTEGRATIONS](docs/INTEGRATIONS.md)。
