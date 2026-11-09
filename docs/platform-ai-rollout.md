# FAFA ONE 平台 AI 验收与发布

平台沿用现有 React 前后端界面、Fastify、PostgreSQL、会话鉴权和 Worker。服务账户由 Owner 维护。成员从服务状态接口取得已授权的显示名称与模型 ID。既有账户和历史任务保留在原表。

## 隔离验收

1. 使用空的本地测试 PostgreSQL 数据库，设置独立的 `DATABASE_URL`、`TEST_DATABASE_URL` 和 `ENCRYPTION_KEY`。连接使用 `127.0.0.1`，专项集成测试使用名为 `fafa_platform_<hex>_test` 的数据库。
2. 安装锁定依赖并运行 `pnpm exec tsx packages/db/src/migrate.ts`。候选使用 `009_platform_ai.sql` 和 `010_platform_chat.sql`。
3. 为隔离 API 与 Worker 设置 `PLATFORM_CODEX_ENABLED=true`。该名称沿用平台入口开关，默认关闭。启用后仍须由 Owner 打开平台策略。
   预览前端可在构建时设置 `VITE_ADMIN_ORIGIN` 为同一环境的后台地址。
4. 从后台「AI 服务管理」录入 OpenAI 项目 Service Account 签发的测试凭据。在 OpenAI 项目控制台核对密钥归属。应用连接检查只验证上游模型访问和 Responses 输入计数接口权限。
5. 配置模型完整 ID、短上下文标准费率、缓存读写费率、单任务上限和用户范围。编辑服务账户的允许模型，执行连接检查，然后启用账户。将模型加入平台默认额度或指定用户的额度策略。
6. 以两个独立成员检查模型可见范围与会话隔离。以一个已授权成员完成真实 GPT 流式对话并核对 Usage。对照 OpenAI 项目账单检查费率。
7. 运行类型检查、Lint、构建、单元和集成测试。对同一测试库分别串行运行 `tests/platform-ai.integration.test.ts` 与 `tests/platform-chat.integration.test.ts`，再在桌面与手机浏览器验收。

成员请求预算在 PostgreSQL 事务中串行预留。成功响应按上游 Usage 和任务记录中的费率计算费用。返回用量缺失的已发出请求保留预留金额，供管理员核对。模型限流时暂缓对应项目调度。密钥撤销会从应用停止使用，轮换完成后应在 OpenAI 项目撤销旧密钥。

[项目服务账户与凭据生命周期](https://developers.openai.com/api/docs/guides/api-keys) · [OpenAI API 费率](https://developers.openai.com/api/docs/pricing)

## 生产准备与回滚

1. 固定候选 Git 提交并建立独立 Release。在取得发布授权后，备份生产数据库与配置，并在隔离库验证恢复。
2. 用迁移角色执行 009 和 010。上线前单独核对 `fafa_app` 对四张新表的最小权限，范围为 SELECT、INSERT 和 UPDATE。应用角色沿用既有加固规则。
3. 先在功能开关关闭时验证候选 API、Worker、前台、后台和原有业务，再按隔离验收配置方式逐步开放。
4. 回滚前停止接收平台任务，核对排队与运行状态并完成收尾。切回上一个 Release 时保留迁移新增的账户、对话和用量记录。

当前 GPT 对话通过 OpenAI Responses API 处理文本。管理员可另行开放不超过 8 KB 的文本附件。Codex 原生代码执行、仓库和 SSH 任务提交需要独立执行服务、批准流程、网络策略及资源隔离验收，当前入口保持关闭。
