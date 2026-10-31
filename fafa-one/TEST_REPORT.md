# 本次候选版本验证报告 — 2.0.0-alpha.1

仅当前隔离开发环境，非生产验收；最终完整运行记录来自 docs/evidence，未沿用 v1 的测试结论。

| 范围 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| SQLite 后端/集成/隔离/迁移/恢复 | 101 | 0 | 1 |
| 隔离 PostgreSQL 17（含真实 pg_dump/restore） | 102 | 0 | 0 |
| 真实本地 API + 构建后 Chromium UI | 6 | 0 | 12 |
| 执行合计（含双数据库重复用例） | 209 | 0 | 13 |

SQLite 跳过的唯一用例为需 Docker PostgreSQL 的恢复检查，该用例在 PostgreSQL 运行中通过。浏览器 12 个跳过项是未接通或未实现的完整验收，不计作通过；见测试文件和 RELEASE_GATES.md。

验证包括新增密钥关联加密、不可导出、管理员跨 owner 拒绝、默认切换与运行快照、并发默认、预算 admission、计费不明预留、上下文交接确认、取消/上游静默/关闭失败恢复、历史搜索分页、旧表逐行保持，以及旧认证、OAuth 协议和 worker 沙箱回归。供应商协议测试使用明确的合成 fixture，绝不是实际 AI 生成、OAuth 登录或 CLI 执行成功。

前端 TypeScript、ESLint/Prettier、新模块 Ruff/格式、Python 编译、前端构建、双镜像构建、Compose 配置与仅回环 Web/私有 API/DB 检查通过。完整本地 Compose 的数据库迁移、健康检查、非 root API、Nginx 页面及安全响应头通过；同时以实际 API 镜像确认 production alpha 拒绝启动。临时容器和卷结束后清理；无生产操作。旧交付 ZIP SHA256 保持有效。

npm（含开发依赖）和 Python runtime lock 扫描时均为零已知漏洞，不代表完成全面安全或法律审计。Starlette 测试客户端仍有 HTTPX 迁移弃用提示，无功能失败。

移动布局验证 375/768/1440px，输入区域在缩小视口内可见、无页面横向溢出、对话发送在无连接时明确禁用、原生弹窗焦点/ESC/恢复、主题持久化、历史返回、真实注册及连接增删改/default/revoke、普通用户管理员 API 403 已通过。没有模拟供应商成功响应来通过 UI 验收。

生产前端单次本地 Chromium 样本：LCP 640ms，CLS 0，无网络节流。不是 field p75；INP 未测。初始 JS 约 182KB（gzip 59KB），Markdown/高亮按需加载；资产预算检查通过。不能宣称达到生产移动端 LCP/INP/CLS 目标。

未执行：真实 iPhone Safari/PWA、Android、macOS Safari、Firefox、Windows Edge；真实 AI/CLI/节点订阅/内容发布/学院/管理员 MFA 全链路；生产服务器权限、资源、证书源站、备份迁移和回滚。公开 DNS/HTTPS 观察只代表可达性，不能证明上线验收。

结论：本地核心候选可审查；完整平台未完成，因阻断未发布。
