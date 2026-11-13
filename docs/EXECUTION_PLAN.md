# 执行计划与仓库审计

基线：main / 000cbe5。仓库只有 README 与 Apache-2.0 LICENSE，无 AGENTS.md、应用、部署、用户数据或秘密。保留原许可证，所有改动在 feat/fafa-one-control-panel；不访问生产。

技术路线：React/Vite 两个独立构建（控制台无需 SSR，降低运行成本）；Fastify API；PostgreSQL + Drizzle；数据库持久任务队列，无 Redis。参考图归档在 reference_images，不作为页面背景。

阶段验收：0. 审计与计划：确认空仓库、记录基线与设计差距。

1. 底座：独立 Web/Admin、玻璃 tokens、迁移、开发与 Docker 启动。
2. 节点：解析/导出、源读写、隔离、Token、SSRF 与刷新队列测试。
3. 身份：OIDC/开发登录、邀请/席位、RBAC、撤销与审计测试。
4. AI：加密多账户、任务/流式接口、取消与未配置门控。
5. 服务器：加密凭据、授权出口、主机指纹固定、WebSocket 终端。
6. 位置：坐标持久化与出口策略，明确 GPS 不支持。
7. 验收：lint/format/typecheck/unit/integration/build/Playwright/security，截图、文档、PR。

各阶段检查结果以最终 ACCEPTANCE_REPORT 为准；外部凭据缺失不伪造成功。设计差距：真实数据不能复用示例 48 节点、156.8GB、在线 Codex；位置标题须修正，手机 320px 指标改为 2×2。
