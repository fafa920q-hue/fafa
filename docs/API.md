# API

统一错误：`{code,message,correlationId}`。正式 API Origin 为 https://fafa888.uk，路由已包含 /api，客户端不得重复添加。REST /api 路径除 GET/HEAD /api/health、/api/ready 和 /api/subscription/download/:token 外要求 Cookie 会话；写操作要求准确 Origin 与 x-csrf-token。凭据不会在读接口回显。UUID 无权访问返回 404。JSON 请求上限约 1 MiB。

| 路径                                                                | 方法               | 功能                                                                           |
| ------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------ |
| /api/health / /api/ready（兼容 /health / /ready）                                                    | GET                | 进程健康 / PostgreSQL readiness                                                |
| /auth/config                                                        | GET                | 非秘密能力开关                                                                 |
| /auth/google / /auth/google/callback                                | GET                | Google code + PKCE OIDC                                                        |
| /auth/dev                                                           | POST               | 仅显式 development 的固定 seed 角色登录                                        |
| /api/me / /api/logout                                               | GET / POST         | 当前身份与 CSRF / 退出                                                         |
| /api/sessions / /api/sessions/:id                                   | GET / DELETE       | 个人会话 / 撤销                                                                |
| /api/summary                                                        | GET                | 实际计数，未知监控值为 null                                                    |
| /api/{node_sources,ai_accounts,server_connections,location_presets} | GET / POST         | 个人资源列表 / 新建                                                            |
| /api/{上述资源}/:id                                                 | GET / PUT / DELETE | 拥有者读写 / 软删除                                                            |
| /api/shared-sources / /api/servers/shared                           | GET                | 已授予使用权的共享资源摘要                                                     |
| /api/node_sources/:id/enabled                                       | PATCH              | 启停源                                                                         |
| /api/node_sources/:id/refresh / /api/sync-runs                      | POST / GET         | 入队刷新 / 个人同步历史                                                        |
| /api/subscription/rotate / /api/subscription                        | POST / DELETE      | 一次性回显新 URL / 撤销所有令牌                                                |
| /api/subscription/profile                                           | GET / PUT          | 国家筛选配置                                                                   |
| /api/subscription/download/:token?format=mihomo（兼容 /subscription/:token）                                  | GET                | Token 导出，format 支持 mihomo / sing-box / uri / base64                       |
| /api/ai/select                                                      | POST               | {accountId}，仅本人账户                                                        |
| /api/ai/tasks                                                       | GET / POST         | 个人任务 / {accountId,prompt,workspace}                                        |
| /api/ai/tasks/:id/cancel / events                                   | POST / GET         | 取消 / SSE 持久快照                                                            |
| /api/servers/:id/probe / pin                                        | POST               | 指纹探测 / {fingerprint} 固定                                                  |
| /api/servers/:id/terminal-ticket                                    | POST               | {confirmed:true,writeApproved?:true}，30 秒票据                                |
| /api/servers/:id/terminal                                           | WS                 | 首帧 {ticket,csrf}；输入 {type:'input',data}；resize {type:'resize',rows,cols} |
| /api/data-export / /api/data-request                                | GET / POST         | 无秘密导出 / 删除请求登记                                                      |
| /api/admin/users / invitations                                      | GET                | 管理摘要列表                                                                   |
| /api/admin/invitations / invitations/:id                            | POST / DELETE      | 邀请 / 撤销                                                                    |
| /api/admin/users/:id                                                | PATCH              | disabled / role / revokeSessions / nodeLimit / subscriptionEnabled             |
| /api/admin/{sources,servers,ai,jobs,audit,settings}                 | GET                | 脱敏后台列表                                                                   |
| /api/admin/grants                                                   | POST               | {kind:'source'或'server',resourceId,userId}                                    |
| /api/admin/grants/:kind/:id/:userId                                 | DELETE             | 撤销自己的资源授权                                                             |
| /api/admin/settings / jobs/:id/retry                                | PATCH / POST       | 调整席位 / 重试失败任务                                                        |

源写入示例：`{name,kind:'OWNED_NODE',content:'trojan://…',country:'日本',authorized:true}`；远程源使用 `kind:'REMOTE_SUBSCRIPTION',url:'https://…'`。编辑秘密资源需重新提供凭据，避免隐式复用旧 host / key。验证器在 packages/shared/src/index.ts。

分页目前为保守上限（列表和审计 50/200），适合 20 人；大规模需实现 cursor 分页与多实例限流。没有对外承诺稳定 v1 API；后续应生成完整 OpenAPI 并做契约测试。
