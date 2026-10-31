# 当前 API 边界

`/api/v1` 为归档兼容认证、管理员、节点、平台 API 账户和 worker 契约；这不代表现网兼容已经验证。新核心统一使用当前 FAFA 用户 ID：

- GET `/api/v2/capabilities` 明示支持状态。
- GET/POST `/api/v2/connections` 列出/创建个人官方 API 连接。
- PATCH/DELETE `/api/v2/connections/{id}` 备注与预算/擦除密钥后软删除。
- POST `/api/v2/connections/{id}/default|test|revoke` 设置后续默认、真实官方模型查询、撤销 FAFA 访问。
- GET `/api/v2/models|usage` 平台核验模型/owner 过滤用量和未知费用预留。
- GET/POST `/api/v2/sessions` owner 搜索与分页/新建；GET/PATCH/DELETE `/{id}` 历史分页/改名/归档。
- POST `/api/v2/sessions/{id}/messages` SSE：start、delta、error、done；运行锁定请求时的连接、模型和价格。
- POST `/api/v2/runs/{id}/stop` 停止本地运行；不保证供应商未计费。
- POST `/api/v2/sessions/{id}/recover` 超过 180 秒后恢复未知状态，保留费用预留，不重发任务。

全部 owner 接口需要会话；写入同时检查 CSRF 与 Origin。跨 owner 返回 404；普通用户访问管理员 API 返回 403。个人接口即使管理员也不允许跨 owner 读原始密钥或对话。请求只能提交个人 API Key，禁止额外 password、Cookie、base_url 或 CLI 凭据字段。

连接轮换需新建，不原地替换，运行不会跟随默认连接变化。跨模型/连接携带上下文必须明确 confirm_handoff。不得把检测通过解释为聊天生成/剩余额度已经验证。
