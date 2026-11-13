# FAFA Control Center 1.0.0 — 实际测试报告

日期：2026-10-23 UTC。仅当前云端隔离开发环境。没有 SSH、生产服务器连接、DNS 修改或日本旧节点操作。

## 结果摘要

- 原始附件：v0.3.0，26 文件；原版前端生产构建通过、原版 4 个后端测试通过。发现的是未覆盖的安全与业务缺口，不是声称原测试报错。
- 当前 TypeScript：`tsc --noEmit` PASS；Vite 6.4.5 生产构建 PASS（1578 modules，JS 192.76kB / gzip 61.47kB；构建产物不进入 ZIP）。
- SQLite：**77 passed，25.87s**。一个第三方弃用提示：Starlette 提醒未来从 httpx 迁移 httpx2，不影响测试；没有隐藏失败。
- PostgreSQL 17 本地一次性 Docker 数据库：**76 passed，56.99s**。之后新增的第 77 项为独立启动器输出上限测试，在 SQLite 测试套件中通过；该测试不使用数据库，本次未重新跑整套 PostgreSQL。
- Chromium Playwright：**6 passed，23.5s**。注册/登录、普通用户隐藏管理员菜单、手输 URL 拒绝、直接 API 403、管理员项目/任务审批后明确未配置、语言/主题持久化、320/768/1440px 无全局横向溢出、移动导航。截图已人工查看，不将临时截图/测试账户数据收入归档。
- Docker Compose 配置验证 PASS；API/前端镜像实际构建 PASS；独立临时 Compose 整栈启动 PASS：PostgreSQL 健康、迁移成功、API 健康、Nginx 页面、非 root API、CSP/X-Frame-Options。只发布临时回环 Web 端口，测试结束仅清理该临时项目及临时卷。
- npm audit：0 已知漏洞。pip-audit（锁定的完整 Python 依赖集合）：0 已知漏洞。扫描时旧 PyJWT/Starlette/pytest 公告已通过升级修复，当前 FastAPI 0.161.1、Starlette 1.9.0、PyJWT 2.15.1、pytest 9.1.1。扫描不是无漏洞保证。
- 源码凭据模式扫描 PASS；归档脚本排除 .env、依赖、构建、数据库、日志、缓存及私钥文件，再执行 ZIP CRC 与逐文件 SHA256 复读校验。最终 ZIP 另附 SHA256 和归档完整清单。

## 必测清单

| # | 项目 | 结果 / 实际范围 |
|---|---|---|
| 1 | 前端安装 | PASS，npm install + 锁文件；镜像内 npm ci |
| 2 | TypeScript | PASS |
| 3 | Vite 生产构建 | PASS，本机与 Docker |
| 4 | 后端语法 | PASS，compileall 覆盖 app/migrations/agent/worker/scripts |
| 5 | 单元测试 | PASS，密码哈希、约束、适配器与状态机 |
| 6 | API 集成 | PASS，SQLite 77 项 / PostgreSQL 76 项范围见上 |
| 7 | 注册与登录 | PASS，忽略 role/is_admin/permissions、限流、验证要求、Cookie 属性 |
| 8 | 普通用户越权 | PASS，所有管理员查询、管理写 API、模块/资源访问、UI URL/API 403 |
| 9 | 超级管理员授权 | PASS，搜索/分页/状态、自定义角色、资源授权、安全设置、审计 |
| 10 | 最后管理员保护 | PASS，禁用、降级及并发同时降级只允许一次；无删除公开接口 |
| 11 | 会话失效 | PASS，退出后盗用旧 Cookie、过期、revoke-all、禁用/恢复、重置密码 |
| 12 | AI 账户隔离 | PASS，授权账户/模型、跨用户日志隔离、Key 不回传、预算准入、未知用量、显式同账户 429 备用路由；供应商调用为 TEST mock |
| 13 | 节点适配器 | PASS，TEST 标记、无假延迟、未配置提示、瞬时故障 3 次重试、版本与配置回滚、Agent 白名单/鉴权/固定 argv；真实引擎未连接 |
| 14 | Codex 状态与超时 | PASS，未配置零执行、审批队列、TEST 执行器日志/变更/回滚、取消、超时、取消未确认禁止重试；rootless 启动参考固定参数/输出上限/清理验证；不是实际 Codex 或沙箱逃逸测试 |
| 15 | 中英文 | PASS，浏览器切换、html lang 和刷新持久化 |
| 16 | 深浅主题 | PASS，浏览器切换、data-theme 和持久化 |
| 17 | 响应式 | PASS，320/768/1440px 多页面检查与移动菜单 |
| 18 | Docker Compose | PASS，配置、镜像构建、完整隔离运行栈；未部署域名/生产 |
| 19 | 泄漏扫描 | PASS，源码/归档排除与模式扫描、API 关键值不回传、验证错误不回显密码；不等于所有潜在秘密均可自动识别 |
| 20 | ZIP 完整性 | 归档脚本实际创建后重新打开，CRC、文件清单及 SHA256 验证；交付侧车文件提供最终大小/校验值 |

## 真实外部测试：BLOCKED / NOT CONFIGURED

SMTP 真实投递、Google Cloud 真实登录、OpenAI/Anthropic/Google 真实调用与账单、Xray/V2Ray/sing-box 真实节点及进程重载、真实 Codex 授权/worker/隔离任务、TLS 域名证书和正式服务器部署均未执行。缺少的是凭据、独立环境或尚需实现的接通部分，不能将 mock 成功写成真实端到端成功。

Google mock 测试包括真实生成 RSA 签名/JWK、错误 audience/issuer/exp/signature/crit、state/nonce/replay/精确回调和禁止自动邮箱关联；令牌测试为捕获 SMTP 函数，不会向外发送邮件。

节点 runtime reload、完整 Codex worker HTTP 服务、主机全量监控、外部告警渠道、KMS、防篡改审计、备份定时及 SQLite→PostgreSQL 数据导入工具尚需后续工程。[完整清单](docs/INTEGRATIONS.md)。

## 已修复的验收问题

1. 原版无可撤销会话/CSRF/限流/审计/角色外键/最后管理员保护：新增对应实现及回归测试。
2. 安装阶段沙箱网络和缓存目录权限：仅为开发测试添加网络权限、缓存使用 /tmp，保留 TLS 校验；未修改环境代理或凭据。
3. 初始 API 容器中文件 root:0600 导致非 root 迁移无法读取配置：Docker COPY 显式 chown，重新构建后整栈通过。
4. 浏览器测试发现 select 包裹标签定位不明确：补齐 aria-label 后完整流程通过。
5. 旧 Python 依赖已知公告：升级依赖并锁定，重新审计/运行后端和浏览器测试。
6. 独立沙箱启动参考对输出使用有界读取，超过 1MB 强制终止并清理容器；测试用真实本地 fixture 子进程验证上限，不冒充 Docker/Codex 真实执行。

## 复现命令

README.md 提供安装和测试命令；scripts/browser_test.sh、scripts/docker_smoke.sh、scripts/stack_smoke.py 使用自动生成的临时配置/数据库，不读取生产凭据。PostgreSQL 测试强制仅接受回环 fafa_test 数据库。scripts/package_release.py 可重建源码归档，内容哈希清单写入 SHA256SUMS.txt，文件清单写入 ARCHIVE_FILES.txt。
