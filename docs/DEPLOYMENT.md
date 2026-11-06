# FAFA ONE 生产部署

目标为现有服务器 **3.19.237.155**，沿用现有数据库、卷、密钥及安全设置。正式域名仅有用户端 <https://fafa888.uk> 与独立管理端 <https://a.fafa888.uk>。不创建 API 子域名，不需要额外服务器。

## 域名与路由

| 入口 | 上游 / 行为 |
| --- | --- |
| https://fafa888.uk/api/* | Fastify api:4000，保留 /api 前缀 |
| https://fafa888.uk/auth/* | Fastify，Google 回调固定 /auth/google/callback |
| https://fafa888.uk/api/servers/:id/terminal | Fastify WebSocket，通过 wss:// 连接 |
| https://fafa888.uk/api/ai/tasks/:id/events | Fastify SSE |
| https://fafa888.uk/api/subscription/download/:token | Token 认证下载，无需浏览器会话 |
| https://fafa888.uk/subscription/:token | 兼容已有订阅 URL，令牌及撤销语义不变 |
| https://fafa888.uk/health 与 /ready | 保留内部健康路径的兼容入口，推荐 /api/health 与 /api/ready |
| 主域名其他页面 | 独立 Web 构建 |
| https://a.fafa888.uk | 独立 Admin React 构建；后端路径返回 404，不回退 SPA |

Caddy 使用互斥 `handle`，不使用会剥离前缀的 `handle_path`，不添加 /api。WebSocket / SSE 都在 /api 内，由 reverse_proxy 处理，不配置 SPA rewrite。未知后端路径返回后端错误，绝不能返回 index.html。

用户构建固定使用相对 /api；管理构建固定使用 https://fafa888.uk 作为 API Origin，登录入口也指向主域名。开发 Vite 仍使用同源代理。本项目路由本身已经包含 /api，API_PUBLIC_URL **只能是 Origin，不得附加 /api**。

## 生产配置

模板见根目录 `.env.production.example`。升级时只调整下面的公开字段，删除旧的 API_DOMAIN 配置，不得用模板覆盖已有生产文件或重新生成密钥：

```dotenv
NODE_ENV=production
DEMO_MODE=false
DEV_MOCK_LOGIN=false
PANEL_DOMAIN=fafa888.uk
ADMIN_DOMAIN=a.fafa888.uk
WEB_ORIGIN=https://fafa888.uk
ADMIN_ORIGIN=https://a.fafa888.uk
API_PUBLIC_URL=https://fafa888.uk
GOOGLE_REDIRECT_URI=https://fafa888.uk/auth/google/callback
```

保留 DATABASE_URL、POSTGRES_PASSWORD、ENCRYPTION_KEY、ENCRYPTION_KEY_ID、旧 key ring、Google 客户端凭据、SSH 白名单及交互开关。API 生产启动会拒绝错误 Origin、HTTP 公共 URL 或错误 OAuth 回调。API_PORT 保持 4000，但不发布到宿主机；生产 Compose 只有 proxy 发布 80/443，PostgreSQL 与 API 均为 Docker 内部服务。

Google Cloud 的现有 Web OAuth 客户端必须登记唯一回调 `https://fafa888.uk/auth/google/callback`；此项不是 DNS 记录。首次 Owner 绑定继续使用 BOOTSTRAP_ADMIN_GOOGLE_SUB，绑定后可移除，不运行演示 seed。不要发送客户端 Secret、SSH 私钥、会话 Cookie 或订阅令牌到聊天 / PR。

Cookie 使用 HttpOnly、SameSite=Lax，生产 Secure。新安装默认 COOKIE_DOMAIN 留空：Cookie 属于主域名，管理端通过 credentials:include 向主域名发请求；无需把 Cookie 发给管理端静态站。升级时保留已有受控父域 COOKIE_DOMAIN，避免改变现有会话作用域；不要同时切换 Cookie 策略。清理 Cookie 与设置 Cookie 使用一致作用域。

管理域名与主域名属于相同 HTTPS site，但属于不同 Origin。API 只允许上述两个精确 Origin，带凭据 CORS 不使用通配符；写请求仍要求 Origin + 会话 CSRF。管理端 CSP 允许主域名 HTTPS/WSS 连接，禁止 HTTP/WS 混合内容。管理权限及对象级隔离继续由 Fastify 校验。

## 在现有服务器发布

先通过现有可信 SSH / SSM 通道进入 3.19.237.155。检查部署目录、Compose 项目名和现有卷绑定，保留当前镜像 SHA/tag、Caddyfile、受保护环境文件及可恢复的加密数据库备份。本仓库不能自动得知服务器现有目录或凭据。

