# FAFA Control Center 1.0.0

从用户提供的 v0.3.0 工程原地迭代。React 18 + TypeScript + Vite 6 / FastAPI + SQLAlchemy + Alembic / PostgreSQL 17（正式）或 SQLite（开发）。Docker Compose 默认仅发布 `127.0.0.1:8080`。计划域名 `codex.fafa888.uk` 只是配置模板，本次未访问或部署。

已实现可运行的认证、用户/角色/模块权限、审计、节点记录和适配器、AI API 账户/模型/预算工作台、Codex 审批队列、双语/双主题 UI。集成外部服务需要合法凭据和独立 Agent/worker，详见 [尚未接通服务](docs/INTEGRATIONS.md)。特别是 Codex 未配置时不会执行，节点配置暂存成功不代表运行中服务已重载。

## 本地开发

需要 Python 3.12、Node 22；命令在项目根目录执行。

```bash
python -m venv .venv
.venv/bin/pip install -r backend/requirements.lock
cd frontend
npm ci
cd ..
```

在自己的开发终端设置环境（值不要提交到仓库）：

```bash
export APP_ENV=development PUBLIC_ORIGIN=http://127.0.0.1:5173 COOKIE_SECURE=false
export REQUIRE_VERIFIED_EMAIL=false DATABASE_URL=sqlite:///./fafa-control-center.db
export APP_SECRET="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(48))')"
cd backend
../.venv/bin/alembic upgrade head
../.venv/bin/python -m app.bootstrap --email admin@example.com
../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
# 另一终端在 frontend 中运行 npm run dev -- --host 127.0.0.1
```

普通注册用户默认无节点、AI、Codex 模块权限，由超级管理员分配。公开注册不能创建管理员。首次管理员初始化需输入两次密码；只允许在尚无超级管理员时执行，不会提升已有公开注册账号。

## 验证

```bash
.venv/bin/python -m compileall -q backend/app agent worker
.venv/bin/python -m pytest backend/tests -q
npm --prefix frontend run typecheck
npm --prefix frontend run build
.venv/bin/python scripts/compose_check.py
scripts/browser_test.sh
# 可选：仅限本机隔离 Docker；会创建并清理临时 PostgreSQL 容器
scripts/docker_smoke.sh
```

浏览器测试使用本机 Chromium；`CHROMIUM_PATH` 可覆盖路径。CI 也可安装 Playwright 的 Chromium 后设置路径。测试密码仅用于脚本创建的临时 TEST 数据库，不作为部署默认账号。测试需要本地线程/回环网络可用。

生产部署：[部署手册](DEPLOYMENT.md)。其他文档：[架构](ARCHITECTURE.md)、[API](docs/API.md)、[安全](SECURITY.md)、[备份恢复](docs/BACKUP_RESTORE.md)、[回滚](docs/ROLLBACK.md)、[测试报告](TEST_REPORT.md)、[集成状态](docs/INTEGRATIONS.md)、[Agent 与 Worker 契约](docs/AGENT_WORKER.md)。
