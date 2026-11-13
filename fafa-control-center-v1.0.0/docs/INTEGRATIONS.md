# 外部服务与实际接通状态 / Integration readiness

交付物版本 1.0.0。在云端隔离环境开发，无生产连接、SSH、DNS 或日本旧服务操作。

| 项目 | 已有实现 | 本次真实连接状态 / 后续工作 |
|---|---|---|
| 邮箱认证 | 注册、Argon2id、会话撤销、CSRF、验证和重置单次令牌、SMTP STARTTLS | NOT CONFIGURED：需 SMTP。邮件流程使用捕获投递的测试，不代表真实邮箱收件成功。生产默认强制验证。 |
| Google OAuth | 授权码 + PKCE S256、state Cookie 绑定、nonce、RS256/JWKS、iss/aud/exp 校验、防自动邮箱合并 | NOT CONFIGURED：需 Google Cloud Web OAuth 客户端、同意屏幕与精确回调。模拟签名和回调测试通过不代表真实 Google 登录。 |
| AI | OpenAI Responses、Anthropic Messages、Google generateContent 官方 API；账户/模型授权、请求统计、预算预留、显式同账户备用模型 | NOT CONFIGURED：需各自合法 API Key、有效官方模型 ID 和经核对价格。无真实 API 调用。供应商余额与订阅额度均未知；不合并 ChatGPT/Codex 订阅。其他供应商需新增官方适配器。 |
| 节点 | Xray/V2Ray/sing-box 固定 CLI 配置验证边界、独立 Agent、分组/禁用/授权、健康探测、指标、版本、回滚、错误告警 | NOT CONFIGURED：需部署专用非 root Agent，安装相应官方二进制并提供白名单和 TLS。没有连接真实节点。配置可验证并原子暂存；自动 reload / 重启集成尚未提供，必须由运维验证后接入。未验证进程不得显示在线。 |
| 节点 TEST | 显式测试适配器 | 始终显示 TEST；无真实延迟、CPU、在线状态。配置测试不宣称应用到节点。 |
| Codex | 项目/队列、审批、状态机、取消/超时/重试/回滚接口、日志/变更/diff/测试结果、隔离执行器契约 | NOT CONFIGURED：需合法 Codex/API 授权和符合契约的独立 HTTPS worker。未附带完整 Codex worker 服务或授权，不执行代码。worker/sandbox.py 是 rootless Docker 启动参考，实现 CPU/内存/时限/文件系统/网络限制；尚未执行真实 Codex 任务。 |
| Worker 网络 | 默认 deny，沙箱仅写工作目录，镜像 digest 固定 | 真实云端 Codex API 需要经过审查的受限出口设计；本交付没有放开网络，不可直接假定离线沙箱可访问供应商。 |
| 告警 | 运维页节点故障、AI 用户限额 80% 告警、请求错误日志 | 不发送邮件/短信/聊天通知；供应商不可得限额保持未知。 |
| 备份 | SQLite 一致性备份/恢复脚本；PostgreSQL pg_dump/pg_restore 操作手册 | 需运维配置加密保存、异地副本、定期演练与定时任务。界面不伪造备份成功。 |
| 监控 | DB 健康、真实应用记录、Agent 命名空间指标 | Web API 不访问主机 root。节点 metrics 附 scope；Agent CPU 为自身进程 CPU 秒，非整机 CPU 百分比。完整主机指标需另接监控 Agent。 |

禁止把本表中 NOT CONFIGURED 的项目写成已完成真实端到端测试。正式上线前应按所需模块完成相应接通验收；可先部署认证与管理平台进行受控验收。