1. 在现有 checkout 切换到 PR #2 的最新已验证提交。保留工作目录的本地生产配置；若有未提交修改先比较，不能用 reset --hard 覆盖。
2. 仅调整上文公开配置。Compose 项目名 `fafa-one`、卷 pg/caddy/caddy_config 及 PostgreSQL 挂载保持不变；如果现有部署另有项目名或卷名，继续显式使用原项目名和原 override，不能创建新空数据库替换业务库。
3. 设置 IMAGE_TAG 为待发布提交 SHA，通过现有受保护 .env.production 注入其余变量，顺序构建三个目标：

```bash
docker build -f infra/docker/Dockerfile --target runtime -t fafa-one-runtime:YOUR_COMMIT_SHA .
docker build -f infra/docker/Dockerfile --target web -t fafa-one-web:YOUR_COMMIT_SHA .
docker build -f infra/docker/Dockerfile --target admin -t fafa-one-admin:YOUR_COMMIT_SHA .
```

如构建需受信代理 CA，保留已有 BuildKit `--secret id=proxy_ca,src=受信CA路径`，不要关闭 TLS 校验。

4. 本次不包含数据库 schema 变更。先做不泄漏配置的校验，再更新服务，重建代理以加载新路由：

```bash
docker compose --env-file .env.production -f infra/docker/compose.production.yaml config --quiet
docker run --rm -i -e PANEL_DOMAIN=fafa888.uk -e ADMIN_DOMAIN=a.fafa888.uk caddy:2.10.2-alpine caddy adapt --config - --adapter caddyfile --validate < infra/reverse-proxy/Caddyfile > /dev/null
docker compose --env-file .env.production -f infra/docker/compose.production.yaml up -d --wait --wait-timeout 120
docker compose --env-file .env.production -f infra/docker/compose.production.yaml up -d --no-deps --force-recreate proxy
```

保留现有非 root / read-only / cap_drop / no-new-privileges 和数据库最小权限角色，不更改防火墙。禁止 down -v、卷删除、演示 seed 和生产恢复覆盖。不要把完整 compose config 或 env 输出到日志。

5. 检查两个现有域名是否已指向目标 IP；本修改不自动变更 DNS。核验公开 TLS、/api/ready、匿名 /api/me=401、主域名 SPA 深链接和独立 Admin 页面。通过真实受邀账号完成 Google 登录，管理端验证 Owner/Admin 可用且 Member/Viewer 被拒绝；在浏览器检查无 CORS/CSP/混合内容报错。
6. 使用已有授权订阅验证下载及客户端导入；使用已白名单、固定指纹的 SSH 目标验证 WSS 终端、票据、撤销。不放宽白名单或重新固定未知指纹来通过测试。服务器上 `docker compose ... port api 4000` 应无发布端口，同时检查现有防火墙/安全组没有额外开放 4000。失败时按 [ROLLBACK.md](ROLLBACK.md) 回退镜像及代理配置，保留数据。

## 自动验证的边界

`pnpm test` 包含生产 Origin / OAuth 校验、API 路径拼接与 Compose 端口/数据卷安全契约；集成测试覆盖订阅新旧路径、撤销、权限、CORS/CSRF、Google PKCE 和 SSH fixture。

`pnpm verify:tls` 仅在一次性 CI 容器运行，配套 `compose.dev.yaml + compose.tls-test.yaml`，读取实际生产 Caddyfile 并仅换为内部 CA。Chromium 的两个域名只映射 loopback，不更改 DNS；Node HTTPS 显式信任临时 CA 并验证未受信证书被拒绝。测试独立 Web/Admin 构建、管理端跨源会话、订阅下载、OAuth 回调路由与 WSS Upgrade。测试内 Google 客户端和订阅数据是 fixture，WSS 无效票据必须被拒绝；这不等于真实 Google 登录或生产 SSH 验收。不要把此 CI override 或演示登录部署到生产。

## 备份 / 恢复

沿用现有 `infra/scripts/backup.sh` 与 `restore.sh`。备份需要 PostgreSQL 客户端和 age，主密钥独立备份；本次不安装软件或调整备份策略。恢复必须指向新空库，设置 RESTORE_DATABASE_URL / AGE_IDENTITY_FILE / CONFIRM_RESTORE=RESTORE_TO_NEW_DATABASE；脚本拒绝非空库并在单个事务恢复。不得覆盖生产数据库。详见回滚文档。
