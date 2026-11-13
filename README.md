# FAFA ONE

玻璃质感的私有控制台：VPN 多源订阅、OpenAI API 多账户、SSH 授权工作区、位置预设与独立管理员后台。正式架构为用户端 https://fafa888.uk、独立管理端 https://a.fafa888.uk，API 统一通过主域名 /api 访问；生产执行结果需以部署记录为准。原仓库 Apache-2.0 许可证保留。

## Windows 最简启动（只需 Docker Desktop）

1. 安装并打开 [Docker Desktop](https://www.docker.com/products/docker-desktop/)，等待 **Engine running**；按提示完成 WSL 更新或重启。使用 Linux containers。
2. 在 GitHub 开发分支页面点击 **Code → Download ZIP**，完整解压到普通本地文件夹。
3. 双击解压目录里的 **START-FAFA.cmd**。首次启动会下载和构建镜像，请保持窗口打开。成功后自动打开 <http://localhost:5173>；管理员端是 <http://localhost:5174>。

无需安装 Git、Node.js 或 pnpm。脚本只在 `.env` 不存在时生成本地随机加密密钥，保留已有配置和数据库；不会购买资源或修改 DNS。此入口仅允许开发演示模式。之后双击同一文件可再次启动；Docker Desktop 需要保持运行。`cmd` 入口只为本次子进程设置 PowerShell 执行策略，不修改系统执行策略。

如果 Docker 已安装但终端找不到命令，入口会自动查找默认安装路径。报错时保留窗口，查看最先出现的错误。企业代理需按下文提供受信 CA；不会关闭 TLS 验证。

启动入口会将已启用的 Windows HTTP/HTTPS 系统代理传给 Docker CLI 的当前进程，解决镜像认证请求未继承 Desktop 代理的问题；已有进程代理优先，并保留本地地址绕过。不会修改 Windows 代理设置或输出代理凭据。使用 v2rayN 等本地代理时，请先开启系统代理并保持软件运行；Docker Desktop 自身的镜像拉取代理也须使用可用配置。

如果 Docker 显示 **Virtual Machine Platform is not enabled**，在管理员 PowerShell 执行 `Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart`，保存工作并重启 Windows，再打开 Docker Desktop。

## 开发命令启动

需要 Node.js 24、pnpm 11.25.0、Docker Compose。首次下载镜像和依赖的耗时取决于网络。

```bash
corepack enable # 或 npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm exec tsx infra/scripts/init-env.ts
# 只在 .env 不存在时生成本地随机加密密钥；不会覆盖现有配置。
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

用户端 <http://localhost:5173>，管理员端 <http://localhost:5174>，API <http://localhost:4000/health>。选择「管理员演示 / 成员演示 / 访客演示」。演示账户没有 Google 绑定；示例节点不含可连接凭据。所有样例卡片有演示标记，AI / SSH / 远程订阅抓取均被阻止。

全容器开发方案（先关闭 `pnpm dev` 避免端口冲突）：

```bash
docker compose -f infra/docker/compose.dev.yaml up --build -d
```

这会启动独立 Web、Admin、API、Worker、迁移、seed 与 PostgreSQL，数据卷与根 compose 的数据库卷独立。受企业代理影响时，将 `FAFA_BUILD_CA` 指向受信 CA 文件；保持 TLS 校验。云端运行时还需按环境插件文档传入运行容器 CA 与代理配置。

## 接入真实服务

只在本地受保护的 `.env` 或部署 secret 中配置凭据，不要发送到聊天、Issue 或 PR。开发模式下将 `DEMO_MODE=false`；正式部署同时使用 `NODE_ENV=production`、`DEV_MOCK_LOGIN=false`，不要运行演示 seed。

- Google：配置 OIDC 客户端、回调与服务器本地一次性 Owner 授权。默认仅受邀 verified email 激活；详见 [首次 Owner 绑定](docs/OWNER_SETUP.md) 与 [部署文档](docs/DEPLOYMENT.md)。
- 订阅：添加有权聚合的 HTTPS URL 或已支持的节点文本；Worker 刷新；生成独立链接供客户端更新。服务端能实际转换，但客户端真机导入仍待验收。
- AI：在面板添加自己的 OpenAI API Key，选择账户并创建任务；Responses API 独立计费。不接管官方 Codex Cloud，不使用 Plus 额度。
- SSH：先配置 `SSH_ALLOWED_TARGETS=host:port`，添加自己的私钥或密码，核验并固定主机指纹，批准只读诊断。完整交互终端还需 `SSH_INTERACTIVE_ENABLED=true` 与额外批准；有真实写入风险。
- 位置：坐标保存可立即使用；出口国家筛选影响导出配置。没有系统 GPS 修改能力，在线地图供应商未接入。

## 验证

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration # 自动创建后缀 _test 的独立数据库，绝不清空业务数据库
pnpm build
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
pnpm security
pnpm audit --audit-level=moderate
```

集成测试可设置 `TEST_DATABASE_URL`，数据库名必须以 `_test` 结尾。E2E 使用本地开发数据库，会新增演示位置和邀请。CI 的 PostgreSQL 为一次性服务。不要将 E2E 指向生产。

[架构](docs/ARCHITECTURE.md) · [产品规格](docs/PRODUCT_SPEC.md) · [安全与限制](docs/SECURITY.md) · [部署](docs/DEPLOYMENT.md) · [API](docs/API.md) · [许可证](docs/OPEN_SOURCE_ATTRIBUTION.md) · [验收报告](docs/ACCEPTANCE_REPORT.md)

正式升级和受保护 SSM/GitHub 部署见 [生产运维手册](docs/PRODUCTION_RUNBOOK.md)，节点导入见 [节点导入](docs/NODE_IMPORT.md)。已有环境与密钥继续沿用。
