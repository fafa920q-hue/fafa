# 新加坡服务器部署手册（待用户在部署阶段执行）

本次只生成文件并在当前云端隔离环境验收；没有连接新加坡/日本生产服务器、SSH 或修改 DNS。以下是日后部署步骤，**本次没有执行**。

## 1. 准备独立目录

确认 Docker Engine / Compose v2、空闲本地端口 8080、足够内存和备份空间。使用新的目录和 Compose project，不复用旧面板目录/卷/容器。解压后核对 SHA256 与 ARCHIVE_FILES.txt。不要运行 `docker system prune` 或停止其他项目。

```bash
unzip FAFA-Control-Center-v1.0.0.zip
cd fafa-control-center-v1.0.0
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
```

在自己机器上生成随机 APP_SECRET 和 PostgreSQL 密码，填到 .env；两者至少 32 字符，数据库密码建议使用随机十六进制以便 URL 安全。不把真实值写进源码、聊天或 shell 历史。保持 APP_ENV=production、COOKIE_SECURE=true、REQUIRE_VERIFIED_EMAIL=true、PUBLIC_ORIGIN=https://codex.fafa888.uk。

默认 DATABASE_URL 由 Compose 构造，连接内部 PostgreSQL；不要添加 DB/API 的宿主机端口。`SECRETS_HOST_DIR` 挂载只读密钥文件；文件对容器 UID 10001 可读，对其他用户不可读（例如受控组，root:10001 + 0440，密钥目录 root:10001 + 0750）。不用的集成保持空值，不要填 TEST fixture 值。

## 2. 本地预验收、镜像与初始化

```bash
docker compose config --quiet
docker compose build
docker compose up -d db
docker compose run --rm migrate
docker compose run --rm api python -m app.bootstrap --email YOUR_ADMIN_EMAIL
docker compose up -d api frontend
docker compose ps
curl --fail http://127.0.0.1:8080/api/health
```

初始化密码在交互终端输入两次，不支持公开 HTTP 初始化或命令行明文密码参数。已有超级管理员时初始化拒绝；公开注册同邮箱也不会被提升。不要反复设置 BOOTSTRAP_ADMIN_PASSWORD（该旧变量已移除）。Compose 启动 api 前会运行迁移，启动时验证数据库版本。

企业受控构建可用 registry 镜像缓存和镜像 digest；保留构建产物 digest。当前 Dockerfile 用受维护的大版本 base tags，发布环境应评审后固化实际测试过的 digest。云开发环境代理 CA 构建脚本 `scripts/build_images.sh` 支持 BuildKit secret mount；普通服务器无需云会话 CA，直接 compose build。

## 3. 审查 HTTPS 反向代理

先备份服务器现有 Caddy 配置。只把 `Caddyfile.example` 中**本站点块**合入经审查的配置，检查现有 80/443、路由与服务；不要覆盖配置或重启日本旧服务。使用 `caddy validate --config <候选文件>` 验证；由运维在获授权维护窗口应用。DNS 和证书需单独授权和验证，本次未执行。

在 HTTPS 可用前仅测健康，不使用生产 Secure Cookie 在 HTTP 页面登录。Web 宿主机入口保持 127.0.0.1；不要改成 0.0.0.0。若端口占用，改为另一个回环端口，并同步候选反向代理配置。

## 4. 邮件、Google 与集成配置

先配置 SMTP_HOST/PORT/USER/PASSWORD/FROM，确认 STARTTLS 和真实邮箱投递。普通注册生产默认必须验证邮箱。初始化管理员由受控本地流程验证；仍应配置正常邮件恢复渠道。

Google Cloud 创建 Web OAuth client，配置同意屏幕及用户范围；JS origin 精确为 `https://codex.fafa888.uk`；redirect URI 必须精确为 `https://codex.fafa888.uk/api/v1/auth/google/callback`。填 GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI，再在测试身份上验收。不得将模拟回调测试当成真实认证成功。

AI：只通过服务端 secret 文件配置官方 API Key；管理员保存账户引用、官方模型 ID、当前核对后的输入输出价格及用户授权。首次用极小请求确认实际供应商身份、可用模型、usage/费用和失败行为。

节点/Codex 默认不接通。按 [独立服务契约](docs/AGENT_WORKER.md) 在**新的隔离测试环境**部署、审核并验收；不要连接旧面板。Worker 必须验证沙箱强约束和合法授权后再开放。新增 Agent URL 不代表服务在线。

## 5. 上线验收

用独立普通用户验证：菜单隐藏、手动管理员路径 403、管理员 API 403、没有默认模块授权。验证超级管理员搜索/禁用/恢复/角色、最后管理员保护、旧 Cookie 失效、CSRF、真实邮件和 OAuth。小额 AI 请求核对账户隔离；新节点/worker 分别完成受控真实验收。

配置 [备份恢复](docs/BACKUP_RESTORE.md)、[回滚](docs/ROLLBACK.md) 和监控保留策略。未接通模块保持未配置；外部真实服务有任何阻塞时先不对用户开放对应授权。

## 从 v0.3 迁移

先离线备份旧 SQLite。用新的 v1 副本运行 `alembic upgrade head`，迁移保留 ID/邮箱/哈希/角色，未知 role 降为 user，旧无效会话不继承。旧账户 verified=false，需要邮件验证（包括旧超级管理员）；不要关闭生产验证以绕过迁移。PBKDF2 成功登录会升级 Argon2id。SQLite 到 PostgreSQL 的**数据导入工具尚未提供**，不能把更改 DATABASE_URL 当成已迁移数据；生产新装 PostgreSQL 已有自动迁移，旧库跨引擎导入需独立备份、映射和对账任务。
