# FAFA ONE — 2.0.0-alpha.1（未发布）

本目录是独立重构候选源码，不是已上线的 FAFA ONE。完整平台尚未完成；生产迁移与发布被阻断。没有修改生产服务、DNS 或生产数据库。

仓库的 `release/fafa-control-center-v1.0.0` 分支提供了归档 Python/React 工程（19b9d38），不是已确认的线上版本。线上公开页面和健康端点与该归档存在差异。原始源码和 ZIP 完整保留在相邻目录，不能把归档提交标成生产基线。

本次可运行增量是个人 AI API 连接与会话核心：AES-256-GCM 密钥存储、严格 owner 校验、多个官方连接、默认账户、检测、撤销/删除、月度预算、模型目录、流式会话、历史/搜索/重命名/归档、上下文交接确认、中止与故障恢复，以及新的响应式中文界面。没有真实供应商凭据，官方 API 实际调用尚未验收。测试中的供应商契约 fixture 不计作真实调用。

Codex/Claude 设备授权、节点订阅迁移、发现与学院、独立管理员 MFA 等仍未完成。旧版管理员/节点/任务 API 仅作为本地兼容基线保留；新界面没有用静态演示或伪响应代替缺失模块。生产模式明确拒绝启动。

详细状态：[发布门禁](docs/RELEASE_GATES.md)、[架构](ARCHITECTURE.md)、[安全](SECURITY.md)、[集成决策](docs/INTEGRATIONS.md)、[本次测试](TEST_REPORT.md)。

## 仅在隔离环境运行

Python 3.12、Node 22+；正式存储目标 PostgreSQL 17，SQLite 用于开发与迁移夹具。

```sh
python -m venv .venv
.venv/bin/pip install -r backend/requirements.lock -r backend/requirements-dev.txt
npm --prefix frontend ci
```

用受控配置设置 `APP_ENV=development`、`COOKIE_SECURE=false`、`REQUIRE_VERIFIED_EMAIL=false`、`PUBLIC_ORIGIN=http://127.0.0.1:5173`，为测试数据库指定新的 `DATABASE_URL`。`APP_SECRET` 必须独立随机生成，`AI_KEY_ENCRYPTION_KEY` 必须是独立随机的 32 字节密钥的 URL-safe Base64 编码。不要打印或提交实际密钥；开发与生产禁止共用凭据。没有加密密钥时个人连接写入返回 503。

在 backend 运行 `.venv` 对应的 `alembic upgrade head`；启动 API：`uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log`。前端使用 `npm run dev -- --host 127.0.0.1`。新迁移只适用于归档数据库，不可用于未检查的线上数据库。

模型列表来自个人连接检测；可发送的模型还必须由本地管理员通过已有 `/api/v1/ai/models` 配置对应供应商和核验价格。不预置猜测的模型、价格、用户或实际 API 密钥。管理员初始化仅能用本地 `python -m app.bootstrap --email <受控邮箱>` 交互流程；本版本不能据此开通生产管理站。

## 复现验证

```sh
.venv/bin/python -m pytest backend/tests -q
.venv/bin/ruff check --config backend/pyproject.toml backend/app/one backend/tests/test_personal_ai.py backend/tests/test_v2_migration.py backend/tests/test_postgres_restore.py ops
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend run build
scripts/browser_test.sh
scripts/docker_smoke.sh
scripts/build_images.sh
.venv/bin/python scripts/stack_smoke.py
```

浏览器脚本使用临时数据库、真实本地 API 和生产前端构建，绝不连接真实供应商。12 项外部/未实现验收明确跳过。PostgreSQL 脚本仅允许本地 Docker socket，绑定回环临时端口，结束后只清理自身容器。`ops/readiness.py` 只读检查公开 DNS/HTTPS，不尝试生产登录。
