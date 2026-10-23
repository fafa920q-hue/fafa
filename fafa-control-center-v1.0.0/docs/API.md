# API 1.0.0

机器可读 schema：[openapi.json](openapi.json)，与实际 FastAPI routes 一起生成。运行时 schema 仅超级管理员可在 `GET /api/v1/admin/openapi` 取得。公开 `/docs` 和 `/openapi.json` 已关闭。

基路径 `/api/v1`，JSON、同源 Cookie 认证。健康 `/api/health` 只报告实际数据库可连接及版本。认证错误 401；权限不足 403；缺少记录 404；状态冲突/最后管理员保护 409；校验错误 422；限流/预算 429；集成未配置 503；外部提供商失败 502。不把 failed/not_configured 结果说成成功。

## CSRF 与会话

先 GET `/auth/csrf`，保留 HttpOnly Cookie，把 JSON 的 csrf_token 放进之后所有写请求的 `X-CSRF-Token`。浏览器需 `credentials: include`。跨 Origin 不允许。不要把 session Cookie 复制到代码/日志。

| 方法/路径 | 权限 | 用途 |
|---|---|---|
| GET /auth/capabilities | 公开 | 邮件/Google 配置状态，不代表已连接 |
| POST /auth/register | 公开+CSRF+限流 | email/password/display_name；忽略提权字段 |
| POST /auth/login | 公开+CSRF+限流 | 认证成功设置会话；随后 GET /auth/me |
| GET /auth/me | 登录 | 当前角色、模块、资源授权与限额，不含密码/密钥 |
| POST /auth/logout | CSRF | 撤销当前会话并清 Cookie |
| GET /auth/sessions | 登录 | 当前用户有效会话摘要 ID/时间（不是 bearer token） |
| POST /auth/sessions/revoke-all | 登录 | 撤销用户全部会话 |
| POST /auth/verification/request | 公开+CSRF+限流 | email；统一 accepted，需要 SMTP |
| POST /auth/verification/confirm | 公开+CSRF | token 单次使用 |
| POST /auth/password/request | 公开+CSRF+限流 | email；统一 accepted，需要 SMTP |
| POST /auth/password/reset | 公开+CSRF | token/password，完成后撤销全部会话 |
| GET /auth/google/start | 公开+限流 | PKCE/state/nonce 后跳转官方授权页 |
| GET /auth/google/callback | state Cookie | 仅预配置回调；验证官方 token |

邮件链接令牌在 URL fragment，不传反向代理日志；页面调用对应确认 API。令牌仅摘要保存在 DB，30 分钟过期。投递失败和缺配置明确报告。

## 管理员

仅 role=super_admin。模块权限无法替代管理员角色。写操作记录审计。

| 方法/路径 | 请求/用途 |
|---|---|
| GET /admin/users | q / status=all,active,disabled / page / page_size(1–100) |
| PATCH /admin/users/{id} | role、active、grants、monthly_requests、monthly_tokens、budget_cents，可部分更新；撤销目标旧会话 |
| POST /admin/users/{id}/disable 或 /restore | 便捷状态操作，保护最后管理员 |
| GET /admin/roles | 内置与自定义角色 |
| PUT /admin/roles | name、modules；内置 user/super_admin 不可改 |
| GET /admin/security | 安全策略；固定生产策略由环境配置控制 |
| PUT /admin/security | open_registration |
| GET /admin/audit | page/page_size，记录 actor_id/target/action/result/created_at |
| GET /admin/operations | DB 状态、真实用户数、任务汇总、节点错误 |

用户 grants 示例（仅管理员可设置）：

```json
{"modules":["ai","nodes","codex"],"accounts":[1],"models":["operator-reviewed-model"],"nodes":[1]}
```

模块授权是 role.modules 与 grants.modules 并集；普通用户还需明确账户/模型/节点 ID 授权。预算单位 USD cents，Token 与请求数按 UTC 月统计。

## 节点

GET `/nodes?q=`：nodes 模块 + 资源授权；POST `/nodes` 和 PUT `/nodes/{id}` 仅管理员。name、engine=xray/v2ray/sing-box/TEST、agent_ref、group、region、metadata、enabled。已有配置后 engine/agent_ref 不可改。

POST `/nodes/{id}/health` 或 `/retry`：授权用户可请求真实 Agent 检查，最多 3 次；无连接保持 unknown，错误入历史/告警。返回 operation_id/status/attempts/node/message。latency_ms 是 Agent HTTP RTT，metrics 说明 scope；TEST 不返回假数值。

GET `/nodes/{id}/history`：操作和版本摘要，不向普通用户返回配置正文。

管理员 POST `/nodes/{id}/config`（config JSON）、`/rollback`（version）和 `/nodes/batch`（ids 最多50，action=health/disable/enable）。变更不自动重试，避免远端不确定状态下重复执行。只有真实 Agent 确认已写入的配置才建立版本，运行态重载状态另行报告。

## AI

ai 模块 + 独立账户/模型授权。GET `/ai/catalog`，GET `/ai/usage`，GET `/ai/logs?page=`。日志/用量仅当前用户（管理员也不默认混合他人的请求数据）。provider_remaining_quota=null 表示未知。

仅管理员 POST `/ai/accounts`、PUT `/ai/accounts/{id}`：name/provider/secret_ref/enabled；provider 为 openai/anthropic/google。任何 API 都不返回 Key，secret_ref 只是挂载文件名。

仅管理员 PUT `/ai/models`：id/provider/capabilities/input_cents_per_million/output_cents_per_million/enabled。未配置价格时拒绝真实调用，避免无法执行预算。

POST `/ai/requests`：account_id、model_id、prompt、max_tokens(16–4096)、可选 fallback_model_id。同一账户、同一供应商、用户有授权且显式选择的备用模型，仅在 429 拒绝后使用。无隐式跨账户切换。成功响应包含实际 output 与 provider Token；未知 usage 保持 null。费用来自配置价格，不宣称供应商账单余额。失败/未知用量保留预算预留，不擅自归零。

## Codex

codex 模块 + 项目 owner；超级管理员可管理全部。GET/POST `/codex/projects`（name/repository，只接受无凭据 HTTPS URL）。GET/POST `/codex/tasks`（project_id/prompt/timeout_seconds=30–3600）。当前任务列表最多200条，项目/任务深度查询分页需后续扩展。

POST `/codex/tasks/{id}/approve`（仅管理员）、`/cancel`（owner/admin）、`/retry`（owner/admin，必须重新审批）、`/rollback`（仅管理员且真实任务已完成）。

状态：pending_approval → queued → dispatching → running → succeeded/failed/cancelled/timed_out。未配置执行器：approve → not_configured，attempts=0。取消实际运行中任务先变 cancel_requested，worker 确认后才变 cancelled。超时取消未确认会明确记录，禁止直接重试。回滚只有远端确认后记录 rolled_back。

日志、changes、diff、tests 初始为空/null。没有真实执行不得制造结果。worker 细节见 [AGENT_WORKER](AGENT_WORKER.md)。
