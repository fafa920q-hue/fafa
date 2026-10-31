# 候选架构与实现边界

统一 React/TypeScript 客户端 + FastAPI 模块化 API + SQLAlchemy/Alembic + PostgreSQL；保留已有受限 worker 契约。不为本次核心额外启动 Redis、LiteLLM、完整聊天应用或运维面板。没有在无 GPU 主机部署模型。

新 `app/one` 模块独立于旧管理员平台 AIAccount。`ai_connections` 只存本用户官方 API 连接；FAFA 登录身份、设备 CLI 授权和管理员平台 AI 账户不能通过此接口提交。设备授权缺失时明确不支持，不接收消费者密码/Cookie。

`chat_sessions`、`chat_messages`、`ai_runs` 都有 owner_id。服务端逐项校验；管理员也不能通过个人接口读取其他人的连接或对话。历史分页 50 条、会话分页 30 条，搜索字面匹配并按 owner 过滤。上下文最多 50 条、32KB admission 上限；超过时拒绝并要求新建会话，不静默丢弃上下文。

运行前锁定 connection_id/model_id/价格；凭据不能原地替换。默认连接改变只影响后续选择。并发 admission、默认账户和预算写入采用数据库真实写锁；供应商异常、取消或未返回完整用量时保留预留。停止本地流不保证上游已经停止计费。只调用固定官方 HTTPS 地址，不支持自定义 base URL 或跳转，不自动重试计费请求。

流式任务在 API 进程内处理，最长 120 秒，检查断连及撤销，关闭上游读取。尚未实现任务进程迁移或可靠分布式队列；重启后的未知任务由用户在 180 秒后显式恢复，不自动重发。消息完成/中止时落库；执行中的 token 尚未跨设备实时广播，完整同步能力仍属未完成项。

前端默认深色，浅色偏好本地保存；桌面侧栏和移动底栏、原生 dialog 焦点恢复、VisualViewport 高度、受限滚动区、Markdown 默认禁用 HTML。Markdown/高亮按需加载。实际 Safari/PWA 和其他浏览器尚未验证。

未来双域名是独立 surface/实例，必要时独立服务器，以受限内部 API 通信；不从 DNS 相同就推断必须共址。正式数据库、业务实体映射、GPS/订阅 Token/Agent 身份与部署拓扑必须从生产只读基线确认后设计。当前没有这些数据，不能声称已完成生产迁移或双域名认证隔离。
