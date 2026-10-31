# 开源评估与真实集成状态（2026-10-31）

通过 GitHub 官方 API 核验了 19 个仓库元数据，并读取部分官方许可证/README 和供应商 SDK 文档。原始核验摘要见 OPEN_SOURCE_RESEARCH.json；不是已安装或已发布清单，GitHub 的 NOASSERTION 也不是许可证认可。

| 项目 | 结论 |
|---|---|
| LibreChat | MIT 原文已读；参考会话交互。本次没有复制/运行完整应用，避免重复用户/存储系统 |
| Open WebUI | LICENSE 含品牌保留条件和有限例外，不能当成普通 MIT 直接换标；未集成 |
| LiteLLM | 非 enterprise 范围 MIT，enterprise 有独立许可；本次只有三种官方固定适配器，未新增网关服务 |
| Happier | README 确认手机/电脑 Agent 编排及 E2EE；尚未完成协议与身份隔离审计，未声称接通 |
| Mine | README 明确依赖 ZCode、本地 SQLite 与 CLI，不是现成 Codex/Claude 多租户网关；未启动 |
| CC Switch | 桌面 Tauri 配置管理工具；不把消费者凭据上传或后台代管，未集成其桌面授权文件 |
| Better Auth / Authentik | 已核验仓库；前者为 TS 体系，后者增加身份服务运维和资源要求。本候选保留兼容认证基线，未完成身份改造/MFA，不能发布 |
| RSSHub / FreshRSS / Docmost | AGPL 元数据已核验；当前没有运行服务或复制代码，发现和学院仍未实现 |
| 1Panel / Coolify / Uptime Kuma / Beszel | 仓库已核验，资源和目标权限未知，不启动多个重复面板。未安装到任何服务器 |
| Mihomo | 查询预期路径的元数据与 README 却呈现游戏数据 Python 库，存在身份/来源不一致；禁止按名称猜测并接入，需独立复核 |
| sing-box | 实读许可证为 GPLv3-or-later 并含名称/关联限制，GitHub SPDX 返回 NOASSERTION；未安装/联调 |
| Codex / Claude Code | 仓库核验，未在受信用户设备完成 CLI 授权，未运行真实任务；不能把官方 API 聊天称为 CLI 已连接 |

真正复用的基础组件：React、TypeScript、Vite、Lucide、react-markdown、remark-gfm、rehype-highlight，FastAPI、SQLAlchemy、Alembic、Argon2、cryptography AESGCM、HTTPX、PostgreSQL，以及 nginx/Caddy 配置参考。版本来自 lock 文件；这些基础组件不等于用户列出的业务应用已融合。

参考文档已读取：openai/openai-python README（Responses/streaming）、anthropics/anthropic-sdk-python README（官方 Messages 及凭据）、googleapis/python-genai README（官方 Gemini API）。未抄用示例模型名、版本号或价格作为默认值；模型 ID 只接受实际连接检测返回且平台启用的条目。官方实际调用仍缺少测试凭据。
