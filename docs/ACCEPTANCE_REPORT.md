# FAFA ONE 工程验收报告

验收日期：2026-11-06。仓库：[fafa920q-hue/fafa](https://github.com/fafa920q-hue/fafa)，开发分支 `feat/fafa-one-control-panel`，审查入口：[Draft PR #2](https://github.com/fafa920q-hue/fafa/pull/2)。未合并，未购买服务器、修改生产 DNS 或正式部署。

## 仓库恢复与保全

原 `/workspace/fafa` 成功恢复，应用、迁移、测试、参考图和截图保留；没有执行 git clean、reset --hard 或重新初始化。源码先以 e6a5735 保全，再推送 f0b02e5、eff804e。出站代理随后持续返回 503，已改用 GitHub 连接器保存后续源码及 CI 配置，保留原本地提交；不以强制推送覆盖其他提交。

## 已通过的检查

| 检查                      | 结果与边界                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| lint / format / typecheck | 本地通过                                                                                                                          |
| Web / Admin 构建          | 两个独立 Vite 产物构建通过；终端与页面按需加载                                                                                    |
| unit                      | 46 项通过：5 协议 × 4 输出往返、完整身份去重、SSRF 地址/DNS、加密和生产开发登录门控                                               |
| integration               | 15 项通过，使用独立 `_test` PostgreSQL，非生产数据                                                                                |
| 20 人权限                 | 用户计数达到 20 后并发额外激活被拒绝；个人对象交叉读取 404、普通用户无管理权限、Viewer 写入拒绝                                   |
| 其他安全路径              | CSRF、邀请/verified email、Google sub 绑定、Token 轮换撤销、凭据加密、再认证、会话撤销、审计不可修改                              |
| SSH                       | 本地受控 SSH 服务器实际握手、指纹确认、变更拒绝、授权只读 WS 通道通过；不是公网用户服务器实连                                     |
| 备份与实际恢复            | pg_dump → age → 解密 → pg_restore，27 张表计数一致，凭据可解密、审计仍不可修改；非空库和缺少确认拒绝恢复                          |
| 依赖                      | glob 唯一解析到 14.0.3，修复 GHSA-3g3m-2fjr-6pw4；minimatch 11.0.4。修复后本地完整审计未报已知漏洞；随后云代理 503 不计为审计通过 |
| Compose 全服务            | GitHub CI 成功构建并启动 Web、Admin、API、Worker、PostgreSQL，migrate/seed 退出 0，服务健康通过                                   |
| HTTPS / Caddy             | CI 中临时 `.test` 域名与内部 CA；启用证书验证，验证三端反向代理、未信任证书拒绝、API 401 / no-store / correlation ID / 无堆栈泄漏 |

容器与 TLS 的可审查结果：[CI run 42150478474](https://github.com/fafa920q-hue/fafa/actions/runs/42150478474)，`containers` job 成功；[容器证据摘要](evidence/container-ci.json)。生产域名证书与 DNS 未配置，不冒充生产 HTTPS 验收。

备份证据：[backup-restore.json](evidence/backup-restore.json)。恢复期间只创建和删除本次随机命名的测试库及临时 age 私钥，没有覆盖业务数据库或删除持久卷。

## 浏览器、视觉与可访问性

- Chrome / Firefox / 桌面 WebKit / iPhone WebKit 模拟 / Android Chrome 模拟均覆盖用户页面、管理页面、实际写入、Viewer 权限、空态和断网重试。
- 桌面引擎覆盖 320 / 375 / 390 / 430 / 768 / 1024 / 1440 / 1920px；手机模拟器覆盖 320 / 375 / 390 / 430px。桌面和手机模拟上下文分开，避免把 iPhone 模拟器用于 1440px 桌面交互。
- 26 项有效通过：完整轮次 25 项通过，iPhone 命令框用例失败后，通过固定视口定位和固定结果区尺寸修复，原生点击补充复测通过。4 个跳过仅为其他引擎重复的 axe 检查。未把补充复测伪称为原始整轮一次性全绿。
- axe：6 页面 × 浅/深色 × 390/1280px，共 24 组，0 项 WCAG A/AA 自动检查违规。搜索按钮可访问名称包含可见快捷键。
- 截图见 [screenshots](screenshots/)，参考图原件保留在 `reference_images/`。页面由路由和组件实现，没有使用整图背景冒充应用。
- 真机 iPhone Safari / iOS 26.3、真实 Android 设备、系统文字缩放及软键盘最终体验仍需人工验收。模拟器不代表真机认证。

机器可读记录：[verification-summary.json](evidence/verification-summary.json)、[完整轮次报告](evidence/playwright.json)、[AXE_REPORT.json](AXE_REPORT.json)。最终 GitHub CI 状态应在 PR 上单独核对，不能用本地通过替代远端 CI 结论。

## 性能

前次本地生产构建/演示环境 Lighthouse：Performance 100、Accessibility 100、Best Practices 100，LCP 1764ms、CLS 0.000075、TBT 31ms；报告在 [performance/lighthouse.html](performance/lighthouse.html)。这是实验室环境，未测真实用户 INP，生产上线前必须复测。开发服务器较早结果 Performance 61 / Accessibility 94 亦保留，不能和生产构建数据混用。

## 已有能力与配置边界

用户端六路由、管理端八路由、订阅源读写/解析/聚合/导出/轮换/刷新队列、Google 邀请与席位逻辑、加密多 API 账户与任务流、SSH 授权指纹和终端、位置预设与出口地区筛选均有数据模型和 API。演示模式明确标注，阻止外部 AI / SSH / 订阅抓取。

以下仍待用户环境，不计作真实接通：

1. Google OAuth 客户端与 Owner Google sub 的生产实连验收。
2. 自有 OpenAI API Key 的真实额度、模型和流式请求验证；不使用 ChatGPT Plus 额度。
3. 公网 SSH 白名单与用户服务器指纹线下核验；默认只读 uptime。完整 shell 需服务端开关及额外会话批准，不是逐条危险命令沙箱。
4. 第三方订阅合法授权及真实客户端导入/兼容性；未提供可靠接口时，流量/在线/延迟均显示未知或数据不可用。
5. 在线地图服务未接入，当前为坐标预设与示意；网页/小火箭不能改变 iOS GPS。
6. Sign in with ChatGPT 托管集成尚未获批准，按钮禁用；官方 Codex Cloud 仅外链。
7. 管理员 MFA、自动保留期清理、备份调度与生产容量/恢复耗时演练仍需后续运维建设。

配置清单见 [DEPLOYMENT.md](DEPLOYMENT.md)，回滚见 [ROLLBACK.md](ROLLBACK.md)，安全边界见 [SECURITY.md](SECURITY.md)。所有秘密只经受保护环境变量、密钥管理或个人 HTTPS 表单注入，不发送到聊天。
