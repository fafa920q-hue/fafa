# 现有服务器发布与维护

唯一目标：3.19.237.155，/opt/fafa-one，现有 Docker/Compose、Deploy Key、60GiB 磁盘、2GiB Swap、三个已构建镜像和 .env.production 全部沿用。没有新服务器、第三个域名或重新安装步骤。代码升级才需要重建三张镜像。

## 执行通道

优先使用已有 SSM。仓库提供固定命令文档 infra/deploy/ssm-document.json、受保护工作流 .github/workflows/deploy.yml 与最小 IAM 策略模板。部署角色只能向指定的一个实例发送 FAFAOne-Deploy 文档，不能更改该文档、IAM、安全组或 DNS。文档只接受 SHA 和 check/deploy，不能传任意 shell 命令。

GitHub production Environment 必须有人工 required reviewers 且禁止管理员绕过；缺失或无法读取保护规则时失败关闭。工作流只对本仓库指定开发分支生效，先等待同一个 SHA 的完整 CI 成功，再等待 Environment 的人工批准。不会合并主分支。工作流支持分支 push，首次准备不需要把它合并 main。

尚未配置通道时只需补充以下非秘密设置，不重做服务器搭建：

1. AWS 管理员确认目标实例已经 SSM Online；安装固定文档版本 1，并将 OIDC 部署角色限于该文档/该实例。模板中的 Account、Region、Instance ID 和精确 OIDC sub 必须按实际账号填写；GitHub 2026 年后仓库可能使用包含不可变 owner/repo ID 的 sub，不能盲填旧格式或用通配符。
2. 仓库配置 production 人工审批保护，在该环境设置 AWS_ROLE_ARN、AWS_REGION、AWS_INSTANCE_ID；仓库变量 FAFA_DEPLOY_ENABLED=true 才启用通道。没有权限时保持关闭，不把 SSH 私钥或 AWS Access Key 放进聊天或工作流。
3. 对待发布 SHA 审查并人工批准，工作流校验实例公网 IP、SSM Online 和只读安全组状态。不自动修改安全组；80/443未确认开放或4000/5432有公网规则时停止并请求授权处理。

如果当前 GitHub 计划不提供私有仓库 Environment 审批，不能绕过保护或要求购买服务器；使用已有受信 SSM/服务器交互终端，在人工审核 SHA 后执行部署脚本。若 SSM/IAM 尚未授权，记录为实际阻塞。

## 服务器自动步骤

固定文档先确认 Git 干净、既有远端可信且 SHA 属于开发分支，再切换已批准 SHA；不会 reset --hard 或覆盖 .env。deploy-production.sh 使用进程锁和 Git archive 构建，只包含已跟踪源码，不把本地配置/用户文件送进镜像。

脚本验证 .env.production 是普通文件且权限600，保留原密钥，核验生产标志、双域名与 Google 配置；只把当前秘密与 Git 历史作本地比较，不打印配置值。确认泄露才进入现有轮换流程，不无故重生成已校验密钥。聊天、提供商后台、AWS历史日志的泄露不能由 Git 扫描排除。

先保留旧镜像/服务状态，启动现有 PG，再做加密 pg_dump 并实际验证解密和 pg_restore 清单。备份使用现有版本化信封密钥，文件600，密钥仍须独立备份；工具单次原始 dump 上限256MiB，超过时停止发布并使用现有流式 age 流程，不截断备份。新增备份工具不安装主机软件。

随后建立/复用独立 fafa_app 账号，已有 runtime 凭据必须验证一致，不重设其密码；原 PG 管理密码和加密主密钥不变。应用容器只接收 app URL 及所需业务配置，不接收 PG 管理密码。API/Worker 在启动时验证最小角色和权限；迁移与本地 Owner 工具使用原管理连接。新的 .env.runtime 是独立角色配置，并非覆盖 .env.production。

