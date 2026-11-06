# 部署准备（尚未部署）

当前不购买服务器、收费账户，不变更 DNS。以下是将来在自己新购的机器上执行的准备流程，不得指向旧生产环境。

## 配置清单

| 配置                                     | 用途                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| DATABASE_URL                             | 私网 PostgreSQL 连接；生产使用随机强密码，运行/迁移账号分离                    |
| ENCRYPTION_KEY / ENCRYPTION_KEY_ID       | 32 字节随机 base64 主密钥与版本，独立 secret 存储                              |
| ENCRYPTION_PREVIOUS_KEYS_JSON            | 可选轮换 key ring，受保护 JSON ID→base64                                       |
| NODE_ENV / DEMO_MODE / DEV_MOCK_LOGIN    | 生产必须 production / false / false                                            |
| WEB_ORIGIN / ADMIN_ORIGIN                | 精确 https://panel.你的域名 / https://admin.你的域名                           |
| API_PUBLIC_URL                           | 客户端订阅 URL 的公共 https://api.你的域名                                     |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET  | 在你自己的 Google Cloud 项目配置 Web OIDC 客户端                               |
| GOOGLE_REDIRECT_URI                      | 例如 https://panel.你的域名/auth/google/callback，必须在 Google 控制台精确登记 |
| BOOTSTRAP_ADMIN_GOOGLE_SUB               | 可信渠道取得的首次 Owner Google sub，完成绑定后移除                            |
| COOKIE_DOMAIN                            | 可选 .你的域名，使 panel/admin 共享已登录 Cookie；仅在所有子域受控时使用       |
| SSH_ALLOWED_TARGETS                      | 精确逗号分隔 host:port；只允许拥有管理权的公网目标                             |
| SSH_INTERACTIVE_ENABLED                  | 默认 false，仅理解远程完整 shell 风险后设置 true                               |
| OPENAI_MODEL                             | 账户实际可用的 Responses 模型，默认 gpt-4.1-mini                               |
| PANEL_DOMAIN / ADMIN_DOMAIN / API_DOMAIN | Caddy 三域名，不使用参考图域名                                                 |
| AGE_RECIPIENT / AGE_IDENTITY_FILE        | 备份公钥 / 恢复私钥文件，私钥离线存储                                          |

不要求将任何秘密发到聊天。OpenAI Key 和 SSH Key 通过自己的面板 HTTPS 表单配置，不是服务器全局环境变量。Google 登录首次生产激活时不运行演示 seed；bootstrap sub 只有服务端配置能授予 Owner。

OIDC 始终回到配置 WEB_ORIGIN；使用管理端时建议受控父域 Cookie，随后打开 admin 域名。若不希望共享父域 Cookie，应增设独立管理登录回调配置后再部署。SameSite=Lax、生产 Secure + HttpOnly；不要跨不受控站点共享 Cookie。

## 建议规模与网络

20 人起步可评估 2 vCPU / 4GB RAM / 40GB SSD 的面板机器，视并发 SSH、队列延迟、数据库增长和响应时间扩容；这不是性能实测容量保证。VPN 出口节点与面板 API 不是同一台必需机器，代理流量不应经此 API 转发。PostgreSQL 不映射公网端口，公网只开放 80/443，SSH 运维按自己的最小出口策略管理。

需要公网 DNS 与 TLS 后自行执行（未在本任务执行）：

1. 设置自己拥有的三域名，配置 Google OIDC 回调并将生产秘密写入 `.env.production`（chmod 600），设置不可预测 DB 密码。保留现有配置与备份。
2. 构建并固定镜像标签（例如本 PR 的 commit SHA）：

```bash
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -f infra/docker/Dockerfile --target runtime -t fafa-one-runtime:YOUR_TAG .
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -f infra/docker/Dockerfile --target web -t fafa-one-web:YOUR_TAG .
docker build --secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt -f infra/docker/Dockerfile --target admin -t fafa-one-admin:YOUR_TAG .
```

3. 使用受保护环境配置 IMAGE_TAG / POSTGRES_PASSWORD / 三域名后执行 `docker compose -f infra/docker/compose.production.yaml up -d`。迁移为一次性任务；API/Worker 非 root、只读根文件系统、drop capabilities、禁止权限提升。Caddy 静态服务监听 8080，外层 Caddy 终止 TLS。实际镜像发布与 DNS 修改不在本任务内。
4. 检查 `/ready`、日志脱敏、Google 邀请激活、跨用户 404、真实订阅、API 任务、SSH 指纹/撤销；再做真机与 Lighthouse 验收。未达到上线验收前不要宣传正式上线。
5. 使用非 superuser 运行角色，对 audit_events 只授 SELECT/INSERT，迁移角色单独保管。复核容器出口、主密钥注入、CSP 与反向代理日志，不记录订阅 URL 或 OAuth code。样例 Caddy 未启 access log。

## 备份 / 恢复

机器上需要 Node.js 24、PostgreSQL 17 客户端（pg_dump、pg_restore、psql）和 age；通过安全 shell 注入 DATABASE_URL 与 AGE_RECIPIENT，执行 `bash infra/scripts/backup.sh`。可以在运维确认后配置每日定时任务，保留 30 天加密备份并异地保存。不要在 CI 上传数据库备份。

恢复先创建新空数据库，设置 RESTORE_DATABASE_URL / AGE_IDENTITY_FILE / CONFIRM_RESTORE=RESTORE_TO_NEW_DATABASE，执行 `bash infra/scripts/restore.sh path/to/backup.dump.age`。脚本会拒绝非空库，不使用 --clean，并在单个事务中恢复。数据库 URL 经 libpq 环境变量注入，不放入子进程参数。必须配套主密钥备份，否则存储的加密凭据无法恢复。已在独立测试数据库执行加密备份与恢复，27 张表计数一致；报告见 evidence/backup-restore.json。还未在生产执行恢复演练。

回滚使用旧镜像标签，数据库只采用向前兼容迁移；重要迁移先备份并在副本演练。生产升级不能直接删除数据卷。开发的 `docker compose down` 不加 `-v` 即保留数据。

完整回滚步骤见 [ROLLBACK.md](ROLLBACK.md)。低磁盘空间的云环境建议顺序构建 `api`、`web`、`admin` 三个目标，然后 `docker compose -f infra/docker/compose.dev.yaml up -d --no-build`；四个运行服务共用同一开发镜像。
