# FAFA ONE V3 第二阶段安全暂停记录

状态：按用户明确指令暂停。禁止自动恢复开发、构建、测试、数据库操作或部署；必须等用户明确恢复指令。

## 生产与开发版本

- 生产 SHA：`8354c4f899addb110e90e558f8b0435c5ea33827`。
- 生产 Release：`/opt/fafa-one/releases/b-v3-v3-phase1-release-20261108T161500Z-8354c4f899ad`。
- 独立工作区：`/tmp/fafa-v3-phase2`。
- 独立开发分支：`feat/v3-phase2-delivery-20261109`，不合并、不部署。
- 暂停前开发基线 SHA：`4b242ecd47436c180a41eca53153e36e24ee4192`。
- 本次保存后的准确开发 SHA、未提交文件清单与文件哈希记录在 `/tmp/fafa-v3-phase2-pause-20261109.json`；Git 分支指针及暂停保存提交也保留此版本。
- 主源码工作区 `/opt/fafa-one/source` 的既有未跟踪文件、第一阶段工作区、备份、报告均未删除或重置。

## 已保留的开发中改动

以下不是已完成交付，不得用作生产发布候选：

- `packages/auth/src/business-access.ts`：新增临时活动授权层、注册体验资格、业务资源范围、明确禁止规则及真实计量数据读取基础代码。
- `packages/auth/src/auto-grant.ts`：接入新的体验发放入口，保留旧策略兼容路径。
- `packages/auth/src/service-policy.ts`：扩展全站活动范围、期限、时区、服务范围和 AI 配额的契约。
- `apps/api/src/access-center.ts`：新增普通用户单个/批量业务授权、平台资源分配、活动策略、审计、AI 使用摘要及人工核实流量登记接口草稿。
- `apps/api/src/admin.ts`：尝试将原管理员控制与有效权限读取、明确撤权规则衔接，并增加用户行锁检查。
- `apps/api/src/server.ts`：接入有效权限、节点订阅资源范围、订阅期限和 Shadowrocket/v2rayN 输出别名；限制普通用户写入节点。
- `apps/api/src/workspace.ts`：接入公开节点查看控制和临时活动权限。
- `apps/api/src/ai.ts`、`apps/worker/src/jobs.ts`：接入团队服务用户范围、有效期和运行时复查，尝试记录供应商实际用量。
- `apps/api/src/ssh.ts`：接入服务器资源范围、授权期限和会话复查。

中断时最后一个大补丁未落盘：`apps/admin/src/pages/AccessCenter.tsx` 不存在，`MemberDeliveryAdmin.tsx` 与 `member-auth.ts` 的对应 UI 整合补丁也未应用。不要假设权限中心页面已经开发完成；本轮暂停不会重放该补丁。

## 测试状态和 TypeScript 报错

只启动过一次第二阶段 TypeScript 检查；它已经结束，退出码为 **2**。没有执行第二阶段数据库集成测试、浏览器测试、生产构建、迁移或部署。

最近一次编译诊断：

```text
apps/api/src/server.ts(90,492): error TS2769: No overload matches this call.
Argument of type 'any[]' is not assignable to parameter of type
'[...any[], string] & readonly EscapableArray[]'.
Source provides no match for required element at position 1 in target.
The alternate overload requires TemplateStringsArray and property 'raw'.
```

关联位置是 `visibleNodes` 查询中把临时授权的节点源 ID 数组传给 `sql(...)` 的调用。该诊断后仍有增量编辑，暂停时没有重新编译；当前是否还有其他 TypeScript 或 Lint 错误尚未验证。不得称当前代码已通过测试。

暂停核查未发现仍在运行的第二阶段测试、构建或浏览器子进程；此前 TypeScript 进程已退出。未停止任何生产 Docker 容器或 PostgreSQL。API、Worker、PostgreSQL 仍健康，生产 Release 指针保持不变。

## 安全审查结果与未完成事项

- 本轮没有修改生产数据库、Owner、用户、节点、订阅或邮件配置，没有执行迁移、重新导入节点或重发邮件。
- Owner/管理角色保护、批量原子更新、活动不绕过明确禁止、临时权限到期恢复基础权限等，目前仅有代码草稿，尚需完整并发、跨用户和运行时撤权测试，不能当作安全验收已通过。
- 尚未完成管理员权限中心、活动及团队 AI 的页面和路由整合。
- 尚需审查所有读写入口的权限一致性，尤其是原管理 API、节点列表、服务器共享列表、WebSocket 看门狗错误处理、AI 运行中的撤权及额度变化、订阅新旧链接与资源到期。
- 当前 46 个节点是 34 个 SS 和 12 个 VMess。没有确认可用的按用户自动计量/停用网关。人工流量记录与面板订阅访问限制不等于实际数据平面限流，不能虚报已实现真实流量强制执行。此前对此接入条件的询问未获得答复。
- 个人 Codex 托管授权继续保持暂未开放，不收集个人 ChatGPT Cookie、登录令牌或 CLI 凭据。
- 尚未新增第二阶段专项测试，原有测试的部分预期可能需要随明确的新权限规则更新；在修复编译和补齐测试前不能构建或发布。
- `node_modules` 是指向 `/opt/fafa-one/source/node_modules` 的依赖复用符号链接，仅留在工作区，不纳入 Git 提交，不删除。

## 恢复步骤（仅用户明确恢复后）

1. 阅读本记录与 `/tmp/fafa-v3-phase2-pause-20261109.json`，确认保存提交及未跟踪文件；先核对生产 SHA 是否仍为第一阶段版本。
2. 从保存分支继续现有修改，不重置工作区、不重放未落盘 UI 补丁、不覆盖主源码中的成果。
3. 修复已知 `TS2769`，再次执行类型检查以取得当前实际报错；然后补齐管理员 UI、活动语义与所有权限入口，按模块补测试。
4. 明确真实流量计量/停用的数据平面接入条件；继续保持未配置状态，禁止伪造用量或声称已强制限流。
5. 必要测试、三端回归及兼容性通过后，再按届时授权进行有效备份与恢复验证、镜像构建及安全发布。第一阶段已完成的邮件验收不重复。

本记录仅用于保存和恢复，不构成继续执行或生产发布授权。

保存前对本次拟提交文件进行了只读凭据模式检查，未发现常见私钥、AWS Access Key、GitHub Token 或 OpenAI 项目密钥模式；此检查不替代完整安全审计，未重新运行测试。