迁移执行003_owner_setup，最后收紧授权、启动服务和代理，验证内部 ready、Worker heartbeat、端口未发布、重启策略及日志轮换。记录 deployments/SHA-services.json、SHA-migrations.txt、SHA-owner.json；不转储 Docker Env。完整备份保留在 backups/，不上传 CI。

失败时保留数据、配置、备份及镜像，API/Worker停止以避免权限回退。不要盲目回退到忽略新节点启停/共享权限的旧代码。先检查迁移兼容性，再切回已经验证的兼容镜像；数据库只恢复到新空库，绝不覆盖生产卷。信封备份须先完整通过 GCM 认证，再用原 pg_restore --single-transaction 恢复新空库；现有 age 备份/恢复工具继续可用。

## 发布后的人工最小步骤

通过受信服务器交互终端执行 [OWNER_SETUP.md](OWNER_SETUP.md) 中的一条命令，然后在手机正式网站输入一次性授权凭据并登录自己的 Google 账户。此步骤不能由 CI 的假身份替代。

第三方节点先在提供商轮换，再经 [NODE_IMPORT.md](NODE_IMPORT.md) 的 HTTPS 表单输入；明确授权依据后导入。没有新凭据时不导入。使用自己的 Shadowrocket/v2rayN 实机验证，记录导入数量、地区及失败，不上传敏感二维码或订阅 Token 截图。

保护工作流只自动截图公网登录页（PC Chromium / iPhone WebKit模拟），不截图已登录用户数据；模拟不能替代 iPhone Safari 真机。Google、Owner、订阅下载、OpenAI及公网 SSH 的私有验收仍需实际授权会话，结果必须逐项注明。

## 维护

保持备份离机副本与主密钥的独立保管；定期做新空库恢复演练。业务镜像、生产配置、PG/Caddy 数据卷持续保留。现有容器 unless-stopped 自动恢复，Docker 服务的系统级自启动需在真实服务器检查；本环境未连接服务器时不能声称已启用。检查 worker_heartbeat、磁盘、证书到期、任务错误与经过脱敏的日志；json-file 轮换上限10MiB×3/容器。

数据库/加密凭据轮换沿用现有脚本，先备份、重包加密数据并验证，再清理旧版本。Google Secret 与第三方节点泄露必须通过各自提供商撤销/重签发；不能靠改数据库字段使原凭据失效。

成功发布的镜像 SHA 单独保存在 .deployed-sha，不改 .env.production 的旧 IMAGE_TAG。后续工具命令用 production-compose.sh 读取实际发布版本。脚本配置每日加密备份 timer 和 Docker 自启动；遇到同名但不同内容的现有备份单元会保留并停止，不能覆盖用户策略。工具容器禁用 Docker 日志采集，防止备份明文被日志驱动保存。

首次无 .env.runtime / .deployed-sha 的控制台执行步骤见 [AWS_CONSOLE_HANDOFF.md](AWS_CONSOLE_HANDOFF.md)。发布前的 Cookie/代理域名及管理员数据库连接一致性检查会失败关闭，不重设既有密码。CI production-startup 使用一次性凭据/卷验证首次启动、迁移前备份、恢复新库及PG重启持久化，不访问AWS。

授权 root/SSM 调用发布脚本时，Git 操作以现有仓库属主执行，复用该用户已配置的 Deploy Key；不添加全局 safe.directory 或复制私钥。SSM 固定文档的初始 Git 操作采用相同规则。若已安装旧文档，管理员必须审核文档版本及客户端固定版本后再授权，不擅自改写云端文档。

内部端口使用容器 inspect 的 HostConfig.PortBindings 和 NetworkSettings.Ports 校验，不以 compose port 的 :0 或服务状态提示判断。仅 EXPOSE/null/空列表允许；任何真实宿主机端口绑定（包括127.0.0.1和IPv6）均拒绝。停止/缺失服务、检查失败或未解析的发布请求单独报错并触发现有失败恢复。若旧检查在迁移后误拦截，保留现有数据库、备份、.env.runtime和密钥，更新获批准提交后重跑同一发布入口；迁移幂等、已有运行时凭据复用，不删除数据卷。
