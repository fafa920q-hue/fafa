# FAFA ONE

玻璃质感的私有控制台：VPN 多源订阅、OpenAI API 多账户、SSH 授权工作区、位置预设与独立管理员后台。当前是开发交付版，**没有生产部署**。原仓库 Apache-2.0 许可证保留。

## 约 5 分钟本地启动

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

- Google：配置 OIDC 客户端、回调与首次 Owner 的 Google sub。默认仅受邀 verified email 激活；详见 [部署文档](docs/DEPLOYMENT.md)。
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
